import { randomInt, randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupportTicket } from '@prisma-support'

vi.mock('@config/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@config/env')>()),
  ZHORA_ENABLED: true,
  ZHORA_OPENROUTER_API_KEY: 'synthetic-category-test-key',
  ZHORA_MODEL_TAGS: 'test/tag',
}))
vi.mock('@apps/services/chat.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@apps/services/chat.service')>()),
  refreshPinnedTicketCard: vi.fn(),
}))
vi.mock('@telegram/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@telegram/api')>()),
  ...(await import('./_telegram-stub')).telegramStub(),
}))

import { prismaSupport } from '@config/database'
import { appendMessage } from '@apps/services/message.service'
import { refreshPinnedTicketCard } from '@apps/services/chat.service'
import {
  parseTicketCategory,
  runZhoraTicketCategoryPass,
} from '@apps/services/zhora/ticket-category.service'
import { handleUpdate } from '@telegram/updates'
import * as telegram from '@telegram/api'
import {
  TEST_CHAT_ID,
  agentMessageUpdate,
  callbackUpdate,
} from './_telegram-stub'

let ticket: SupportTicket
const fromId = 91_234
const sent = () => vi.mocked(telegram.sendPlainMessage)

async function customerText(text: string) {
  return appendMessage({
    ticketId: ticket.id,
    direction: 'IN',
    text,
    translationPending: true,
  })
}

async function complete(attempt: number, category: string) {
  await prismaSupport.zhoraJob.update({
    where: { eventKey: `ticket:tag:${ticket.id}:${attempt}` },
    data: {
      status: 'completed',
      result: { text: JSON.stringify({ category }) },
    },
  })
}

beforeEach(async () => {
  vi.clearAllMocks()
  ticket = await prismaSupport.supportTicket.create({
    data: {
      userId: randomUUID(),
      userNId: randomInt(100_000, 900_000),
      tgChatId: BigInt(TEST_CHAT_ID),
      tgTopicId: randomInt(1_000, 2_000_000_000),
    },
  })
})

afterEach(async () => {
  await prismaSupport.zhoraJob.deleteMany({ where: { ticketId: ticket.id } })
  await prismaSupport.supportTicket.delete({ where: { id: ticket.id } })
})

describe('ticket category', () => {
  it('classifies first text once and retries OTHER only after the second text', async () => {
    await customerText('Hello')
    await runZhoraTicketCategoryPass()
    await runZhoraTicketCategoryPass()
    expect(
      await prismaSupport.zhoraJob.count({ where: { ticketId: ticket.id } })
    ).toBe(1)
    await complete(1, 'OTHER')
    await runZhoraTicketCategoryPass()
    expect(
      await prismaSupport.zhoraJob.count({ where: { ticketId: ticket.id } })
    ).toBe(1)

    await customerText('My deposit is missing')
    await runZhoraTicketCategoryPass()
    const second = await prismaSupport.zhoraJob.findUniqueOrThrow({
      where: { eventKey: `ticket:tag:${ticket.id}:2` },
    })
    expect(second.input).toMatchObject({
      input: expect.stringContaining('My deposit is missing'),
    })
    await complete(2, 'DEPOSIT')
    await runZhoraTicketCategoryPass()
    const tagged = await prismaSupport.supportTicket.findUniqueOrThrow({
      where: { id: ticket.id },
    })
    expect(tagged).toMatchObject({
      category: 'DEPOSIT',
      categoryAttempt: 2,
      categoryJobId: null,
    })
    expect(refreshPinnedTicketCard).toHaveBeenCalled()
    await customerText('Thanks')
    await runZhoraTicketCategoryPass()
    expect(
      await prismaSupport.zhoraJob.count({ where: { ticketId: ticket.id } })
    ).toBe(2)
  })

  it('keeps a second message that arrives while the first classification runs', async () => {
    await customerText('Hello')
    await runZhoraTicketCategoryPass()
    await customerText('My withdrawal is pending')
    await complete(1, 'OTHER')
    await runZhoraTicketCategoryPass()
    expect(
      await prismaSupport.zhoraJob.findUnique({
        where: { eventKey: `ticket:tag:${ticket.id}:2` },
      })
    ).not.toBeNull()
  })

  it('lets /tag override an in-flight AI result permanently', async () => {
    await customerText('I need help')
    await runZhoraTicketCategoryPass()
    await handleUpdate(
      agentMessageUpdate({
        topicId: ticket.tgTopicId!,
        messageId: randomInt(1_000, 2_000_000_000),
        fromId,
        text: '/tag',
      })
    )
    const button =
      sent().mock.calls.at(-1)![0].replyMarkup!.inline_keyboard[0]![0]!
    const data = 'callback_data' in button ? button.callback_data : ''
    await handleUpdate(
      callbackUpdate({
        topicId: ticket.tgTopicId!,
        messageId: 100,
        fromId,
        data,
      })
    )
    await complete(1, 'WITHDRAWAL')
    await runZhoraTicketCategoryPass()
    const tagged = await prismaSupport.supportTicket.findUniqueOrThrow({
      where: { id: ticket.id },
    })
    expect(tagged.category).toBe('DEPOSIT')
    expect(tagged.categoryManual).toBe(true)
    expect(tagged.categoryJobId).toBeNull()
  })

  it('runs the deposit shortcut only for a current deposit-tagged preview', async () => {
    const { message } = await customerText('Deposit issue')
    await prismaSupport.supportTicket.update({
      where: { id: ticket.id },
      data: { category: 'DEPOSIT' },
    })
    const job = await prismaSupport.zhoraJob.create({
      data: {
        eventKey: `quick:${ticket.id}`,
        operation: 'reply',
        input: {},
        ticketId: ticket.id,
        status: 'completed',
      },
    })
    const suggestion = await prismaSupport.zhoraSuggestion.create({
      data: {
        jobId: job.id,
        targetMessageId: message.id,
        language: 'en',
        previewSentAt: new Date(),
        previewTgMessageId: 777,
      },
    })
    const update = callbackUpdate({
      topicId: ticket.tgTopicId!,
      messageId: 777,
      fromId,
      data: `${telegram.ZHORA_DEPOSITS_CALLBACK_PREFIX}${suggestion.id}`,
    })
    await handleUpdate(update)
    expect(vi.mocked(telegram.sendToTopic)).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Депозиты') })
    )
    vi.mocked(telegram.sendToTopic).mockClear()
    await prismaSupport.supportTicket.update({
      where: { id: ticket.id },
      data: { category: 'ACCOUNT' },
    })
    await handleUpdate(update)
    expect(telegram.sendToTopic).not.toHaveBeenCalled()
    expect(sent().mock.calls.at(-1)![0].text).toContain(
      'Категория тикета изменилась'
    )
  })

  it('rejects invalid model categories', () => {
    expect(() => parseTicketCategory('{"category":"UNKNOWN"}')).toThrow()
    expect(() =>
      parseTicketCategory('{"category":"DEPOSIT","extra":1}')
    ).toThrow()
    expect(parseTicketCategory('{"category":"OTHER"}')).toBe('OTHER')
  })
})
