import { execFileSync } from 'node:child_process'
import { randomInt, randomUUID } from 'node:crypto'
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
import type { SupportTicket } from '@prisma-support'

const settings = vi.hoisted(() => ({ schema: '', url: '' }))
vi.mock('@config/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@config/database')>()
  const { PrismaClient } = await import('@prisma-support')
  settings.schema = `zhora_outcome_${randomUUID().replaceAll('-', '')}`
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
}))
vi.mock('@apps/services/push.service', () => ({ pushToUser: vi.fn() }))
vi.mock('@telegram/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@telegram/api')>()),
  ...(await import('./_telegram-stub')).telegramStub(),
}))

import { prismaSupport } from '@config/database'
import { appendMessage } from '@apps/services/message.service'
import { closeTicket } from '@apps/services/ticket.service'
import {
  answerSimilarity,
  finalizeIgnoredSuggestions,
} from '@apps/services/zhora/suggestion-outcome.service'
import { handleUpdate } from '@telegram/updates'
import {
  TEST_CHAT_ID,
  agentEditUpdate,
  agentMessageUpdate,
  callbackUpdate,
} from './_telegram-stub'

let ticket: SupportTicket
let fromId: number

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
  fromId = randomInt(100_000, 900_000)
  ticket = await prismaSupport.supportTicket.create({
    data: {
      userId: randomUUID(),
      userNId: randomInt(100_000, 900_000),
      tgChatId: BigInt(TEST_CHAT_ID),
      tgTopicId: randomInt(1_000, 2_000_000_000),
    },
  })
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

async function preview(
  answer: string,
  options: {
    sourceSuggestionId?: string
    previewMessageId?: number
    previewSentAt?: Date | null
  } = {}
) {
  const target = await appendMessage({
    ticketId: ticket.id,
    direction: 'IN',
    text: 'Customer question',
  })
  const job = await prismaSupport.zhoraJob.create({
    data: {
      eventKey: randomUUID(),
      operation: 'reply',
      input: {},
      ticketId: ticket.id,
      status: 'completed',
      result: { answer, answerRu: answer, needsReview: false, sources: [] },
    },
  })
  return prismaSupport.zhoraSuggestion.create({
    data: {
      jobId: job.id,
      targetMessageId: target.message.id,
      language: 'en',
      sourceSuggestionId: options.sourceSuggestionId,
      previewSentAt:
        options.previewSentAt === undefined
          ? new Date()
          : options.previewSentAt,
      previewTgMessageId:
        options.previewMessageId ?? randomInt(1_000, 2_000_000_000),
    },
  })
}

function operatorText(text: string, replyToMessageId?: number) {
  const messageId = randomInt(1_000, 2_000_000_000)
  return {
    messageId,
    update: agentMessageUpdate({
      topicId: ticket.tgTopicId!,
      messageId,
      fromId,
      text,
      ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
    }),
  }
}

