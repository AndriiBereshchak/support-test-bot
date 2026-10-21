import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@apps/services/push.service', () => ({
  pushToUser: vi.fn(async () => undefined),
}))
vi.mock('@telegram/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@telegram/api')>()),
  ...(await import('./_telegram-stub')).telegramStub(),
}))

import { prismaSupport, shutdownPrisma } from '@config/database'

import {
  closeTicketEverywhere,
  userSendMessage,
} from '@apps/services/chat.service'
import { findTicketByTopic } from '@apps/services/ticket.service'

import * as telegram from '@telegram/api'

import { cleanupTestUser, createTestUser, openTicketOf } from './_helpers'

/**
 * The deploy scenario, which no unit test would otherwise cover: production
 * already holds tickets bound to their OWN per-ticket topics, created before
 * the permanent-thread model existed. Nothing was migrated, on purpose.
 *
 * What must hold afterwards:
 *   • a legacy ticket keeps working in the topic it was opened in;
 *   • the NEXT conversation starts the user's permanent thread;
 *   • both topics still resolve to the right ticket from Telegram's side.
 */

const createdTopics = () => vi.mocked(telegram.createTicketTopic)

beforeEach(() => {
  vi.clearAllMocks()
})

afterAll(async () => {
  await shutdownPrisma()
})

describe('a user who already had tickets before the thread model', () => {
  it('leaves the legacy topic alone and opens a permanent one for what follows', async () => {
    const user = await createTestUser()
    try {
      // A ticket exactly as the old code left it: bound to its own topic, with
      // no row in `support_user_threads`.
      const legacy = await prismaSupport.supportTicket.create({
        data: {
          userId: user.userId,
          userNId: user.userNId,
          product: 'PLATFORM',
          status: 'OPEN',
          tgChatId: BigInt(-1001234567890),
          tgTopicId: 424242,
        },
      })

      // Telegram can still find it — `/close`, `/del` and edits depend on this.
      const resolved = await findTicketByTopic(-1001234567890, 424242)
      expect(resolved?.id).toBe(legacy.id)

      // The user writes into that same live conversation: no new topic, no
      // thread invented behind their back.
      await userSendMessage({
        userId: user.userId,
        userNId: user.userNId,
        text: 'продолжаю старое обращение',
      })
      expect(createdTopics()).not.toHaveBeenCalled()

      const stillLegacy = (await openTicketOf(user.userId))!
      expect(stillLegacy.id).toBe(legacy.id)
      expect(stillLegacy.tgTopicId).toBe(424242)

      // Now that conversation ends and a new one begins — THIS is where the
      // permanent thread starts.
      await closeTicketEverywhere(legacy.id, 'AGENT')
      await userSendMessage({
        userId: user.userId,
        userNId: user.userNId,
        text: 'новое обращение',
      })

      const fresh = (await openTicketOf(user.userId))!
      expect(fresh.id).not.toBe(legacy.id)
      expect(createdTopics()).toHaveBeenCalledTimes(1)
      expect(createdTopics().mock.calls[0]![0].threadTitle).toBe(true)
      // A different topic from the legacy one, and recorded as the thread.
      expect(fresh.tgTopicId).not.toBe(424242)

      const thread = await prismaSupport.supportUserThread.findUnique({
        where: {
          product_userId: { product: 'PLATFORM', userId: user.userId },
        },
      })
      expect(thread?.tgTopicId).toBe(fresh.tgTopicId)

      // Both topics keep resolving — the old one to the closed ticket, the new
      // one to the live one. An operator answering in either reaches the right
      // conversation.
      expect((await findTicketByTopic(-1001234567890, 424242))?.id).toBe(
        legacy.id
      )
      expect(
        (await findTicketByTopic(Number(fresh.tgChatId), fresh.tgTopicId!))?.id
      ).toBe(fresh.id)
    } finally {
      await cleanupTestUser(user.userId)
    }
  })

  it('resolves a shared topic to the OPEN ticket, not an older closed one', async () => {
    // The ordering rule the whole operator toolchain rests on: a reply typed in
    // the thread must reach the live conversation, not the one that ended.
    const user = await createTestUser()
    try {
      await userSendMessage({
        userId: user.userId,
        userNId: user.userNId,
        text: 'первое',
      })
      const first = (await openTicketOf(user.userId))!
      await closeTicketEverywhere(first.id, 'USER')

      await userSendMessage({
        userId: user.userId,
        userNId: user.userNId,
        text: 'второе',
      })
      const second = (await openTicketOf(user.userId))!

      const resolved = await findTicketByTopic(
        Number(second.tgChatId),
        second.tgTopicId!
      )
      expect(resolved?.id).toBe(second.id)

      // And once everything is closed, it falls back to the most recent one so
      // `/del` and edits still work on a finished thread.
      await closeTicketEverywhere(second.id, 'AGENT')
      const afterAllClosed = await findTicketByTopic(
        Number(second.tgChatId),
        second.tgTopicId!
      )
      expect(afterAllClosed?.id).toBe(second.id)
    } finally {
      await cleanupTestUser(user.userId)
    }
  })
})
