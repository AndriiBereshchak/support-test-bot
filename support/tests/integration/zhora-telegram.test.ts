import { randomInt, randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupportMessage, SupportTicket } from '@prisma-support'

const settings = vi.hoisted(() => ({ enabled: true }))
vi.mock('@config/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@config/env')>()),
  get ZHORA_ENABLED() {
    return settings.enabled
  },
  ZHORA_OPENROUTER_API_KEY: 'synthetic-telegram-test-key',
  ZHORA_MODEL_REPLY: 'test/reply',
  ZHORA_MODEL_FIX: 'test/fix',
  ZHORA_MODEL_BRIEF: 'test/brief',
  ZHORA_MODEL_TRANSLATE: 'test/translate',
}))
vi.mock('@apps/services/push.service', () => ({ pushToUser: vi.fn() }))
vi.mock('@telegram/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@telegram/api')>()),
  ...(await import('./_telegram-stub')).telegramStub(),
}))

import { prismaSupport } from '@config/database'
import { pushToUser } from '@apps/services/push.service'
import * as chat from '@apps/services/chat.service'
import { runZhoraSuggestionPreviewPass } from '@apps/services/zhora/suggestion-preview.service'
import { prepareZhoraInvocation } from '@telegram/zhora'
import { handleZhoraAlternativeCallback } from '@telegram/zhora-alternative'
import { handleZhoraSendCallback } from '@telegram/zhora-send'
import {
  handleZhoraTranslationMenu,
  handleZhoraTranslationSelection,
} from '@telegram/zhora-translate'
import { handleUpdate } from '@telegram/updates'
import * as telegram from '@telegram/api'
import { cleanupTestUser, createTestUser, type TestUser } from './_helpers'
import {
  TEST_CHAT_ID,
  agentEditUpdate,
  agentMediaUpdate,
  agentMessageUpdate,
  callbackUpdate,
  generalMessageUpdate,
} from './_telegram-stub'

let user: TestUser
let ticket: SupportTicket
let target: SupportMessage
let fromId: number
const agents: string[] = []
const originalMuteRead = prismaSupport.supportMute.findUnique
const fetchMock = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
const sent = () => vi.mocked(telegram.sendPlainMessage)
const invocation = () => ({
  chatId: TEST_CHAT_ID,
  topicId: ticket.tgTopicId!,
  fromId,
})
const command = () =>
  agentMessageUpdate({
    topicId: ticket.tgTopicId!,
    messageId: randomInt(1000, 2_000_000_000),
    fromId,
    text: '/zhora',
  })

beforeEach(async () => {
  vi.clearAllMocks()
  settings.enabled = true
  fetchMock.mockRejectedValue(
    new Error('Network calls are forbidden in this test')
  )
  vi.stubGlobal('fetch', fetchMock)
  user = await createTestUser()
  fromId = randomInt(1000, 2_000_000_000)
  ticket = await prismaSupport.supportTicket.create({
    data: {
      ...user,
      tgChatId: BigInt(TEST_CHAT_ID),
      tgTopicId: randomInt(1000, 2_000_000_000),
    },
  })
  target = await prismaSupport.supportMessage.create({
    data: {
      ticketId: ticket.id,
      seq: 1,
      direction: 'IN',
      text: 'Synthetic question',
      tgMessageId: randomInt(1000, 2_000_000_000),
    },
  })
})
afterEach(async () => {
  // Prisma proxy methods need explicit restoration after a Vitest spy.
  vi.restoreAllMocks()
  prismaSupport.supportMute.findUnique = originalMuteRead
  vi.unstubAllGlobals()
  await prismaSupport.zhoraJob.deleteMany({ where: { ticketId: ticket.id } })
  await cleanupTestUser(user.userId)
  if (agents.length)
    await prismaSupport.supportAgent.deleteMany({
      where: { id: { in: agents.splice(0) } },
    })
  expect(fetchMock).not.toHaveBeenCalled()
})

