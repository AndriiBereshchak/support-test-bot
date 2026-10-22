import { execFileSync } from 'node:child_process'
import path from 'node:path'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

const settings = vi.hoisted(() => ({ enabled: true, schema: '', url: '' }))
vi.mock('@config/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@config/database')>()
  const { PrismaClient } = await import('@prisma-support')
  const { randomUUID } = await import('node:crypto')
  settings.schema = `zhora_jobs_${randomUUID().replaceAll('-', '')}`
  const url = new URL(process.env.DATABASE_SUPPORT!)
  url.searchParams.set('schema', settings.schema)
  settings.url = url.toString()
  return {
    ...actual,
    prismaSupport: new PrismaClient({
      datasources: { db: { url: settings.url } },
    }),
  }
})
vi.mock('@config/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@config/env')>()),
  get ZHORA_ENABLED() {
    return settings.enabled
  },
  ZHORA_OPENROUTER_API_KEY: 'fake-jobs-test-key',
  ZHORA_MODEL_REPLY: 'test/reply',
  ZHORA_MONTHLY_BUDGET_USD: 1,
}))
vi.mock('@apps/services/zhora/openrouter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@apps/services/zhora/openrouter')>()),
  generateZhoraText: vi.fn(),
  getOpenRouterMonthlyUsage: vi.fn(),
}))
vi.mock('@telegram/api', () => ({ sendPlainMessage: vi.fn(async () => 123) }))

import { Prisma } from '@prisma-support'
import { prismaSupport } from '@config/database'
import { logger } from '@config/logger'
import {
  generateZhoraText,
  getOpenRouterMonthlyUsage,
  OpenRouterError,
  type OpenRouterResult,
} from '@apps/services/zhora/openrouter'
import {
  enqueueZhoraJob,
  recoverExpiredZhoraJobs,
  runZhoraJobPass,
  startZhoraWorker,
} from '@apps/services/zhora/job.service'

const input = {
  operation: 'reply' as const,
  systemPrompt: 'Synthetic rules',
  input: 'Synthetic question',
}
const answer = (): OpenRouterResult => ({
  text: 'Synthetic answer',
  model: 'test/reply',
  generationId: 'gen-test',
  durationMs: 10,
  usage: {
    inputTokens: 10,
    outputTokens: 5,
    costUsd: 0.1,
    cachedTokens: null,
    cacheWriteTokens: null,
  },
})
const generate = vi.mocked(generateZhoraText)
const originalUpdate = prismaSupport.zhoraJob.updateMany
const stops: Array<() => Promise<void>> = []
const releases: Array<() => void> = []
const enqueue = (eventKey: string) => enqueueZhoraJob({ eventKey, input })
const reload = (id: string) =>
  prismaSupport.zhoraJob.findUniqueOrThrow({ where: { id } })

