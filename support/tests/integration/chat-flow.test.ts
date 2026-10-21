import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Only the two I/O boundaries are replaced: the Telegram wrapper and the
// WebSocket fanout. Postgres is real, and every assertion below is either a row
// this suite re-read from it or an argument the real service handed the mock.
vi.mock('@apps/services/push.service', () => ({
  pushToUser: vi.fn(async () => undefined),
}))
vi.mock('@telegram/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@telegram/api')>()),
  ...(await import('./_telegram-stub')).telegramStub(),
}))

import { shutdownPrisma } from '@config/database'

import {
  agentSendMessage,
  closeTicketEverywhere,
  markRead,
  userSendMessage,
} from '@apps/services/chat.service'
import { pushToUser } from '@apps/services/push.service'
import { getThread } from '@apps/services/ticket.service'

import * as telegram from '@telegram/api'

import {
  cleanupTestUser,
  createTestUser,
  listMessages,
  listTickets,
  openTicketOf,
  unreadInDb,
} from './_helpers'

const pushes = () => vi.mocked(pushToUser).mock.calls
const pushActions = () => pushes().map(([, payload]) => payload.action)

const createdTopics = () => vi.mocked(telegram.createTicketTopic)
const relays = () => vi.mocked(telegram.relayUserMessage)

beforeEach(() => {
  // Call history only — the stub implementations (incrementing topic / message
  // ids) must survive, so this is deliberately not `resetAllMocks`.
  vi.clearAllMocks()
})

afterAll(async () => {
  await shutdownPrisma()
})

describe('the first message a user ever sends', () => {
  it('opens one ticket, writes both bubbles, creates one topic, pushes once', async () => {
    const user = await createTestUser()
    try {
      const text =
        'Здравствуйте!\n\nНе приходит депозит — вот адрес: <b>0xабв</b>'
      const result = await userSendMessage({
        userId: user.userId,
        userNId: user.userNId,
        text,
      })

      const tickets = await listTickets(user.userId)
      expect(tickets).toHaveLength(1)
      const ticket = tickets[0]!
      expect(ticket.status).toBe('OPEN')
      expect(ticket.userNId).toBe(user.userNId)
      // The topic binding is what makes the ticket reachable from Telegram.
      // Note it was created even though the exchange `accounts`/`payments`
      // tables do not exist in the test stand: `getUserCard` settles each read
      // on its own, so a degraded info card can never cost the user a ticket.
      expect(ticket.tgTopicId).toBeGreaterThan(0)
      expect(ticket.tgChatId).not.toBeNull()

      const messages = await listMessages(ticket.id)
      // Support's automatic greeting closes the run: it follows the user's own
      // message, never precedes it, and carries a CODE instead of text so the
      // client renders it in the language the user is reading.
      expect(
        messages.map((m) => [m.direction, m.systemKind ?? m.autoKind, m.seq])
      ).toEqual([
        ['SYSTEM', 'TICKET_OPENED', 1],
        ['IN', null, 2],
        ['OUT', 'agent_greeting', 3],
      ])
      // Text IS stored, as a Russian fallback for browsers holding a bundle
      // older than the auto-message codes — they would otherwise render an
      // empty bubble. Newer clients ignore it and translate `autoKind`.
      expect(messages[2]!.text).toContain('Мы получили ваше сообщение')
      // Raw text, verbatim: newlines kept, markup-looking characters untouched.
      expect(messages[1]!.text).toBe(text)
      // The relay's message id is written back, which is what an inbound edit
      // later matches against.
      expect(messages[1]!.tgMessageId).toBeGreaterThan(0)

      expect(createdTopics()).toHaveBeenCalledTimes(1)
      expect(relays()).toHaveBeenCalledTimes(1)
      // Persist, bind, THEN relay — a relay against an unbound ticket would
      // silently drop the message into no topic at all.
      expect(relays().mock.calls[0]![0].ticket.tgTopicId).toBe(ticket.tgTopicId)

      // Two: the user's own echo, then the greeting.
      expect(pushes()).toHaveLength(2)
      const [pushedUserId, payload] = pushes()[0]!
      expect(pushedUserId).toBe(user.userId)
      expect(payload).toMatchObject({
        action: 'support_message',
        unread: 0,
        message: { id: messages[1]!.id, direction: 'in', seq: 2, text },
        ticket: { id: ticket.id, status: 'open' },
      })

      expect(result.message.id).toBe(messages[1]!.id)
      expect(result.ticket.id).toBe(ticket.id)
    } finally {
      await cleanupTestUser(user.userId)
    }
  })
})

