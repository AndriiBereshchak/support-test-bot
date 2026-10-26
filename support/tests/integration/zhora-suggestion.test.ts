import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
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
  settings.schema = `zhora_suggestion_${randomUUID().replaceAll('-', '')}`
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
  ZHORA_ENABLED: true,
  ZHORA_OPENROUTER_API_KEY: 'synthetic-suggestion-test-key',
  ZHORA_MODEL_REPLY: 'test/reply',
}))
vi.mock('@apps/services/zhora/context.service', () => ({
  buildZhoraContext: vi.fn(),
}))
vi.mock('@apps/services/zhora/llm.service', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@apps/services/zhora/llm.service')
  >()),
  generateZhoraTextWithJournal: vi.fn(),
}))
vi.mock('@telegram/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@telegram/api')>()),
  sendPlainMessage: vi.fn(async () => 12345),
}))

import { prismaSupport } from '@config/database'
import { appendMessage } from '@apps/services/message.service'
import {
  buildZhoraContext,
  type ZhoraContext,
} from '@apps/services/zhora/context.service'
import { generateZhoraTextWithJournal } from '@apps/services/zhora/llm.service'
import { runZhoraJobPass } from '@apps/services/zhora/job.service'
import { requestZhoraSuggestion } from '@apps/services/zhora/suggestion.service'
import { runZhoraSuggestionPreviewPass } from '@apps/services/zhora/suggestion-preview.service'
import { sendPlainMessage } from '@telegram/api'

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
  vi.clearAllMocks()
  await prismaSupport.zhoraJob.deleteMany()
  await prismaSupport.supportTicket.deleteMany()
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

async function customerMessage(text: string, language: string | null) {
  const ticket = await prismaSupport.supportTicket.create({
    data: {
      userId: randomUUID(),
      userNId: 123,
      detectedLang: language,
      detectedLangSeq: language ? 1 : 0,
    },
  })
  const { message } = await appendMessage({
    ticketId: ticket.id,
    direction: 'IN',
    text,
  })
  return { ticket, message }
}

