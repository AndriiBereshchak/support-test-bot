import * as Sentry from '@sentry/node'

import type { SupportTicket } from '@prisma-support'

import { prismaSupport } from '@config/database'
import {
  RELAY_RETRY_BATCH_SIZE,
  RELAY_RETRY_MAX_ATTEMPTS,
  RELAY_RETRY_MIN_AGE_SEC,
} from '@config/env'
import { logger } from '@config/logger'
import { redisClient, supportKey } from '@config/redis'

import { ensureTopic, relayIncomingMessage } from './chat.service'
import { forgetThreadTopic } from './ticket.service'
import type { PermanentFailure } from '@telegram/api'
import { reopenTopic } from '@telegram/api'

/**
 * The delivery guarantee for user messages.
 *
 * `userSendMessage` persists first and relays second, so a Telegram outage, a
 * revoked bot token or a restart between the two costs the user nothing — their
 * message is in Postgres and their tab shows it. It costs SUPPORT everything:
 * without this loop, nobody in the topic ever learns the message exists, and
 * the user sits waiting for an answer to a question no operator can see.
 *
 * No outbox table, deliberately. An IN message with `tgMessageId IS NULL` has
 * BY CONSTRUCTION not been relayed — that column is only ever written by a
 * successful relay — so the outbox already exists in the messages table, and a
 * second one would be a migration plus a way for the two to disagree.
 */

interface PendingMessage {
  id: string
  seq: number
  text: string | null
}

/**
 * Per-message attempt counter, in Redis.
 *
 * TRADE-OFF, stated because it is a real one: the counter belongs on the
 * message row, and a column is not available here (no migration in this slice),
 * so it lives in Redis with a TTL. A Redis flush therefore hands every stranded
 * message a fresh budget and re-fires its alert. That is the right way round —
 * losing the counter costs a handful of duplicate Telegram calls and one repeat
 * Sentry event, whereas losing the MESSAGE costs a customer conversation. The
 * bound it enforces (a poison message stops burning the send budget) survives
 * everything except a Redis restart.
 */
const attemptsKey = (messageId: string): string =>
  supportKey(`relay:attempts:${messageId}`)

// Long enough to outlive any outage the loop can actually recover from, short
// enough that the keys of a purged conversation age out on their own. Refreshed
// on every pass that looks at the message, so a given-up message stays given up
// while the loop keeps seeing it.
const ATTEMPT_TTL_SEC = 24 * 60 * 60

async function attemptsSpent(messageId: string): Promise<number> {
  const raw = await redisClient.get(attemptsKey(messageId))
  const spent = Number(raw ?? 0)
  return Number.isFinite(spent) ? spent : 0
}

async function recordAttempt(messageId: string): Promise<number> {
  const key = attemptsKey(messageId)
  const attempts = await redisClient.incr(key)
  await redisClient.expire(key, ATTEMPT_TTL_SEC)
  return attempts
}

function giveUp(
  message: PendingMessage,
  ticket: SupportTicket,
  attempts: number,
  permanent: PermanentFailure | null
): void {
  const reason = permanent
    ? `telegram reports ${permanent}`
    : 'telegram kept refusing it'
  const error = new Error(
    `[relay-retry] message ${message.id} of ticket ${ticket.id} never reached telegram after ${attempts} attempts — ${reason}`
  )
  // The one place in this file that pages a human: every automatic recovery has
  // been tried, so from here a person has to fix the group (or answer the user
  // another way). The message stays in the user's feed either way.
  logger.error(error.message)
  Sentry.captureException(error, {
    level: 'error',
    tags: { handler: 'relay-retry', ...(permanent ? { permanent } : {}) },
    extra: { messageId: message.id, ticketId: ticket.id, attempts },
  })
}

/**
 * Drop the topic binding so `ensureTopic` builds a new thread next pass.
 *
 * Only for `topic-missing`: an operator deleted the thread, and there is no
 * other way back to a conversation the user is still in. `tgChatId` stays (it
 * records which group the ticket lived in, and `ensureTopic` keys off the topic
 * id), but `tgInfoMessageId` must go — it points at a pinned card inside the
 * deleted thread, and every later edit against it would fail.
 */
async function forgetTopic(ticket: SupportTicket): Promise<SupportTicket> {
  logger.warn(
    `[relay-retry] topic ${ticket.tgTopicId} of ticket ${ticket.id} is gone — unbinding so a new one is created`
  )
  // The user's permanent thread has to forget it too. It is the thread that
  // `ensureTopic` consults, so clearing only the ticket would have it re-bind
  // straight back to the deleted topic and the conversation would never reach
  // Telegram again.
  await forgetThreadTopic(ticket.tgChatId, ticket.tgTopicId)
  return prismaSupport.supportTicket.update({
    where: { id: ticket.id },
    data: { tgTopicId: null, tgInfoMessageId: null },
  })
}

interface DrainResult {
  /** Messages that reached the topic. */
  relayed: number
  /** Sends actually made, whatever came of them — what the pass budget spends. */
  attempted: number
}

/**
 * Relay one ticket's backlog, oldest message first.
 *
 * ORDERING is the whole reason this is a per-ticket function: support reads a
 * topic top to bottom, and a conversation whose second message arrives before
 * its first is worse than a late one. So the messages go out in `seq` order and
 * a failure stops the ticket — everything behind it has to land behind it.
 *
 * The single exception is a message the budget has already given up on: that
 * one is never arriving, and holding the rest of the conversation hostage to it
 * would turn one lost message into a silent ticket.
 */
