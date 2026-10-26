import { randomInt, randomUUID } from 'node:crypto'
import fs from 'node:fs'
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

vi.mock('@apps/services/push.service', () => ({
  pushToUser: vi.fn(async () => undefined),
}))
vi.mock('@telegram/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@telegram/api')>()),
  ...(await import('./_telegram-stub')).telegramStub(),
}))
vi.mock('@telegram/zhora-alternative', () => ({
  handleZhoraAlternativeCallback: vi.fn(),
}))

import { prismaSupport, shutdownPrisma } from '@config/database'
import { SUPPORT_FILES_DIR } from '@config/env'
import { logger } from '@config/logger'

import { userSendMessage } from '@apps/services/chat.service'
import { toAttachmentDto } from '@apps/services/mappers'
import { pushToUser } from '@apps/services/push.service'

import * as telegram from '@telegram/api'
import { handleUpdate } from '@telegram/updates'
import { handleZhoraAlternativeCallback } from '@telegram/zhora-alternative'

import { MP4_BYTES, PNG_BYTES } from '../fixtures/bytes'
import {
  cleanupTestUser,
  createTestUser,
  listAttachments,
  listMessages,
  openTicketOf,
  unreadInDb,
} from './_helpers'
import {
  TEST_CHAT_ID,
  agentEditUpdate,
  agentMediaUpdate,
  agentMessageUpdate,
  callbackUpdate,
  generalMessageUpdate,
} from './_telegram-stub'

// `handleUpdate` is total: it swallows every failure so Telegram never
// redelivers a poisoned update forever. That is right in production and
// blinding in a test — a broken router looks exactly like "nothing happened".
// So every logged error is captured, and the happy paths assert there were
// none.
const loggedErrors: string[] = []

const pushes = () => vi.mocked(pushToUser).mock.calls
const sentPlain = () => vi.mocked(telegram.sendPlainMessage)

beforeAll(() => {
  // Installed once and never restored: `vi.restoreAllMocks()` would also strip
  // the implementations off the Telegram stub's `vi.fn`s.
  vi.spyOn(logger, 'error').mockImplementation(((message: unknown) => {
    loggedErrors.push(String(message))
    return logger
  }) as never)
})

beforeEach(() => {
  vi.clearAllMocks()
  loggedErrors.length = 0
})

afterAll(async () => {
  await shutdownPrisma()
})

it('routes an alternative callback with the exact preview and event IDs', async () => {
  const suggestionId = randomUUID()
  const update = callbackUpdate({
    topicId: 4242,
    messageId: 5252,
    fromId: 777001,
    data: `za:${suggestionId}`,
  })
  await handleUpdate(update)
  expect(handleZhoraAlternativeCallback).toHaveBeenCalledWith({
    chatId: TEST_CHAT_ID,
    topicId: 4242,
    fromId: 777001,
    suggestionId,
    previewMessageId: 5252,
    callbackId: update.callback_query!.id,
  })
})

/** A user with an open, topic-bound ticket — the normal state of a live chat. */
async function userWithBoundTicket() {
  const user = await createTestUser()
  await userSendMessage({
    userId: user.userId,
    userNId: user.userNId,
    text: 'здравствуйте',
  })
  const ticket = (await openTicketOf(user.userId))!
  return { user, ticket, topicId: ticket.tgTopicId! }
}