describe('Zhora Telegram preflight', () => {
  it('deduplicates one command or tap while allowing a new request', async () => {
    await prismaSupport.supportTicket.update({
      where: { id: ticket.id },
      data: { detectedLang: 'pl', detectedLangSeq: target.seq },
    })
    const first = command()
    await handleUpdate(first)
    await handleUpdate(first)
    expect(
      await prismaSupport.zhoraSuggestion.count({
        where: { targetMessage: { ticketId: ticket.id } },
      })
    ).toBe(1)

    const tapped = callbackUpdate({
      topicId: ticket.tgTopicId!,
      messageId: target.tgMessageId!,
      fromId,
      data: `${telegram.ZHORA_REPLY_CALLBACK_PREFIX}${target.id}`,
    })
    await handleUpdate(tapped)
    await handleUpdate(tapped)
    expect(
      await prismaSupport.zhoraSuggestion.count({
        where: { targetMessage: { ticketId: ticket.id } },
      })
    ).toBe(2)
    // A request queues the draft; only the worker sends the finished preview.
    expect(sent()).not.toHaveBeenCalled()
    expect(pushToUser).not.toHaveBeenCalled()
    expect(
      await prismaSupport.supportMessage.count({
        where: { ticketId: ticket.id, direction: 'OUT' },
      })
    ).toBe(0)
  })

  it('consumes commands and photo captions privately without creating customer replies or AI calls', async () => {
    const updates = ['zhora', 'fix', 'brief'].map((name) =>
      agentMessageUpdate({
        topicId: ticket.tgTopicId!,
        messageId: randomInt(1000, 2_000_000_000),
        fromId,
        text: `/${name} operator draft`,
      })
    )
    updates.push(
      agentMediaUpdate({
        topicId: ticket.tgTopicId!,
        messageId: randomInt(1000, 2_000_000_000),
        fromId,
        caption: '/fix photo draft',
        media: {
          photo: [
            {
              file_id: 'test-file',
              file_unique_id: 'test-unique',
              width: 1,
              height: 1,
            },
          ],
        },
      })
    )
    for (const update of updates) await handleUpdate(update)
    expect(sent()).toHaveBeenCalledTimes(3)
    expect(sent().mock.calls[0]![0].text).toContain(
      'Не удалось определить язык этого сообщения'
    )
    expect(sent().mock.calls[1]![0].text).toContain('язык')
    expect(sent().mock.calls[2]![0].text).toContain('язык')
    expect(
      await prismaSupport.supportMessage.count({
        where: { ticketId: ticket.id },
      })
    ).toBe(1)
    expect(pushToUser).not.toHaveBeenCalled()
    expect(telegram.downloadFile).not.toHaveBeenCalled()
  })

  it('queues one private /brief job for a repeated command update', async () => {
    const update = agentMessageUpdate({
      topicId: ticket.tgTopicId!,
      messageId: randomInt(1000, 2_000_000_000),
      fromId,
      text: '/brief',
    })
    await handleUpdate(update)
    await handleUpdate(update)
    expect(
      await prismaSupport.zhoraJob.count({
        where: { ticketId: ticket.id, operation: 'brief' },
      })
    ).toBe(1)
    expect(await outgoing()).toHaveLength(0)
    expect(pushToUser).not.toHaveBeenCalled()
    expect(sent()).not.toHaveBeenCalled()
  })

  it('resolves the current ticket, customer message and invoking operator without requiring a profile', async () => {
    const agent = await prismaSupport.supportAgent.create({
      data: { tgUserId: BigInt(fromId), displayName: 'Test operator' },
    })
    agents.push(agent.id)
    await expect(
      prepareZhoraInvocation({
        ...invocation(),
        ticketId: ticket.id,
        tgMessageId: target.tgMessageId!,
      })
    ).resolves.toMatchObject({
      ticket: { id: ticket.id },
      agentId: agent.id,
      messageId: target.id,
    })
    await expect(
      prepareZhoraInvocation({ ...invocation(), fromId: fromId + 1 })
    ).resolves.toMatchObject({ agentId: null })
    expect(sent()).not.toHaveBeenCalled()
  })

  it.each(['disabled', 'general', 'unbound', 'closed', 'muted'] as const)(
    'explains why a command cannot run: %s',
    async (reason) => {
      let update = command()
      let expected: string
      switch (reason) {
        case 'disabled':
          settings.enabled = false
          expected = 'Жора выключен'
          break
        case 'general':
          // A General reply can carry a thread ID without being a topic.
          update = generalMessageUpdate({
            messageId: 999,
            fromId,
            text: '/zhora',
            threadId: ticket.tgTopicId!,
          })
          expected = 'внутри темы'
          break
        case 'unbound':
          await prismaSupport.supportTicket.update({
            where: { id: ticket.id },
            data: { tgTopicId: null },
          })
          expected = 'не найден тикет'
          break
        case 'closed':
          await prismaSupport.supportTicket.update({
            where: { id: ticket.id },
            data: { status: 'CLOSED' },
          })
          expected = 'Тикет закрыт'
          break
        case 'muted':
          await prismaSupport.supportMute.create({
            data: { ...user, mutedUntil: new Date(Date.now() + 60_000) },
          })
          expected = 'запрет на обращения'
      }
      await handleUpdate(update)
      expect(sent()).toHaveBeenCalledTimes(1)
      expect(sent().mock.calls[0]![0].text).toContain(expected)
      expect(pushToUser).not.toHaveBeenCalled()
      expect(
        await prismaSupport.supportMessage.count({
          where: { ticketId: ticket.id },
        })
      ).toBe(1)
    }
  )

  it('rejects another group and bot senders in the new preflight', async () => {
    expect(
      await prepareZhoraInvocation({
        ...invocation(),
        chatId: TEST_CHAT_ID - 1,
      })
    ).toBeNull()
    expect(
      await prepareZhoraInvocation({ ...invocation(), isBot: true })
    ).toBeNull()
    expect(sent()).not.toHaveBeenCalled()
    expect(pushToUser).not.toHaveBeenCalled()
  })

  it('rejects an old callback ticket or customer message after the same topic is reused', async () => {
    await prismaSupport.supportTicket.update({
      where: { id: ticket.id },
      data: { status: 'CLOSED' },
    })
    const current = await prismaSupport.supportTicket.create({
      data: { ...user, tgChatId: ticket.tgChatId, tgTopicId: ticket.tgTopicId },
    })
    expect(
      await prepareZhoraInvocation({ ...invocation(), ticketId: ticket.id })
    ).toBeNull()
    expect(sent().mock.calls.at(-1)![0].text).toContain('другому тикету')
    expect(
      await prepareZhoraInvocation({
        ...invocation(),
        ticketId: current.id,
        tgMessageId: target.tgMessageId!,
      })
    ).toBeNull()
    expect(sent().mock.calls.at(-1)![0].text).toContain('текущего тикета')
  })

  it('rejects operator and deleted messages as the source of an answer', async () => {
    await prismaSupport.supportMessage.update({
      where: { id: target.id },
      data: { direction: 'OUT' },
    })
    expect(
      await prepareZhoraInvocation({
        ...invocation(),
        tgMessageId: target.tgMessageId!,
      })
    ).toBeNull()
    await prismaSupport.supportMessage.update({
      where: { id: target.id },
      data: { direction: 'IN', deletedAt: new Date() },
    })
    expect(
      await prepareZhoraInvocation({
        ...invocation(),
        tgMessageId: target.tgMessageId!,
      })
    ).toBeNull()
    expect(sent()).toHaveBeenCalledTimes(2)
  })

  it('keeps edited commands away from the customer', async () => {
    const outgoing = await prismaSupport.supportMessage.create({
      data: {
        ticketId: ticket.id,
        seq: 2,
        direction: 'OUT',
        text: 'Original reply',
        tgMessageId: target.tgMessageId! + 1,
      },
    })
    await handleUpdate(
      agentEditUpdate({
        topicId: ticket.tgTopicId!,
        messageId: outgoing.tgMessageId!,
        fromId,
        text: '/fix private draft',
      })
    )
    expect(
      (
        await prismaSupport.supportMessage.findUniqueOrThrow({
          where: { id: outgoing.id },
        })
      ).text
    ).toBe('Original reply')
    expect(pushToUser).not.toHaveBeenCalled()
    expect(sent()).not.toHaveBeenCalled()
  })

  it('refuses new work when the mute check fails instead of assuming access', async () => {
    vi.spyOn(prismaSupport.supportMute, 'findUnique').mockRejectedValueOnce(
      new Error('synthetic DB failure')
    )
    await handleUpdate(command())
    expect(sent().mock.calls.at(-1)![0].text).toContain('Не удалось проверить')
    expect(pushToUser).not.toHaveBeenCalled()
  })
})

