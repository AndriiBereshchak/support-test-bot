// Rating support's work after the conversation is closed.
//
// What matters here:
//   • a rating can only be given for YOUR OWN and only for a CLOSED
//     conversation
//   • a repeat submission overwrites nothing and does not duplicate the
//     notification
//   • the invitation to rate arrives once and disappears after the answer
//   • old conversations do not pop up — nobody is going to rate a week-old
//     conversation, and the window would just be annoying
//   • going to Trustpilot sets VIP and does not move the date on a repeat click
//
// Requires the infrastructure to be up:
//   yarn test:infra:up && yarn test:wait && yarn test:migrate

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@apps/services/push.service', () => ({
  pushToUser: vi.fn(async () => undefined),
}))
vi.mock('@telegram/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@telegram/api')>()),
  ...(await import('./_telegram-stub')).telegramStub(),
}))

import { prismaExchange, prismaSupport, shutdownPrisma } from '@config/database'
import { closeRedis } from '@config/redis'

import {
  closeTicketEverywhere,
  userSendMessage,
} from '@apps/services/chat.service'
import {
  markTrustpilotClick,
  submitFeedback,
} from '@apps/services/feedback.service'
import { muteUser } from '@apps/services/mute.service'
import { getThread } from '@apps/services/ticket.service'

import * as telegram from '@telegram/api'

import { cleanupTestUser, createTestUser, openTicketOf } from './_helpers'

const sent = () => vi.mocked(telegram.sendToTopic)
const DAY = 24 * 3_600_000

