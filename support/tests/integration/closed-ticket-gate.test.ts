import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

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
  userSendMessage,
} from '@apps/services/chat.service'
import { pushToUser } from '@apps/services/push.service'

import {
  cleanupTestUser,
  createTestUser,
  listMessages,
  openTicketOf,
  unreadInDb,
} from './_helpers'

/**
 * A reply written into a CLOSED ticket's topic must never reach the user.
 *
 * Telegram lets a group admin post into an ARCHIVED forum topic, and that post
 * arrives over the webhook looking exactly like a live reply. Nothing on the
 * path checked the ticket status, so the bubble appeared in the user's feed
 * next to a disabled composer — visible, unanswerable — and `appendMessage`
 * raised `unreadForUser` on a conversation that was over.
 */

const pushes = () => vi.mocked(pushToUser).mock.calls

beforeEach(() => {
  vi.clearAllMocks()
})

afterAll(async () => {
  await shutdownPrisma()
})

describe('support — an agent reply into a closed ticket is not delivered', () => {
  it('is refused, leaves no message row and no push', async () => {
    const user = await createTestUser()
    try {
      await userSendMessage({
        userId: user.userId,
        userNId: user.userNId,
        text: 'первый вопрос',
      })
      const ticket = (await openTicketOf(user.userId))!

      await closeTicketEverywhere(ticket.id, 'USER')

      const before = await listMessages(ticket.id)
      const unreadBefore = await unreadInDb(user.userId)
      vi.clearAllMocks()

      const result = await agentSendMessage({
        ticket,
        text: 'дописываю в закрытую ветку',
        tgMessageId: 9001,
      })

      // The caller uses this to warn the agent back in the topic — silence
      // would leave them believing Telegram had delivered it.
      expect(result).toBe('closed')

      // Nothing was written and nothing was sent.
      const after = await listMessages(ticket.id)
      expect(after).toHaveLength(before.length)
      expect(pushes()).toHaveLength(0)

      // …and the badge did not move on a conversation that is over.
      expect(await unreadInDb(user.userId)).toBe(unreadBefore)
    } finally {
      await cleanupTestUser(user.userId)
    }
  })

  it('the same reply is delivered once the user reopens the conversation', async () => {
    const user = await createTestUser()
    try {
      await userSendMessage({
        userId: user.userId,
        userNId: user.userNId,
        text: 'первый вопрос',
      })
      const first = (await openTicketOf(user.userId))!
      await closeTicketEverywhere(first.id, 'USER')

      expect(
        await agentSendMessage({
          ticket: first,
          text: 'ответ в закрытую',
          tgMessageId: 9101,
        })
      ).toBe('closed')

      // The user writes again — a new ticket opens, and support can reach them.
      await userSendMessage({
        userId: user.userId,
        userNId: user.userNId,
        text: 'ещё вопрос',
      })
      const second = (await openTicketOf(user.userId))!
      expect(second.id).not.toBe(first.id)

      const delivered = await agentSendMessage({
        ticket: second,
        text: 'теперь отвечаю',
        tgMessageId: 9102,
      })
      expect(delivered).not.toBe('closed')
      expect(delivered).not.toBeNull()
    } finally {
      await cleanupTestUser(user.userId)
    }
  })

  it('a close landing mid-flight still blocks the append', async () => {
    // The guard is folded into the same locked UPDATE that allocates `seq`, so
    // there is no read-then-write window for `/close` to slip through. Fired
    // together rather than in sequence: whichever order Postgres settles on,
    // the two must not BOTH succeed.
    const user = await createTestUser()
    try {
      await userSendMessage({
        userId: user.userId,
        userNId: user.userNId,
        text: 'вопрос',
      })
      const ticket = (await openTicketOf(user.userId))!

      const [, sent] = await Promise.all([
        closeTicketEverywhere(ticket.id, 'AGENT'),
        agentSendMessage({
          ticket,
          text: 'гонка',
          tgMessageId: 9301,
        }),
      ])

      // Order-independent invariant — either outcome is legitimate, but the
      // answer the agent gets and the row in the database must agree. The bug
      // this guards against is "refused, yet stored" (and its mirror): a reply
      // the agent believes was delivered while it sits on a closed ticket
      // raising the user's unread badge.
      const delivered = (await listMessages(ticket.id)).some(
        (m) => m.text === 'гонка'
      )
      expect(delivered).toBe(sent !== 'closed')
    } finally {
      await cleanupTestUser(user.userId)
    }
  })

  it('a stale ticket object cannot smuggle a message past the gate', async () => {
    // The relay hands `agentSendMessage` a ticket read before the album
    // debounce and the file downloads — by delivery time it can be minutes old,
    // which is exactly long enough for `/close` to have run.
    const user = await createTestUser()
    try {
      await userSendMessage({
        userId: user.userId,
        userNId: user.userNId,
        text: 'вопрос',
      })
      const stale = (await openTicketOf(user.userId))!
      expect(stale.status).toBe('OPEN')

      await closeTicketEverywhere(stale.id, 'AGENT')

      // Same object, still claiming OPEN — the gate re-reads the row.
      expect(
        await agentSendMessage({
          ticket: stale,
          text: 'проскочит?',
          tgMessageId: 9201,
        })
      ).toBe('closed')
    } finally {
      await cleanupTestUser(user.userId)
    }
  })
})
