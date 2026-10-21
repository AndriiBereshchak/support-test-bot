import { prismaExchange, prismaSupport } from '@config/database'
import { logger } from '@config/logger'

import type { SupportTicketDto } from '@core/contracts'
import { ApiError } from '@core/errors/api-error'

import { assertCanWrite } from './mute.service'

import { sendToTopic } from '@telegram/api'
import { escapeHtml } from '@telegram/text'

import { toTicketDto } from './mappers'

/**
 * Support rating after the conversation is closed.
 *
 * The rating lives on the ticket, the VIP priority on the user: people rate a
 * specific conversation, while the priority is promised for every future
 * request.
 */

const MIN_RATING = 1
const MAX_RATING = 5
/** Same as the column. We truncate instead of rejecting: a long comment is
 *  effort, not an error. */
const COMMENT_MAX = 2000
/** From this rating up we offer Trustpilot. */
export const HIGH_RATING = 5
/** Same as the window the rating prompt is shown for (findPendingFeedback). */
const FEEDBACK_WINDOW_MS = 48 * 3_600_000

const STARS = (rating: number): string =>
  '⭐️'.repeat(rating) + '☆'.repeat(MAX_RATING - rating)

/**
 * Record the rating and notify the operator.
 *
 * Idempotent: a repeat call on an already rated ticket returns it as is and
 * sends NOTHING to Telegram. The client-side window lives in the browser, and
 * one person can have several browsers — a second "submit" must neither
 * overwrite the rating nor duplicate the message to the operator.
 */
export async function submitFeedback(input: {
  userId: string
  ticketId: string
  rating: number
  comment?: string | null
}): Promise<SupportTicketDto> {
  // An integer exactly, no Math.trunc: rounding turned "2.5" into a valid two
  // stars, i.e. accepted a request the interface cannot send and silently
  // recorded something other than what was submitted.
  const rating = Number(input.rating)
  if (!Number.isInteger(rating) || rating < MIN_RATING || rating > MAX_RATING) {
    throw new ApiError('rating must be 1..5', 400, 'BAD_RATING')
  }

  // The write ban extends here too. Without this check a banned user kept a
  // working channel into the operator's topic: a rating comment is the same
  // 2000 characters of free text they were banned for. Through the interface
  // this is unreachable (the card is not shown while the ban is on), but a
  // direct request and a stale tab are reachable.
  await assertCanWrite(input.userId)

  const ticket = await prismaSupport.supportTicket.findFirst({
    // userId in the where clause, not in a check afterwards: someone else's
    // ticket must be indistinguishable from a non-existent one.
    where: { id: input.ticketId, userId: input.userId },
  })
  if (!ticket) throw new ApiError('Ticket not found', 404, 'NO_TICKET')
  // The rating window is enforced on the server as well, not only in the hint
  // to the client: otherwise any closed conversation in the whole history,
  // including last year's, could be rated (and given a comment).
  if (
    ticket.closedAt &&
    Date.now() - ticket.closedAt.getTime() > FEEDBACK_WINDOW_MS
  ) {
    throw new ApiError('Feedback window is over', 409, 'FEEDBACK_EXPIRED')
  }
  if (ticket.status !== 'CLOSED') {
    // People rate a finished conversation. An open one is still going, and a
    // rating on it would mean the window was shown at the wrong time.
    throw new ApiError('Ticket is not closed', 409, 'TICKET_OPEN')
  }
  const comment = input.comment?.trim().slice(0, COMMENT_MAX) || null

  // The rating is set ONCE and never overwritten: the window sends it right on
  // the click on a star (otherwise closing the window would lose a choice
  // already made), and the comment arrives as a second request — and that one
  // can still be filled in while it is empty. This way a second tab cannot
  // override the rating, and the person still gets to tell what went wrong.
  if (ticket.ratedAt) {
    if (!comment || ticket.ratingComment) return toTicketDto(ticket)

    const withComment = await prismaSupport.supportTicket.update({
      where: { id: ticket.id },
      data: { ratingComment: comment },
    })
    notifyOperator(ticket, ticket.rating ?? rating, comment, true)
    return toTicketDto(withComment)
  }

  const updated = await prismaSupport.supportTicket.update({
    where: { id: ticket.id },
    data: { rating, ratingComment: comment, ratedAt: new Date() },
  })

  notifyOperator(ticket, rating, comment, false)

  return toTicketDto(updated)
}

/**
 * Push the rating to the operator in the ticket topic: feedback is useless if
 * it only sits in the database.
 *
 * Best-effort and outside the transaction: the rating is already recorded, and
 * an unavailable Telegram is no reason to lose it or show the user an error.
 */
function notifyOperator(
  ticket: {
    tgChatId: bigint | null
    tgTopicId: number | null
    userNId: number
  },
  rating: number,
  comment: string | null,
  isCommentOnly: boolean
): void {
  if (ticket.tgChatId == null || ticket.tgTopicId == null) return

  const lines = isCommentOnly
    ? [
        `💬 <b>Комментарий к оценке ${rating}/${MAX_RATING}</b>`,
        `Юзер: <code>${ticket.userNId}</code>`,
        '',
        `<i>${escapeHtml(comment ?? '')}</i>`,
      ]
    : [
        `${STARS(rating)} <b>Оценка поддержки: ${rating}/${MAX_RATING}</b>`,
        `Юзер: <code>${ticket.userNId}</code>`,
        ...(comment ? ['', `<i>${escapeHtml(comment)}</i>`] : []),
      ]

  void sendToTopic({
    chatId: Number(ticket.tgChatId),
    topicId: ticket.tgTopicId,
    text: lines.join('\n'),
  }).catch((err: unknown) =>
    logger.warn(
      `[feedback] не смог отправить оценку в топик ${ticket.tgTopicId}: ${(err as Error).message}`
    )
  )
}

/**
 * The user went off to leave a review on Trustpilot — mark the VIP priority.
 *
 * There is nothing to verify the review was actually published with, so we
 * store exactly the date of the click-through: the operator sees it in the
 * card and clears the mark if the review never appeared. The first date is not
 * overwritten — it answers "when it was promised", not "when it was clicked
 * last".
 */
export async function markTrustpilotClick(
  userId: string
): Promise<{ supportVipAt: string | null }> {
  try {
    const user = await prismaExchange.user.findUnique({
      where: { id: userId },
      select: { supportVipAt: true },
    })
    if (!user) throw new ApiError('User not found', 404, 'NO_USER')
    if (user.supportVipAt) {
      return { supportVipAt: user.supportVipAt.toISOString() }
    }

    const now = new Date()
    await prismaExchange.user.update({
      where: { id: userId },
      data: { supportVipAt: now },
      // Without `select` Prisma reads the WHOLE user model back — fifty odd
      // columns for the sake of the single one written. We need none of them.
      select: { id: true },
    })
    logger.info(`[feedback] VIP-приоритет выдан юзеру ${userId}`)
    return { supportVipAt: now.toISOString() }
  } catch (err) {
    if (err instanceof ApiError) throw err
    // Do not break the client: it has already opened Trustpilot in a new tab,
    // and an error here will not undo the click-through — it will only ruin
    // the thank-you window.
    logger.warn(
      `[feedback] не смог отметить VIP для ${userId}: ${(err as Error).message}`
    )
    return { supportVipAt: null }
  }
}
