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

const isolated = vi.hoisted(() => ({ schema: '', url: '' }))
vi.mock('@config/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@config/database')>()
  const { PrismaClient } = await import('@prisma-support')
  const { randomUUID } = await import('node:crypto')
  isolated.schema = `zhora_budget_${randomUUID().replaceAll('-', '')}`
  const url = new URL(process.env.DATABASE_SUPPORT!)
  url.searchParams.set('schema', isolated.schema)
  isolated.url = url.toString()
  return {
    ...actual,
    prismaSupport: new PrismaClient({
      datasources: { db: { url: isolated.url } },
    }),
  }
})
vi.mock('@config/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@config/env')>()),
  ZHORA_ENABLED: true,
  ZHORA_OPENROUTER_API_KEY: 'fake-budget-test-key',
  ZHORA_MODEL_REPLY: 'test/reply',
  ZHORA_MODEL_TRANSLATE: 'test/translate',
  ZHORA_MONTHLY_BUDGET_USD: 1,
  TELEGRAM_CHAT_ID: -1002000000001,
}))
vi.mock('@apps/services/zhora/openrouter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@apps/services/zhora/openrouter')>()),
  generateZhoraText: vi.fn(),
  getOpenRouterMonthlyUsage: vi.fn(),
  getOpenRouterGenerationCost: vi.fn(),
}))
vi.mock('@telegram/api', () => ({ sendPlainMessage: vi.fn(async () => 123) }))

import { Prisma } from '@prisma-support'
import { prismaSupport } from '@config/database'
import { logger } from '@config/logger'
import { sendPlainMessage } from '@telegram/api'
import {
  generateZhoraText,
  getOpenRouterMonthlyUsage,
  getOpenRouterGenerationCost,
  OpenRouterError,
  type OpenRouterResult,
} from '@apps/services/zhora/openrouter'
import { assertZhoraBudget } from '@apps/services/zhora/budget.service'
import { generateZhoraTextWithJournal } from '@apps/services/zhora/llm.service'

const month = '2051-08'
const prompt = {
  operation: 'reply' as const,
  systemPrompt: 'Synthetic rules',
  input: 'Synthetic question',
}
const generate = vi.mocked(generateZhoraText)
const monthly = vi.mocked(getOpenRouterMonthlyUsage)
const generationCost = vi.mocked(getOpenRouterGenerationCost)
const notice = vi.mocked(sendPlainMessage)
const databaseMethods = {
  findBudget: prismaSupport.zhoraMonthlyBudget.findFirst,
  createCall: prismaSupport.zhoraLlmCall.create,
  upsertCall: prismaSupport.zhoraLlmCall.upsert,
}
const answer = (costUsd: number | null = 0.1): OpenRouterResult => ({
  text: 'Synthetic answer',
  model: 'test/reply',
  generationId: 'gen-test',
  durationMs: 10,
  usage: {
    inputTokens: 10,
    outputTokens: 5,
    costUsd,
    cachedTokens: null,
    cacheWriteTokens: null,
  },
})

beforeAll(() => {
  // Private schema: neither budget state nor cleanup touches existing local data.
  const cli = path.join(
    path.dirname(require.resolve('prisma/package.json')),
    'build/index.js'
  )
  execFileSync(
    process.execPath,
    [cli, 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'],
    {
      cwd: path.resolve(__dirname, '../..'),
      env: { ...process.env, DATABASE_SUPPORT: isolated.url },
      stdio: 'pipe',
    }
  )
})
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(`${month}-15T12:00:00Z`))
  generate.mockReset().mockImplementation(async () => answer())
  monthly.mockReset().mockResolvedValue({ month, costUsd: 0 })
  generationCost.mockReset().mockResolvedValue(0.2)
  notice.mockReset().mockResolvedValue(123)
  vi.spyOn(logger, 'warn').mockImplementation(() => logger)
  await prismaSupport.zhoraLlmCall.deleteMany()
  await prismaSupport.zhoraMonthlyBudget.deleteMany()
})
afterEach(() => {
  vi.restoreAllMocks()
  // Prisma delegates are dynamic proxies; Vitest 1 can restore their method
  // descriptors to undefined. Keep the real functions for the next test.
  prismaSupport.zhoraMonthlyBudget.findFirst = databaseMethods.findBudget
  prismaSupport.zhoraLlmCall.create = databaseMethods.createCall
  prismaSupport.zhoraLlmCall.upsert = databaseMethods.upsertCall
  vi.useRealTimers()
})
afterAll(async () => {
  try {
    await prismaSupport.$executeRawUnsafe(
      `DROP SCHEMA IF EXISTS "${isolated.schema}" CASCADE`
    )
  } finally {
    await prismaSupport.$disconnect()
  }
})