/** A user with one closed conversation. */
async function closedTicketOf(userId: string, userNId: number) {
  await userSendMessage({ userId, userNId, text: 'Не приходит депозит' })
  const open = await openTicketOf(userId)
  if (!open) throw new Error('тикет не создался')
  await closeTicketEverywhere(open.id, 'AGENT')
  return open
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterAll(async () => {
  await Promise.allSettled([shutdownPrisma(), closeRedis()])
})

describe('support feedback rating', () => {
  it('after the close the thread offers a rating, after the answer it stops', async () => {
    const user = await createTestUser()
    try {
      const ticket = await closedTicketOf(user.userId, user.userNId)

      const before = await getThread(user.userId)
      expect(before.pendingFeedback?.ticketId).toBe(ticket.id)

      await submitFeedback({
        userId: user.userId,
        ticketId: ticket.id,
        rating: 5,
      })

      const after = await getThread(user.userId)
      // Asking a second time is not allowed: the user has already answered.
      expect(after.pendingFeedback).toBeNull()
    } finally {
      await cleanupTestUser(user.userId)
    }
  })

  it('the rating and the comment are stored and reach the operator', async () => {
    const user = await createTestUser()
    try {
      const ticket = await closedTicketOf(user.userId, user.userNId)

      const dto = await submitFeedback({
        userId: user.userId,
        ticketId: ticket.id,
        rating: 2,
        comment: '  Долго отвечали  ',
      })

      expect(dto.rating).toBe(2)
      const row = await prismaSupport.supportTicket.findUniqueOrThrow({
        where: { id: ticket.id },
      })
      expect(row.rating).toBe(2)
      // Edge whitespace is trimmed: this is human input, not data.
      expect(row.ratingComment).toBe('Долго отвечали')
      expect(row.ratedAt).not.toBeNull()

      // Feedback is useless if it only sits in the database.
      const message = sent().mock.calls.at(-1)?.[0]
      expect(message?.text).toContain('Оценка поддержки: 2/5')
      expect(message?.text).toContain('Долго отвечали')
    } finally {
      await cleanupTestUser(user.userId)
    }
  })

  it('a repeat submission does not overwrite the rating and does not send a second message', async () => {
    const user = await createTestUser()
    try {
      const ticket = await closedTicketOf(user.userId, user.userNId)
      await submitFeedback({
        userId: user.userId,
        ticketId: ticket.id,
        rating: 5,
      })
      const callsAfterFirst = sent().mock.calls.length

      // A second browser with the same window open.
      const again = await submitFeedback({
        userId: user.userId,
        ticketId: ticket.id,
        rating: 1,
      })

      expect(again.rating).toBe(5)
      expect(sent().mock.calls.length).toBe(callsAfterFirst)
    } finally {
      await cleanupTestUser(user.userId)
    }
  })

  it('the comment can be sent afterwards in a second request, and the rating does not change', async () => {
    const user = await createTestUser()
    try {
      const ticket = await closedTicketOf(user.userId, user.userNId)
      // The window sends the rating immediately on the star click — otherwise
      // closing the window would lose a choice that has already been made. The
      // comment follows after it.
      await submitFeedback({
        userId: user.userId,
        ticketId: ticket.id,
        rating: 3,
      })

      await submitFeedback({
        userId: user.userId,
        ticketId: ticket.id,
        // A second tab may send a different rating — it must not override the
        // first one.
        rating: 1,
        comment: 'Пришлось объяснять дважды',
      })

      const row = await prismaSupport.supportTicket.findUniqueOrThrow({
        where: { id: ticket.id },
      })
      expect(row.rating).toBe(3)
      expect(row.ratingComment).toBe('Пришлось объяснять дважды')

      // A second comment no longer overwrites the first one.
      await submitFeedback({
        userId: user.userId,
        ticketId: ticket.id,
        rating: 3,
        comment: 'Передумал',
      })
      const again = await prismaSupport.supportTicket.findUniqueOrThrow({
        where: { id: ticket.id },
      })
      expect(again.ratingComment).toBe('Пришлось объяснять дважды')
    } finally {
      await cleanupTestUser(user.userId)
    }
  })

  it('a banned user cannot submit a rating with a comment', async () => {
    const user = await createTestUser()
    try {
      const ticket = await closedTicketOf(user.userId, user.userNId)
      await muteUser({ userId: user.userId, userNId: user.userNId, ms: DAY })

      // A comment on a rating is the same 2000 characters of free text into
      // the operator's topic that the user was banned for in the first place.
      await expect(
        submitFeedback({
          userId: user.userId,
          ticketId: ticket.id,
          rating: 1,
          comment: 'всё ещё пишу',
        })
      ).rejects.toThrow()

      const row = await prismaSupport.supportTicket.findUniqueOrThrow({
        where: { id: ticket.id },
      })
      expect(row.rating).toBeNull()
    } finally {
      await cleanupTestUser(user.userId)
    }
  })

  it('a long-closed conversation cannot be rated, not merely is not offered', async () => {
    const user = await createTestUser()
    try {
      const ticket = await closedTicketOf(user.userId, user.userNId)
      await prismaSupport.supportTicket.update({
        where: { id: ticket.id },
        data: { closedAt: new Date(Date.now() - 72 * 3_600_000) },
      })

      // The window lives on the server, not only in the hint given to the
      // client: otherwise a direct request could rate any conversation in the
      // whole history.
      await expect(
        submitFeedback({ userId: user.userId, ticketId: ticket.id, rating: 5 })
      ).rejects.toThrow()
    } finally {
      await cleanupTestUser(user.userId)
    }
  })

  it('another user conversation cannot be rated and is indistinguishable from a nonexistent one', async () => {
    const owner = await createTestUser()
    const other = await createTestUser()
    try {
      const ticket = await closedTicketOf(owner.userId, owner.userNId)

      await expect(
        submitFeedback({
          userId: other.userId,
          ticketId: ticket.id,
          rating: 5,
        })
      ).rejects.toThrow()

      const row = await prismaSupport.supportTicket.findUniqueOrThrow({
        where: { id: ticket.id },
      })
      expect(row.rating).toBeNull()
    } finally {
      await cleanupTestUser(owner.userId)
      await cleanupTestUser(other.userId)
    }
  })

  it('an open conversation cannot be rated', async () => {
    const user = await createTestUser()
    try {
      await userSendMessage({
        userId: user.userId,
        userNId: user.userNId,
        text: 'Привет',
      })
      const open = await openTicketOf(user.userId)

      await expect(
        submitFeedback({
          userId: user.userId,
          ticketId: open!.id,
          rating: 5,
        })
      ).rejects.toThrow()
      // Offering a rating for an open conversation is not allowed either.
      expect((await getThread(user.userId)).pendingFeedback).toBeNull()
    } finally {
      await cleanupTestUser(user.userId)
    }
  })

  it('a rating outside the range is rejected', async () => {
    const user = await createTestUser()
    try {
      const ticket = await closedTicketOf(user.userId, user.userNId)

      for (const rating of [0, 6, -1, 2.5]) {
        await expect(
          submitFeedback({ userId: user.userId, ticketId: ticket.id, rating })
        ).rejects.toThrow()
      }
    } finally {
      await cleanupTestUser(user.userId)
    }
  })

  it('a long-closed conversation is not offered for rating', async () => {
    const user = await createTestUser()
    try {
      const ticket = await closedTicketOf(user.userId, user.userNId)
      // Three days ago: the user no longer remembers the conversation, and the
      // window is annoying.
      await prismaSupport.supportTicket.update({
        where: { id: ticket.id },
        data: { closedAt: new Date(Date.now() - 72 * 3_600_000) },
      })

      expect((await getThread(user.userId)).pendingFeedback).toBeNull()
    } finally {
      await cleanupTestUser(user.userId)
    }
  })

  it('going to Trustpilot sets VIP and does not move the date on a repeat click', async () => {
    const user = await createTestUser()
    try {
      const first = await markTrustpilotClick(user.userId)
      expect(first.supportVipAt).toBeTruthy()

      const again = await markTrustpilotClick(user.userId)
      // The date answers the question "when was it promised", not "when was it
      // last clicked" — otherwise it would drift on every repeat click.
      expect(again.supportVipAt).toBe(first.supportVipAt)

      const row = await prismaExchange.user.findUniqueOrThrow({
        where: { id: user.userId },
        select: { supportVipAt: true },
      })
      expect(row.supportVipAt?.toISOString()).toBe(first.supportVipAt)
    } finally {
      await cleanupTestUser(user.userId)
    }
  })
})