describe('an operator replying in a ticket topic', () => {
  it('turns a redelivered update into ONE message and ONE push', async () => {
    const { user, ticket, topicId } = await userWithBoundTicket()
    try {
      vi.clearAllMocks()
      const update = agentMessageUpdate({
        topicId,
        messageId: 4242,
        fromId: 777001,
        text: 'Добрый день! Проверяем ваш депозит.',
      })

      // Telegram retries an update until it gets a 2xx, and the router answers
      // 200 even when it fails — so the SAME update arriving twice is normal
      // traffic, not an edge case.
      await handleUpdate(update)
      await handleUpdate(update)

      const messages = await listMessages(ticket.id)
      // The greeting is an OUT row too; this suite is about the agent's own.
      const out = messages.filter(
        (m) => m.direction === 'OUT' && m.autoKind === null
      )
      expect(out).toHaveLength(1)
      expect(out[0]!.text).toBe('Добрый день! Проверяем ваш депозит.')
      expect(out[0]!.tgMessageId).toBe(4242)
      expect(out[0]!.dedupeKey).toBe(`tg:${TEST_CHAT_ID}:4242`)
      // No burnt seq: the deduped attempt rolled its transaction back.
      // opened, user, greeting, the operator's single reply
      expect(messages.map((m) => m.seq)).toEqual([1, 2, 3, 4])

      expect(pushes()).toHaveLength(1)
      expect(pushes()[0]![1]).toMatchObject({
        action: 'support_message',
        message: {
          direction: 'out',
          text: 'Добрый день! Проверяем ваш депозит.',
        },
        unread: 1,
      })
      // The badge moved exactly once, too.
      expect(await unreadInDb(user.userId)).toBe(1)
      expect(loggedErrors).toEqual([])
    } finally {
      await cleanupTestUser(user.userId)
    }
  })
})

describe('an operator editing their message in Telegram', () => {
  it('leaves editedAt alone for a no-op edit and pushes nothing', async () => {
    const { user, ticket, topicId } = await userWithBoundTicket()
    try {
      const text = 'сейчас проверим'
      await handleUpdate(
        agentMessageUpdate({ topicId, messageId: 5150, fromId: 777002, text })
      )
      vi.clearAllMocks()

      // Telegram fires edit events for changes that are not the text at all
      // (a link preview resolving, for one). Stamping `editedAt` for those
      // would flash an "изменено" marker the operator never caused.
      await handleUpdate(
        agentEditUpdate({ topicId, messageId: 5150, fromId: 777002, text })
      )

      const edited = (await listMessages(ticket.id)).find(
        (m) => m.tgMessageId === 5150
      )!
      expect(edited.text).toBe(text)
      expect(edited.editedAt).toBeNull()
      expect(pushes()).toHaveLength(0)
      expect(loggedErrors).toEqual([])
    } finally {
      await cleanupTestUser(user.userId)
    }
  })

  it('mirrors a real edit into the feed and pushes support_message_updated', async () => {
    const { user, ticket, topicId } = await userWithBoundTicket()
    try {
      await handleUpdate(
        agentMessageUpdate({
          topicId,
          messageId: 5151,
          fromId: 777003,
          text: 'депозит придёт завтра',
        })
      )
      const before = (await listMessages(ticket.id)).find(
        (m) => m.tgMessageId === 5151
      )!
      vi.clearAllMocks()

      await handleUpdate(
        agentEditUpdate({
          topicId,
          messageId: 5151,
          fromId: 777003,
          text: 'депозит уже зачислен',
        })
      )

      const after = await prismaSupport.supportMessage.findUniqueOrThrow({
        where: { id: before.id },
      })
      expect(after.text).toBe('депозит уже зачислен')
      expect(after.editedAt).not.toBeNull()
      // An edit rewrites a bubble the user already saw; it must not re-raise
      // the badge as though it were a new reply.
      expect(after.seq).toBe(before.seq)
      expect(await unreadInDb(user.userId)).toBe(1)

      expect(pushes()).toHaveLength(1)
      expect(pushes()[0]![1]).toMatchObject({
        action: 'support_message_updated',
        id: before.id,
        ticketId: ticket.id,
        text: 'депозит уже зачислен',
        deleted: false,
      })
      expect(loggedErrors).toEqual([])
    } finally {
      await cleanupTestUser(user.userId)
    }
  })
})