async function readyDraft() {
  await prismaSupport.supportTicket.update({
    where: { id: ticket.id },
    data: { lastSeq: target.seq },
  })
  const job = await prismaSupport.zhoraJob.create({
    data: {
      eventKey: `test:send:${randomUUID()}`,
      operation: 'reply',
      ticketId: ticket.id,
      input: {},
      status: 'completed',
      result: {
        answer: 'Please provide the withdrawal ID.',
        answerRu: 'Укажите ID вывода.',
        sources: [],
        needsReview: true,
      },
      suggestion: {
        create: {
          targetMessageId: target.id,
          language: 'en',
          previewSentAt: new Date(),
          previewTgMessageId: target.tgMessageId! + 1,
        },
      },
    },
    include: { suggestion: true },
  })
  const suggestion = job.suggestion!
  const tap = (operatorId = fromId) =>
    callbackUpdate({
      topicId: ticket.tgTopicId!,
      messageId: suggestion.previewTgMessageId!,
      fromId: operatorId,
      data: `${telegram.ZHORA_SEND_CALLBACK_PREFIX}${suggestion.id}`,
    })
  return { suggestion, tap }
}

const outgoing = () =>
  prismaSupport.supportMessage.findMany({
    where: { ticketId: ticket.id, direction: 'OUT' },
    orderBy: { seq: 'asc' },
  })

