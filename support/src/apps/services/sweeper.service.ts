import { prismaSupport } from '@config/database'
import {
  FILE_RETENTION_DAYS,
  RELAY_RETRY_BATCH_SIZE,
  RELAY_RETRY_INTERVAL_SEC,
  REPLY_REMINDER_MINUTES,
  TICKET_IDLE_CLOSE_HOURS,
} from '@config/env'
import { logger } from '@config/logger'
import { redisClient, supportKey } from '@config/redis'

import { closeTicketEverywhere } from './chat.service'
import { runRelayRetryPass } from './relay-retry.service'
import { runReplyReminderPass } from './reply-reminder.service'
import { runRetentionPass } from './retention.service'

/**
 * The worker role's background loops — closing idle tickets, ageing attachment
 * bytes out of the volume, re-relaying user messages Telegram never took.
 *
 * They share the shape rather than the schedule: an immediate run at boot, a
 * fixed interval after that, one Redis SET-NX lock each so a second `worker`
 * replica never duplicates the work, and an in-process re-entrancy guard so a
 * slow pass never overlaps itself.
 */

// One pass every 15 minutes. The threshold is measured in hours, so a coarse
// tick is fine and keeps the lock contention between replicas negligible.
const SWEEP_INTERVAL_MS = 15 * 60 * 1000

// Deliberately just under the interval: long enough that a slow pass is never
// swept a second time by a sibling replica, short enough that the next tick
// always finds the lock free.
const LOCK_KEY = supportKey('sweeper:lock')
const LOCK_TTL_SEC = 14 * 60

// Retention is measured in DAYS, so hourly is already far finer than the
// threshold it enforces — and it keeps the full `SUM(size_bytes)` that anchors
// the disk-usage counter down to one query an hour per deployment.
const RETENTION_INTERVAL_MS = 60 * 60 * 1000
const RETENTION_LOCK_KEY = supportKey('retention:lock')
const RETENTION_LOCK_TTL_SEC = 55 * 60

// The only loop measured in seconds: every tick it skips is a user message
// support cannot see yet. Its lock is held just under the interval like the
// others, and a pass that outlives even that stays safe — the per-message claim
// in `chat.service` is what actually prevents a double send.
const RELAY_RETRY_INTERVAL_MS = RELAY_RETRY_INTERVAL_SEC * 1000
const RELAY_RETRY_LOCK_KEY = supportKey('relay-retry:lock')
const RELAY_RETRY_LOCK_TTL_SEC = Math.max(
  5,
  Math.floor(RELAY_RETRY_INTERVAL_SEC) - 5
)

// Must be well UNDER the reminder threshold, or the nudge lands late by up to a
// whole interval — a 15-minute tick would turn "after 10 minutes" into anywhere
// between 10 and 25. Two minutes keeps the worst case at 12.
const REPLY_REMINDER_INTERVAL_MS = 2 * 60 * 1000
const REPLY_REMINDER_LOCK_KEY = supportKey('reply-reminder:lock')
const REPLY_REMINDER_LOCK_TTL_SEC = 105

// Bounded batch. A backlog (feature just shipped, or the worker was down for a
// day) drains over several ticks instead of firing thousands of Telegram topic
// closures and WebSocket pushes in one burst.
const BATCH_SIZE = 200

/**
 * Close tickets nobody has touched in TICKET_IDLE_CLOSE_HOURS.
 *
 * This is the SYSTEM entry point of the three-way close (user button, /close in
 * the topic, this). All three funnel through `closeTicketEverywhere`, which is
 * idempotent, so racing with either of the others is harmless.
 */
async function sweepOnce(): Promise<void> {
  const cutoff = new Date(Date.now() - TICKET_IDLE_CLOSE_HOURS * 3600_000)

  const stale = await prismaSupport.supportTicket.findMany({
    where: {
      status: 'OPEN',
      OR: [
        { lastMessageAt: { lt: cutoff } },
        // A ticket whose creation crashed between the row insert and the first
        // message has `lastMessageAt = null`, and a plain `lt` comparison never
        // matches NULL — it would stay open forever, and (being the user's one
        // allowed open ticket) would block every future ticket for them.
        { lastMessageAt: null, createdAt: { lt: cutoff } },
      ],
    },
    select: { id: true },
    orderBy: { lastMessageAt: 'asc' },
    take: BATCH_SIZE,
  })
  if (!stale.length) return

  // No batch summary here on purpose: `closeTicket` already logs one line per
  // ticket it actually closed, with the id — counting them again would be the
  // same event logged twice.
  for (const { id } of stale) {
    try {
      await closeTicketEverywhere(id, 'SYSTEM')
    } catch (err) {
      // One unreachable Telegram topic must not strand the rest of the batch.
      logger.error(
        `[sweeper] failed to close ticket ${id}: ${(err as Error).message}`
      )
    }
  }
}

