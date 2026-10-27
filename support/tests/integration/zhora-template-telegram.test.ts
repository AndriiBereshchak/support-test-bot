import { randomInt, randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupportTicket } from '@prisma-support'

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
import { pushToUser } from '@apps/services/push.service'
import { sourceHash } from '@apps/services/zhora/template.service'
import { handleUpdate } from '@telegram/updates'
import * as telegram from '@telegram/api'
import { cleanupTestUser, createTestUser, type TestUser } from './_helpers'
import {
  TEST_CHAT_ID,
  agentMessageUpdate,
  callbackUpdate,
} from './_telegram-stub'

let user: TestUser
let ticket: SupportTicket
let fromId: number
let agentId: string
const templateIds: string[] = []
const sent = () => vi.mocked(telegram.sendPlainMessage)
const command = (text: string, replyToMessageId?: number) =>
  agentMessageUpdate({
    topicId: ticket.tgTopicId!,
    messageId: randomInt(1_000, 2_000_000_000),
    fromId,
    text,
    ...(replyToMessageId ? { replyToMessageId } : {}),
  })
const tap = (messageId: number, data: string) =>
  callbackUpdate({ topicId: ticket.tgTopicId!, messageId, fromId, data })

async function createTemplate(args: { ru: string; en: string }) {
  const code = `TEST_${randomUUID().slice(0, 8)}`
  const variables = [
    ...new Set(
      [...args.ru.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]!)
    ),
  ]
  const template = await prismaSupport.zhoraTemplate.create({
    data: {
      code,
      category: 'account',
      textRu: args.ru,
      variables,
      updatedById: 'synthetic-admin',
      translations: {
        create: [
          {
            language: 'en',
            text: args.en,
            sourceHash: sourceHash(args.ru),
            isManual: true,
          },
        ],
      },
    },
  })
  templateIds.push(template.id)
  return template
}

beforeEach(async () => {
  vi.clearAllMocks()
  user = await createTestUser({ fullName: 'Alice' })
  fromId = randomInt(1_000, 2_000_000_000)
  const agent = await prismaSupport.supportAgent.create({
    data: { tgUserId: BigInt(fromId), displayName: 'Operator Anna' },
  })
  agentId = agent.id
  ticket = await prismaSupport.supportTicket.create({
    data: {
      ...user,
      detectedLang: 'en',
      tgChatId: BigInt(TEST_CHAT_ID),
      tgTopicId: randomInt(1_000, 2_000_000_000),
    },
  })
})

afterEach(async () => {
  await cleanupTestUser(user.userId)
  await prismaSupport.zhoraTemplate.deleteMany({
    where: { id: { in: templateIds.splice(0) } },
  })
  await prismaSupport.supportAgent.delete({ where: { id: agentId } })
})