describe('Zhora operator-approved sending', () => {
  it('sends only the saved answer as the clicking operator, once across concurrent taps and retries', async () => {
    const agent = await prismaSupport.supportAgent.create({
      data: { tgUserId: BigInt(fromId), displayName: 'Clicking operator' },
    })
    agents.push(agent.id)
    const { suggestion, tap } = await readyDraft()
    expect(await outgoing()).toHaveLength(0)
    const update = tap()
    await Promise.all([handleUpdate(update), handleUpdate(update)])
    await handleUpdate(tap(fromId + 1))
    expect(await outgoing()).toMatchObject([
      {
        agentId: agent.id,
        text: 'Please provide the withdrawal ID.',
        dedupeKey: `zhora:send:${suggestion.id}`,
        autoKind: null,
      },
    ])
    expect(pushToUser).toHaveBeenCalledTimes(1)
    expect(sent().mock.calls.at(-1)![0].text).toContain('уже отправлен')
  })

  it('keeps the existing neutral attribution for an operator without a profile', async () => {
    const { tap } = await readyDraft()
    await handleUpdate(tap())
    expect(await outgoing()).toMatchObject([{ agentId: null }])
  })

  it('blocks delivery if the ticket closes after preflight, before the append', async () => {
    const { tap } = await readyDraft()
    const send = chat.agentSendMessage
    vi.spyOn(chat, 'agentSendMessage').mockImplementationOnce(async (input) => {
      await prismaSupport.supportTicket.update({
        where: { id: ticket.id },
        data: { status: 'CLOSED' },
      })
      return send(input)
    })
    await handleUpdate(tap())
    expect(await outgoing()).toHaveLength(0)
    expect(pushToUser).not.toHaveBeenCalled()
    expect(sent().mock.calls.at(-1)![0].text).toContain('Ответ не отправлен')
  })

  it.each([
    'closed',
    'muted',
    'new-ticket',
    'deleted-source',
    'disabled',
    'mute-read-error',
  ] as const)('rechecks access at click time: %s', async (reason) => {
    const { tap } = await readyDraft()
    if (reason === 'closed' || reason === 'new-ticket') {
      await prismaSupport.supportTicket.update({
        where: { id: ticket.id },
        data: { status: 'CLOSED' },
      })
    }
    if (reason === 'new-ticket') {
      await prismaSupport.supportTicket.create({
        data: {
          ...user,
          tgChatId: ticket.tgChatId,
          tgTopicId: ticket.tgTopicId,
        },
      })
    }
    if (reason === 'muted') {
      await prismaSupport.supportMute.create({
        data: { ...user, mutedUntil: new Date(Date.now() + 60_000) },
      })
    }
    if (reason === 'deleted-source') {
      await prismaSupport.supportMessage.update({
        where: { id: target.id },
        data: { deletedAt: new Date() },
      })
    }
    if (reason === 'disabled') settings.enabled = false
    if (reason === 'mute-read-error') {
      vi.spyOn(prismaSupport.supportMute, 'findUnique').mockRejectedValueOnce(
        new Error('synthetic failure')
      )
    }
    await handleUpdate(tap())
    expect(await outgoing()).toHaveLength(0)
    expect(pushToUser).not.toHaveBeenCalled()
    expect(sent()).toHaveBeenCalledTimes(1)
  })

  it.each([
    'pending-preview',
    'failed-job',
    'empty-answer',
    'wrong-preview',
    'wrong-topic',
    'general',
    'foreign-chat',
    'bot',
  ] as const)(
    'does not deliver an unavailable or misplaced draft: %s',
    async (reason) => {
      const { suggestion, tap } = await readyDraft()
      const update = tap()
      const query = update.callback_query!
      if (reason === 'pending-preview') {
        await prismaSupport.zhoraSuggestion.update({
          where: { id: suggestion.id },
          data: { previewSentAt: null },
        })
      }
      if (reason === 'failed-job' || reason === 'empty-answer') {
        await prismaSupport.zhoraJob.update({
          where: { id: suggestion.jobId },
          data:
            reason === 'failed-job'
              ? { status: 'failed' }
              : { result: { answer: '  ' } },
        })
      }
      if (reason === 'wrong-preview') query.message!.message_id += 1
      if (reason === 'wrong-topic') query.message!.message_thread_id! += 1
      if (reason === 'general') query.message!.is_topic_message = undefined
      if (reason === 'foreign-chat') query.message!.chat.id -= 1
      if (reason === 'bot') query.from.is_bot = true
      await handleUpdate(update)
      expect(await outgoing()).toHaveLength(0)
      expect(pushToUser).not.toHaveBeenCalled()
      expect(telegram.answerCallback).toHaveBeenCalledTimes(1)
    }
  )
})

