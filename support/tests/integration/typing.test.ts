import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Same two boundaries the rest of the integration suite replaces. Redis is
// NOT mocked — the throttle is the thing under test, and a fake claim would
// prove nothing about the multi-replica behaviour it exists for.
vi.mock('@apps/services/push.service', () => ({
  pushToUser: vi.fn(async () => undefined),
}))
vi.mock('@telegram/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@telegram/api')>()),
  ...(await import('./_telegram-stub')).telegramStub(),
}))

import { shutdownPrisma } from '@config/database'
import { closeRedis, redisClient, supportKey } from '@config/redis'

import { userSendMessage, userTyping } from '@apps/services/chat.service'
import { ensureOpenTicket } from '@apps/services/ticket.service'

import * as telegram from '@telegram/api'

import {
  cleanupTestUser,
  createTestUser,
  listTickets,
  openTicketOf,
} from './_helpers'
import { TEST_CHAT_ID } from './_telegram-stub'

const typings = () => vi.mocked(telegram.sendTypingToTopic)
const throttleKey = (ticketId: string): string =>
  supportKey(`typing:${ticketId}`)

beforeEach(() => {
  vi.clearAllMocks()
})

afterAll(async () => {
  await closeRedis()
  await shutdownPrisma()
})

describe('the typing indicator', () => {
  it('sends once per window and swallows everything typed inside it', async () => {
    const user = await createTestUser()
    let ticketId: string | null = null
    try {
      // A real message first: that is what opens the ticket and binds the
      // topic, and typing only ever mirrors into a topic that already exists.
      await userSendMessage({
        userId: user.userId,
        userNId: user.userNId,
        text: 'Здравствуйте, есть вопрос по выводу',
      })
      const ticket = await openTicketOf(user.userId)
      expect(ticket).not.toBeNull()
      ticketId = ticket!.id
      vi.clearAllMocks()

      await userTyping(user.userId)
      // Four more keystrokes' worth. The FE debounce is deliberately not
      // simulated: the point is that the server holds even when the client
      // sends one of these per character.
      await userTyping(user.userId)
      await userTyping(user.userId)
      await userTyping(user.userId)
      await userTyping(user.userId)

      expect(typings()).toHaveBeenCalledTimes(1)
      expect(typings().mock.calls[0]).toEqual([TEST_CHAT_ID, ticket!.tgTopicId])

      // The window is a Redis claim, so it survives a replica restart — and it
      // must expire on its own rather than needing anyone to clear it.
      const ttl = await redisClient.ttl(throttleKey(ticketId))
      expect(ttl).toBeGreaterThan(0)
      expect(ttl).toBeLessThanOrEqual(4)

      // Expiry, without spending four seconds of suite time on it: dropping
      // the claim is exactly what the TTL does, and the next call goes out.
      await redisClient.del(throttleKey(ticketId))
      await userTyping(user.userId)
      expect(typings()).toHaveBeenCalledTimes(2)
    } finally {
      if (ticketId) await redisClient.del(throttleKey(ticketId))
      await cleanupTestUser(user.userId)
    }
  })

  it('stays silent — and creates nothing — for a user with no ticket', async () => {
    const user = await createTestUser()
    try {
      await userTyping(user.userId)

      expect(typings()).not.toHaveBeenCalled()
      // The load-bearing half: a ticket conjured by a keystroke would post an
      // empty topic into the support group for every idle input focus.
      expect(await listTickets(user.userId)).toHaveLength(0)
      expect(vi.mocked(telegram.createTicketTopic)).not.toHaveBeenCalled()
    } finally {
      await cleanupTestUser(user.userId)
    }
  })

  it('stays silent for an open ticket Telegram has not seen yet', async () => {
    const user = await createTestUser()
    try {
      // A ticket whose topic creation failed (Telegram down at the time) is
      // exactly this shape: OPEN, but unbound until the next real message.
      const { ticket } = await ensureOpenTicket({
        userId: user.userId,
        userNId: user.userNId,
      })
      expect(ticket.tgTopicId).toBeNull()

      await userTyping(user.userId)

      expect(typings()).not.toHaveBeenCalled()
      // And no topic was created to have somewhere to type into.
      expect(vi.mocked(telegram.createTicketTopic)).not.toHaveBeenCalled()
      // The claim is never spent on a call that had nowhere to go.
      expect(await redisClient.exists(throttleKey(ticket.id))).toBe(0)
    } finally {
      await cleanupTestUser(user.userId)
    }
  })
})
