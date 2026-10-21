import { randomInt } from 'node:crypto'

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Same two boundaries as the rest of the suite. What makes this file work is
// that the Telegram stub is a `vi.fn`: refusing a send is one `mockResolvedValue
// Once(null)`, which is exactly the outage this loop exists for.
vi.mock('@apps/services/push.service', () => ({
  pushToUser: vi.fn(async () => undefined),
}))
vi.mock('@telegram/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@telegram/api')>()),
  ...(await import('./_telegram-stub')).telegramStub(),
}))

import { prismaSupport, shutdownPrisma } from '@config/database'
import { RELAY_RETRY_MAX_ATTEMPTS } from '@config/env'
import { logger } from '@config/logger'

import { userSendMessage } from '@apps/services/chat.service'
import { runRelayRetryPass } from '@apps/services/relay-retry.service'

import * as telegram from '@telegram/api'

import {
  cleanupTestUser,
  createTestUser,
  listMessages,
  openTicketOf,
  reloadTicket,
} from './_helpers'
import { TEST_CHAT_ID } from './_telegram-stub'

const relays = () => vi.mocked(telegram.relayUserMessage)
const topics = () => vi.mocked(telegram.createTicketTopic)

/**
 * Relays of ONE ticket, in call order.
 *
 * Filtered rather than counted globally on purpose: the pass reads the whole
 * outbox, so a message another test (or a crashed earlier run) left unrelayed
 * would otherwise show up in these numbers.
 */
const relaysFor = (ticketId: string) =>
  relays().mock.calls.filter(([args]) => args.ticket.id === ticketId)

/**
 * Age a message past the grace period that keeps the loop off fresh sends.
 *
 * A minute, not an hour: the pass reads the outbox newest-first, so a message
 * backdated too far would sort behind whatever an earlier run left in the
 * shared test database and fall out of the batch.
 */
async function backdate(messageId: string): Promise<void> {
  await prismaSupport.supportMessage.update({
    where: { id: messageId },
    data: { createdAt: new Date(Date.now() - 60_000) },
  })
}

const reload = (messageId: string) =>
  prismaSupport.supportMessage.findUniqueOrThrow({ where: { id: messageId } })

/** The IN messages of a ticket, oldest first. */
async function incoming(ticketId: string) {
  return (await listMessages(ticketId)).filter((m) => m.direction === 'IN')
}

beforeEach(() => {
  // Call history only — the incrementing-id implementations must survive.
  vi.clearAllMocks()

  // Belt and braces on top of the stub's own randomized base. This is the one
  // suite whose pass touches EVERY unrelayed message in the database, including
  // anything a crashed earlier run left behind, so it binds topics for tickets
  // it did not create — and `(tgChatId, tgTopicId)` is unique. Drawing a fresh
  // id per CALL, rather than walking a sequence from one draw, keeps that true
  // even when the debris it adopts runs into the dozens.
  topics().mockImplementation(async () => ({
    chatId: TEST_CHAT_ID,
    topicId: randomInt(1_000, 2_000_000_000),
    infoMessageId: randomInt(1_000, 2_000_000_000),
  }))
})

afterAll(async () => {
  await shutdownPrisma()
})

