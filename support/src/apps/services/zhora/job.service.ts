import { setTimeout as delay } from 'node:timers/promises'
import { Prisma, type ZhoraJob } from '@prisma-support'

import { prismaSupport } from '@config/database'
import { ZHORA_ENABLED } from '@config/env'
import { logger } from '@config/logger'

import { ZhoraBudgetError } from './budget.service'
import {
  enqueuePendingKbEmbeddings,
  indexZhoraKbJob,
} from './kb-search.service'
import {
  generateZhoraTextWithJournal,
  temporaryDatabaseError,
} from './llm.service'
import {
  getZhoraModel,
  OpenRouterError,
  type OpenRouterInput,
  type ZhoraOperation,
} from './openrouter'

// Technical scheduling defaults, not product limits. One job at a time per
// worker process; PostgreSQL arbitrates claims between worker replicas.
const POLL_INTERVAL_MS = 1000
const LEASE_MS = 60_000
const HEARTBEAT_MS = 15_000
const KB_DISCOVERY_INTERVAL_MS = 15 * 60_000

export async function enqueueZhoraJob(args: {
  eventKey: string
  input: OpenRouterInput
  ticketId?: string | null
  agentId?: string | null
}): Promise<ZhoraJob> {
  getZhoraModel(args.input)
  if (!args.eventKey.trim() || args.eventKey.length > 160)
    throw new Error('[zhora] invalid_job_event_key')
  const { systemPrompt, input, knowledge, cachePrompt } = args.input
  try {
    return await prismaSupport.zhoraJob.upsert({
      where: { eventKey: args.eventKey },
      create: {
        eventKey: args.eventKey,
        operation: args.input.operation,
        input: {
          systemPrompt,
          input,
          ...(knowledge !== undefined ? { knowledge } : {}),
          ...(cachePrompt !== undefined ? { cachePrompt } : {}),
        },
        ticketId: args.ticketId ?? null,
        agentId: args.agentId ?? null,
      },
      update: {},
    })
  } catch (error) {
    // Prisma may emulate an empty-update upsert with read/create. If two
    // producers race, the unique event key still selects one durable job.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      const existing = await prismaSupport.zhoraJob
        .findUnique({
          where: { eventKey: args.eventKey },
        })
        .catch(() => null)
      if (existing) return existing
    }
    // Do not expose Prisma's query arguments (which include prepared text).
    throw new Error('[zhora] job_enqueue_failed')
  }
}

function readInput(job: ZhoraJob): OpenRouterInput {
  const value = job.input
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof value.systemPrompt !== 'string' ||
    typeof value.input !== 'string' ||
    (value.knowledge !== undefined && typeof value.knowledge !== 'string') ||
    (value.cachePrompt !== undefined && typeof value.cachePrompt !== 'boolean')
  )
    throw new OpenRouterError('invalid_input')
  return {
    operation: job.operation as ZhoraOperation,
    systemPrompt: value.systemPrompt,
    input: value.input,
    ...(typeof value.knowledge === 'string'
      ? { knowledge: value.knowledge }
      : {}),
    ...(typeof value.cachePrompt === 'boolean'
      ? { cachePrompt: value.cachePrompt }
      : {}),
  }
}

/** A lost worker does not authorize replaying a possibly paid call. */
export async function recoverExpiredZhoraJobs(): Promise<void> {
  await prismaSupport.zhoraJob.updateMany({
    where: {
      status: 'running',
      OR: [{ leaseExpiresAt: { lte: new Date() } }, { leaseExpiresAt: null }],
    },
    data: {
      status: 'uncertain',
      errorCode: 'execution_unknown',
      finishedAt: new Date(),
      leaseExpiresAt: null,
    },
  })
}

async function claimJob(): Promise<ZhoraJob | null> {
  const claimed = await prismaSupport.$queryRaw<Array<{ id: string }>>`
    UPDATE zhora_jobs
    SET status = 'running', started_at = NOW(), updated_at = NOW(),
        lease_expires_at = ${new Date(Date.now() + LEASE_MS)}
    WHERE id = (
      SELECT id FROM zhora_jobs WHERE status = 'queued'
      ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1
    ) AND status = 'queued'
    RETURNING id
  `
  if (!claimed[0]) return null
  return prismaSupport.zhoraJob.findUniqueOrThrow({
    where: { id: claimed[0].id },
  })
}