describe('Zhora card quick action', () => {
  it('shows the current ticket card to the operator without sending a customer reply', async () => {
    const { suggestion } = await readyDraft()
    settings.enabled = false // /info remains available even when AI is paused.
    const update = callbackUpdate({
      topicId: ticket.tgTopicId!,
      messageId: suggestion.previewTgMessageId!,
      fromId,
      data: `${telegram.ZHORA_CARD_CALLBACK_PREFIX}${suggestion.id}`,
    })
    await handleUpdate(update)
    expect(vi.mocked(telegram.sendToTopic)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(telegram.sendToTopic).mock.calls[0]![0]).toMatchObject({
      chatId: TEST_CHAT_ID,
      topicId: ticket.tgTopicId,
      text: expect.stringContaining(user.userNId.toString()),
    })
    expect(await outgoing()).toHaveLength(0)
    expect(pushToUser).not.toHaveBeenCalled()
  })

  it('rejects a stale preview or a button used in another topic', async () => {
    const { suggestion } = await readyDraft()
    const invalidButtons: Array<[number, number]> = [
      [ticket.tgTopicId!, suggestion.previewTgMessageId! + 1],
      [ticket.tgTopicId! + 1, suggestion.previewTgMessageId!],
    ]
    for (const [topicId, messageId] of invalidButtons) {
      await handleUpdate(
        callbackUpdate({
          topicId,
          messageId,
          fromId,
          data: `${telegram.ZHORA_CARD_CALLBACK_PREFIX}${suggestion.id}`,
        })
      )
    }
    expect(vi.mocked(telegram.sendToTopic)).not.toHaveBeenCalled()
    expect(sent()).toHaveBeenCalledTimes(2)
    expect(await outgoing()).toHaveLength(0)
  })
})