describe('an operator sending video', () => {
  it('turns one video update into one bubble carrying a playable attachment', async () => {
    const { user, ticket, topicId } = await userWithBoundTicket()
    try {
      vi.clearAllMocks()

      // The one thing stubbed is the download itself — the boundary where the
      // service would otherwise dial api.telegram.org. Everything after it (the
      // guard re-sniffing the bytes, the subtree choice, the row, the DTO) is
      // the real production path, which is the point: Telegram announced
      // `video/quicktime`, and only the BYTES decide what is stored.
      vi.mocked(telegram.downloadFile).mockResolvedValueOnce({
        buffer: MP4_BYTES,
        filePath: 'videos/file_42.mp4',
      })

      await handleUpdate(
        agentMediaUpdate({
          topicId,
          messageId: 6003,
          fromId: 777022,
          caption: 'смотрите запись',
          media: {
            video: {
              file_id: 'BAAC-ok',
              file_unique_id: 'u-ok',
              width: 1280,
              height: 720,
              duration: 12,
              file_name: 'запись экрана.mov',
              mime_type: 'video/quicktime',
              file_size: MP4_BYTES.length,
            },
          },
        })
      )

      // One bubble, not one per file: the caption and the video are the same
      // message on the operator's screen and must stay one on the user's.
      const out = (await listMessages(ticket.id)).filter(
        (m) => m.direction === 'OUT' && m.autoKind === null
      )
      expect(out).toHaveLength(1)
      expect(out[0]!.text).toBe('смотрите запись')

      const attachments = await listAttachments(ticket.id)
      expect(attachments).toHaveLength(1)
      const video = attachments[0]!
      expect(video.messageId).toBe(out[0]!.id)
      expect(video.kind).toBe('VIDEO')
      // Declared quicktime, actually mp4 — the bytes win, and the stored name
      // gets the sniffed extension so the download cannot lie either.
      expect(video.mimeType).toBe('video/mp4')
      expect(video.fileName).toBe('запись экрана.mp4')
      expect(video.uploadedByAgent).toBe(true)
      // Kept so the bot can re-send the file without re-uploading bytes.
      expect(video.tgFileId).toBe('BAAC-ok')
      // Nothing decoded it: same bytes, no dimensions.
      expect(video.sizeBytes).toBe(MP4_BYTES.length)
      expect(video.width).toBeNull()
      expect(video.height).toBeNull()

      // It landed in the subtree exchange publishes, and the DTO the user's
      // browser receives points at the static mount rather than the proxy —
      // the proxy has no Range support, so through it the clip would not seek.
      expect(video.storagePath.startsWith(`media/${ticket.id}/`)).toBe(true)
      const dto = toAttachmentDto(video)
      expect(dto.url).toBe(`/support-files/${video.storagePath}`)
      expect(
        fs.existsSync(
          path.join(path.resolve(SUPPORT_FILES_DIR), video.storagePath)
        )
      ).toBe(true)

      // The user is told about it exactly once, and the push carries the same
      // url — the browser renders straight from the envelope.
      expect(pushes()).toHaveLength(1)
      expect(pushes()[0]![1]).toMatchObject({
        action: 'support_message',
        message: { direction: 'out', attachments: [dto] },
      })
      // Nothing was skipped, so the operator's topic stays quiet.
      expect(sentPlain()).not.toHaveBeenCalled()
      expect(loggedErrors).toEqual([])
    } finally {
      fs.rmSync(
        path.join(path.resolve(SUPPORT_FILES_DIR), 'media', ticket.id),
        {
          recursive: true,
          force: true,
        }
      )
      await cleanupTestUser(user.userId)
    }
  })

  it('tells the agent when the file is too big for a bot to fetch', async () => {
    const { user, ticket, topicId } = await userWithBoundTicket()
    try {
      vi.clearAllMocks()

      // The asymmetry this whole path exists for: their client happily uploads
      // 300 MB, a bot may only DOWNLOAD 20 MB. Telegram shows the operator a
      // finished upload, so without a note the failure is invisible on both
      // sides.
      await handleUpdate(
        agentMediaUpdate({
          topicId,
          messageId: 6001,
          fromId: 777020,
          caption: 'вот запись экрана',
          media: {
            video: {
              file_id: 'BAAC-too-large',
              file_unique_id: 'u-too-large',
              width: 1920,
              height: 1080,
              duration: 90,
              file_name: 'экран.mov',
              mime_type: 'video/quicktime',
              file_size: 300 * 1024 * 1024,
            },
          },
        })
      )

      // Nothing broken on the platform side: the caption is a normal bubble,
      // carrying no attachment rather than a broken one.
      const out = (await listMessages(ticket.id)).filter(
        (m) => m.direction === 'OUT' && m.autoKind === null
      )
      expect(out).toHaveLength(1)
      expect(out[0]!.text).toBe('вот запись экрана')
      expect(
        await prismaSupport.supportAttachment.count({
          where: { ticketId: ticket.id },
        })
      ).toBe(0)

      // The size alone settles it — no download is even attempted.
      expect(vi.mocked(telegram.downloadFile)).not.toHaveBeenCalled()

      expect(sentPlain()).toHaveBeenCalledTimes(1)
      const note = String(sentPlain().mock.calls[0]![0].text)
      expect(note).toContain('экран.mov')
      expect(note).toContain('20 МБ')
      expect(loggedErrors).toEqual([])
    } finally {
      await cleanupTestUser(user.userId)
    }
  })

  it('downloads a GIF once, though Telegram announces it twice', async () => {
    const { user, topicId } = await userWithBoundTicket()
    try {
      vi.clearAllMocks()

      const fileId = 'CgAC-animation'
      await handleUpdate(
        agentMediaUpdate({
          topicId,
          messageId: 6002,
          fromId: 777021,
          media: {
            animation: {
              file_id: fileId,
              file_unique_id: 'u-animation',
              width: 480,
              height: 270,
              duration: 3,
              file_name: 'reaction.mp4',
              mime_type: 'video/mp4',
              file_size: 512 * 1024,
            },
            // For backward compatibility Telegram fills `document` on an
            // animation message with the SAME file. Taking both would fetch it
            // twice and hang two identical attachments off one bubble.
            document: {
              file_id: fileId,
              file_unique_id: 'u-animation',
              file_name: 'reaction.mp4',
              mime_type: 'video/mp4',
              file_size: 512 * 1024,
            },
          },
        })
      )

      expect(vi.mocked(telegram.downloadFile)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(telegram.downloadFile)).toHaveBeenCalledWith(fileId)
      // The stub downloads nothing, so this run ends in the skipped-file note —
      // one line for one file, which is the point being made.
      const note = String(sentPlain().mock.calls[0]![0].text)
      expect(note.split('\n')).toHaveLength(1)
      expect(loggedErrors).toEqual([])
    } finally {
      await cleanupTestUser(user.userId)
    }
  })
})

