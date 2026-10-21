import './load-env'
import './instrument'

import 'module-alias/register'
import './path-alias'

import type { Server } from 'node:http'

import * as Sentry from '@sentry/node'
import type { FastifyInstance } from 'fastify'

import { prismaSupport, shutdownPrisma } from '@config/database'
import {
  APP_PORT,
  METRICS_ENABLED,
  METRICS_PORT,
  SUPPORT_ROLE,
  assertRequiredEnv,
} from '@config/env'
import { logger } from '@config/logger'
import { closeNats, getNatsConnection } from '@config/nats'
import { startMetricsServer } from '@config/metrics'
import { closeRedis } from '@config/redis'

import { startInactivitySweeper } from '@apps/services/sweeper.service'

import { registerWebhook } from '@telegram/api'

import { buildApp } from './app'

// How long shutdown gets before we stop being polite. Docker sends SIGKILL at
// 10s by default, so a drain that hangs on a wedged socket must not be what
// decides whether prisma got to disconnect.
const SHUTDOWN_TIMEOUT_MS = 8000

let app: FastifyInstance | undefined
let metricsServer: Server | undefined
let stopSweeper: (() => void) | undefined
let shuttingDown = false

// ─── Global last-resort error handlers ───────────────────────────────
// Node terminates the process on an unhandled rejection when no handler is
// registered — a single stray fire-and-forget promise would silently kill the
// replica with nothing in the logs. Report and survive instead; that is
// strictly more available and more debuggable than an unlogged crash.
process.on('unhandledRejection', (reason: unknown) => {
  const err =
    reason instanceof Error
      ? reason
      : new Error(`Unhandled rejection: ${String(reason)}`)
  logger.error(`[unhandledRejection] ${err.stack ?? err.message}`)
  Sentry.captureException(err, {
    level: 'error',
    tags: { handler: 'unhandledRejection', role: SUPPORT_ROLE },
  })
})

process.on('uncaughtException', (err: Error) => {
  logger.error(`[uncaughtException] ${err.stack ?? err.message}`)
  Sentry.captureException(err, {
    level: 'error',
    tags: { handler: 'uncaughtException', role: SUPPORT_ROLE },
  })
})

async function run(): Promise<void> {
  assertRequiredEnv()

  // Eager connect so a bad DATABASE_SUPPORT dies at boot rather than on the
  // first user message. The exchange client stays lazy on purpose: it is
  // read-only decoration (the ticket info card), and its database being
  // briefly unreachable must not stop support from working.
  await prismaSupport.$connect()

  const startApi = SUPPORT_ROLE === 'api' || SUPPORT_ROLE === 'all'
  const startWorker = SUPPORT_ROLE === 'worker' || SUPPORT_ROLE === 'all'

  // Both roles push to the browser, so both need NATS. Non-fatal: `pushToUser`
  // reconnects lazily, and a message that misses its push is still in Postgres
  // and arrives on the client's next thread read.
  try {
    await getNatsConnection()
  } catch (err) {
    logger.error(`[boot] NATS bootstrap failed: ${(err as Error).message}`)
  }

  if (startApi) {
    app = buildApp()
    await app.listen({ port: APP_PORT, host: '0.0.0.0' })

    // AFTER listen, never before: registering the webhook makes Telegram start
    // posting updates immediately, and an update arriving at a socket that
    // isn't bound yet is an update lost.
    try {
      await registerWebhook()
    } catch (err) {
      // Best-effort. The platform side of the chat must keep working through a
      // Telegram outage; the webhook re-registers on the next deploy.
      logger.error(
        `[boot] telegram webhook registration failed: ${(err as Error).message}`
      )
    }

    if (METRICS_ENABLED) metricsServer = startMetricsServer(METRICS_PORT)
  }

  if (startWorker) {
    stopSweeper = startInactivitySweeper()
  }

  // One line for the whole boot: which role this replica took, and the port it
  // answers on when it took the api one.
  logger.info(
    `[boot] role=${SUPPORT_ROLE} ready${startApi ? ` on :${APP_PORT}` : ''}`
  )
}

void run().catch((err: Error) => {
  logger.error(`[boot] fatal: ${err.stack ?? err.message}`)
  Sentry.captureException(err, { level: 'fatal', tags: { handler: 'boot' } })
  process.exit(1)
})

async function gracefulShutdown(code: number): Promise<void> {
  // Docker can deliver SIGTERM and SIGINT back to back; re-entering here would
  // double-disconnect prisma and mask the real exit code.
  if (shuttingDown) return
  shuttingDown = true

  const hardExit = setTimeout(() => {
    logger.error('[shutdown] timed out, exiting hard')
    process.exit(code)
  }, SHUTDOWN_TIMEOUT_MS)
  hardExit.unref()

  // Stop generating new work before tearing down what it depends on.
  stopSweeper?.()

  try {
    // Fastify's close stops accepting connections and waits for in-flight
    // requests, so a user's send is never cut off mid-transaction.
    await app?.close()
  } catch (err) {
    logger.error(`[shutdown] http close failed: ${(err as Error).message}`)
  }

  metricsServer?.close()

  // NATS last among the transports: draining it flushes pushes queued by the
  // requests that just finished draining above.
  await closeNats()
  // No-op on an api-role replica: the client is lazy and never dialled.
  await closeRedis()
  await shutdownPrisma()

  logger.info('[shutdown] complete')
  process.exit(code)
}

process.on('SIGINT', () => void gracefulShutdown(0))
process.on('SIGTERM', () => void gracefulShutdown(0))