describe('Zhora template Telegram flow', () => {
  it('lists categories, fills a missing value privately, edits and sends once', async () => {
    const template = await createTemplate({
      ru: 'Здравствуйте, {name}. Статус вывода: {withdrawal_status}.',
      en: 'Hello, {name}. Withdrawal status: {withdrawal_status}.',
    })
    await handleUpdate(command('/t'))
    const categoryButton =
      sent().mock.calls.at(-1)![0].replyMarkup!.inline_keyboard[0]![0]!
    await handleUpdate(
      tap(
        101,
        'callback_data' in categoryButton ? categoryButton.callback_data : ''
      )
    )
    const selectButton =
      sent().mock.calls.at(-1)![0].replyMarkup!.inline_keyboard[0]![0]!
    await handleUpdate(
      tap(
        102,
        'callback_data' in selectButton ? selectButton.callback_data : ''
      )
    )
    const first = await prismaSupport.zhoraTemplateDraft.findFirstOrThrow({
      where: { templateId: template.id, ticketId: ticket.id },
    })
    expect(first.missing).toEqual(['withdrawal_status'])
    expect(first.text).toBeNull()
    expect(
      await prismaSupport.supportMessage.count({
        where: { ticketId: ticket.id, direction: 'OUT' },
      })
    ).toBe(0)

    await handleUpdate(
      command('/t withdrawal_status="under review"', first.previewTgMessageId!)
    )
    const filled = await prismaSupport.zhoraTemplateDraft.findUniqueOrThrow({
      where: { id: first.id },
    })
    expect(filled.text).toBe('Hello, Alice. Withdrawal status: under review.')
    expect(filled.previewVersion).toBe(2)
    expect(filled.previewTgMessageId).not.toBe(first.previewTgMessageId)

    await handleUpdate(
      command(
        '/t edit Hello, Alice. Your withdrawal is under review.',
        filled.previewTgMessageId!
      )
    )
    const edited = await prismaSupport.zhoraTemplateDraft.findUniqueOrThrow({
      where: { id: first.id },
    })
    expect(edited.previewVersion).toBe(3)
    await handleUpdate(
      tap(
        filled.previewTgMessageId!,
        `${telegram.ZHORA_TEMPLATE_SEND_CALLBACK_PREFIX}${first.id}:2`
      )
    )
    expect(
      await prismaSupport.supportMessage.count({
        where: { ticketId: ticket.id, direction: 'OUT' },
      })
    ).toBe(0)

    const send = tap(
      edited.previewTgMessageId!,
      `${telegram.ZHORA_TEMPLATE_SEND_CALLBACK_PREFIX}${first.id}:3`
    )
    await handleUpdate(send)
    await handleUpdate(send)
    const out = await prismaSupport.supportMessage.findMany({
      where: { ticketId: ticket.id, direction: 'OUT' },
    })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      text: 'Hello, Alice. Your withdrawal is under review.',
      agentId,
    })
    expect(pushToUser).toHaveBeenCalledTimes(1)
    expect(
      await prismaSupport.zhoraTemplateUsage.findMany({
        where: { templateId: template.id },
      })
    ).toMatchObject([
      { editedBeforeSend: true, agentId, operatorTgUserId: BigInt(fromId) },
    ])
  })

  it('blocks unsupported ticket languages and unavailable translations', async () => {
    const template = await createTemplate({ ru: 'Здравствуйте.', en: 'Hello.' })
    await prismaSupport.supportTicket.update({
      where: { id: ticket.id },
      data: { detectedLang: 'pl' },
    })
    await handleUpdate(command(`/t ${template.code}`))
    expect(sent().mock.calls.at(-1)![0].text).toContain('недоступен на языке')
    await prismaSupport.supportTicket.update({
      where: { id: ticket.id },
      data: { detectedLang: 'de' },
    })
    await handleUpdate(command(`/t ${template.code}`))
    expect(sent().mock.calls.at(-1)![0].text).toContain(
      'Перевод шаблона ещё не готов'
    )
    expect(
      await prismaSupport.zhoraTemplateDraft.count({
        where: { ticketId: ticket.id },
      })
    ).toBe(0)
    expect(
      await prismaSupport.supportMessage.count({
        where: { ticketId: ticket.id, direction: 'OUT' },
      })
    ).toBe(0)
  })

  it('binds a long preview button to its final Telegram message', async () => {
    const template = await createTemplate({
      ru: 'А'.repeat(4_000),
      en: 'B'.repeat(4_000),
    })
    await handleUpdate(command(`/t ${template.code}`))
    const draft = await prismaSupport.zhoraTemplateDraft.findFirstOrThrow({
      where: { templateId: template.id },
    })
    const calls = sent().mock.calls.filter(
      ([args]) => args.replyMarkup || args.text.includes('B')
    )
    expect(calls.length).toBeGreaterThan(1)
    expect(calls.at(-1)![0].replyMarkup).toBeDefined()
    expect(draft.previewTgMessageId).not.toBeNull()
    await handleUpdate(
      tap(
        draft.previewTgMessageId!,
        `${telegram.ZHORA_TEMPLATE_SEND_CALLBACK_PREFIX}${draft.id}:1`
      )
    )
    expect(
      await prismaSupport.supportMessage.count({
        where: { ticketId: ticket.id, direction: 'OUT' },
      })
    ).toBe(1)
  })

  it('invalidates a preview when an admin changes its translation', async () => {
    const template = await createTemplate({ ru: 'Здравствуйте.', en: 'Hello.' })
    await handleUpdate(command(`/t ${template.code}`))
    const draft = await prismaSupport.zhoraTemplateDraft.findFirstOrThrow({
      where: { templateId: template.id },
    })
    await prismaSupport.zhoraTemplate.update({
      where: { id: template.id },
      data: { updatedAt: new Date(Date.now() + 5_000) },
    })
    await handleUpdate(
      tap(
        draft.previewTgMessageId!,
        `${telegram.ZHORA_TEMPLATE_SEND_CALLBACK_PREFIX}${draft.id}:1`
      )
    )
    expect(sent().mock.calls.at(-1)![0].text).toContain('устарело')
    expect(
      await prismaSupport.supportMessage.count({
        where: { ticketId: ticket.id, direction: 'OUT' },
      })
    ).toBe(0)
  })

  it('does not send another operator’s name in a shared preview', async () => {
    const template = await createTemplate({
      ru: 'С вами {operator_name}.',
      en: 'This is {operator_name}.',
    })
    await handleUpdate(command(`/t ${template.code}`))
    const draft = await prismaSupport.zhoraTemplateDraft.findFirstOrThrow({
      where: { templateId: template.id },
    })
    await handleUpdate(
      callbackUpdate({
        topicId: ticket.tgTopicId!,
        messageId: draft.previewTgMessageId!,
        fromId: fromId + 1,
        data: `${telegram.ZHORA_TEMPLATE_SEND_CALLBACK_PREFIX}${draft.id}:1`,
      })
    )
    expect(sent().mock.calls.at(-1)![0].text).toContain(
      'содержит имя оператора'
    )
    expect(
      await prismaSupport.supportMessage.count({
        where: { ticketId: ticket.id, direction: 'OUT' },
      })
    ).toBe(0)
  })
})