describe('the General topic', () => {
  it('is completely silent — no row written, no Telegram call, no push', async () => {
    const { user, ticket } = await userWithBoundTicket()
    try {
      const before = await listMessages(ticket.id)
      const totalBefore = await prismaSupport.supportMessage.count()
      vi.clearAllMocks()

      // A plain post in General carries no thread id at all...
      await handleUpdate(
        generalMessageUpdate({
          messageId: 9001,
          fromId: 777004,
          text: 'ребята, кто сегодня на смене?',
        })
      )
      // ...and a reply inside General carries one (the message it answers),
      // which is exactly why `is_topic_message` is the real discriminator.
      await handleUpdate(
        generalMessageUpdate({
          messageId: 9002,
          fromId: 777004,
          text: 'я, до шести',
          threadId: 9001,
        })
      )

      expect(await prismaSupport.supportMessage.count()).toBe(totalBefore)
      expect(await listMessages(ticket.id)).toHaveLength(before.length)
      expect(pushes()).toHaveLength(0)
      expect(sentPlain()).not.toHaveBeenCalled()
      expect(vi.mocked(telegram.sendToTopic)).not.toHaveBeenCalled()
      expect(vi.mocked(telegram.createTicketTopic)).not.toHaveBeenCalled()
      expect(loggedErrors).toEqual([])
    } finally {
      await cleanupTestUser(user.userId)
    }
  })

  it('ignores a message from another chat entirely', async () => {
    const totalBefore = await prismaSupport.supportMessage.count()
    await handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        message_thread_id: 55,
        is_topic_message: true,
        date: Math.floor(Date.now() / 1000),
        chat: {
          id: TEST_CHAT_ID + 1,
          type: 'supergroup',
          title: 'чужая группа',
        },
        from: { id: 777005, is_bot: false, first_name: 'Stranger' },
        text: '/close',
      },
    })
    expect(await prismaSupport.supportMessage.count()).toBe(totalBefore)
    expect(sentPlain()).not.toHaveBeenCalled()
  })
})