beforeAll(() => {
  const cli = path.join(
    path.dirname(require.resolve('prisma/package.json')),
    'build/index.js'
  )
  execFileSync(
    process.execPath,
    [cli, 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'],
    {
      cwd: path.resolve(__dirname, '../..'),
      env: { ...process.env, DATABASE_SUPPORT: settings.url },
      stdio: 'pipe',
    }
  )
})
beforeEach(async () => {
  settings.enabled = true
  generate.mockReset().mockImplementation(async () => answer())
  vi.mocked(getOpenRouterMonthlyUsage)
    .mockReset()
    .mockImplementation(async () => ({
      month: new Date().toISOString().slice(0, 7),
      costUsd: 0,
    }))
  vi.spyOn(logger, 'warn').mockImplementation(() => logger)
  await prismaSupport.zhoraJob.deleteMany()
  await prismaSupport.zhoraLlmCall.deleteMany()
  await prismaSupport.zhoraMonthlyBudget.deleteMany()
  await prismaSupport.supportTicket.deleteMany()
  await prismaSupport.supportAgent.deleteMany()
})
afterEach(async () => {
  releases.splice(0).forEach((release) => release())
  await Promise.all(stops.splice(0).map((stop) => stop()))
  vi.restoreAllMocks()
  // Preserve the real dynamic Prisma method after Vitest restores a spy.
  prismaSupport.zhoraJob.updateMany = originalUpdate
})
afterAll(async () => {
  try {
    await prismaSupport.$executeRawUnsafe(
      `DROP SCHEMA IF EXISTS "${settings.schema}" CASCADE`
    )
  } finally {
    await prismaSupport.$disconnect()
  }
})

describe('durable Zhora jobs', () => {
  it('deduplicates concurrent enqueue operations without calling AI', async () => {
    const [first, second] = await Promise.all([
      enqueue('telegram:1:reply'),
      enqueue('telegram:1:reply'),
    ])
    expect(first.id).toBe(second.id)
    expect(first.status).toBe('queued')
    expect(await prismaSupport.zhoraJob.count()).toBe(1)
    expect(generate).not.toHaveBeenCalled()
  })

  it('lets only one worker claim a job and preserves result, context and call linkage', async () => {
    const ticket = await prismaSupport.supportTicket.create({
      data: { userId: 'synthetic-job-user', userNId: 123 },
    })
    const agent = await prismaSupport.supportAgent.create({
      data: { tgUserId: 123456789n, displayName: 'Synthetic operator' },
    })
    const job = await enqueueZhoraJob({
      eventKey: 'telegram:2:reply',
      input,
      ticketId: ticket.id,
      agentId: agent.id,
    })
    await Promise.all([runZhoraJobPass(), runZhoraJobPass()])
    const done = await reload(job.id)
    expect(done.status).toBe('completed')
    expect(done.result).toMatchObject({
      text: 'Synthetic answer',
      usage: { costUsd: 0.1 },
    })
    const call = await prismaSupport.zhoraLlmCall.findUniqueOrThrow({
      where: { id: done.callId! },
    })
    expect(call).toMatchObject({
      ticketId: ticket.id,
      agentId: agent.id,
      outcome: 'ok',
    })
    expect((await enqueue('telegram:2:reply')).id).toBe(job.id)
    await runZhoraJobPass()
    expect(generate).toHaveBeenCalledTimes(1)
    expect(await prismaSupport.zhoraLlmCall.count()).toBe(1)
  })

  it('marks an expired execution uncertain instead of replaying a possibly paid call', async () => {
    const job = await enqueue('telegram:3:reply')
    await prismaSupport.zhoraJob.update({
      where: { id: job.id },
      data: {
        status: 'running',
        startedAt: new Date(),
        leaseExpiresAt: new Date(Date.now() - 1000),
      },
    })
    await recoverExpiredZhoraJobs()
    expect(await reload(job.id)).toMatchObject({
      status: 'uncertain',
      errorCode: 'execution_unknown',
    })
    await enqueue('telegram:3:reply')
    await runZhoraJobPass()
    expect(generate).not.toHaveBeenCalled()
  })

  it('stores budget refusal as a failed job without a provider call', async () => {
    const job = await enqueue('telegram:4:reply')
    await prismaSupport.zhoraMonthlyBudget.create({
      data: {
        month: new Date().toISOString().slice(0, 7),
        spentUsd: 1,
        exhaustedAt: new Date(),
      },
    })
    await runZhoraJobPass()
    expect(await reload(job.id)).toMatchObject({
      status: 'failed',
      errorCode: 'budget_exhausted',
      callId: null,
    })
    await runZhoraJobPass()
    expect(generate).not.toHaveBeenCalled()
  })

  it('does not automatically retry a timeout with unknown payment outcome', async () => {
    const job = await enqueue('telegram:5:reply')
    const details = answer()
    details.generationId = null
    details.usage.costUsd = null
    generate.mockRejectedValue(new OpenRouterError('timeout', details))
    await runZhoraJobPass()
    expect(await reload(job.id)).toMatchObject({
      status: 'uncertain',
      errorCode: 'timeout',
    })
    await runZhoraJobPass()
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('drains active work on stop and leaves the next queued job for a new worker', async () => {
    const first = await enqueue('telegram:6:reply')
    let release!: () => void
    generate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(answer())
          releases.push(release)
        })
    )
    const stop = startZhoraWorker()
    stops.push(stop)
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1))
    const second = await enqueue('telegram:7:reply')
    let drained = false
    const stopping = stop().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    release()
    await stopping
    expect((await reload(first.id)).status).toBe('completed')
    expect((await reload(second.id)).status).toBe('queued')
    generate.mockImplementation(async () => answer())
    const stopNext = startZhoraWorker()
    stops.push(stopNext)
    await vi.waitFor(async () =>
      expect((await reload(second.id)).status).toBe('completed')
    )
    await stopNext()
    expect(generate).toHaveBeenCalledTimes(2)
  })

  it('keeps a lost result write uncertain after recovery without another generation', async () => {
    const job = await enqueue('telegram:8:reply')
    generate.mockImplementationOnce(async () => {
      const error = new Prisma.PrismaClientKnownRequestError(
        'Synthetic disconnect',
        { code: 'P1017', clientVersion: 'test' }
      )
      vi.spyOn(prismaSupport.zhoraJob, 'updateMany')
        .mockRejectedValueOnce(error)
        .mockRejectedValueOnce(error)
        .mockRejectedValueOnce(error)
      return answer()
    })
    await expect(runZhoraJobPass()).rejects.toMatchObject({ code: 'P1017' })
    prismaSupport.zhoraJob.updateMany = originalUpdate
    await prismaSupport.zhoraJob.update({
      where: { id: job.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    })
    await runZhoraJobPass()
    expect(await reload(job.id)).toMatchObject({
      status: 'uncertain',
      result: null,
    })
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('does not consume queued jobs while Zhora is disabled', async () => {
    const job = await enqueue('telegram:9:reply')
    settings.enabled = false
    const stop = startZhoraWorker()
    await runZhoraJobPass()
    await stop()
    expect((await reload(job.id)).status).toBe('queued')
    expect(generate).not.toHaveBeenCalled()
  })
})
