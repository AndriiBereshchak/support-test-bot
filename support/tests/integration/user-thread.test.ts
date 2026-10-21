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
  ensureTopic,
  userSendMessage,
} from '@apps/services/chat.service'

import * as telegram from '@telegram/api'

import {
  cleanupTestUser,
  createTestUser,
  listTickets,
  openTicketOf,
} from './_helpers'

/**
 * One Telegram topic per USER, not per ticket.
 *
 * Every conversation a person has lands in the same thread, in order, so an
 * operator scrolling it sees their whole history instead of hunting through a
 * topic per ticket. The invariant lives in `support_user_threads`
 * (unique on product+user), not in application logic.
 */

const createdTopics = () => vi.mocked(telegram.createTicketTopic)

const threadOf = (userId: string) =>
  prismaSupport.supportUserThread.findUnique({
    where: { product_userId: { product: 'PLATFORM', userId } },
  })

beforeEach(() => {
  vi.clearAllMocks()
})

afterAll(async () => {
  await shutdownPrisma()
})

describe('the user’s permanent support thread', () => {
  it('reuses one topic across several tickets', async () => {
    const user = await createTestUser()
    try {
      await userSendMessage({
        userId: user.userId,
        userNId: user.userNId,
        text: 'первое обращение',
      })
      const first = (await openTicketOf(user.userId))!
      await closeTicketEverywhere(first.id, 'USER')

      await userSendMessage({
        userId: user.userId,
        userNId: user.userNId,
        text: 'второе обращение',
      })
      const second = (await openTicketOf(user.userId))!

      // Two separate conversations…
      expect(second.id).not.toBe(first.id)
      // …in ONE topic, created once.
      expect(second.tgTopicId).toBe(first.tgTopicId)
      expect(second.tgChatId).toStrictEqual(first.tgChatId)
      expect(createdTopics()).toHaveBeenCalledTimes(1)

      const thread = await threadOf(user.userId)
      expect(thread?.tgTopicId).toBe(first.tgTopicId)
    } finally {
      await cleanupTestUser(user.userId)
    }
  })

  it('hands every caller its OWN ticket, not whichever one started the topic', async () => {
    // The coalescing window is keyed by USER now, so two calls for two
    // different tickets share one creation. Returning the shared promise
    // directly handed the second caller the FIRST caller's row — status and
    // all — and a user could be pushed a CLOSED ticket, locking their own
    // composer. What is shared is the thread; the binding is per ticket.
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

      // Both unbound, so both go through the shared creation path, and both
      // rows re-read from the database — `first` in hand is a snapshot taken
      // before it was closed.
      await prismaSupport.supportTicket.updateMany({
        where: { id: { in: [first.id, second.id] } },
        data: { tgTopicId: null },
      })
      const [freshFirst, freshSecond] = await Promise.all([
        prismaSupport.supportTicket.findUniqueOrThrow({
          where: { id: first.id },
        }),
        prismaSupport.supportTicket.findUniqueOrThrow({
          where: { id: second.id },
        }),
      ])

      const [a, b] = await Promise.all([
        ensureTopic(freshSecond),
        ensureTopic(freshFirst),
      ])

      // Each got its own row back, with its own status.
      expect(a.id).toBe(second.id)
      expect(a.status).toBe('OPEN')
      expect(b.id).toBe(first.id)
      expect(b.status).toBe('CLOSED')
      // …both pointing at the one shared topic.
      expect(a.tgTopicId).toBe(b.tgTopicId)
    } finally {
      await cleanupTestUser(user.userId)
    }
  })

  it('titles the topic by who it belongs to, not by the first ticket', async () => {
    const user = await createTestUser()
    try {
      await userSendMessage({
        userId: user.userId,
        userNId: user.userNId,
        text: 'привет',
      })

      const args = createdTopics().mock.calls[0]![0]
      // The flag is what switches the name to `<nId> · <email>`; a ticket id in
      // the title would name only the first of many conversations.
      expect(args.threadTitle).toBe(true)
      expect(args.userNId).toBe(user.userNId)
    } finally {
      await cleanupTestUser(user.userId)
    }
  })

  it('does NOT archive the topic when a ticket closes', async () => {
    // Archiving is what would break the whole model: Telegram refuses ordinary
    // posts into a closed topic, so the user's next message would come back to
    // a thread nobody can answer in.
    const user = await createTestUser()
    try {
      await userSendMessage({
        userId: user.userId,
        userNId: user.userNId,
        text: 'вопрос',
      })
      const ticket = (await openTicketOf(user.userId))!

      await closeTicketEverywhere(ticket.id, 'AGENT')

      expect(vi.mocked(telegram.closeTicketTopic)).toHaveBeenCalledTimes(1)
      // Third argument = "this is a permanent thread": notice and icon yes,
      // archiving no.
      expect(vi.mocked(telegram.closeTicketTopic).mock.calls[0]![2]).toBe(true)
    } finally {
      await cleanupTestUser(user.userId)
    }
  })

  it('keeps both conversations readable in one continuous feed', async () => {
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

      const tickets = await listTickets(user.userId)
      expect(tickets).toHaveLength(2)
      // Both bound to the same topic — the shared thread — which the dropped
      // unique index used to make impossible.
      const topics = new Set(tickets.map((t) => t.tgTopicId))
      expect(topics.size).toBe(1)
    } finally {
      await cleanupTestUser(user.userId)
    }
  })
})