describe('Zhora monthly budget', () => {
  it('uses local costs in the UTC month after bootstrapping the dedicated key', async () => {
    vi.setSystemTime(new Date('2051-09-01T00:30:00+03:00')) // Still August UTC.
    await prismaSupport.zhoraLlmCall.create({
      data: {
        operation: 'reply',
        model: 'test/reply',
        costUsd: 5,
        outcome: 'ok',
        createdAt: new Date('2051-07-31T23:59:59Z'),
      },
    })
    await expect(generateZhoraTextWithJournal(prompt)).resolves.toMatchObject({
      text: 'Synthetic answer',
    })
    await generateZhoraTextWithJournal(prompt)
    expect(monthly).toHaveBeenCalledTimes(1)
    const budget = await prismaSupport.zhoraMonthlyBudget.findUniqueOrThrow({
      where: { month },
    })
    expect(budget.spentUsd.equals('0.2')).toBe(true)
    expect(budget.exhaustedAt).toBeNull()
    expect(notice).not.toHaveBeenCalled()
  })

  it('blocks every operation at the exact limit and keeps the stop across month rollover', async () => {
    monthly.mockResolvedValue({ month, costUsd: 1 })
    await expect(generateZhoraTextWithJournal(prompt)).rejects.toMatchObject({
      code: 'budget_exhausted',
    })
    await expect(
      generateZhoraTextWithJournal({ ...prompt, operation: 'translate' })
    ).rejects.toMatchObject({ code: 'budget_exhausted' })
    vi.setSystemTime(new Date('2051-09-01T00:00:00Z'))
    await expect(assertZhoraBudget()).rejects.toMatchObject({
      code: 'budget_exhausted',
    })
    expect(generate).not.toHaveBeenCalled()
    expect(notice).toHaveBeenCalledTimes(1)
    expect(notice.mock.calls[0]![0]).toMatchObject({ topicId: null })
    expect(await prismaSupport.zhoraMonthlyBudget.count()).toBe(1)
  })

  it('finishes concurrent admitted calls, records both charges and sends one notice', async () => {
    await prismaSupport.zhoraMonthlyBudget.create({ data: { month } })
    const finish: Array<(value: OpenRouterResult) => void> = []
    generate.mockImplementation(
      () => new Promise((resolve) => finish.push(resolve))
    )
    const calls = [
      generateZhoraTextWithJournal(prompt),
      generateZhoraTextWithJournal(prompt),
    ]
    await vi.waitFor(() => expect(finish).toHaveLength(2))
    finish.forEach((resolve) => resolve(answer(0.6)))
    await Promise.all(calls)
    const budget = await prismaSupport.zhoraMonthlyBudget.findUniqueOrThrow({
      where: { month },
    })
    expect(budget.spentUsd.equals('1.2')).toBe(true)
    expect(await prismaSupport.zhoraLlmCall.count()).toBe(2)
    await expect(assertZhoraBudget()).rejects.toMatchObject({
      code: 'budget_exhausted',
    })
    expect(generate).toHaveBeenCalledTimes(2)
    expect(notice).toHaveBeenCalledTimes(1)
  })

  it('resolves missing cost by generation ID and counts paid provider failures', async () => {
    generate.mockResolvedValueOnce(answer(null))
    const resolved = await generateZhoraTextWithJournal(prompt)
    expect(resolved.usage.costUsd).toBe(0.2)
    expect(generationCost).toHaveBeenCalledWith('gen-test')
    const error = new OpenRouterError('provider_error', answer(0.8))
    generate.mockRejectedValueOnce(error)
    await expect(generateZhoraTextWithJournal(prompt)).rejects.toBe(error)
    const budget = await prismaSupport.zhoraMonthlyBudget.findUniqueOrThrow({
      where: { month },
    })
    expect(budget.spentUsd.equals('1')).toBe(true)
    expect(budget.exhaustedAt).not.toBeNull()
    expect(notice).toHaveBeenCalledTimes(1)
  })

  it('keeps unknown cost null and refuses new calls when key reconciliation is unavailable', async () => {
    generationCost.mockRejectedValue(
      new Error('Synthetic unavailable metadata')
    )
    generate.mockResolvedValueOnce(answer(null))
    const resolved = await generateZhoraTextWithJournal(prompt)
    expect(resolved.usage.costUsd).toBeNull()
    expect(
      (await prismaSupport.zhoraLlmCall.findFirstOrThrow()).costUsd
    ).toBeNull()
    monthly.mockRejectedValue(new Error('Synthetic unavailable accounting'))
    await expect(generateZhoraTextWithJournal(prompt)).rejects.toMatchObject({
      code: 'budget_unavailable',
    })
    expect(generate).toHaveBeenCalledTimes(1)
    monthly.mockResolvedValue({ month, costUsd: 1 })
    await expect(generateZhoraTextWithJournal(prompt)).rejects.toMatchObject({
      code: 'budget_exhausted',
    })
  })

  it('does not generate when the budget read or initial journal write fails', async () => {
    vi.spyOn(
      prismaSupport.zhoraMonthlyBudget,
      'findFirst'
    ).mockRejectedValueOnce(new Error('Private DB details'))
    await expect(generateZhoraTextWithJournal(prompt)).rejects.toMatchObject({
      code: 'budget_unavailable',
    })
    vi.spyOn(prismaSupport.zhoraLlmCall, 'create').mockRejectedValueOnce(
      new Error('Private DB details')
    )
    await expect(generateZhoraTextWithJournal(prompt)).rejects.toMatchObject({
      code: 'budget_unavailable',
    })
    expect(generate).not.toHaveBeenCalled()
  })

  it('returns a ready answer after failed final writes and reconciles its durable pending record', async () => {
    const write = vi
      .spyOn(prismaSupport.zhoraLlmCall, 'upsert')
      .mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Synthetic disconnect', {
          code: 'P1017',
          clientVersion: 'test',
        })
      )
    await expect(generateZhoraTextWithJournal(prompt)).resolves.toMatchObject({
      text: 'Synthetic answer',
    })
    expect(write).toHaveBeenCalledTimes(3)
    const pending = await prismaSupport.zhoraLlmCall.findFirstOrThrow()
    expect(pending.outcome).toBeNull()
    monthly.mockResolvedValue({ month, costUsd: 1 })
    await expect(generateZhoraTextWithJournal(prompt)).rejects.toMatchObject({
      code: 'budget_exhausted',
    })
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('retries an unconfirmed General notice on a later check but not a confirmed one', async () => {
    monthly.mockResolvedValue({ month, costUsd: 1 })
    notice.mockResolvedValueOnce(null)
    await expect(assertZhoraBudget()).rejects.toMatchObject({
      code: 'budget_exhausted',
    })
    expect(
      (
        await prismaSupport.zhoraMonthlyBudget.findUniqueOrThrow({
          where: { month },
        })
      ).notifiedAt
    ).toBeNull()
    await expect(assertZhoraBudget()).rejects.toMatchObject({
      code: 'budget_exhausted',
    })
    await expect(assertZhoraBudget()).rejects.toMatchObject({
      code: 'budget_exhausted',
    })
    expect(notice).toHaveBeenCalledTimes(2)
  })
})
