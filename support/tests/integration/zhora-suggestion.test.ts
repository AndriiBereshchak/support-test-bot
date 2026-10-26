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
  ZHORA_MODEL_FIX: 'test/fix',
  ZHORA_MODEL_TRANSLATE: 'test/translate',
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
  sendMonospaceMessage: vi.fn(async () => 12346),
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
import { requestZhoraFix } from '@apps/services/zhora/suggestion-fix.service'
import { requestZhoraSuggestionAlternative } from '@apps/services/zhora/suggestion-alternative.service'
import { requestZhoraSuggestionVariant } from '@apps/services/zhora/suggestion-variant.service'
import { runZhoraSuggestionPreviewPass } from '@apps/services/zhora/suggestion-preview.service'
import { sendMonospaceMessage, sendPlainMessage } from '@telegram/api'

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
      replyMarkup: {
        inline_keyboard: [
          [
            {
              text: 'Отправить',
              callback_data: `zs:${first.suggestion.id}`,
            },
            {
              text: 'Скопировать',
              copy_text: { text: 'Proszę podać ID wypłaty.' },
            },
          ],
          [
            { text: 'Перевести', callback_data: `zt:${first.suggestion.id}` },
            { text: 'Ещё вариант', callback_data: `za:${first.suggestion.id}` },
          ],
          [{ text: 'Карточка', callback_data: `zc:${first.suggestion.id}` }],
        ],
      },
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
    const longAnswer = `${'Answer '.repeat(400)}\n${'Detail '.repeat(100)}`
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
    vi.mocked(sendPlainMessage).mockResolvedValueOnce(12345)
    vi.mocked(sendMonospaceMessage)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(12346)
    await runZhoraSuggestionPreviewPass()
    expect(vi.mocked(sendPlainMessage)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendMonospaceMessage)).toHaveBeenCalledTimes(1)
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
    expect(vi.mocked(sendPlainMessage)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendMonospaceMessage)).toHaveBeenCalledTimes(2)
    expect(
      vi.mocked(sendPlainMessage).mock.calls[0]![0].replyMarkup
    ).toBeUndefined()
    expect(
      vi.mocked(sendMonospaceMessage).mock.calls[1]![0].replyMarkup
    ).toEqual({
      inline_keyboard: [
        [{ text: 'Отправить', callback_data: `zs:${suggestion.id}` }],
        [
          { text: 'Перевести', callback_data: `zt:${suggestion.id}` },
          { text: 'Ещё вариант', callback_data: `za:${suggestion.id}` },
        ],
        [{ text: 'Карточка', callback_data: `zc:${suggestion.id}` }],
      ],
    })
    expect(vi.mocked(sendPlainMessage).mock.calls[0]![0].text).toContain(
      'Источник: ⚠ в базе нет ответа'
    )
    expect(vi.mocked(sendMonospaceMessage).mock.calls[1]![0].text).toBe(
      longAnswer
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

  it.each([256, 257])(
    'uses the copy button only up to %i characters',
    async (length) => {
      const { ticket } = await customerMessage('Question', 'en')
      await prismaSupport.supportTicket.update({
        where: { id: ticket.id },
        data: { tgChatId: -1002000000001n, tgTopicId: 781 },
      })
      const { suggestion } = await requestZhoraSuggestion({
        ticketId: ticket.id,
        eventKey: `reply:copy:${length}`,
      })
      const answer = 'A'.repeat(length)
      await prismaSupport.zhoraJob.update({
        where: { id: suggestion.jobId },
        data: {
          status: 'completed',
          result: {
            answer,
            answerRu: 'Русский ответ',
            sourceKbIds: [],
            needsReview: false,
            sources: [],
          },
        },
      })
      await runZhoraSuggestionPreviewPass()
      if (length === 256) {
        expect(vi.mocked(sendMonospaceMessage)).not.toHaveBeenCalled()
        expect(
          vi.mocked(sendPlainMessage).mock.calls[0]![0].replyMarkup
        ).toEqual({
          inline_keyboard: [
            [
              { text: 'Отправить', callback_data: `zs:${suggestion.id}` },
              { text: 'Скопировать', copy_text: { text: answer } },
            ],
            [
              { text: 'Перевести', callback_data: `zt:${suggestion.id}` },
              { text: 'Ещё вариант', callback_data: `za:${suggestion.id}` },
            ],
            [{ text: 'Карточка', callback_data: `zc:${suggestion.id}` }],
          ],
        })
      } else {
        expect(
          vi.mocked(sendPlainMessage).mock.calls[0]![0].replyMarkup
        ).toBeUndefined()
        expect(vi.mocked(sendMonospaceMessage).mock.calls[0]![0]).toMatchObject(
          {
            text: answer,
            replyMarkup: {
              inline_keyboard: [
                [{ text: 'Отправить', callback_data: `zs:${suggestion.id}` }],
                [
                  { text: 'Перевести', callback_data: `zt:${suggestion.id}` },
                  { text: 'Ещё вариант', callback_data: `za:${suggestion.id}` },
                ],
                [{ text: 'Карточка', callback_data: `zc:${suggestion.id}` }],
              ],
            },
          }
        )
      }
    }
  )

  it('splits an oversized copy into complete ordered code blocks', async () => {
    const { ticket } = await customerMessage('Question', 'en')
    await prismaSupport.supportTicket.update({
      where: { id: ticket.id },
      data: { tgChatId: -1002000000001n, tgTopicId: 780 },
    })
    const { suggestion } = await requestZhoraSuggestion({
      ticketId: ticket.id,
      eventKey: 'reply:copy:oversized',
    })
    const answer = `${'A'.repeat(4095)}😀${'B'.repeat(50)}`
    await prismaSupport.zhoraJob.update({
      where: { id: suggestion.jobId },
      data: {
        status: 'completed',
        result: {
          answer,
          answerRu: 'Русский ответ',
          sourceKbIds: [],
          needsReview: false,
          sources: [],
        },
      },
    })
    await runZhoraSuggestionPreviewPass()
    const copyCalls = vi
      .mocked(sendMonospaceMessage)
      .mock.calls.map(([args]) => args)
    expect(copyCalls).toHaveLength(2)
    expect(copyCalls.map((args) => args.text).join('')).toBe(answer)
    expect(copyCalls[0]!.text.length).toBeLessThanOrEqual(4096)
    expect(copyCalls[0]!.text.endsWith('😀')).toBe(false)
    expect(copyCalls[0]!.replyMarkup).toBeUndefined()
    expect(copyCalls[1]!.replyMarkup).toEqual({
      inline_keyboard: [
        [{ text: 'Отправить', callback_data: `zs:${suggestion.id}` }],
        [
          { text: 'Перевести', callback_data: `zt:${suggestion.id}` },
          { text: 'Ещё вариант', callback_data: `za:${suggestion.id}` },
        ],
        [{ text: 'Карточка', callback_data: `zc:${suggestion.id}` }],
      ],
    })
    expect(
      (
        await prismaSupport.zhoraSuggestion.findUniqueOrThrow({
          where: { id: suggestion.id },
        })
      ).nextChunkIndex
    ).toBe(
      vi.mocked(sendPlainMessage).mock.calls.length +
        vi.mocked(sendMonospaceMessage).mock.calls.length
    )
  })

  it.each(['failed', 'uncertain', 'malformed'])(
    'does not offer sending for an unusable result: %s',
    async (state) => {
      const { ticket } = await customerMessage('Question', 'en')
      await prismaSupport.supportTicket.update({
        where: { id: ticket.id },
        data: { tgChatId: -1002000000001n, tgTopicId: 779 },
      })
      const { suggestion } = await requestZhoraSuggestion({
        ticketId: ticket.id,
        eventKey: `reply:unusable:${state}`,
      })
      await prismaSupport.zhoraJob.update({
        where: { id: suggestion.jobId },
        data: {
          status: state === 'malformed' ? 'completed' : state,
          result: {
            answer: '',
            answerRu: 'RU',
            sources: [],
            needsReview: true,
          },
        },
      })
      await runZhoraSuggestionPreviewPass()
      expect(vi.mocked(sendPlainMessage)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(sendPlainMessage).mock.calls[0]![0]).toMatchObject({
        text: expect.stringContaining('Не удалось подготовить'),
      })
      expect(
        vi.mocked(sendPlainMessage).mock.calls[0]![0].replyMarkup
      ).toBeUndefined()
    }
  )

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

describe('Zhora /fix drafts', () => {
  it('deduplicates a typed draft, previews the edited text and never sends it to the customer', async () => {
    const { ticket, message } = await customerMessage('Please help', 'en')
    await prismaSupport.supportTicket.update({
      where: { id: ticket.id },
      data: { tgChatId: -1002000000001n, tgTopicId: 789 },
    })
    vi.mocked(generateZhoraTextWithJournal).mockResolvedValue({
      text: JSON.stringify({
        answer: 'Please send your account ID.',
        answerRu: 'Пожалуйста, укажите ID аккаунта.',
        needsReview: false,
      }),
      model: 'test/fix',
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
    const args = {
      eventKey: `fix:cmd:${randomUUID()}`,
      ticketId: ticket.id,
      agentId: null,
      text: 'дайте id аккаунта пожалуйста',
    }
    const first = await requestZhoraFix(args)
    const repeated = await requestZhoraFix(args)
    expect(repeated.suggestion.id).toBe(first.suggestion.id)
    expect(first.suggestion.targetMessageId).toBe(message.id)
    expect(first.suggestion.language).toBe('en')
    await runZhoraJobPass()
    const job = await prismaSupport.zhoraJob.findUniqueOrThrow({
      where: { id: first.suggestion.jobId },
    })
    expect(job.status).toBe('completed')
    expect(job.result).toMatchObject({
      kind: 'fix',
      answer: 'Please send your account ID.',
      answerRu: 'Пожалуйста, укажите ID аккаунта.',
    })
    expect(
      vi.mocked(generateZhoraTextWithJournal).mock.calls[0]![0]
    ).toMatchObject({
      operation: 'fix',
      input: expect.stringContaining('дайте id аккаунта пожалуйста'),
    })
    expect(buildZhoraContext).not.toHaveBeenCalled()
    await runZhoraSuggestionPreviewPass()
    expect(vi.mocked(sendPlainMessage).mock.calls[0]![0]).toMatchObject({
      text: expect.stringContaining('Жора — исправленный черновик'),
      replyMarkup: {
        inline_keyboard: expect.arrayContaining([
          [{ text: 'Карточка', callback_data: `zc:${first.suggestion.id}` }],
        ]),
      },
    })
    expect(vi.mocked(sendPlainMessage).mock.calls[0]![0].text).not.toContain(
      'в базе нет ответа'
    )
    expect(
      await prismaSupport.supportMessage.count({
        where: { ticketId: ticket.id, direction: 'OUT' },
      })
    ).toBe(0)
  })

  it('does not expose a send button for an invalid model result', async () => {
    const { ticket } = await customerMessage('Question', 'en')
    await prismaSupport.supportTicket.update({
      where: { id: ticket.id },
      data: { tgChatId: -1002000000001n, tgTopicId: 791 },
    })
    const { suggestion } = await requestZhoraFix({
      eventKey: `fix:cmd:${randomUUID()}`,
      ticketId: ticket.id,
      agentId: null,
      text: 'проверим',
    })
    vi.mocked(generateZhoraTextWithJournal).mockResolvedValue({
      text: JSON.stringify({ answer: 'We will check.' }),
      model: 'test/fix',
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
    await runZhoraJobPass()
    expect(
      (
        await prismaSupport.zhoraJob.findUniqueOrThrow({
          where: { id: suggestion.jobId },
        })
      ).status
    ).toBe('failed')
    await runZhoraSuggestionPreviewPass()
    expect(
      vi.mocked(sendPlainMessage).mock.calls[0]![0].replyMarkup
    ).toBeUndefined()
  })

  it('carries the already-sent warning from a replied message into the preview', async () => {
    const { ticket } = await customerMessage('Please help', 'en')
    await prismaSupport.supportTicket.update({
      where: { id: ticket.id },
      data: { tgChatId: -1002000000001n, tgTopicId: 792 },
    })
    const { message: source } = await appendMessage({
      ticketId: ticket.id,
      direction: 'OUT',
      text: 'щас проверим',
    })
    vi.mocked(generateZhoraTextWithJournal).mockResolvedValue({
      text: JSON.stringify({
        answer: 'We will check.',
        answerRu: 'Сейчас проверим.',
        needsReview: false,
      }),
      model: 'test/fix',
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
    const { suggestion } = await requestZhoraFix({
      eventKey: `fix:reply:${randomUUID()}`,
      ticketId: ticket.id,
      agentId: null,
      text: source.text!,
      sourceMessageId: source.id,
    })
    await runZhoraJobPass()
    const job = await prismaSupport.zhoraJob.findUniqueOrThrow({
      where: { id: suggestion.jobId },
    })
    expect(job.result).toMatchObject({ originalAlreadySent: true })
    await runZhoraSuggestionPreviewPass()
    expect(vi.mocked(sendPlainMessage).mock.calls[0]![0].text).toContain(
      'Исходное сообщение уже доставлено клиенту'
    )
  })
})

async function completedSource() {
  const { ticket } = await customerMessage('Question', 'en')
  await prismaSupport.supportTicket.update({
    where: { id: ticket.id },
    data: { tgChatId: -1002000000001n, tgTopicId: 782 },
  })
  const { suggestion } = await requestZhoraSuggestion({
    ticketId: ticket.id,
    eventKey: `reply:translation:${randomUUID()}`,
  })
  await prismaSupport.zhoraJob.update({
    where: { id: suggestion.jobId },
    data: {
      status: 'completed',
      result: {
        answer: 'Please provide your ID.',
        answerRu: 'Пожалуйста, укажите ваш ID.',
        needsReview: true,
        sources: [{ code: 'TEST_1', question: 'Identity' }],
      },
    },
  })
  await prismaSupport.zhoraSuggestion.update({
    where: { id: suggestion.id },
    data: { previewSentAt: new Date(), previewTgMessageId: 4321 },
  })
  return { ticket, suggestion }
}

describe('Zhora translated variants', () => {
  it('reuses the RU text without a paid job and keeps the ticket language', async () => {
    const { ticket, suggestion } = await completedSource()
    const first = await requestZhoraSuggestionVariant({
      sourceSuggestionId: suggestion.id,
      language: 'ru',
      agentId: null,
    })
    const repeated = await requestZhoraSuggestionVariant({
      sourceSuggestionId: suggestion.id,
      language: 'ru',
      agentId: null,
    })
    expect(first.created).toBe(true)
    expect(repeated).toMatchObject({
      created: false,
      suggestion: { id: first.suggestion.id },
    })
    const job = await prismaSupport.zhoraJob.findUniqueOrThrow({
      where: { id: first.suggestion.jobId },
    })
    expect(job.status).toBe('completed')
    expect(job.callId).toBeNull()
    expect(job.result).toMatchObject({
      answer: 'Пожалуйста, укажите ваш ID.',
      answerRu: 'Пожалуйста, укажите ваш ID.',
      sources: [{ code: 'TEST_1', question: 'Identity' }],
    })
    await runZhoraSuggestionPreviewPass()
    expect(vi.mocked(sendPlainMessage).mock.calls[0]![0]).toMatchObject({
      text: expect.stringContaining('Жора — перевод (ru)'),
      replyMarkup: {
        inline_keyboard: [
          [
            { text: 'Отправить', callback_data: `zs:${first.suggestion.id}` },
            {
              text: 'Скопировать',
              copy_text: { text: 'Пожалуйста, укажите ваш ID.' },
            },
          ],
          [{ text: 'Карточка', callback_data: `zc:${first.suggestion.id}` }],
        ],
      },
    })
    expect(generateZhoraTextWithJournal).not.toHaveBeenCalled()
    expect(
      (
        await prismaSupport.supportTicket.findUniqueOrThrow({
          where: { id: ticket.id },
        })
      ).detectedLang
    ).toBe('en')
  })

  it('queues one translated variant and saves the model text for preview', async () => {
    const { ticket, suggestion } = await completedSource()
    const first = await requestZhoraSuggestionVariant({
      sourceSuggestionId: suggestion.id,
      language: 'de',
      agentId: null,
    })
    const repeated = await requestZhoraSuggestionVariant({
      sourceSuggestionId: suggestion.id,
      language: 'de',
      agentId: null,
    })
    expect(repeated.suggestion.id).toBe(first.suggestion.id)
    expect(first.suggestion.sourceSuggestionId).toBe(suggestion.id)
    vi.mocked(generateZhoraTextWithJournal).mockResolvedValue({
      text: JSON.stringify({ answer: 'Bitte nennen Sie Ihre ID.' }),
      model: 'test/translate',
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
    await runZhoraJobPass()
    expect(generateZhoraTextWithJournal).toHaveBeenCalledTimes(1)
    expect(
      vi.mocked(generateZhoraTextWithJournal).mock.calls[0]![0]
    ).toMatchObject({
      operation: 'translate',
      input: expect.stringContaining('German'),
    })
    const job = await prismaSupport.zhoraJob.findUniqueOrThrow({
      where: { id: first.suggestion.jobId },
    })
    expect(job.status).toBe('completed')
    expect(job.result).toMatchObject({
      answer: 'Bitte nennen Sie Ihre ID.',
      answerRu: 'Пожалуйста, укажите ваш ID.',
      needsReview: true,
      sources: [{ code: 'TEST_1', question: 'Identity' }],
    })
    await runZhoraSuggestionPreviewPass()
    expect(vi.mocked(sendPlainMessage).mock.calls[0]![0].text).toContain(
      'Жора — перевод (de)'
    )
    expect(
      (
        await prismaSupport.supportTicket.findUniqueOrThrow({
          where: { id: ticket.id },
        })
      ).detectedLang
    ).toBe('en')
  })
})

describe('Zhora alternative drafts', () => {
  it('creates a new draft for each tap, but not for a redelivered callback', async () => {
    const { ticket, suggestion } = await completedSource()
    const firstEventKey = `alternative:${randomUUID()}`
    const first = await requestZhoraSuggestionAlternative({
      eventKey: firstEventKey,
      sourceSuggestionId: suggestion.id,
      agentId: null,
    })
    const repeated = await requestZhoraSuggestionAlternative({
      eventKey: firstEventKey,
      sourceSuggestionId: suggestion.id,
      agentId: null,
    })
    const second = await requestZhoraSuggestionAlternative({
      eventKey: `alternative:${randomUUID()}`,
      sourceSuggestionId: suggestion.id,
      agentId: null,
    })
    expect(first.created).toBe(true)
    expect(repeated).toMatchObject({
      created: false,
      suggestion: { id: first.suggestion.id },
    })
    expect(second.suggestion.id).not.toBe(first.suggestion.id)
    expect(first.suggestion.targetMessageId).toBe(suggestion.targetMessageId)
    expect(first.suggestion.language).toBe('en')

    vi.mocked(generateZhoraTextWithJournal)
      .mockResolvedValueOnce({
        text: JSON.stringify({
          answer: 'Could you send us your ID, please?',
          answerRu: 'Пожалуйста, пришлите нам ваш ID.',
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
      .mockResolvedValueOnce({
        text: JSON.stringify({
          answer: 'Please send us your ID when you can.',
          answerRu: 'Отправьте нам ваш ID, когда сможете.',
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
    await runZhoraJobPass()
    await runZhoraJobPass()
    expect(generateZhoraTextWithJournal).toHaveBeenCalledTimes(2)
    expect(buildZhoraContext).not.toHaveBeenCalled()
    const firstJob = await prismaSupport.zhoraJob.findUniqueOrThrow({
      where: { id: first.suggestion.jobId },
    })
    expect(firstJob.result).toMatchObject({
      answer: 'Could you send us your ID, please?',
      answerRu: 'Пожалуйста, пришлите нам ваш ID.',
      needsReview: true,
      sources: [{ code: 'TEST_1', question: 'Identity' }],
    })
    expect(firstJob.input).toEqual({
      kind: 'suggestion-alternative',
      sourceSuggestionId: suggestion.id,
    })
    await runZhoraSuggestionPreviewPass()
    expect(vi.mocked(sendPlainMessage).mock.calls[0]![0]).toMatchObject({
      text: expect.stringContaining('Жора — ещё вариант ответа'),
      replyMarkup: {
        inline_keyboard: [
          [
            { text: 'Отправить', callback_data: `zs:${first.suggestion.id}` },
            {
              text: 'Скопировать',
              copy_text: { text: 'Could you send us your ID, please?' },
            },
          ],
          [
            { text: 'Перевести', callback_data: `zt:${first.suggestion.id}` },
            {
              text: 'Ещё вариант',
              callback_data: `za:${first.suggestion.id}`,
            },
          ],
          [{ text: 'Карточка', callback_data: `zc:${first.suggestion.id}` }],
        ],
      },
    })
    const chained = await requestZhoraSuggestionAlternative({
      eventKey: `alternative:${randomUUID()}`,
      sourceSuggestionId: first.suggestion.id,
      agentId: null,
    })
    expect(chained.created).toBe(true)
    expect(chained.suggestion.targetMessageId).toBe(suggestion.targetMessageId)
    expect(
      (
        await prismaSupport.supportTicket.findUniqueOrThrow({
          where: { id: ticket.id },
        })
      ).detectedLang
    ).toBe('en')
  })

  it('refuses to reword a translated preview or a closed ticket', async () => {
    const { ticket, suggestion } = await completedSource()
    const translated = await requestZhoraSuggestionVariant({
      sourceSuggestionId: suggestion.id,
      language: 'ru',
      agentId: null,
    })
    await prismaSupport.zhoraSuggestion.update({
      where: { id: translated.suggestion.id },
      data: { previewSentAt: new Date() },
    })
    await expect(
      requestZhoraSuggestionAlternative({
        eventKey: `alternative:${randomUUID()}`,
        sourceSuggestionId: translated.suggestion.id,
        agentId: null,
      })
    ).rejects.toThrow('недоступен')
    await prismaSupport.supportTicket.update({
      where: { id: ticket.id },
      data: { status: 'CLOSED' },
    })
    await expect(
      requestZhoraSuggestionAlternative({
        eventKey: `alternative:${randomUUID()}`,
        sourceSuggestionId: suggestion.id,
        agentId: null,
      })
    ).rejects.toThrow()
  })

  it('does not publish a send button for an unchanged or malformed model result', async () => {
    const { suggestion } = await completedSource()
    const alternative = await requestZhoraSuggestionAlternative({
      eventKey: `alternative:${randomUUID()}`,
      sourceSuggestionId: suggestion.id,
      agentId: null,
    })
    vi.mocked(generateZhoraTextWithJournal).mockResolvedValue({
      text: JSON.stringify({
        answer: 'Please provide your ID.',
        answerRu: 'Пожалуйста, укажите ваш ID.',
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
    await runZhoraJobPass()
    const job = await prismaSupport.zhoraJob.findUniqueOrThrow({
      where: { id: alternative.suggestion.jobId },
    })
    expect(job).toMatchObject({ status: 'failed', errorCode: 'invalid_result' })
    await runZhoraSuggestionPreviewPass()
    expect(
      vi.mocked(sendPlainMessage).mock.calls[0]![0].replyMarkup
    ).toBeUndefined()
  })
})
