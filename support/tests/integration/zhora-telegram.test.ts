import { randomInt } from 'node:crypto'
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
}))
vi.mock('@apps/services/push.service', () => ({ pushToUser: vi.fn() }))
vi.mock('@telegram/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@telegram/api')>()),
  ...(await import('./_telegram-stub')).telegramStub(),
}))

import { prismaSupport } from '@config/database'
import { pushToUser } from '@apps/services/push.service'
import { prepareZhoraInvocation } from '@telegram/zhora'
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
    expect(await prismaSupport.zhoraSuggestion.count()).toBe(1)

    const tapped = callbackUpdate({
      topicId: ticket.tgTopicId!,
      messageId: target.tgMessageId!,
      fromId,
      data: `${telegram.ZHORA_REPLY_CALLBACK_PREFIX}${target.id}`,
    })
    await handleUpdate(tapped)
    await handleUpdate(tapped)
    expect(await prismaSupport.zhoraSuggestion.count()).toBe(2)
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
    expect(sent()).toHaveBeenCalledTimes(4)
    expect(sent().mock.calls[0]![0].text).toContain(
      'Не удалось определить язык этого сообщения'
    )
    expect(
      sent()
        .mock.calls.slice(1)
        .every(([message]) => message.text.includes('пока недоступна'))
    ).toBe(true)
    expect(
      await prismaSupport.supportMessage.count({
        where: { ticketId: ticket.id },
      })
    ).toBe(1)
    expect(pushToUser).not.toHaveBeenCalled()
    expect(telegram.downloadFile).not.toHaveBeenCalled()
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
