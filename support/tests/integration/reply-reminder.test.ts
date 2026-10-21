import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@apps/services/push.service', () => ({
  pushToUser: vi.fn(async () => undefined),
}))
vi.mock('@telegram/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@telegram/api')>()),
  ...(await import('./_telegram-stub')).telegramStub(),
}))

import { prismaSupport, shutdownPrisma } from '@config/database'
import { REPLY_REMINDER_MINUTES } from '@config/env'
import { closeRedis } from '@config/redis'

import { agentSendMessage, userSendMessage } from '@apps/services/chat.service'
import { runReplyReminderPass } from '@apps/services/reply-reminder.service'

import * as telegram from '@telegram/api'

import { cleanupTestUser, createTestUser, openTicketOf } from './_helpers'

/**
 * The nudge for a ticket nobody has answered.
 *
 * Every case here backdates the clock in the database rather than waiting, and
 * asserts on TELEGRAM only — this message must never reach the user's feed,
 * since telling somebody "nobody has answered you" is the opposite of helpful.
 */

const sentPlain = () => vi.mocked(telegram.sendPlainMessage)

/** Push the whole ticket far enough into the past to cross the threshold. */
async function ageTicket(ticketId: string): Promise<void> {
  const past = new Date(Date.now() - (REPLY_REMINDER_MINUTES + 5) * 60_000)
  await prismaSupport.supportTicket.update({
    where: { id: ticketId },
    data: { lastMessageAt: past },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterAll(async () => {
  await shutdownPrisma()
  await closeRedis()
})

describe('a user message nobody has answered', () => {
  it('nudges the topic once, and only once', async () => {
    const user = await createTestUser()
    try {
      await userSendMessage({
        userId: user.userId,
        userNId: user.userNId,
        text: 'Здравствуйте, где мой депозит?',
      })
      const ticket = (await openTicketOf(user.userId))!
      await ageTicket(ticket.id)
      vi.clearAllMocks()

      await runReplyReminderPass()

      expect(sentPlain()).toHaveBeenCalledTimes(1)
      const call = sentPlain().mock.calls[0]![0]
      expect(call.topicId).toBe(ticket.tgTopicId)
      expect(call.text).toContain(String(REPLY_REMINDER_MINUTES))

      // The claim is keyed by the MESSAGE, so however often the loop runs, one
      // silence produces one line. Without this the topic would collect a nudge
      // every two minutes until somebody replied.
      await runReplyReminderPass()
      expect(sentPlain()).toHaveBeenCalledTimes(1)
    } finally {
      await cleanupTestUser(user.userId)
    }
  })

  it('writes nothing into the user-facing thread', async () => {
    const user = await createTestUser()
    try {
      await userSendMessage({
        userId: user.userId,
        userNId: user.userNId,
        text: 'ау',
      })
      const ticket = (await openTicketOf(user.userId))!
      await ageTicket(ticket.id)

      const before = await prismaSupport.supportMessage.count({
        where: { ticketId: ticket.id },
      })
      await runReplyReminderPass()

      expect(
        await prismaSupport.supportMessage.count({
          where: { ticketId: ticket.id },
        })
      ).toBe(before)
    } finally {
      await cleanupTestUser(user.userId)
    }
  })
})

describe('a ticket that is not actually waiting', () => {
  it('stays quiet once an agent has replied', async () => {
    const user = await createTestUser()
    try {
      await userSendMessage({
        userId: user.userId,
        userNId: user.userNId,
        text: 'вопрос',
      })
      const ticket = (await openTicketOf(user.userId))!
      await agentSendMessage({ ticket, tgMessageId: 8001, text: 'отвечаю' })
      // `lastMessageAt` is old for BOTH kinds of message, which is exactly why
      // the pass looks at the direction of the last one instead of trusting the
      // timestamp alone.
      await ageTicket(ticket.id)
      vi.clearAllMocks()

      await runReplyReminderPass()

      expect(sentPlain()).not.toHaveBeenCalled()
    } finally {
      await cleanupTestUser(user.userId)
    }
  })

  it('stays quiet while the wait is still under the threshold', async () => {
    const user = await createTestUser()
    try {
      await userSendMessage({
        userId: user.userId,
        userNId: user.userNId,
        text: 'только что написал',
      })
      vi.clearAllMocks()

      await runReplyReminderPass()

      expect(sentPlain()).not.toHaveBeenCalled()
    } finally {
      await cleanupTestUser(user.userId)
    }
  })
})
