import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@apps/services/push.service', () => ({
  pushToUser: vi.fn(async () => undefined),
}))
vi.mock('@telegram/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@telegram/api')>()),
  ...(await import('./_telegram-stub')).telegramStub(),
}))

import { prismaSupport, shutdownPrisma } from '@config/database'
import { TICKET_IDLE_CLOSE_HOURS } from '@config/env'
import { closeRedis, redisClient, supportKey } from '@config/redis'

import {
  closeTicketEverywhere,
  userSendMessage,
} from '@apps/services/chat.service'
import { pushToUser } from '@apps/services/push.service'
import { startInactivitySweeper } from '@apps/services/sweeper.service'

import * as telegram from '@telegram/api'
import { handleUpdate } from '@telegram/updates'

import {
  cleanupTestUser,
  createTestUser,
  listMessages,
  openTicketOf,
  reloadTicket,
  waitFor,
} from './_helpers'
import { agentMessageUpdate } from './_telegram-stub'

const pushes = () => vi.mocked(pushToUser).mock.calls
const closedTopics = () => vi.mocked(telegram.closeTicketTopic)

const SWEEPER_LOCK = supportKey('sweeper:lock')
const HOUR_MS = 3_600_000

beforeEach(() => {
  vi.clearAllMocks()
})

afterAll(async () => {
  await closeRedis()
  await shutdownPrisma()
})

/** How many TICKET_CLOSED bubbles a ticket carries. Must never exceed one. */
async function closedBubbles(ticketId: string): Promise<number> {
  return prismaSupport.supportMessage.count({
    where: { ticketId, systemKind: 'TICKET_CLOSED' },
  })
}

async function openTicketFor(user: { userId: string; userNId: number }) {
  await userSendMessage({
    userId: user.userId,
    userNId: user.userNId,
    text: 'нужна помощь',
  })
  return (await openTicketOf(user.userId))!
}

describe('the user closing their own ticket', () => {
  it('closes once, appends one bubble, and is idempotent when repeated', async () => {
    const user = await createTestUser()
    try {
      const ticket = await openTicketFor(user)
      vi.clearAllMocks()

      const closed = await closeTicketEverywhere(ticket.id, 'USER')
      expect(closed.status).toBe('closed')

      const row = await reloadTicket(ticket.id)
      expect(row.status).toBe('CLOSED')
      expect(row.closedBy).toBe('USER')
      expect(row.closedAt).not.toBeNull()
      expect(await closedBubbles(ticket.id)).toBe(1)

      // Both halves of the settle: the bubble the user sees, then the ticket
      // state their other tabs need, then the topic archived in Telegram.
      // Support's goodbye, then the grey separator, then the ticket state.
      expect(pushes().map(([, p]) => p.action)).toEqual([
        'support_message',
        'support_message',
        'support_ticket_updated',
      ])
      expect(closedTopics()).toHaveBeenCalledTimes(1)
      expect(closedTopics().mock.calls[0]![1]).toBe('USER')

      // A double-click on the close button, or the sweeper racing the user.
      vi.clearAllMocks()
      const again = await closeTicketEverywhere(ticket.id, 'USER')
      expect(again.status).toBe('closed')
      expect(await closedBubbles(ticket.id)).toBe(1)
      expect(pushes()).toHaveLength(0)
      expect(closedTopics()).not.toHaveBeenCalled()

      // Closing frees the user to open a fresh ticket, and that one is new.
      await userSendMessage({
        userId: user.userId,
        userNId: user.userNId,
        text: 'ещё вопрос',
      })
      const next = (await openTicketOf(user.userId))!
      expect(next.id).not.toBe(ticket.id)
    } finally {
      await cleanupTestUser(user.userId)
    }
  })
})

describe('an operator typing /close in the topic', () => {
  it('closes the ticket the topic belongs to, exactly once', async () => {
    const user = await createTestUser()
    try {
      const ticket = await openTicketFor(user)
      vi.clearAllMocks()

      const close = () =>
        handleUpdate(
          agentMessageUpdate({
            topicId: ticket.tgTopicId!,
            messageId: 8001,
            fromId: 778001,
            text: '/close',
          })
        )

      await close()

      const row = await reloadTicket(ticket.id)
      expect(row.status).toBe('CLOSED')
      expect(row.closedBy).toBe('AGENT')
      expect(await closedBubbles(ticket.id)).toBe(1)
      expect(closedTopics().mock.calls[0]![1]).toBe('AGENT')
      // The command itself must not be relayed to the user as a message.
      const outs = (await listMessages(ticket.id)).filter(
        (m) => m.direction === 'OUT'
      )
      // The only OUT rows are support's automatic greeting and goodbye —
      // `/close` itself must never relay the command text to the user.
      expect(outs.map((m) => m.autoKind)).toEqual([
        'agent_greeting',
        'agent_farewell',
      ])
      // Both carry the Russian fallback text next to their code.
      expect(outs.every((m) => (m.text ?? '').length > 0)).toBe(true)

      // The redelivery / second /close: answered in the topic, nothing else.
      vi.clearAllMocks()
      await handleUpdate(
        agentMessageUpdate({
          topicId: ticket.tgTopicId!,
          messageId: 8002,
          fromId: 778001,
          text: '/close',
        })
      )
      expect(await closedBubbles(ticket.id)).toBe(1)
      expect(closedTopics()).not.toHaveBeenCalled()
      expect(pushes()).toHaveLength(0)
      expect(
        vi.mocked(telegram.sendPlainMessage).mock.calls[0]![0].text
      ).toContain('уже закрыт')
    } finally {
      await cleanupTestUser(user.userId)
    }
  })
})