async function finishJob(
  id: string,
  data: Prisma.ZhoraJobUpdateManyMutationInput
): Promise<void> {
  const retryDelays = [100, 300]
  for (let attempt = 0; ; attempt++) {
    try {
      await prismaSupport.zhoraJob.updateMany({
        // A delayed but still alive executor may complete after its lease
        // expired. An uncertain job is never picked up by another executor.
        where: { id, status: { in: ['running', 'uncertain'] } },
        data: { ...data, finishedAt: new Date(), leaseExpiresAt: null },
      })
      return
    } catch (error) {
      const pause = retryDelays[attempt]
      if (!temporaryDatabaseError(error) || pause === undefined) throw error
      await delay(pause)
    }
  }
}

async function executeJob(job: ZhoraJob): Promise<void> {
  let result
  try {
    result =
      job.operation === 'embedding'
        ? await indexZhoraKbJob(job)
        : await generateZhoraTextWithJournal(readInput(job), {
            ticketId: job.ticketId,
            agentId: job.agentId,
            jobId: job.id,
          })
  } catch (error) {
    const code =
      error instanceof ZhoraBudgetError || error instanceof OpenRouterError
        ? error.code
        : 'execution_unknown'
    const uncertain = [
      'timeout',
      'network_error',
      'execution_unknown',
    ].includes(code)
    await finishJob(job.id, {
      status: uncertain ? 'uncertain' : 'failed',
      errorCode: code,
    })
    return
  }
  // JSON removes optional undefined metadata fields. Never log this result.
  await finishJob(job.id, {
    status: 'completed',
    result: JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue,
    errorCode: null,
  })
}

/** One claim per pass. Multiple workers use the same atomic SQL claim. */
export async function runZhoraJobPass(
  shouldStop: () => boolean = () => false
): Promise<void> {
  if (!ZHORA_ENABLED || shouldStop()) return
  await recoverExpiredZhoraJobs()
  if (shouldStop()) return
  const job = await claimJob()
  if (!job) return
  if (shouldStop()) {
    // Shutdown raced the claim, but no paid work has started yet.
    await prismaSupport.zhoraJob.updateMany({
      where: { id: job.id, status: 'running', callId: null },
      data: { status: 'queued', startedAt: null, leaseExpiresAt: null },
    })
    return
  }
  let heartbeat: Promise<unknown> | undefined
  const timer = setInterval(() => {
    if (heartbeat) return
    heartbeat = prismaSupport.zhoraJob
      .updateMany({
        where: { id: job.id, status: 'running' },
        data: { leaseExpiresAt: new Date(Date.now() + LEASE_MS) },
      })
      .catch(() => {
        logger.warn(`[zhora] job lease refresh failed: ${job.id}`)
      })
      .finally(() => {
        heartbeat = undefined
      })
  }, HEARTBEAT_MS)
  timer.unref()
  try {
    await executeJob(job)
  } finally {
    clearInterval(timer)
    await heartbeat
  }
}

/** Stop claims immediately, then drain the active pass before DB shutdown.
 * The host's existing shutdown deadline still bounds a wedged process. */
export function startZhoraWorker(): () => Promise<void> {
  if (!ZHORA_ENABLED) return async () => undefined
  let stopping = false
  let active: Promise<void> | undefined
  let nextKbDiscovery = 0
  let kbCursor: string | null = null
  const tick = () => {
    if (stopping || active) return
    active = (async () => {
      if (Date.now() >= nextKbDiscovery) {
        const batch = await enqueuePendingKbEmbeddings(kbCursor)
        kbCursor = batch.nextCursor
        // Walk the existing KB once at startup/model change, then reconcile
        // periodically. Ordinary CRUD writes already enqueue their own jobs.
        nextKbDiscovery = Date.now() + (kbCursor ? 0 : KB_DISCOVERY_INTERVAL_MS)
      }
      await runZhoraJobPass(() => stopping)
    })()
      .catch(() => {
        logger.warn('[zhora] job pass failed; no automatic generation retry')
      })
      .finally(() => {
        active = undefined
      })
  }
  const timer = setInterval(tick, POLL_INTERVAL_MS)
  tick()
  return async () => {
    stopping = true
    clearInterval(timer)
    await active
  }
}
