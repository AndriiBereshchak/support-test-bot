import { execFileSync } from 'node:child_process'
import path from 'node:path'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

const settings = vi.hoisted(() => ({ schema: '', url: '' }))
vi.mock('@config/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@config/database')>()
  const { PrismaClient } = await import('@prisma-support')
  const { randomUUID } = await import('node:crypto')
  settings.schema = `zhora_search_${randomUUID().replaceAll('-', '')}`
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
    return flags.enabled
  },
  get ZHORA_MODEL_EMBEDDING() {
    return flags.model
  },
  ZHORA_OPENROUTER_API_KEY: 'fake-embedding-key',
  ZHORA_MONTHLY_BUDGET_USD: 1,
}))
const flags = vi.hoisted(() => ({ enabled: true, model: 'test/embedding' }))
vi.mock('@apps/services/zhora/openrouter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@apps/services/zhora/openrouter')>()),
  generateZhoraEmbedding: vi.fn(),
  getOpenRouterMonthlyUsage: vi.fn(async () => ({
    month: new Date().toISOString().slice(0, 7),
    costUsd: 0,
  })),
}))
vi.mock('@telegram/api', () => ({ sendPlainMessage: vi.fn(async () => 123) }))

import { prismaSupport } from '@config/database'
import {
  createZhoraKbEntry,
  importZhoraKbEntries,
  updateZhoraKbEntry,
} from '@apps/services/zhora/kb.service'
import {
  enqueuePendingKbEmbeddings,
  findZhoraKbMatches,
  searchZhoraKb,
} from '@apps/services/zhora/kb-search.service'
import {
  runZhoraJobPass,
  startZhoraWorker,
} from '@apps/services/zhora/job.service'
import {
  generateZhoraEmbedding,
  OpenRouterError,
  type OpenRouterEmbeddingResult,
} from '@apps/services/zhora/openrouter'

const vector = (x = 1, y = 0) => [x, y, ...Array(1022).fill(0)] as number[]
const generate = vi.mocked(generateZhoraEmbedding)
const result = (): OpenRouterEmbeddingResult => ({
  embedding: vector(),
  model: flags.model,
  generationId: null,
  durationMs: 10,
  usage: {
    inputTokens: 20,
    outputTokens: 0,
    costUsd: 0.001,
    cachedTokens: null,
    cacheWriteTokens: null,
  },
})
const input = () => ({
  question: 'Synthetic question',
  variants: ['Synthetic variant'],
  answer_ru: 'Тестовый ответ',
  category: 'test',
  status: 'active' as const,
})
const create = (overrides = {}) =>
  createZhoraKbEntry({ ...input(), ...overrides }, 'test-user-1')
async function indexed(overrides = {}, embedding = vector()) {
  // Existing indexed data, deliberately bypassing the CRUD producer.
  const entry = await prismaSupport.zhoraKbEntry.create({
    data: {
      ...input(),
      translations: {},
      updatedById: 'test-user-1',
      ...overrides,
    },
  })
  await prismaSupport.$executeRaw`
    UPDATE zhora_kb_entries SET embedding = ${JSON.stringify(embedding)}::public.vector,
      embedding_model = ${flags.model}, embedding_hash = md5(question || chr(10) || variants::text || chr(10) || answer_ru),
      embedding_indexed_at = NOW()
    WHERE id = ${entry.id}::uuid
  `
  return entry
}
const search = (originDomain?: string, minScore = 0.75) =>
  findZhoraKbMatches(vector(), { originDomain, minScore })

