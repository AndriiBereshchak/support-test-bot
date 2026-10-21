import { prismaSupport } from '@config/database'
import { REPLY_REMINDER_MINUTES, TICKET_IDLE_CLOSE_HOURS } from '@config/env'
import { logger } from '@config/logger'
import { redisClient, supportKey } from '@config/redis'

import * as telegram from '@telegram/api'

/**
 * Nudge a topic where a user's message has gone unanswered.
 *
 * Operators live in a Telegram group with many topics, and a ticket that gets
 * no reply looks exactly like one that was handled — the topic just sits there.
 * This posts a single line into the topic once the wait crosses the threshold.
 *
 * The message goes to TELEGRAM ONLY. It is never appended to the ticket, so it
 * never reaches the user's feed: telling somebody "nobody has answered you" is
 * the opposite of helpful.
 */

// Bounded like every other worker pass: a backlog (feature just shipped, or the
// worker was down) drains over several ticks instead of firing one burst of
// Telegram calls.
const BATCH_SIZE = 100

/**
 * One nudge per unanswered message, claimed in Redis.
 *
 * Keyed by the MESSAGE, not the ticket, so a conversation that goes quiet twice
 * gets reminded twice — while a single silence can never be reminded about more
 * than once, however often the pass runs.
 *
 * The TTL outlives the ticket itself: after `TICKET_IDLE_CLOSE_HOURS` the
 * sweeper closes it, so a key that survives that long can never gate a reminder
 * anyone would still want. Losing Redis costs at most one duplicate line.
 */
const CLAIM_TTL_SEC = Math.ceil(TICKET_IDLE_CLOSE_HOURS * 3600)

const REMINDER_TEXT = `⏳ Пользователь ждёт ответа больше ${REPLY_REMINDER_MINUTES} мин.`

export async function runReplyReminderPass(): Promise<void> {
  const cutoff = new Date(Date.now() - REPLY_REMINDER_MINUTES * 60_000)

  const waiting = await prismaSupport.supportTicket.findMany({
    where: {
      status: 'OPEN',
      lastMessageAt: { lt: cutoff },
      // No topic means nowhere to post. Those tickets are the relay-retry
      // loop's problem, not this one's.
      tgChatId: { not: null },
      tgTopicId: { not: null },
    },
    select: { id: true, tgChatId: true, tgTopicId: true },
    orderBy: { lastMessageAt: 'asc' },
    take: BATCH_SIZE,
  })

  for (const ticket of waiting) {
    try {
      // `lastMessageAt` alone is not "waiting for us" — it moves for an agent
      // reply and for system notices too. Only a conversation whose LAST word
      // came from the user is actually unanswered.
      //
      // Support's automatic replies are excluded explicitly. The greeting is an
      // OUT message that lands immediately after the user's own, so counting it
      // as an answer would silence this reminder for EVERY ticket — nobody
      // would ever be flagged as waiting again.
      const last = await prismaSupport.supportMessage.findFirst({
        where: {
          ticketId: ticket.id,
          deletedAt: null,
          // Support's own automatic replies are not an answer: the greeting
          // lands right after the user's message, so counting it would silence
          // this reminder for every ticket. `autoKind IS NULL` is exactly
          // "written by a human or by the lifecycle", with none of the NULL
          // semantics a NOT-IN over a nullable column would drag in.
          autoKind: null,
        },
        orderBy: { seq: 'desc' },
        select: { id: true, direction: true },
      })
      if (!last || last.direction !== 'IN') continue

      const claimed = await redisClient.set(
        supportKey(`reply-reminder:${last.id}`),
        '1',
        'EX',
        CLAIM_TTL_SEC,
        'NX'
      )
      if (claimed !== 'OK') continue

      await telegram.sendPlainMessage({
        chatId: Number(ticket.tgChatId),
        topicId: Number(ticket.tgTopicId),
        text: REMINDER_TEXT,
      })
    } catch (err) {
      // One unreachable topic must not strand the rest of the batch.
      logger.error(
        `[reply-reminder] ticket ${ticket.id}: ${(err as Error).message}`
      )
    }
  }
}