describe('one open ticket per user', () => {
  it('collapses two concurrent first messages onto one ticket and one topic', async () => {
    const user = await createTestUser()
    try {
      // Both calls read "no open ticket" before either has inserted one. The
      // partial unique index `support_tickets_one_open_per_user` is what
      // rejects the loser; without it the user's thread forks into two Telegram
      // topics and support answers in the one nobody is reading.
      await Promise.all([
        userSendMessage({
          userId: user.userId,
          userNId: user.userNId,
          text: 'первое',
        }),
        userSendMessage({
          userId: user.userId,
          userNId: user.userNId,
          text: 'второе',
        }),
      ])

      const tickets = await listTickets(user.userId)
      expect(tickets).toHaveLength(1)

      const messages = await listMessages(tickets[0]!.id)
      // Exactly one opening notice — only the caller that created the row
      // writes it — and a gap-free seq despite the two racing appends.
      expect(
        messages.filter((m) => m.systemKind === 'TICKET_OPENED')
      ).toHaveLength(1)
      expect(messages.filter((m) => m.direction === 'IN')).toHaveLength(2)
      // opened, two IN, greeting
      expect(messages.map((m) => m.seq)).toEqual([1, 2, 3, 4])

      // And exactly ONE forum topic: the second caller must not create a
      // second one and overwrite the binding, stranding the first message.
      expect(createdTopics()).toHaveBeenCalledTimes(1)
      expect(relays()).toHaveBeenCalledTimes(2)
      // two echoes + one greeting (the ticket is greeted once, not per message)
      expect(pushes()).toHaveLength(3)
    } finally {
      await cleanupTestUser(user.userId)
    }
  })
})

describe('idempotency of a browser send', () => {
  it('collapses a retried requestId onto one row, one relay, one push', async () => {
    const user = await createTestUser()
    try {
      const requestId = 'a5d0f5c0-0000-4000-8000-000000000001'
      const send = () =>
        userSendMessage({
          userId: user.userId,
          userNId: user.userNId,
          text: 'двойной тап',
          requestId,
        })

      const first = await send()
      const second = await send()

      // The retry gets the SAME message back, not a second bubble.
      expect(second.message.id).toBe(first.message.id)

      const ticket = (await openTicketOf(user.userId))!
      const messages = await listMessages(ticket.id)
      expect(messages.filter((m) => m.direction === 'IN')).toHaveLength(1)
      expect(messages[1]!.dedupeKey).toBe(`web:${requestId}`)
      // The seq allocator must not burn a number on the deduped attempt.
      // opened, the single IN row, greeting — the retry adds none of them
      expect(messages.map((m) => m.seq)).toEqual([1, 2, 3])

      expect(relays()).toHaveBeenCalledTimes(1)
      // the echo plus the greeting; the retried send adds neither
      expect(pushes()).toHaveLength(2)
    } finally {
      await cleanupTestUser(user.userId)
    }
  })

  it('does not dedupe two genuinely different sends', async () => {
    const user = await createTestUser()
    try {
      await userSendMessage({
        userId: user.userId,
        userNId: user.userNId,
        text: 'раз',
        requestId: 'a5d0f5c0-0000-4000-8000-000000000002',
      })
      await userSendMessage({
        userId: user.userId,
        userNId: user.userNId,
        text: 'два',
        requestId: 'a5d0f5c0-0000-4000-8000-000000000003',
      })

      const ticket = (await openTicketOf(user.userId))!
      const messages = await listMessages(ticket.id)
      expect(messages.filter((m) => m.direction === 'IN')).toHaveLength(2)
      expect(relays()).toHaveBeenCalledTimes(2)
    } finally {
      await cleanupTestUser(user.userId)
    }
  })
})