describe('Zhora answer requests', () => {
  it('creates one paid job for a repeated event and stores only a draft', async () => {
    const { ticket, message } = await customerMessage('Kiedy wypłata?', 'pl')
    vi.mocked(buildZhoraContext).mockResolvedValue({
      ticket,
      targetMessage: {
        id: message.id,
        seq: message.seq,
        author: 'customer',
        agentId: null,
        agentName: null,
        text: message.text,
        attachments: [],
        createdAt: message.createdAt,
      },
      history: [],
      searchQuery: message.text ?? '',
      userCard: null,
      deposits: [],
      withdrawals: [],
      knowledge: [
        {
          id: 'kb-source-1',
          code: 'DEP_001',
          question: 'Deposit question',
          variants: [],
          answer_ru: 'Проверьте депозит.',
          translations: {},
          category: 'deposit',
          domains: [],
          notes: [],
          dynamic_fields: [],
          ask_user: [],
          is_temporary: false,
          score: 0.9,
        },
      ],
      kbConfig: null,
      unavailable: [],
    } as unknown as ZhoraContext)
    vi.mocked(generateZhoraTextWithJournal).mockResolvedValue({
      text: JSON.stringify({
        answer: 'Proszę podać ID wypłaty.',
        answerRu: 'Пожалуйста, укажите ID вывода.',
        sourceKbIds: ['kb-source-1'],
        needsReview: true,
      }),
      model: 'test/reply',
      generationId: null,
      durationMs: 1,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
        cachedTokens: null,
        cacheWriteTokens: null,
      },
    })

    const input = {
      ticketId: ticket.id,
      messageId: message.id,
      eventKey: 'reply:cmd:-100:123',
    }
    const first = await requestZhoraSuggestion(input)
    const repeated = await requestZhoraSuggestion(input)
    expect(first.created).toBe(true)
    expect(repeated).toMatchObject({
      created: false,
      suggestion: { id: first.suggestion.id },
    })
    expect(await prismaSupport.zhoraJob.count()).toBe(1)

    await runZhoraJobPass()
    const job = await prismaSupport.zhoraJob.findUniqueOrThrow({
      where: { eventKey: input.eventKey },
    })
    expect(job.status).toBe('completed')
    expect(job.result).toMatchObject({
      answer: 'Proszę podać ID wypłaty.',
      needsReview: true,
    })
    expect(vi.mocked(generateZhoraTextWithJournal)).toHaveBeenCalledTimes(1)
    expect(
      await prismaSupport.supportMessage.count({
        where: { ticketId: ticket.id, direction: 'OUT' },
      })
    ).toBe(0)

    await prismaSupport.supportTicket.update({
      where: { id: ticket.id },
      data: { tgChatId: -1002000000001n, tgTopicId: 777 },
    })
    await runZhoraSuggestionPreviewPass()
    await runZhoraSuggestionPreviewPass()
    expect(vi.mocked(sendPlainMessage)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendPlainMessage).mock.calls[0]![0]).toMatchObject({
      topicId: 777,
      text: expect.stringContaining('Источник: KB DEP_001 «Deposit question»'),
    })
    expect(
      (
        await prismaSupport.zhoraSuggestion.findUniqueOrThrow({
          where: { id: first.suggestion.id },
        })
      ).previewSentAt
    ).toBeInstanceOf(Date)

    const deliberate = await requestZhoraSuggestion({
      ...input,
      eventKey: 'reply:cmd:-100:124',
    })
    expect(deliberate.created).toBe(true)
    expect(await prismaSupport.zhoraJob.count()).toBe(2)
  })

  it('resumes a long preview after partial delivery', async () => {
    const { ticket } = await customerMessage('Question', 'en')
    await prismaSupport.supportTicket.update({
      where: { id: ticket.id },
      data: { tgChatId: -1002000000001n, tgTopicId: 778 },
    })
    const { suggestion } = await requestZhoraSuggestion({
      ticketId: ticket.id,
      eventKey: 'reply:cmd:-100:126',
    })
    const longAnswer = `${'Answer '.repeat(400)}\n${'Detail '.repeat(200)}`
    await prismaSupport.zhoraJob.update({
      where: { id: suggestion.jobId },
      data: {
        status: 'completed',
        result: {
          answer: longAnswer,
          answerRu: 'Русский ответ',
          sourceKbIds: [],
          needsReview: true,
          sources: [],
        },
      },
    })
    vi.mocked(sendPlainMessage)
      .mockResolvedValueOnce(12345)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(12346)
    await runZhoraSuggestionPreviewPass()
    expect(vi.mocked(sendPlainMessage)).toHaveBeenCalledTimes(2)
    expect(
      (
        await prismaSupport.zhoraSuggestion.findUniqueOrThrow({
          where: { id: suggestion.id },
        })
      ).nextChunkIndex
    ).toBe(1)
    await prismaSupport.zhoraSuggestion.update({
      where: { id: suggestion.id },
      data: { previewSendingUntil: new Date(0) },
    })
    await runZhoraSuggestionPreviewPass()
    expect(vi.mocked(sendPlainMessage)).toHaveBeenCalledTimes(3)
    expect(vi.mocked(sendPlainMessage).mock.calls[2]![0].text).toContain(
      'Источник: ⚠ в базе нет ответа'
    )
    expect(
      (
        await prismaSupport.zhoraSuggestion.findUniqueOrThrow({
          where: { id: suggestion.id },
        })
      ).previewTgMessageId
    ).toBe(12346)
    expect(
      await prismaSupport.supportMessage.count({
        where: { ticketId: ticket.id, direction: 'OUT' },
      })
    ).toBe(0)
  })

  it('does not use a previous language while a newer message is pending', async () => {
    const { ticket } = await customerMessage('Hello', 'en')
    const { message } = await appendMessage({
      ticketId: ticket.id,
      direction: 'IN',
      text: 'Kiedy wypłata?',
      translationPending: true,
    })
    const args = { ticketId: ticket.id, eventKey: 'reply:cmd:-100:125' }
    await expect(requestZhoraSuggestion(args)).rejects.toThrow(
      'Язык сообщения ещё определяется'
    )
    expect(await prismaSupport.zhoraJob.count()).toBe(0)

    await prismaSupport.supportTicket.update({
      where: { id: ticket.id },
      data: { detectedLang: 'pl', detectedLangSeq: message.seq },
    })
    const ready = await requestZhoraSuggestion(args)
    expect(ready.suggestion.language).toBe('pl')
    expect(ready.suggestion.targetMessageId).toBe(message.id)
  })
})