/**
 * Topic ids for the hand-made topics below.
 *
 * The adoption path binds a ticket to whatever `(chat, topic)` pair the update
 * carries, and that pair is unique in the database. Fixed ids meant a run that
 * crashed before its `cleanupTestUser` left a ticket owning them forever, and
 * the next run's adoption resolved THAT ticket instead of creating one — so the
 * assertion failed in a file that had done nothing wrong. Randomized per run
 * for the same reason `createTestUser` randomizes `nId`; still a fixed offset
 * apart, so the four cases stay distinguishable in a failure message.
 */
const MANUAL_TOPIC_BASE = randomInt(1_000, 2_000_000_000)

describe('a topic an admin created by hand', () => {
  it('binds to the right user and relays the first message', async () => {
    const user = await createTestUser()
    const topicId = MANUAL_TOPIC_BASE
    try {
      // Telegram attaches the topic-creation service message as
      // `reply_to_message` on the first post in a hand-made topic — the only
      // place the topic NAME ever reaches the bot.
      await handleUpdate(
        agentMessageUpdate({
          topicId,
          messageId: 3001,
          fromId: 777010,
          text: 'Здравствуйте, это поддержка.',
          replyTopicName: `${user.userNId} · deadbeef`,
        })
      )

      const ticket = (await openTicketOf(user.userId))!
      expect(ticket.tgTopicId).toBe(topicId)
      expect(Number(ticket.tgChatId)).toBe(TEST_CHAT_ID)
      // The card is posted into the EXISTING topic — creating one would leave
      // a stray empty topic next to the one the admin just made.
      expect(vi.mocked(telegram.postTicketCard)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(telegram.createTicketTopic)).not.toHaveBeenCalled()
      expect(ticket.tgInfoMessageId).toBeGreaterThan(0)

      const messages = await listMessages(ticket.id)
      expect(
        messages.map((m) => [m.direction, m.systemKind ?? m.autoKind])
      ).toEqual([
        ['SYSTEM', 'TICKET_OPENED'],
        ['OUT', null],
      ])
      expect(messages[1]!.text).toBe('Здравствуйте, это поддержка.')

      // BOTH go out live, opening marker first. Pushing only the agent's line
      // (which is what used to happen) left a tab that was already open
      // rendering that line as the start of the dialog: the marker existed in
      // the table but did not reach the socket, so the order only corrected
      // itself on the next refetch.
      expect(pushes()).toHaveLength(2)
      expect(pushes()[0]![1]).toMatchObject({
        action: 'support_message',
        message: { direction: 'system', systemKind: 'ticket_opened' },
      })
      expect(pushes()[1]![1]).toMatchObject({
        action: 'support_message',
        message: {
          direction: 'out',
          text: 'Здравствуйте, это поддержка.',
        },
      })
      expect(loggedErrors).toEqual([])
    } finally {
      await cleanupTestUser(user.userId)
    }
  })

  it('accepts the separators an admin actually types', async () => {
    const user = await createTestUser()
    const topicId = MANUAL_TOPIC_BASE + 1
    try {
      await handleUpdate(
        agentMessageUpdate({
          topicId,
          messageId: 3002,
          fromId: 777011,
          text: 'пишу первым',
          // No middle dot, an emoji in front, a dash separator: all of these
          // reach `parseTopicNId`, and all of them must resolve to the nId.
          replyTopicName: `🎫 #${user.userNId} - ticket01`,
        })
      )

      const ticket = await openTicketOf(user.userId)
      expect(ticket?.tgTopicId).toBe(topicId)
      expect(loggedErrors).toEqual([])
    } finally {
      await cleanupTestUser(user.userId)
    }
  })

  it('refuses an unreadable name, hints once, and creates nothing', async () => {
    const topicId = MANUAL_TOPIC_BASE + 2
    const ticketsBefore = await prismaSupport.supportTicket.count()

    await handleUpdate(
      agentMessageUpdate({
        topicId,
        messageId: 3003,
        fromId: 777012,
        text: 'первое',
        replyTopicName: 'Общие вопросы',
      })
    )
    await handleUpdate(
      agentMessageUpdate({
        topicId,
        messageId: 3004,
        fromId: 777012,
        text: 'второе',
        replyTopicName: 'Общие вопросы',
      })
    )

    expect(await prismaSupport.supportTicket.count()).toBe(ticketsBefore)
    // One hint for the topic, not one per message: an admin pasting five
    // screenshots into a mis-named topic would otherwise get five replies.
    expect(sentPlain()).toHaveBeenCalledTimes(1)
    expect(sentPlain().mock.calls[0]![0]).toMatchObject({ topicId })
  })

  it('refuses a name pointing at a user that does not exist', async () => {
    const topicId = MANUAL_TOPIC_BASE + 3
    const ticketsBefore = await prismaSupport.supportTicket.count()

    await handleUpdate(
      agentMessageUpdate({
        topicId,
        messageId: 3005,
        fromId: 777013,
        text: 'кто это',
        // Below the floor `createTestUser` randomizes from, so no fixture user
        // can ever own this number.
        replyTopicName: '999 · abcd1234',
      })
    )

    expect(await prismaSupport.supportTicket.count()).toBe(ticketsBefore)
    expect(sentPlain()).toHaveBeenCalledTimes(1)
    expect(sentPlain().mock.calls[0]![0].text).toContain('999')
  })
})