describe('a message the inline relay could not deliver', () => {
  it('reaches telegram on the next pass and gets its id stamped', async () => {
    const user = await createTestUser()
    try {
      // Telegram is down for the user's send: the message persists, the HTTP
      // call still succeeds, and nothing in the support group knows about it.
      relays().mockResolvedValueOnce(null)
      await userSendMessage({
        userId: user.userId,
        userNId: user.userNId,
        text: 'не приходит депозит',
      })

      const ticket = (await openTicketOf(user.userId))!
      const [pending] = await incoming(ticket.id)
      expect(pending!.tgMessageId).toBeNull()

      await backdate(pending!.id)
      await runRelayRetryPass()

      expect(relaysFor(ticket.id)).toHaveLength(2)
      // The stamp is what makes it stop being a candidate — without it the
      // next pass would relay the same message again.
      expect((await reload(pending!.id)).tgMessageId).toBeGreaterThan(0)

      await runRelayRetryPass()
      expect(relaysFor(ticket.id)).toHaveLength(2)
    } finally {
      await cleanupTestUser(user.userId)
    }
  })

  it('leaves a fresh one alone — the inline send may still be in flight', async () => {
    const user = await createTestUser()
    try {
      relays().mockResolvedValueOnce(null)
      await userSendMessage({
        userId: user.userId,
        userNId: user.userNId,
        text: 'только что отправил',
      })

      const ticket = (await openTicketOf(user.userId))!
      const [pending] = await incoming(ticket.id)

      // Not backdated: a relay queued behind a flood wait is still running, and
      // relaying it a second time would post the user's message twice.
      await runRelayRetryPass()

      expect(relaysFor(ticket.id)).toHaveLength(1)
      expect((await reload(pending!.id)).tgMessageId).toBeNull()
    } finally {
      await cleanupTestUser(user.userId)
    }
  })
})

describe('ordering inside one ticket', () => {
  it('relays in seq order and stops at the first message that fails', async () => {
    const user = await createTestUser()
    try {
      relays().mockResolvedValueOnce(null).mockResolvedValueOnce(null)
      await userSendMessage({
        userId: user.userId,
        userNId: user.userNId,
        text: 'первое',
      })
      await userSendMessage({
        userId: user.userId,
        userNId: user.userNId,
        text: 'второе',
      })

      const ticket = (await openTicketOf(user.userId))!
      const pending = await incoming(ticket.id)
      expect(pending).toHaveLength(2)
      for (const message of pending) await backdate(message.id)

      // Telegram takes the first message of the pass and then breaks again.
      relays().mockResolvedValueOnce(null)
      await runRelayRetryPass()

      const afterFirstPass = relaysFor(ticket.id)
      // Two inline attempts plus ONE retry: the second message must not
      // overtake the first, or support reads the answer before the question.
      expect(afterFirstPass).toHaveLength(3)
      expect(afterFirstPass[2]![0].text).toBe('первое')

      await runRelayRetryPass()
      expect(
        relaysFor(ticket.id)
          .slice(3)
          .map(([args]) => args.text)
      ).toEqual(['первое', 'второе'])

      const settled = await incoming(ticket.id)
      expect(settled.map((m) => m.tgMessageId).every((id) => id! > 0)).toBe(
        true
      )
    } finally {
      await cleanupTestUser(user.userId)
    }
  })
})

describe('the attempt budget', () => {
  it('stops retrying a message telegram will never take', async () => {
    const user = await createTestUser()
    try {
      // One refusal for the inline send, then one for every retry the budget
      // allows. The pass after that must not consume another.
      for (let i = 0; i <= RELAY_RETRY_MAX_ATTEMPTS; i++) {
        relays().mockResolvedValueOnce(null)
      }

      await userSendMessage({
        userId: user.userId,
        userNId: user.userNId,
        text: 'сообщение в никуда',
      })
      const ticket = (await openTicketOf(user.userId))!
      const [pending] = await incoming(ticket.id)
      await backdate(pending!.id)

      for (let i = 0; i < RELAY_RETRY_MAX_ATTEMPTS + 2; i++) {
        await runRelayRetryPass()
      }

      // The queued refusals are exhausted, so an unbounded loop would have hit
      // the stub's default (a successful send) and stamped the row.
      expect(relaysFor(ticket.id)).toHaveLength(RELAY_RETRY_MAX_ATTEMPTS + 1)
      expect((await reload(pending!.id)).tgMessageId).toBeNull()
    } finally {
      await cleanupTestUser(user.userId)
    }
  })
})