describe('Zhora /fix command', () => {
  it('keeps inline text private and deduplicates a redelivered command', async () => {
    await prismaSupport.supportTicket.update({
      where: { id: ticket.id },
      data: { detectedLang: 'en', detectedLangSeq: target.seq },
    })
    const update = agentMessageUpdate({
      topicId: ticket.tgTopicId!,
      messageId: randomInt(1000, 2_000_000_000),
      fromId,
      text: '/fix пожалуйста проверьте аккаунт',
    })
    await handleUpdate(update)
    await handleUpdate(update)
    const jobs = await prismaSupport.zhoraJob.findMany({
      where: { ticketId: ticket.id, operation: 'fix' },
      include: { suggestion: true },
    })
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.input).toEqual({
      kind: 'suggestion-fix',
      text: 'пожалуйста проверьте аккаунт',
    })
    expect(jobs[0]!.suggestion).toMatchObject({
      targetMessageId: target.id,
      language: 'en',
    })
    expect(await outgoing()).toHaveLength(0)
    expect(pushToUser).not.toHaveBeenCalled()
  })

  it('uses an own sent message for /fix, warns in the preview, and sends a separate answer only after a tap', async () => {
    await prismaSupport.supportTicket.update({
      where: { id: ticket.id },
      data: {
        detectedLang: 'en',
        detectedLangSeq: target.seq,
        lastSeq: target.seq,
      },
    })
    const sourceId = randomInt(1000, 2_000_000_000)
    await handleUpdate(
      agentMessageUpdate({
        topicId: ticket.tgTopicId!,
        messageId: sourceId,
        fromId,
        text: 'сейчас проверим',
      })
    )
    expect(await outgoing()).toHaveLength(1)
    expect(pushToUser).toHaveBeenCalledTimes(1)
    const original = (await outgoing())[0]!
    const fix = agentMessageUpdate({
      topicId: ticket.tgTopicId!,
      messageId: sourceId + 1,
      fromId,
      text: '/fix',
      replyToMessageId: sourceId,
    })
    await handleUpdate(fix)
    await handleUpdate(fix)
    const job = await prismaSupport.zhoraJob.findFirstOrThrow({
      where: { ticketId: ticket.id, operation: 'fix' },
      include: { suggestion: true },
    })
    expect(job.input).toEqual({
      kind: 'suggestion-fix',
      text: 'сейчас проверим',
      sourceMessageId: original.id,
    })
    expect(await outgoing()).toHaveLength(1)
    await prismaSupport.zhoraJob.update({
      where: { id: job.id },
      data: {
        status: 'completed',
        result: {
          answer: 'We will check.',
          answerRu: 'Сейчас проверим.',
          needsReview: false,
          sources: [],
          kind: 'fix',
          originalAlreadySent: true,
        },
      },
    })
    await runZhoraSuggestionPreviewPass()
    expect(sent().mock.calls.at(-1)![0].text).toContain(
      'Исходное сообщение уже доставлено клиенту'
    )
    const suggestion = await prismaSupport.zhoraSuggestion.findUniqueOrThrow({
      where: { id: job.suggestion!.id },
    })
    await handleZhoraSendCallback({
      ...invocation(),
      suggestionId: suggestion.id,
      previewMessageId: suggestion.previewTgMessageId!,
    })
    await handleZhoraSendCallback({
      ...invocation(),
      suggestionId: suggestion.id,
      previewMessageId: suggestion.previewTgMessageId!,
    })
    expect(await outgoing()).toMatchObject([
      { id: original.id, text: 'сейчас проверим' },
      { text: 'We will check.' },
    ])
    expect(pushToUser).toHaveBeenCalledTimes(2)
  })

  it('rejects /fix replying to another operator’s message', async () => {
    await prismaSupport.supportTicket.update({
      where: { id: ticket.id },
      data: {
        detectedLang: 'en',
        detectedLangSeq: target.seq,
        lastSeq: target.seq,
      },
    })
    const sourceId = randomInt(1000, 2_000_000_000)
    await handleUpdate(
      agentMessageUpdate({
        topicId: ticket.tgTopicId!,
        messageId: sourceId,
        fromId: fromId + 1,
        text: 'чужой ответ',
      })
    )
    await handleUpdate(
      agentMessageUpdate({
        topicId: ticket.tgTopicId!,
        messageId: randomInt(1000, 2_000_000_000),
        fromId,
        text: '/fix',
        replyToMessageId: sourceId,
        replyToFromId: fromId + 1,
      })
    )
    expect(
      await prismaSupport.zhoraJob.count({
        where: { ticketId: ticket.id, operation: 'fix' },
      })
    ).toBe(0)
    expect(await outgoing()).toHaveLength(1)
  })

  it('delivers the edited draft only after the operator taps Send', async () => {
    await prismaSupport.supportTicket.update({
      where: { id: ticket.id },
      data: {
        detectedLang: 'en',
        detectedLangSeq: target.seq,
        lastSeq: target.seq,
      },
    })
    await handleUpdate(
      agentMessageUpdate({
        topicId: ticket.tgTopicId!,
        messageId: randomInt(1000, 2_000_000_000),
        fromId,
        text: '/fix проверим запрос',
      })
    )
    const job = await prismaSupport.zhoraJob.findFirstOrThrow({
      where: { ticketId: ticket.id, operation: 'fix' },
      include: { suggestion: true },
    })
    await prismaSupport.zhoraJob.update({
      where: { id: job.id },
      data: {
        status: 'completed',
        result: {
          answer: 'We will check your request.',
          answerRu: 'Проверим ваш запрос.',
          needsReview: false,
          sources: [],
          kind: 'fix',
        },
      },
    })
    await runZhoraSuggestionPreviewPass()
    const suggestion = await prismaSupport.zhoraSuggestion.findUniqueOrThrow({
      where: { id: job.suggestion!.id },
    })
    expect(await outgoing()).toHaveLength(0)
    await handleZhoraSendCallback({
      ...invocation(),
      suggestionId: suggestion.id,
      previewMessageId: suggestion.previewTgMessageId!,
    })
    expect(await outgoing()).toMatchObject([
      { text: 'We will check your request.' },
    ])
    expect(pushToUser).toHaveBeenCalledTimes(1)
  })
})

