import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '@prisma-support'

vi.mock('@apps/services/zhora/openrouter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@apps/services/zhora/openrouter')>()),
  generateZhoraText: vi.fn(),
}))

import { prismaSupport } from '@config/database'
import { logger } from '@config/logger'
import {
  generateZhoraText,
  OpenRouterError,
  type OpenRouterResult,
} from '@apps/services/zhora/openrouter'
import { generateZhoraTextWithJournal } from '@apps/services/zhora/llm.service'

const prompt = {
  operation: 'reply' as const,
  systemPrompt: 'Synthetic rules',
  input: 'Private synthetic question',
}
const result: OpenRouterResult = {
  text: 'Private synthetic answer',
  model: 'test/actual-model',
  generationId: 'test-generation',
  usage: {
    inputTokens: 100,
    outputTokens: 20,
    costUsd: 0.000000123456,
    cachedTokens: null,
    cacheWriteTokens: null,
  },
  durationMs: 150,
}
const generate = vi.mocked(generateZhoraText)
const disconnected = () =>
  new Prisma.PrismaClientKnownRequestError('Private connection details', {
    code: 'P1017',
    clientVersion: 'test',
  })
let ticketId: string
let agentId: string

beforeEach(async () => {
  generate.mockReset()
  generate.mockResolvedValue(result)
  ticketId = (
    await prismaSupport.supportTicket.create({
      data: { userId: randomUUID(), userNId: 123 },
    })
  ).id
  agentId = (
    await prismaSupport.supportAgent.create({
      data: {
        tgUserId: BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 12)}`),
        displayName: 'Journal test operator',
      },
    })
  ).id
})

afterEach(async () => {
  vi.restoreAllMocks()
  await prismaSupport.zhoraLlmCall.deleteMany({ where: { ticketId } })
  await prismaSupport.supportTicket.delete({ where: { id: ticketId } })
  await prismaSupport.supportAgent.delete({ where: { id: agentId } })
})

describe('Zhora call journal', () => {
  it('stores actual usage and ticket/operator context without changing the answer', async () => {
    expect(
      await generateZhoraTextWithJournal(prompt, { ticketId, agentId })
    ).toBe(result)
    const rows = await prismaSupport.zhoraLlmCall.findMany({
      where: { ticketId },
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      operation: 'reply',
      ticketId,
      agentId,
      model: 'test/actual-model',
      inputTokens: 100,
      outputTokens: 20,
      durationMs: 150,
      outcome: 'ok',
    })
    expect(rows[0]!.costUsd!.equals('0.000000123456')).toBe(true)
  })

  it.each([
    ['provider_error', result.usage],
    [
      'timeout',
      { ...result.usage, inputTokens: null, outputTokens: null, costUsd: null },
    ],
  ] as const)(
    'records %s and preserves the original error and known cost',
    async (code, usage) => {
      const error = new OpenRouterError(code, { ...result, usage })
      generate.mockRejectedValue(error)
      await expect(
        generateZhoraTextWithJournal(prompt, { ticketId })
      ).rejects.toBe(error)
      const row = await prismaSupport.zhoraLlmCall.findFirstOrThrow({
        where: { ticketId },
      })
      expect(row.outcome).toBe(code)
      expect(row.agentId).toBeNull()
      expect(row.costUsd?.toNumber() ?? null).toBe(usage.costUsd)
    }
  )

  it('retries a lost acknowledgement without duplicating the row or AI request', async () => {
    const original = prismaSupport.zhoraLlmCall.upsert.bind(
      prismaSupport.zhoraLlmCall
    )
    const write = vi.spyOn(prismaSupport.zhoraLlmCall, 'upsert')
    // This service only awaits upsert; the mock does not need Prisma's
    // additional fluent relation methods on the returned promise.
    write.mockImplementationOnce((async (
      args: Prisma.ZhoraLlmCallUpsertArgs
    ) => {
      await original(args)
      throw disconnected()
    }) as unknown as typeof prismaSupport.zhoraLlmCall.upsert)
    expect(await generateZhoraTextWithJournal(prompt, { ticketId })).toBe(
      result
    )
    expect(write).toHaveBeenCalledTimes(2)
    expect(generate).toHaveBeenCalledTimes(1)
    expect(
      await prismaSupport.zhoraLlmCall.count({ where: { ticketId } })
    ).toBe(1)
  })

  it('returns the paid result after exhausted DB retries and logs no private content', async () => {
    const write = vi
      .spyOn(prismaSupport.zhoraLlmCall, 'upsert')
      .mockRejectedValue(disconnected())
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger)
    expect(await generateZhoraTextWithJournal(prompt, { ticketId })).toBe(
      result
    )
    expect(write).toHaveBeenCalledTimes(3)
    expect(generate).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    const message = String(warn.mock.calls[0]![0])
    expect(message).toContain('journal write failed')
    expect(message).not.toContain('Private')
  })

  it('does not retry invalid DB data or replace the original provider error', async () => {
    const write = vi
      .spyOn(prismaSupport.zhoraLlmCall, 'upsert')
      .mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Private invalid data', {
          code: 'P2003',
          clientVersion: 'test',
        })
      )
    vi.spyOn(logger, 'warn').mockImplementation(() => logger)
    const error = new OpenRouterError('provider_error', result)
    generate.mockRejectedValue(error)
    await expect(
      generateZhoraTextWithJournal(prompt, { ticketId })
    ).rejects.toBe(error)
    expect(write).toHaveBeenCalledTimes(1)
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('does not create provider-call records for local refusals', async () => {
    generate.mockRejectedValue(new OpenRouterError('disabled'))
    await expect(
      generateZhoraTextWithJournal(prompt, { ticketId })
    ).rejects.toMatchObject({ code: 'disabled' })
    expect(
      await prismaSupport.zhoraLlmCall.count({ where: { ticketId } })
    ).toBe(0)
  })
})