describe('a 400-class refusal telegram will keep repeating', () => {
  it('spends the budget, escalates once, and never unbinds the topic', async () => {
    const user = await createTestUser()
    try {
      // `bot-removed` is the shape of a permanent failure this loop CANNOT
      // repair by itself (kicked from the group, write rights revoked) — unlike
      // a deleted topic, no amount of retrying and no new thread fixes it, so
      // the only correct ending is the bounded budget plus a human.
      for (let i = 0; i <= RELAY_RETRY_MAX_ATTEMPTS; i++) {
        relays().mockImplementationOnce(async (args) => {
          if (args.failure) args.failure.permanent = 'bot-removed'
          return null
        })
      }

      await userSendMessage({
        userId: user.userId,
        userNId: user.userNId,
        text: 'бот больше не в группе',
      })
      const ticket = (await openTicketOf(user.userId))!
      const [pending] = await incoming(ticket.id)
      await backdate(pending!.id)

      const escalations: string[] = []
      const errors = vi.spyOn(logger, 'error').mockImplementation(((
        message: unknown
      ) => {
        escalations.push(String(message))
        return logger
      }) as never)

      try {
        for (let i = 0; i < RELAY_RETRY_MAX_ATTEMPTS + 2; i++) {
          await runRelayRetryPass()
        }
      } finally {
        errors.mockRestore()
      }

      // Inline send + exactly the allowed retries. The queued refusals run out
      // one attempt before the passes do, so a loop that ignored the budget
      // would have hit the stub's default and stamped the row.
      expect(relaysFor(ticket.id)).toHaveLength(RELAY_RETRY_MAX_ATTEMPTS + 1)
      expect((await reload(pending!.id)).tgMessageId).toBeNull()

      // One page, not one per pass: the give-up is sticky, and an alert that
      // repeats every 30 seconds is an alert nobody reads.
      const mine = escalations.filter((line) => line.includes(pending!.id))
      expect(mine).toHaveLength(1)
      expect(mine[0]).toContain('bot-removed')

      // And the binding survives: `bot-removed` is not a deleted thread, so
      // dropping the topic would strand the whole conversation in a new one
      // the bot equally cannot write to.
      const after = await reloadTicket(ticket.id)
      expect(after.tgTopicId).toBe(ticket.tgTopicId)
      expect(after.tgInfoMessageId).toBe(ticket.tgInfoMessageId)
    } finally {
      await cleanupTestUser(user.userId)
    }
  })
})

describe('a topic an operator deleted', () => {
  it('unbinds the ticket so the next pass relays into a new topic', async () => {
    const user = await createTestUser()
    try {
      relays().mockResolvedValueOnce(null)
      await userSendMessage({
        userId: user.userId,
        userNId: user.userNId,
        text: 'а вы ещё тут?',
      })

      const ticket = (await openTicketOf(user.userId))!
      const [pending] = await incoming(ticket.id)
      await backdate(pending!.id)

      // What Telegram answers once the thread is gone.
      relays().mockImplementationOnce(async (args) => {
        if (args.failure) args.failure.permanent = 'topic-missing'
        return null
      })
      await runRelayRetryPass()

      const unbound = await reloadTicket(ticket.id)
      expect(unbound.tgTopicId).toBeNull()
      // The pinned card lived in the deleted thread; keeping its id would make
      // every later info-card refresh fail.
      expect(unbound.tgInfoMessageId).toBeNull()
      expect((await reload(pending!.id)).tgMessageId).toBeNull()

      await runRelayRetryPass()

      const rebound = await reloadTicket(ticket.id)
      expect(topics()).toHaveBeenCalledTimes(2)
      expect(rebound.tgTopicId).toBeGreaterThan(0)
      expect(rebound.tgTopicId).not.toBe(ticket.tgTopicId)
      // And the message the operator never saw is in the new thread.
      expect((await reload(pending!.id)).tgMessageId).toBeGreaterThan(0)
    } finally {
      await cleanupTestUser(user.userId)
    }
  })
})