describe('an unbound ticket the router cannot resolve', () => {
  it('does not relay into a topic it has never seen', async () => {
    const totalBefore = await prismaSupport.supportMessage.count()
    // No topic name anywhere in the update: nothing to adopt, nothing to write.
    await handleUpdate(
      agentMessageUpdate({
        topicId: MANUAL_TOPIC_BASE + 4,
        messageId: 3006,
        fromId: 777014,
        text: 'а где тут пользователь',
      })
    )
    expect(await prismaSupport.supportMessage.count()).toBe(totalBefore)
    expect(pushes()).toHaveLength(0)
  })
})

/**
 * `/del` exists because the Bot API never tells a bot that a message was
 * deleted — a swipe-delete in the topic is invisible to this service, so the
 * retraction has to be an explicit command.
 */
describe('an operator retracting a message with /del', () => {
  it('drops the bubble on both sides and leaves no trace', async () => {
    const user = await createTestUser()
    const topicId = MANUAL_TOPIC_BASE + 5
    try {
      await handleUpdate(
        agentMessageUpdate({
          topicId,
          messageId: 3101,
          fromId: 777015,
          text: 'Отправил не в ту тему',
          replyTopicName: `${user.userNId} · deadbee5`,
        })
      )
      const ticket = (await openTicketOf(user.userId))!
      vi.clearAllMocks()

      await handleUpdate(
        agentMessageUpdate({
          topicId,
          messageId: 3102,
          fromId: 777015,
          text: '/del',
          replyToMessageId: 3101,
        })
      )

      // The row survives — `seq` is a gap-free cursor — but carries no text.
      const relayed = (await listMessages(ticket.id)).find(
        (m) => m.tgMessageId === 3101
      )!
      expect(relayed.deletedAt).not.toBeNull()
      expect(relayed.text).toBeNull()

      // Silent: the user's feed loses the bubble, it does not gain a "message
      // deleted" placeholder.
      expect(pushes()).toHaveLength(1)
      expect(pushes()[0]![1]).toMatchObject({
        action: 'support_message_updated',
        deleted: true,
        text: null,
      })

      // Both the message and the command itself go from the topic, so the
      // thread reads as if neither was ever sent.
      expect(
        vi.mocked(telegram.deleteTopicMessage).mock.calls.map((c) => c[1])
      ).toEqual([3101, 3102])
      expect(loggedErrors).toEqual([])
    } finally {
      await cleanupTestUser(user.userId)
    }
  })

  it('refuses a message that is not part of the conversation', async () => {
    const user = await createTestUser()
    const topicId = MANUAL_TOPIC_BASE + 6
    try {
      await handleUpdate(
        agentMessageUpdate({
          topicId,
          messageId: 3111,
          fromId: 777016,
          text: 'Здравствуйте',
          replyTopicName: `${user.userNId} · deadbee6`,
        })
      )
      vi.clearAllMocks()

      // The info card, the topic-creation service message, an internal note —
      // none of them have a row, and Telegram makes the first post in a topic
      // LOOK like a reply to that service message. Deleting on a miss would
      // retract something the user never saw.
      await handleUpdate(
        agentMessageUpdate({
          topicId,
          messageId: 3112,
          fromId: 777016,
          text: '/del',
          replyToMessageId: 999_999,
        })
      )

      expect(vi.mocked(telegram.deleteTopicMessage)).not.toHaveBeenCalled()
      expect(pushes()).toHaveLength(0)
      expect(sentPlain().mock.calls[0]![0].text).toContain('не из переписки')
    } finally {
      await cleanupTestUser(user.userId)
    }
  })
})