describe('Zhora translation buttons', () => {
  it('offers 11 languages, then sends only the selected saved variant', async () => {
    const { suggestion } = await readyDraft()
    await handleZhoraTranslationMenu({
      ...invocation(),
      suggestionId: suggestion.id,
      previewMessageId: suggestion.previewTgMessageId!,
    })
    const menu = sent().mock.calls.at(-1)![0]
    expect(menu.text).toContain('Выберите язык')
    const buttons = menu.replyMarkup!.inline_keyboard.flat()
    expect(buttons.map((button) => button.text)).toEqual([
      'en',
      'ru',
      'ua',
      'de',
      'es',
      'fr',
      'hi',
      'tr',
      'ar',
      'cs',
      'it',
    ])
    expect(buttons.find((button) => button.text === 'de')).toMatchObject({
      callback_data: `ztl:${suggestion.id}:de`,
    })
    await handleZhoraTranslationSelection({
      ...invocation(),
      suggestionId: suggestion.id,
      language: 'de',
    })
    const variant = await prismaSupport.zhoraSuggestion.findFirstOrThrow({
      where: { sourceSuggestionId: suggestion.id, language: 'de' },
    })
    await prismaSupport.zhoraJob.update({
      where: { id: variant.jobId },
      data: {
        status: 'completed',
        result: {
          answer: 'Bitte nennen Sie Ihre ID.',
          answerRu: 'Укажите ID вывода.',
          sources: [],
          needsReview: true,
        },
      },
    })
    await runZhoraSuggestionPreviewPass()
    const ready = await prismaSupport.zhoraSuggestion.findUniqueOrThrow({
      where: { id: variant.id },
    })
    expect(ready.previewTgMessageId).toBeTruthy()
    expect(await outgoing()).toHaveLength(0)
    expect(sent().mock.calls.at(-1)![0]).toMatchObject({
      text: expect.stringContaining('RU: Укажите ID вывода.'),
      replyMarkup: {
        inline_keyboard: [
          [
            { text: 'Отправить', callback_data: `zs:${variant.id}` },
            {
              text: 'Скопировать',
              copy_text: { text: 'Bitte nennen Sie Ihre ID.' },
            },
          ],
          [{ text: 'Карточка', callback_data: `zc:${variant.id}` }],
          [
            { text: '👍', callback_data: `zrate:${variant.id}:1` },
            { text: '👎', callback_data: `zrate:${variant.id}:-1` },
          ],
        ],
      },
    })
    await handleZhoraSendCallback({
      ...invocation(),
      suggestionId: variant.id,
      previewMessageId: ready.previewTgMessageId!,
    })
    expect(await outgoing()).toMatchObject([
      { text: 'Bitte nennen Sie Ihre ID.' },
    ])
    expect(pushToUser).toHaveBeenCalledTimes(1)
    expect(
      await prismaSupport.zhoraSuggestion.count({
        where: { sourceSuggestionId: suggestion.id },
      })
    ).toBe(1)
    expect(
      (
        await prismaSupport.supportTicket.findUniqueOrThrow({
          where: { id: ticket.id },
        })
      ).detectedLang
    ).toBeNull()
  })

  it('rejects a menu tap on another preview and a selection in a closed ticket', async () => {
    const { suggestion } = await readyDraft()
    await handleZhoraTranslationMenu({
      ...invocation(),
      suggestionId: suggestion.id,
      previewMessageId: suggestion.previewTgMessageId! + 1,
    })
    expect(sent().mock.calls.at(-1)![0].text).toContain('недоступен')
    await prismaSupport.supportTicket.update({
      where: { id: ticket.id },
      data: { status: 'CLOSED' },
    })
    await handleZhoraTranslationSelection({
      ...invocation(),
      suggestionId: suggestion.id,
      language: 'ru',
    })
    expect(
      await prismaSupport.zhoraSuggestion.count({
        where: { sourceSuggestionId: suggestion.id },
      })
    ).toBe(0)
    expect(pushToUser).not.toHaveBeenCalled()
  })
})