beforeAll(async () => {
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
  flags.enabled = true
  flags.model = 'test/embedding'
  generate.mockReset().mockImplementation(async () => result())
  await prismaSupport.zhoraJob.deleteMany()
  await prismaSupport.zhoraLlmCall.deleteMany()
  await prismaSupport.zhoraMonthlyBudget.deleteMany()
  await prismaSupport.zhoraKbEntry.deleteMany()
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

describe('Zhora KB indexing and pgvector search', () => {
  it('queues active imports immediately and indexes them once through the audited worker', async () => {
    await create({ status: 'draft' })
    await importZhoraKbEntries(
      [
        {
          ...input(),
          notes: ['Verify status.'],
          dynamic_fields: ['request_status'],
          ask_user: ['Request ID'],
          is_temporary: true,
        },
      ],
      'test-user-2'
    )
    expect(await prismaSupport.zhoraJob.count()).toBe(1)
    await Promise.all([
      enqueuePendingKbEmbeddings(),
      enqueuePendingKbEmbeddings(),
    ])
    expect(await prismaSupport.zhoraJob.count()).toBe(1)
    expect(generate).not.toHaveBeenCalled()
    const before = await prismaSupport.zhoraKbEntry.findFirstOrThrow({
      where: { status: 'active' },
    })
    const stop = startZhoraWorker()
    try {
      await vi.waitFor(async () => {
        expect((await prismaSupport.zhoraJob.findFirstOrThrow()).status).toBe(
          'completed'
        )
      })
    } finally {
      await stop()
    }
    const after = await prismaSupport.zhoraKbEntry.findUniqueOrThrow({
      where: { id: before.id },
    })
    expect(after.updatedAt).toEqual(before.updatedAt)
    expect(after.updatedById).toBe('test-user-2')
    expect(await search()).toEqual([
      expect.objectContaining({
        id: before.id,
        notes: ['Verify status.'],
        dynamic_fields: ['request_status'],
        ask_user: ['Request ID'],
        is_temporary: true,
      }),
    ])
    const job = await prismaSupport.zhoraJob.findFirstOrThrow()
    expect(job).toMatchObject({
      operation: 'embedding',
      status: 'completed',
      result: { indexed: true },
    })
    const call = await prismaSupport.zhoraLlmCall.findUniqueOrThrow({
      where: { id: job.callId! },
    })
    expect(call).toMatchObject({
      operation: 'embedding',
      model: flags.model,
      inputTokens: 20,
      outputTokens: 0,
      outcome: 'ok',
    })
    expect(call.costUsd!.toNumber()).toBe(0.001)
    expect(
      (
        await prismaSupport.zhoraMonthlyBudget.findFirstOrThrow()
      ).spentUsd.toNumber()
    ).toBe(0.001)
    expect(generate.mock.calls[0]![0].input).toContain('Synthetic question')
    expect(generate.mock.calls[0]![0].input).toContain('Тестовый ответ')
    await runZhoraJobPass()
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('orders eligible results and filters drafts, domains, stale vectors, models and threshold', async () => {
    const global = await indexed()
    const domain = await indexed({ domains: ['binodex.io'] }, vector(0.8, 0.6))
    await indexed({ domains: ['other.example'] })
    await indexed({ status: 'draft' })
    const stale = await indexed()
    await prismaSupport.zhoraKbEntry.update({
      where: { id: stale.id },
      data: { answer_ru: 'Изменённый ответ' },
    })
    const oldModel = await indexed()
    await prismaSupport.zhoraKbEntry.update({
      where: { id: oldModel.id },
      data: { embeddingModel: 'test/old-model' },
    })
    const found = await search('BINODEX.IO')
    expect(found.map((entry) => entry.id)).toEqual([global.id, domain.id])
    expect(found[0]!.score).toBeCloseTo(1)
    expect(found[1]!.score).toBeCloseTo(0.8)
    expect((await search()).map((entry) => entry.id)).toEqual([global.id])
    expect((await search('binodex.io', 0.9)).map((entry) => entry.id)).toEqual([
      global.id,
    ])
    expect(await search('binodex.io', 1)).toEqual([
      expect.objectContaining({ id: global.id }),
    ])
  })

  it('returns at most five results and rejects a missing threshold or invalid vectors', async () => {
    for (let index = 0; index < 7; index++) await indexed()
    expect(await search()).toHaveLength(5)
    expect(
      await findZhoraKbMatches(vector(), { minScore: 0.5, limit: 2 })
    ).toHaveLength(2)
    await expect(
      findZhoraKbMatches(vector(), { minScore: Number.NaN })
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      findZhoraKbMatches([1, 0], { minScore: 0.5 })
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('immediately excludes edits and reindexes new content without reindexing metadata changes', async () => {
    const entry = await indexed()
    await updateZhoraKbEntry(
      entry.id,
      { category: 'other-category', domains: ['binodex.io'] },
      'test-user-2'
    )
    await enqueuePendingKbEmbeddings()
    expect(await prismaSupport.zhoraJob.count()).toBe(0)
    await updateZhoraKbEntry(
      entry.id,
      { question: 'Updated question' },
      'test-user-2'
    )
    expect(await search('binodex.io')).toHaveLength(0)
    await runZhoraJobPass()
    expect(await search('binodex.io')).toHaveLength(1)
    expect(generate).toHaveBeenCalledTimes(1)
    await updateZhoraKbEntry(entry.id, { status: 'draft' }, 'test-user-2')
    expect(await search('binodex.io')).toHaveLength(0)
  })

  it('does not save a vector when the text changes during its generation', async () => {
    const entry = await create()
    const originalJob = await prismaSupport.zhoraJob.findFirstOrThrow()
    generate.mockImplementationOnce(async () => {
      await updateZhoraKbEntry(
        entry.id,
        { answer_ru: 'Новая версия' },
        'test-user-2'
      )
      return result()
    })
    await runZhoraJobPass()
    expect(
      (
        await prismaSupport.zhoraJob.findUniqueOrThrow({
          where: { id: originalJob.id },
        })
      ).result
    ).toEqual({
      indexed: false,
    })
    expect(await search()).toHaveLength(0)
    await runZhoraJobPass()
    expect(await search()).toHaveLength(1)
    expect(generate).toHaveBeenCalledTimes(2)
  })

  it('skips obsolete queued jobs before calling AI', async () => {
    const entry = await create()
    await enqueuePendingKbEmbeddings()
    await updateZhoraKbEntry(
      entry.id,
      { answer_ru: 'Изменено до выполнения' },
      'test-user-2'
    )
    await runZhoraJobPass()
    expect(generate).not.toHaveBeenCalled()
    await runZhoraJobPass()
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('supports model changes including switching back to a previously used model', async () => {
    await create()
    for (const model of [
      'test/embedding',
      'test/other',
      'test/embedding',
      'test/other',
    ]) {
      flags.model = model
      expect(await search()).toHaveLength(0)
      await enqueuePendingKbEmbeddings()
      await runZhoraJobPass()
      expect(await search()).toHaveLength(1)
    }
    expect(generate).toHaveBeenCalledTimes(4)
  })

  it('blocks embedding calls at the budget limit and does not run workers when disabled', async () => {
    flags.enabled = false
    await create()
    await runZhoraJobPass()
    expect(
      await prismaSupport.zhoraJob.count({ where: { status: 'queued' } })
    ).toBe(1)
    flags.enabled = true
    await prismaSupport.zhoraMonthlyBudget.create({
      data: { month: '2055-01', spentUsd: 1, exhaustedAt: new Date() },
    })
    await runZhoraJobPass()
    expect((await prismaSupport.zhoraJob.findFirstOrThrow()).errorCode).toBe(
      'budget_exhausted'
    )
    expect(generate).not.toHaveBeenCalled()
  })

  it('never replays an uncertain embedding request automatically', async () => {
    await create()
    const metadata = result()
    metadata.usage.costUsd = null
    generate.mockRejectedValueOnce(new OpenRouterError('timeout', metadata))
    await runZhoraJobPass()
    const job = await prismaSupport.zhoraJob.findFirstOrThrow()
    expect(job.status).toBe('uncertain')
    await enqueuePendingKbEmbeddings()
    await runZhoraJobPass()
    expect(generate).toHaveBeenCalledTimes(1)
    expect(await prismaSupport.zhoraJob.count()).toBe(1)
    expect(await search()).toHaveLength(0)
  })

  it('audits query embeddings with ticket context and avoids paid calls if no eligible KB exists', async () => {
    expect(
      await searchZhoraKb({ question: 'Synthetic question', minScore: 0.5 })
    ).toHaveLength(0)
    expect(generate).not.toHaveBeenCalled()
    const entry = await indexed()
    const ticket = await prismaSupport.supportTicket.create({
      data: { userId: 'synthetic-embedding-user', userNId: 123 },
    })
    try {
      expect(
        await searchZhoraKb({
          question: 'Synthetic question',
          minScore: 0.5,
          ticketId: ticket.id,
        })
      ).toEqual([expect.objectContaining({ id: entry.id })])
      expect(generate.mock.calls[0]![0].input).toContain(
        'Query: Synthetic question'
      )
      expect(
        await prismaSupport.zhoraLlmCall.count({
          where: { operation: 'embedding', ticketId: ticket.id },
        })
      ).toBe(1)
    } finally {
      await prismaSupport.supportTicket.delete({ where: { id: ticket.id } })
    }
  })

  it('rolls back creates, activation, content edits and imports when enqueueing fails', async () => {
    const draft = await create({ status: 'draft' })
    const active = await indexed()
    // Inject a queue write failure in this test's isolated schema. Unlike a
    // mocked helper, PostgreSQL itself verifies the transaction rollback.
    await prismaSupport.$executeRawUnsafe(
      `CREATE FUNCTION reject_kb_test_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic queue failure'; END $$`
    )
    await prismaSupport.$executeRawUnsafe(
      `CREATE TRIGGER reject_kb_test_job BEFORE INSERT ON zhora_jobs FOR EACH ROW EXECUTE FUNCTION reject_kb_test_job()`
    )
    try {
      await expect(create()).rejects.toThrow()
      await expect(
        updateZhoraKbEntry(draft.id, { status: 'active' }, 'test-user-2')
      ).rejects.toThrow()
      await expect(
        updateZhoraKbEntry(
          active.id,
          { answer_ru: 'Changed answer' },
          'test-user-2'
        )
      ).rejects.toThrow()
      await expect(
        importZhoraKbEntries(
          [input(), { ...input(), status: 'draft' }],
          'test-user-2'
        )
      ).rejects.toThrow()
      expect(await prismaSupport.zhoraKbEntry.count()).toBe(2)
      expect(await prismaSupport.zhoraJob.count()).toBe(0)
      expect(
        await prismaSupport.zhoraKbEntry.findUniqueOrThrow({
          where: { id: draft.id },
        })
      ).toMatchObject({ status: 'draft', updatedById: 'test-user-1' })
      expect(
        await prismaSupport.zhoraKbEntry.findUniqueOrThrow({
          where: { id: active.id },
        })
      ).toMatchObject({
        answer_ru: input().answer_ru,
        updatedById: 'test-user-1',
      })
      expect((await search()).map((entry) => entry.id)).toEqual([active.id])
    } finally {
      await prismaSupport.$executeRawUnsafe(
        'DROP TRIGGER reject_kb_test_job ON zhora_jobs'
      )
      await prismaSupport.$executeRawUnsafe(
        'DROP FUNCTION reject_kb_test_job()'
      )
    }
  })

  it('reconciles external writes in primary-key pages without rescanning them on every job pass', async () => {
    await prismaSupport.zhoraKbEntry.createMany({
      data: Array.from({ length: 45 }, () => ({
        ...input(),
        translations: {},
        updatedById: 'test-user-1',
      })),
    })
    await runZhoraJobPass()
    expect(await prismaSupport.zhoraJob.count()).toBe(0)
    expect(generate).not.toHaveBeenCalled()
    const first = await enqueuePendingKbEmbeddings()
    expect(first.queued).toBe(20)
    expect(first.nextCursor).not.toBeNull()
    // A page containing only already-queued records still advances the cursor.
    const repeated = await enqueuePendingKbEmbeddings()
    expect(repeated.queued).toBe(0)
    expect(repeated.nextCursor).toBe(first.nextCursor)
    const second = await enqueuePendingKbEmbeddings(first.nextCursor)
    expect(second.queued).toBe(20)
    const last = await enqueuePendingKbEmbeddings(second.nextCursor)
    expect(last).toEqual({ queued: 5, nextCursor: null })
    expect(await prismaSupport.zhoraJob.count()).toBe(45)
  })
})