describe('Zhora suggestion outcomes', () => {
  it('records a button send once and does not count a translation separately', async () => {
    const root = await preview('Your deposit is on the way.')
    const variant = await preview('Ваш депозит уже в пути.', {
      sourceSuggestionId: root.id,
    })
    const tap = callbackUpdate({
      topicId: ticket.tgTopicId!,
      messageId: variant.previewTgMessageId!,
      fromId,
      data: `zs:${variant.id}`,
    })
    await handleUpdate(tap)
    await handleUpdate(tap)
    const saved = await prismaSupport.zhoraSuggestion.findUniqueOrThrow({
      where: { id: root.id },
    })
    expect(saved.outcome).toBe('sent')
    expect(saved.usedVariantId).toBe(variant.id)
    expect(saved.sentMessageId).toBeTruthy()
    expect(
      (
        await prismaSupport.zhoraSuggestion.findUniqueOrThrow({
          where: { id: variant.id },
        })
      ).outcome
    ).toBeNull()
    expect(
      await prismaSupport.supportMessage.count({
        where: { ticketId: ticket.id, direction: 'OUT' },
      })
    ).toBe(1)
  })

  it('links a similar ordinary reply to the closest preview within ten minutes', async () => {
    const first = await preview('We are checking your deposit status now.')
    const best = await preview('We are reviewing your deposit status now.')
    const { update } = operatorText('We are reviewing your deposit status now.')
    await handleUpdate(update)
    expect(
      (
        await prismaSupport.zhoraSuggestion.findUniqueOrThrow({
          where: { id: best.id },
        })
      ).outcome
    ).toBe('copied_sent')
    expect(
      (
        await prismaSupport.zhoraSuggestion.findUniqueOrThrow({
          where: { id: first.id },
        })
      ).outcome
    ).toBeNull()
    const old = await preview('A very old answer.', {
      previewSentAt: new Date(Date.now() - 11 * 60_000),
    })
    await handleUpdate(operatorText('A very old answer.').update)
    expect(
      (
        await prismaSupport.zhoraSuggestion.findUniqueOrThrow({
          where: { id: old.id },
        })
      ).outcome
    ).toBeNull()
  })

  it('attributes an explicit reply to its preview after ten minutes', async () => {
    const old = await preview('We are checking your deposit status now.', {
      previewSentAt: new Date(Date.now() - 11 * 60_000),
    })
    await handleUpdate(
      operatorText(
        'We are checking your deposit status now.',
        old.previewTgMessageId!
      ).update
    )
    const saved = await prismaSupport.zhoraSuggestion.findUniqueOrThrow({
      where: { id: old.id },
    })
    expect(saved.outcome).toBe('copied_sent')
    expect(saved.sentMessageId).toBeTruthy()
  })

  it('records an explicit reply to a translated preview as edited with final text', async () => {
    const root = await preview('Your withdrawal is pending.')
    const variant = await preview('Ihre Auszahlung wird bearbeitet.', {
      sourceSuggestionId: root.id,
    })
    const { messageId, update } = operatorText(
      'I need to check the transaction before giving you an update.',
      variant.previewTgMessageId!
    )
    await handleUpdate(update)
    let saved = await prismaSupport.zhoraSuggestion.findUniqueOrThrow({
      where: { id: root.id },
    })
    expect(saved).toMatchObject({
      outcome: 'edited',
      usedVariantId: variant.id,
      finalText: 'I need to check the transaction before giving you an update.',
    })
    await handleUpdate(
      agentEditUpdate({
        topicId: ticket.tgTopicId!,
        messageId,
        fromId,
        text: 'I checked the transaction and will update you shortly.',
      })
    )
    saved = await prismaSupport.zhoraSuggestion.findUniqueOrThrow({
      where: { id: root.id },
    })
    expect(saved.finalText).toBe(
      'I checked the transaction and will update you shortly.'
    )
  })

  it('keeps the latest vote and marks only unused visible roots ignored at close', async () => {
    const root = await preview('Answer')
    const variant = await preview('Antwort', { sourceSuggestionId: root.id })
    const alternative = await preview('A different answer')
    const unseen = await preview('Not delivered', { previewSentAt: null })
    const tap = (rating: 1 | -1) =>
      callbackUpdate({
        topicId: ticket.tgTopicId!,
        messageId: variant.previewTgMessageId!,
        fromId,
        data: `zrate:${variant.id}:${rating}`,
      })
    await handleUpdate(tap(1))
    await handleUpdate(tap(-1))
    await prismaSupport.supportTicket.update({
      where: { id: ticket.id },
      data: { status: 'CLOSED', closedAt: new Date() },
    })
    await finalizeIgnoredSuggestions()
    const saved = await prismaSupport.zhoraSuggestion.findUniqueOrThrow({
      where: { id: root.id },
    })
    expect(saved).toMatchObject({
      outcome: 'ignored',
      rating: -1,
      ratedByTgUserId: BigInt(fromId),
    })
    expect(
      (
        await prismaSupport.zhoraSuggestion.findUniqueOrThrow({
          where: { id: variant.id },
        })
      ).outcome
    ).toBeNull()
    expect(
      (
        await prismaSupport.zhoraSuggestion.findUniqueOrThrow({
          where: { id: alternative.id },
        })
      ).outcome
    ).toBe('ignored')
    expect(
      (
        await prismaSupport.zhoraSuggestion.findUniqueOrThrow({
          where: { id: unseen.id },
        })
      ).outcome
    ).toBeNull()
  })

  it('finalizes ignored drafts through ticket closure without relying on the worker', async () => {
    const draft = await preview('A suggested answer')
    await closeTicket(ticket.id, 'AGENT')
    expect(
      (
        await prismaSupport.zhoraSuggestion.findUniqueOrThrow({
          where: { id: draft.id },
        })
      ).outcome
    ).toBe('ignored')
  })

  it('uses a strict ninety-percent character threshold', () => {
    expect(answerSimilarity('Hello, world!', 'hello,  world!')).toBe(1)
    expect(answerSimilarity('abcdefghij', 'abcdefghik')).toBe(0.9)
    expect(answerSimilarity('abcdefghij', 'abcdefghxx')).toBe(0)
  })
})
