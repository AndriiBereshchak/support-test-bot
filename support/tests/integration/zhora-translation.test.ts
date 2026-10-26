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
  const { randomUUID } = await import('node:crypto')
  settings.schema = `zhora_translate_${randomUUID().replaceAll('-', '')}`
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
  ZHORA_OPENROUTER_API_KEY: 'synthetic-translation-test-key',
  ZHORA_MODEL_TRANSLATE: 'test/translate',
}))
vi.mock('@apps/services/zhora/llm.service', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@apps/services/zhora/llm.service')
  >()),
  generateZhoraTextWithJournal: vi.fn(),
}))
vi.mock('@telegram/api', () => ({
  sendPlainMessage: vi.fn(async () => 9901),
  attachZhoraReplyButton: vi.fn(async () => true),
}))

import { prismaSupport } from '@config/database'
import { appendMessage } from '@apps/services/message.service'
import { generateZhoraTextWithJournal } from '@apps/services/zhora/llm.service'
import { runZhoraJobPass } from '@apps/services/zhora/job.service'
import {
  parseTranslation,
  runZhoraTranslationPass,
} from '@apps/services/zhora/translation.service'
import { attachZhoraReplyButton, sendPlainMessage } from '@telegram/api'

const generate = vi.mocked(generateZhoraTextWithJournal)
const sent = vi.mocked(sendPlainMessage)
const attachReplyButton = vi.mocked(attachZhoraReplyButton)

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
  await prismaSupport.zhoraTranslation.deleteMany()
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

describe('incoming Zhora translation', () => {
  it('caches one paid job per message and replies only for a non-Russian language', async () => {
    const ticket = await prismaSupport.supportTicket.create({
      data: {
        userId: randomUUID(),
        userNId: 123,
        tgChatId: -1002000000001n,
        tgTopicId: 543,
      },
    })
    const first = await appendMessage({
      ticketId: ticket.id,
      direction: 'IN',
      text: 'Kiedy otrzymam wypłatę?',
      translationPending: true,
      dedupeKey: 'web:translate-test-1',
    })
    await prismaSupport.supportMessage.update({
      where: { id: first.message.id },
      data: { tgMessageId: 101 },
    })
    generate.mockResolvedValue({
      text: JSON.stringify({
        detectedLang: 'pl',
        translationRu: 'Когда я получу вывод?',
      }),
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
    await runZhoraTranslationPass()
    await runZhoraTranslationPass()
    expect(await prismaSupport.zhoraJob.count()).toBe(1)
    await runZhoraJobPass()
    await runZhoraTranslationPass()
    expect(sent).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: -1002000000001,
        topicId: 543,
        replyToMessageId: 101,
        text: 'RU: Когда я получу вывод?',
      })
    )
    expect(
      (
        await prismaSupport.supportTicket.findUniqueOrThrow({
          where: { id: ticket.id },
        })
      ).detectedLang
    ).toBe('pl')
    expect(
      (
        await prismaSupport.zhoraTranslation.findUniqueOrThrow({
          where: { messageId: first.message.id },
        })
      ).sentTgMessageId
    ).toBe(9901)
    await runZhoraTranslationPass()
    expect(generate).toHaveBeenCalledTimes(1)
    expect(sent).toHaveBeenCalledTimes(1)
    expect(attachReplyButton).not.toHaveBeenCalled()

    const second = await appendMessage({
      ticketId: ticket.id,
      direction: 'IN',
      text: 'Здравствуйте',
      translationPending: true,
    })
    await prismaSupport.supportMessage.update({
      where: { id: second.message.id },
      data: { tgMessageId: 102 },
    })
    generate.mockResolvedValueOnce({
      text: JSON.stringify({
        detectedLang: 'ru',
        translationRu: 'Здравствуйте',
      }),
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
    await runZhoraTranslationPass()
    await runZhoraJobPass()
    await runZhoraTranslationPass()
    expect(sent).toHaveBeenCalledTimes(1)
    expect(
      (
        await prismaSupport.supportTicket.findUniqueOrThrow({
          where: { id: ticket.id },
        })
      ).detectedLang
    ).toBe('ru')
    expect(generate).toHaveBeenCalledTimes(2)
  })

  it('requires ua for Ukrainian and rejects malformed output without retrying it', () => {
    expect(
      parseTranslation('{"detectedLang":"ua","translationRu":"Привіт"}')
        .detectedLang
    ).toBe('ua')
    expect(() =>
      parseTranslation('{"detectedLang":"uk","translationRu":"Привіт"}')
    ).toThrow('invalid_translation')
  })

  it('resumes a long Telegram translation after a later chunk fails', async () => {
    const ticket = await prismaSupport.supportTicket.create({
      data: {
        userId: randomUUID(),
        userNId: 124,
        tgChatId: -1002000000001n,
        tgTopicId: 544,
      },
    })
    const incoming = await appendMessage({
      ticketId: ticket.id,
      direction: 'IN',
      text: 'Please explain the long answer.',
      translationPending: true,
    })
    await prismaSupport.supportMessage.update({
      where: { id: incoming.message.id },
      data: { tgMessageId: 103 },
    })
    generate.mockResolvedValueOnce({
      text: JSON.stringify({
        detectedLang: 'en',
        translationRu: `${'а'.repeat(4090)} ${'б'.repeat(50)}`,
      }),
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
    sent.mockResolvedValueOnce(9901).mockResolvedValueOnce(null)
    sent.mockResolvedValueOnce(9902)

    await runZhoraTranslationPass()
    await runZhoraJobPass()
    await runZhoraTranslationPass()
    const pending = await prismaSupport.zhoraTranslation.findUniqueOrThrow({
      where: { messageId: incoming.message.id },
    })
    expect(pending).toMatchObject({
      nextChunkIndex: 1,
      sentTgMessageId: 9901,
      sentAt: null,
    })
    expect(sent).toHaveBeenCalledTimes(2)

    await prismaSupport.zhoraTranslation.update({
      where: { messageId: incoming.message.id },
      data: { sendingUntil: new Date(0) },
    })
    await runZhoraTranslationPass()
    const completed = await prismaSupport.zhoraTranslation.findUniqueOrThrow({
      where: { messageId: incoming.message.id },
    })
    expect(completed.nextChunkIndex).toBe(2)
    expect(completed.sentAt).toBeInstanceOf(Date)
    expect(sent).toHaveBeenCalledTimes(3)
    expect(sent.mock.calls[2]![0].text).toBe(sent.mock.calls[1]![0].text)
    expect(sent.mock.calls[2]![0].text).not.toBe(sent.mock.calls[0]![0].text)
    expect(generate).toHaveBeenCalledTimes(1)
  })
})