describe('the continuous feed across tickets', () => {
  it('numbers seq per ticket and pages backwards through the whole history', async () => {
    const user = await createTestUser()
    try {
      // Ticket 1: opened, two user messages, closed.
      await userSendMessage({
        userId: user.userId,
        userNId: user.userNId,
        text: 'первый тикет, сообщение 1',
      })
      await userSendMessage({
        userId: user.userId,
        userNId: user.userNId,
        text: 'первый тикет, сообщение 2',
      })
      const first = (await openTicketOf(user.userId))!
      await closeTicketEverywhere(first.id, 'USER')

      // Ticket 2: opened by the next message, then an agent reply.
      await userSendMessage({
        userId: user.userId,
        userNId: user.userNId,
        text: 'второй тикет, сообщение 1',
      })
      const second = (await openTicketOf(user.userId))!
      await agentSendMessage({
        ticket: second,
        text: 'здравствуйте, смотрим',
        tgMessageId: 5001,
      })

      expect(second.id).not.toBe(first.id)

      // seq restarts at 1 for each ticket and has no gaps in either.
      const firstSeqs = (await listMessages(first.id)).map((m) => m.seq)
      const secondSeqs = (await listMessages(second.id)).map((m) => m.seq)
      // opened, in, greeting, in, farewell, closed
      expect(firstSeqs).toEqual([1, 2, 3, 4, 5, 6])
      // opened, in, greeting, out
      expect(secondSeqs).toEqual([1, 2, 3, 4])

      // Page backwards in threes over the 10-message feed.
      const pages: Array<Awaited<ReturnType<typeof getThread>>> = []
      let cursor: string | undefined
      do {
        const page = await getThread(user.userId, cursor, 3)
        pages.push(page)
        cursor = page.nextCursor ?? undefined
      } while (cursor)

      expect(pages).toHaveLength(4)
      expect(pages.map((p) => p.messages.length)).toEqual([3, 3, 3, 1])
      expect(pages.map((p) => p.hasMore)).toEqual([true, true, true, false])
      expect(pages[3]!.nextCursor).toBeNull()

      // Every page is oldest-first, and the pages stitched back together
      // reproduce the entire feed with no overlap and nothing missing.
      for (const page of pages) {
        const stamps = page.messages.map((m) => Date.parse(m.createdAt))
        expect([...stamps].sort((a, b) => a - b)).toEqual(stamps)
      }
      const stitched = pages
        .slice()
        .reverse()
        .flatMap((p) => p.messages)
      expect(stitched).toHaveLength(10)
      expect(new Set(stitched.map((m) => m.id)).size).toBe(10)
      // Ticket 1 in full, then ticket 2 — the separators are the system bubbles.
      expect(stitched.map((m) => m.ticketId)).toEqual([
        ...Array(6).fill(first.id),
        ...Array(4).fill(second.id),
      ])
      // Ticket 1: opened, user, greeting, user, goodbye, closed.
      // Ticket 2: opened, user, greeting, agent reply.
      expect(stitched.map((m) => m.systemKind)).toEqual([
        'ticket_opened',
        null,
        'agent_greeting',
        null,
        'agent_farewell',
        'ticket_closed',
        'ticket_opened',
        null,
        'agent_greeting',
        null,
      ])

      // The `ticket` field of every page is the currently OPEN one, whichever
      // slice of history the page happens to hold.
      for (const page of pages) expect(page.ticket?.id).toBe(second.id)
    } finally {
      await cleanupTestUser(user.userId)
    }
  })
})

describe('the unread badge', () => {
  it('counts only agent replies, spans closed tickets, and resets on read', async () => {
    const user = await createTestUser()
    try {
      await userSendMessage({
        userId: user.userId,
        userNId: user.userNId,
        text: 'первый вопрос',
      })
      const first = (await openTicketOf(user.userId))!

      // The user's own message and the opening notice raised nothing.
      expect(await unreadInDb(user.userId)).toBe(0)

      await agentSendMessage({
        ticket: first,
        text: 'ответ по первому тикету',
        tgMessageId: 6001,
      })
      expect(await unreadInDb(user.userId)).toBe(1)

      // A further user message does not clear it — only an explicit read does.
      await userSendMessage({
        userId: user.userId,
        userNId: user.userNId,
        text: 'спасибо',
      })
      expect(await unreadInDb(user.userId)).toBe(1)

      // Closing appends TWO bubbles: the grey system pill, which never touches
      // the badge, and support's goodbye, which does — unlike the greeting it
      // can arrive long after the user has left the chat, so it has to be
      // announced like any other message from support.
      await closeTicketEverywhere(first.id, 'USER')
      expect(await unreadInDb(user.userId)).toBe(2)

      // The unread reply on the CLOSED ticket still counts too, because the
      // badge is one number for one continuous feed.
      await userSendMessage({
        userId: user.userId,
        userNId: user.userNId,
        text: 'ещё вопрос',
      })
      const second = (await openTicketOf(user.userId))!
      await agentSendMessage({
        ticket: second,
        text: 'ответ по второму',
        tgMessageId: 6002,
      })
      // agent reply on ticket 1, goodbye on close, agent reply on ticket 2
      expect(await unreadInDb(user.userId)).toBe(3)
      expect((await getThread(user.userId)).unread).toBe(3)

      // The push that carried the second reply advertised the same total.
      const lastMessagePush = pushes()
        .map(([, payload]) => payload)
        .filter((p) => p.action === 'support_message')
        .at(-1)
      expect(lastMessagePush).toMatchObject({ unread: 3 })

      expect(await markRead(user.userId)).toBe(0)
      expect(await unreadInDb(user.userId)).toBe(0)
      expect((await getThread(user.userId)).unread).toBe(0)
      // Reading also tells the other tabs, so a second window drops its badge.
      expect(pushActions()).toContain('support_ticket_updated')
      expect(pushes().at(-1)![1]).toMatchObject({
        action: 'support_ticket_updated',
        unread: 0,
      })
    } finally {
      await cleanupTestUser(user.userId)
    }
  })
})