async function drainTicket(
  ticketId: string,
  cutoff: Date,
  budget: number
): Promise<DrainResult> {
  const idle: DrainResult = { relayed: 0, attempted: 0 }

  const row = await prismaSupport.supportTicket.findUnique({
    where: { id: ticketId },
  })
  // Gone since the pass began (the ticket cascade took its messages too).
  if (!row) return idle

  // This ticket's OWN backlog, rather than whichever of its messages happened
  // to be in the discovery batch: those were selected newest-first across the
  // whole database, so a ticket with more pending messages than one batch would
  // otherwise start relaying from the middle of its own conversation.
  const messages = await prismaSupport.supportMessage.findMany({
    where: {
      ticketId,
      direction: 'IN',
      tgMessageId: null,
      deletedAt: null,
      createdAt: { lt: cutoff },
    },
    select: { id: true, seq: true, text: true },
    orderBy: { seq: 'asc' },
    take: budget,
  })
  if (!messages.length) return idle

  let ticket = await ensureTopic(row)
  let relayed = 0
  let attempted = 0

  for (const message of messages) {
    if ((await attemptsSpent(message.id)) >= RELAY_RETRY_MAX_ATTEMPTS) {
      // Already escalated. Refresh the TTL so the give-up stays sticky for as
      // long as this message keeps showing up in the batch.
      await redisClient.expire(attemptsKey(message.id), ATTEMPT_TTL_SEC)
      continue
    }

    const attempt = await relayIncomingMessage(ticket, message)
    if (attempt.status === 'busy') {
      // Someone else is relaying this exact message right now — most likely the
      // inline send, still queued behind a flood wait. Leave it, and leave what
      // follows it in the ticket alone too.
      break
    }

    attempted += 1
    const attempts = await recordAttempt(message.id)
    if (attempt.status === 'relayed') {
      relayed += 1
      continue
    }

    // Two failures this loop can repair by itself.
    //
    // A DELETED topic is gone for good — drop the binding so the next relay
    // mints a fresh one.
    if (attempt.permanent === 'topic-missing')
      ticket = await forgetTopic(ticket)

    // An ARCHIVED one is intact and merely shut: reopen it and keep the thread
    // with all its history, instead of abandoning it for an empty new topic.
    // This is how a permanent thread survives an operator tidying the forum
    // list — the binding is deliberately left alone.
    if (
      attempt.permanent === 'topic-closed' &&
      ticket.tgChatId != null &&
      ticket.tgTopicId != null
    ) {
      const reopened = await reopenTopic(
        Number(ticket.tgChatId),
        ticket.tgTopicId
      )
      logger.warn(
        `[relay-retry] topic ${ticket.tgTopicId} was archived — ` +
          (reopened ? 'reopened' : 'could NOT reopen')
      )
    }

    if (attempts >= RELAY_RETRY_MAX_ATTEMPTS) {
      giveUp(message, ticket, attempts, attempt.permanent)
    } else {
      logger.warn(
        `[relay-retry] message ${message.id} still not relayed (attempt ${attempts}/${RELAY_RETRY_MAX_ATTEMPTS})`
      )
    }
    break
  }

  return { relayed, attempted }
}

/**
 * One pass over the outbox.
 *
 * The loop that drives it — interval, Redis lock, re-entrancy guard — lives in
 * `sweeper.service.ts` with the other worker passes, so this stays a plain
 * function: callable twice in a row, and testable without waiting out a lock.
 */
export async function runRelayRetryPass(): Promise<void> {
  const cutoff = new Date(Date.now() - RELAY_RETRY_MIN_AGE_SEC * 1000)

  // Discovery: which tickets are waiting, not which messages. The rows are read
  // newest first because somebody is waiting on the message they sent a minute
  // ago, while one stranded by last week's outage is already a lost cause in
  // every sense but the record; `drainTicket` then flips back to `seq` within
  // each ticket.
  const waiting = await prismaSupport.supportMessage.findMany({
    where: {
      // OUT messages carry Telegram's own id by definition and SYSTEM notices
      // are never relayed, so IN is the entire outbox.
      direction: 'IN',
      tgMessageId: null,
      deletedAt: null,
      // The grace period that keeps this loop off a send that is still running.
      createdAt: { lt: cutoff },
    },
    select: { ticketId: true },
    orderBy: { createdAt: 'desc' },
    take: RELAY_RETRY_BATCH_SIZE,
  })
  if (!waiting.length) return

  const ticketIds = [...new Set(waiting.map((m) => m.ticketId))]

  let relayed = 0
  // One shared budget across the pass, so the batch size means the same thing
  // however the backlog is spread: one ticket with fifty stranded messages and
  // fifty tickets with one each both cost the same number of sends.
  let budget = RELAY_RETRY_BATCH_SIZE

  // Tickets are drained one after another rather than concurrently: they all
  // share ONE Telegram group and its ~20-messages-per-minute budget, so
  // parallelism here buys no throughput and only deepens the transport queue.
  for (const ticketId of ticketIds) {
    if (budget <= 0) break
    const done = await drainTicket(ticketId, cutoff, budget)
    budget -= done.attempted
    relayed += done.relayed
  }

  if (relayed) logger.info(`[relay-retry] relayed ${relayed} message(s)`)
}