describe('Zhora alternative button', () => {
  it('keeps the original draft and sends only the alternative explicitly chosen', async () => {
    const { suggestion } = await readyDraft()
    const callbackId = `synthetic:${randomUUID()}`
    const tap = (id: string) =>
      handleZhoraAlternativeCallback({
        ...invocation(),
        suggestionId: suggestion.id,
        previewMessageId: suggestion.previewTgMessageId!,
        callbackId: id,
      })
    await tap(callbackId)
    await tap(callbackId)
    const jobs = await prismaSupport.zhoraJob.findMany({
      where: {
        ticketId: ticket.id,
        input: { path: ['kind'], equals: 'suggestion-alternative' },
      },
      include: { suggestion: true },
    })
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.suggestion!.id).not.toBe(suggestion.id)
    expect(await outgoing()).toHaveLength(0)

    await prismaSupport.zhoraJob.update({
      where: { id: jobs[0]!.id },
      data: {
        status: 'completed',
        result: {
          answer: 'Could you share your withdrawal ID, please?',
          answerRu: 'Пожалуйста, сообщите ID вывода.',
          sources: [],
          needsReview: true,
        },
      },
    })
    await runZhoraSuggestionPreviewPass()
    const alternative = await prismaSupport.zhoraSuggestion.findUniqueOrThrow({
      where: { id: jobs[0]!.suggestion!.id },
    })
    await handleZhoraSendCallback({
      ...invocation(),
      suggestionId: alternative.id,
      previewMessageId: alternative.previewTgMessageId!,
    })
    expect(await outgoing()).toMatchObject([
      { text: 'Could you share your withdrawal ID, please?' },
    ])
    expect(pushToUser).toHaveBeenCalledTimes(1)
    expect(
      (
        await prismaSupport.zhoraJob.findUniqueOrThrow({
          where: { id: suggestion.jobId },
        })
      ).result
    ).toMatchObject({ answer: 'Please provide the withdrawal ID.' })
  })

  it('rejects a tap under another preview message', async () => {
    const { suggestion } = await readyDraft()
    await handleZhoraAlternativeCallback({
      ...invocation(),
      suggestionId: suggestion.id,
      previewMessageId: suggestion.previewTgMessageId! + 1,
      callbackId: `synthetic:${randomUUID()}`,
    })
    expect(sent().mock.calls.at(-1)![0].text).toContain('недоступен')
    expect(
      await prismaSupport.zhoraJob.count({
        where: {
          ticketId: ticket.id,
          input: { path: ['kind'], equals: 'suggestion-alternative' },
        },
      })
    ).toBe(0)
    expect(await outgoing()).toHaveLength(0)
  })
})