describe('the inactivity sweeper', () => {
  it('closes idle tickets as SYSTEM and leaves active ones alone', async () => {
    const idle = await createTestUser()
    const stalled = await createTestUser()
    const active = await createTestUser()
    let stop: (() => void) | null = null
    try {
      const idleTicket = await openTicketFor(idle)
      const activeTicket = await openTicketFor(active)

      // Idle past the threshold.
      await prismaSupport.supportTicket.update({
        where: { id: idleTicket.id },
        data: {
          lastMessageAt: new Date(
            Date.now() - (TICKET_IDLE_CLOSE_HOURS + 24) * HOUR_MS
          ),
        },
      })

      // The other half of the sweep predicate: a ticket whose creation crashed
      // between the row insert and its first message has lastMessageAt = NULL,
      // and a plain `lt` never matches NULL — it would stay open forever and,
      // being the user's one allowed open ticket, block every future one.
      const stalledTicket = await prismaSupport.supportTicket.create({
        data: {
          userId: stalled.userId,
          userNId: stalled.userNId,
          status: 'OPEN',
          createdAt: new Date(
            Date.now() - (TICKET_IDLE_CLOSE_HOURS + 24) * HOUR_MS
          ),
        },
      })

      // A stale lock from an earlier run would make the pass a silent no-op.
      await redisClient.del(SWEEPER_LOCK)
      vi.clearAllMocks()

      stop = startInactivitySweeper()
      await waitFor(
        'the sweeper to close both idle tickets',
        async () =>
          (await reloadTicket(idleTicket.id)).status === 'CLOSED' &&
          (await reloadTicket(stalledTicket.id)).status === 'CLOSED'
      )

      for (const id of [idleTicket.id, stalledTicket.id]) {
        const row = await reloadTicket(id)
        expect(row.closedBy).toBe('SYSTEM')
        expect(await closedBubbles(id)).toBe(1)
      }
      // Asserted as a superset, not an exact list: the sweep is global, so a
      // ticket left behind by an earlier crashed run may ride along.
      expect(closedTopics().mock.calls.map((c) => c[0].id)).toEqual(
        expect.arrayContaining([idleTicket.id, stalledTicket.id])
      )
      expect(closedTopics().mock.calls.every((c) => c[1] === 'SYSTEM')).toBe(
        true
      )

      // The ticket touched a moment ago is untouched.
      expect((await reloadTicket(activeTicket.id)).status).toBe('OPEN')
      expect(await closedBubbles(activeTicket.id)).toBe(0)

      // Re-running the pass is a no-op — the same idempotent close every other
      // entry point relies on.
      vi.clearAllMocks()
      await redisClient.del(SWEEPER_LOCK)
      const secondStop = startInactivitySweeper()
      await waitFor(
        'the second pass to take the lock',
        async () => (await redisClient.get(SWEEPER_LOCK)) !== null
      )
      secondStop()
      expect(await closedBubbles(idleTicket.id)).toBe(1)
      expect(await closedBubbles(stalledTicket.id)).toBe(1)
    } finally {
      stop?.()
      await redisClient.del(SWEEPER_LOCK).catch(() => undefined)
      await cleanupTestUser(idle.userId)
      await cleanupTestUser(stalled.userId)
      await cleanupTestUser(active.userId)
    }
  })

  it('holds a Redis lock so two replicas never sweep the same batch', async () => {
    await redisClient.del(SWEEPER_LOCK)
    const first = startInactivitySweeper()
    try {
      await waitFor(
        'the first pass to take the lock',
        async () => (await redisClient.get(SWEEPER_LOCK)) !== null
      )
      // A sibling replica starting inside the TTL must find the lock taken.
      const taken = await redisClient.set(
        SWEEPER_LOCK,
        'other-replica',
        'EX',
        60,
        'NX'
      )
      expect(taken).toBeNull()
    } finally {
      first()
      await redisClient.del(SWEEPER_LOCK).catch(() => undefined)
    }
  })
})