interface LoopOptions {
  /** Log tag, also the name in the failure line. */
  name: string
  intervalMs: number
  lockKey: string
  lockTtlSec: number
  pass: () => Promise<void>
}

/**
 * One background loop: a pass now, then every `intervalMs`.
 *
 * The lock lives here rather than inside each pass so both get the same
 * multi-replica guarantee by construction — a pass that forgot to take it
 * would run twice per tick across replicas and nothing would say so.
 */
function startLoop(options: LoopOptions): () => void {
  const { name, intervalMs, lockKey, lockTtlSec, pass } = options
  let running = false

  const tick = async (): Promise<void> => {
    // Re-entrancy guard: a pass that outlives the interval (large batch, slow
    // Telegram) must not overlap itself inside this process.
    if (running) return
    running = true
    try {
      // Multi-replica guard. `worker` role may run more than one replica, and
      // two simultaneous passes would duplicate every side effect — survivable
      // (both passes are idempotent) but it doubles the Telegram API traffic,
      // and for retention it means two processes unlinking the same files.
      const acquired = await redisClient.set(
        lockKey,
        String(Date.now()),
        'EX',
        lockTtlSec,
        'NX'
      )
      if (acquired === 'OK') await pass()
    } catch (err) {
      logger.error(`[${name}] pass failed: ${(err as Error).message}`)
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => void tick(), intervalMs)
  void tick()

  return () => clearInterval(timer)
}

/**
 * Start every worker-role loop. Returns the stopper the shutdown path calls.
 *
 * Named for the pass it began life with; it now owns the retention sweep too,
 * so server.ts still has exactly one thing to start and one to stop. Each pass
 * runs immediately rather than waiting out its first interval, so a fresh
 * deploy notices a backlog at once — the Redis locks are what keep a rolling
 * restart from doing that once per replica.
 */
export function startInactivitySweeper(): () => void {
  const stopSweep = startLoop({
    name: 'sweeper',
    intervalMs: SWEEP_INTERVAL_MS,
    lockKey: LOCK_KEY,
    lockTtlSec: LOCK_TTL_SEC,
    pass: sweepOnce,
  })

  const stopRetention = startLoop({
    name: 'retention',
    intervalMs: RETENTION_INTERVAL_MS,
    lockKey: RETENTION_LOCK_KEY,
    lockTtlSec: RETENTION_LOCK_TTL_SEC,
    pass: runRetentionPass,
  })

  // The boot pass matters most for this one: a worker killed mid-relay leaves
  // exactly the rows it drains, and they are already past the grace period by
  // the time the replacement finishes starting.
  const stopRelayRetry = startLoop({
    name: 'relay-retry',
    intervalMs: RELAY_RETRY_INTERVAL_MS,
    lockKey: RELAY_RETRY_LOCK_KEY,
    lockTtlSec: RELAY_RETRY_LOCK_TTL_SEC,
    pass: runRelayRetryPass,
  })

  const stopReplyReminder = startLoop({
    name: 'reply-reminder',
    intervalMs: REPLY_REMINDER_INTERVAL_MS,
    lockKey: REPLY_REMINDER_LOCK_KEY,
    lockTtlSec: REPLY_REMINDER_LOCK_TTL_SEC,
    pass: runReplyReminderPass,
  })

  // Both ends are debug: `[boot] role=…` and `[shutdown] complete` already
  // mark the lifecycle, and these only start on a worker replica.
  logger.debug(
    `[sweeper] started — every ${SWEEP_INTERVAL_MS / 60000}m, idle threshold ${TICKET_IDLE_CLOSE_HOURS}h`
  )
  logger.debug(
    `[retention] started — every ${RETENTION_INTERVAL_MS / 60000}m, keeping files ${FILE_RETENTION_DAYS}d`
  )
  logger.debug(
    `[relay-retry] started — every ${RELAY_RETRY_INTERVAL_SEC}s, up to ${RELAY_RETRY_BATCH_SIZE} message(s) per pass`
  )

  logger.debug(
    `[reply-reminder] started — every ${REPLY_REMINDER_INTERVAL_MS / 60000}m, nudging after ${REPLY_REMINDER_MINUTES}m unanswered`
  )

  return () => {
    stopSweep()
    stopRetention()
    stopRelayRetry()
    stopReplyReminder()
    logger.debug('[sweeper] stopped')
  }
}