describe('an operator sending a sticker', () => {
  it('relays a static sticker as its own attachment kind', async () => {
    const { ticket, topicId } = await userWithBoundTicket()
    try {
      vi.clearAllMocks()
      vi.mocked(telegram.downloadFile).mockResolvedValueOnce({
        buffer: PNG_BYTES,
        filePath: 'stickers/file_7.webp',
      })

      await handleUpdate(
        agentMediaUpdate({
          topicId,
          messageId: 6100,
          fromId: 777022,
          media: {
            sticker: {
              file_id: 'CAAC-static',
              file_unique_id: 'u-static',
              type: 'regular',
              width: 512,
              height: 512,
              is_animated: false,
              is_video: false,
              emoji: '👍',
              file_size: PNG_BYTES.length,
            },
          },
        })
      )

      const attachments = await listAttachments(ticket.id)
      expect(attachments).toHaveLength(1)
      const sticker = attachments[0]!
      // Its own kind, not IMAGE: the bytes cannot say it is a sticker, only
      // Telegram can, and the client renders the two differently.
      expect(sticker.kind).toBe('IMAGE')
      expect(sticker.isSticker).toBe(true)
      // Under `media/`, where the static mount can reach it — a sticker filed
      // as a document would be invisible to the browser.
      expect(sticker.storagePath.startsWith('media/')).toBe(true)
    } finally {
      await cleanupTestUser(ticket.userId)
    }
  })

  it('falls back to the preview frame for an animated sticker', async () => {
    // A .tgs is gzipped Lottie: nothing in a browser draws it, and the file
    // guard rejects gzip outright. Telegram ships a static thumbnail, and that
    // is what has to be downloaded instead.
    const { ticket, topicId } = await userWithBoundTicket()
    try {
      vi.clearAllMocks()
      vi.mocked(telegram.downloadFile).mockResolvedValueOnce({
        buffer: PNG_BYTES,
        filePath: 'thumbnails/file_8.webp',
      })

      await handleUpdate(
        agentMediaUpdate({
          topicId,
          messageId: 6101,
          fromId: 777022,
          media: {
            sticker: {
              file_id: 'CAAC-animated',
              file_unique_id: 'u-animated',
              type: 'regular',
              width: 512,
              height: 512,
              is_animated: true,
              is_video: false,
              thumbnail: {
                file_id: 'THUMB-1',
                file_unique_id: 'u-thumb',
                width: 128,
                height: 128,
                file_size: PNG_BYTES.length,
              },
              file_size: 4096,
            },
          },
        })
      )

      // The THUMBNAIL was fetched, never the .tgs itself.
      expect(vi.mocked(telegram.downloadFile)).toHaveBeenCalledWith('THUMB-1')

      const attachments = await listAttachments(ticket.id)
      expect(attachments).toHaveLength(1)
      expect(attachments[0]!.isSticker).toBe(true)
    } finally {
      await cleanupTestUser(ticket.userId)
    }
  })
})
