// The I/O boundary the integration suite replaces, and nothing else.
//
// `@telegram/api` is the dumb wrapper that actually talks to Telegram; every
// export that performs a network call is swapped for a `vi.fn`, while the pure
// helpers in the same module (`formatTopicName`, `parseTopicName`,
// `renderUserCard`, `topicUrl`) keep their real implementations. grammY itself
// is never mocked — there is no bot token in the test env, so nothing under it
// would dial out even if it were reached.
//
// Usage, per test file (vi.mock is hoisted, so the factory cannot be shared as
// a call — only its body can):
//
//   vi.mock('@telegram/api', async (importOriginal) => ({
//     ...(await importOriginal<typeof import('@telegram/api')>()),
//     ...(await import('./_telegram-stub')).telegramStub(),
//   }))

import { randomInt } from 'node:crypto'

import { vi } from 'vitest'

import type { Chat, Message, Update, User } from 'grammy/types'

/**
 * The support supergroup id the router matches against.
 *
 * Read from the environment rather than hardcoded so it can never drift from
 * what `@config/env` loaded — a mismatch would make `isSupportChat` drop every
 * update and the Telegram tests would pass without routing anything.
 */
export const TEST_CHAT_ID = Number(process.env.SUPPORT_CHAT_ID)

/**
 * Fresh mocks with ids that keep increasing, so a test can tell two topics (or
 * two Telegram messages) apart without stubbing anything itself.
 *
 * The BASE is randomized, for the same reason `createTestUser` randomizes
 * `nId`: `(tg_chat_id, tg_topic_id)` is unique, the test database is shared and
 * persistent, and `cleanupTestUser` only removes the rows a run created. A
 * fixed base meant every file in every run handed out the same first topic id,
 * so one crashed run — or a second suite running concurrently — left a ticket
 * holding that pair forever and every later run died on P2002 in files that had
 * nothing to do with it. The range is wide enough that a collision needs the
 * same draw twice out of two billion.
 */
export function telegramStub() {
  let nextTopicId = randomInt(1_000, 2_000_000_000)
  let nextMessageId = randomInt(1_000, 2_000_000_000)

  return {
    createTicketTopic: vi.fn(async () => ({
      chatId: TEST_CHAT_ID,
      topicId: (nextTopicId += 1),
      infoMessageId: (nextMessageId += 1),
    })),
    postTicketCard: vi.fn(async () => (nextMessageId += 1)),
    relayUserMessage: vi.fn(async () => (nextMessageId += 1)),
    attachZhoraReplyButton: vi.fn(async () => true),
    sendToTopic: vi.fn(async () => (nextMessageId += 1)),
    sendTypingToTopic: vi.fn(async () => undefined),
    sendPlainMessage: vi.fn(async () => (nextMessageId += 1)),
    editTopicMessage: vi.fn(async () => undefined),
    answerCallback: vi.fn(async () => undefined),
    deleteTopicMessage: vi.fn(async () => undefined),
    closeTicketTopic: vi.fn(async () => undefined),
    downloadFile: vi.fn(async () => null),
    registerWebhook: vi.fn(async () => undefined),
    ensureBotInitialized: vi.fn(async () => null),
    getBot: vi.fn(() => null),
  }
}

// ─── Update builders ──────────────────────────────────────────────────────
//
// Hand-built payloads shaped like what Telegram actually posts to the webhook.
// They carry no `entities`, which is exactly the case `parseCommand`'s
// entity-less fallback exists for.

const SUPPORT_GROUP: Chat.SupergroupChat = {
  id: TEST_CHAT_ID,
  type: 'supergroup',
  title: 'binodex support (test)',
}

const agentFrom = (id: number): User => ({
  id,
  is_bot: false,
  first_name: 'Operator',
})

let nextUpdateId = 1

export interface TopicMessageInput {
  topicId: number
  messageId: number
  fromId: number
  text?: string
  /**
   * Name of the topic-creation service message this update answers. Telegram
   * attaches it to the first message posted in a hand-made topic, and it is the
   * only way the router can recognise a topic an admin opened by hand.
   */
  replyTopicName?: string
  /**
   * Id of an ordinary message this one answers — what `/del` points at.
   *
   * Separate from `replyTopicName` because Telegram fills the same field with
   * two very different things: the topic-creation service message (no `from`,
   * carries `forum_topic_created`) and a real reply. Telling them apart is the
   * whole reason `/del` checks ownership against our own rows.
   */
  replyToMessageId?: number
}

// `Update.NonChannel` is what every message-carrying update field is typed as:
// a non-channel `chat` plus a non-optional `from`. Both hold here, so the
// builder is declared with it rather than cast at each of its three callers.
function topicMessage(input: TopicMessageInput): Message & Update.NonChannel {
  return {
    message_id: input.messageId,
    message_thread_id: input.topicId,
    // The real discriminator: a plain reply inside General also carries a
    // thread id, and reading that as a topic would make the bot talk there.
    is_topic_message: true,
    date: Math.floor(Date.now() / 1000),
    chat: SUPPORT_GROUP,
    from: agentFrom(input.fromId),
    ...(input.text !== undefined ? { text: input.text } : {}),
    ...(input.replyTopicName !== undefined
      ? {
          reply_to_message: {
            message_id: input.topicId,
            message_thread_id: input.topicId,
            is_topic_message: true,
            date: Math.floor(Date.now() / 1000),
            chat: SUPPORT_GROUP,
            forum_topic_created: {
              name: input.replyTopicName,
              icon_color: 0x6fb9f0,
            },
            // Telegram never nests a second level, and grammy's `ReplyMessage`
            // encodes that as a required `undefined`.
            reply_to_message: undefined,
          },
        }
      : {}),
    ...(input.replyToMessageId !== undefined
      ? {
          reply_to_message: {
            message_id: input.replyToMessageId,
            message_thread_id: input.topicId,
            is_topic_message: true,
            date: Math.floor(Date.now() / 1000),
            chat: SUPPORT_GROUP,
            from: agentFrom(input.fromId),
            reply_to_message: undefined,
          },
        }
      : {}),
  }
}

/** An operator writing inside a ticket topic. */
export function agentMessageUpdate(input: TopicMessageInput): Update {
  return { update_id: (nextUpdateId += 1), message: topicMessage(input) }
}

export interface MediaMessageInput extends TopicMessageInput {
  /**
   * The media fields Telegram hangs off the message, passed through verbatim.
   *
   * Verbatim matters: the payloads worth testing are the ones with quirks, and
   * the biggest is that an `animation` message ALSO carries a `document`
   * pointing at the same file — a test has to be able to reproduce that
   * exactly, not through a tidier abstraction that hides it.
   */
  media: Partial<
    Pick<
      Message,
      'photo' | 'video' | 'video_note' | 'animation' | 'document' | 'sticker'
    >
  >
  /** A media message's text lives in `caption`, never in `text`. */
  caption?: string
}

/** An operator posting a file (or an album part) into a ticket topic. */
export function agentMediaUpdate(input: MediaMessageInput): Update {
  const { media, caption, ...rest } = input
  return {
    update_id: (nextUpdateId += 1),
    message: {
      ...topicMessage(rest),
      ...(caption !== undefined ? { caption } : {}),
      ...media,
    },
  }
}

/** The same operator editing that message afterwards. */
export function agentEditUpdate(input: TopicMessageInput): Update {
  return {
    update_id: (nextUpdateId += 1),
    edited_message: {
      ...topicMessage(input),
      edit_date: Math.floor(Date.now() / 1000),
    },
  }
}

/**
 * A message in the group's General topic.
 *
 * Two shapes, because production sees both: no `message_thread_id` at all
 * (a plain post) and a thread id WITHOUT `is_topic_message` (a reply inside
 * General, whose thread id is the message it answers).
 */
export function generalMessageUpdate(input: {
  messageId: number
  fromId: number
  text: string
  /** Set to mimic a reply inside General. */
  threadId?: number
}): Update {
  return {
    update_id: (nextUpdateId += 1),
    message: {
      message_id: input.messageId,
      ...(input.threadId !== undefined
        ? { message_thread_id: input.threadId }
        : {}),
      date: Math.floor(Date.now() / 1000),
      chat: SUPPORT_GROUP,
      from: agentFrom(input.fromId),
      text: input.text,
    },
  }
}

/**
 * An operator pressed an inline button under a message in a ticket topic.
 *
 * The `message` in a callback is the message the button sits UNDER, so its
 * `message_id` is exactly what the handler will be repainting.
 */
export function callbackUpdate(input: {
  topicId: number
  messageId: number
  data: string
  fromId?: number
}): Update {
  const fromId = input.fromId ?? 900_001
  return {
    update_id: (nextUpdateId += 1),
    callback_query: {
      id: String((nextUpdateId += 1)),
      from: agentFrom(fromId),
      chat_instance: 'test-chat-instance',
      data: input.data,
      message: {
        message_id: input.messageId,
        message_thread_id: input.topicId,
        is_topic_message: true,
        date: Math.floor(Date.now() / 1000),
        chat: { ...SUPPORT_GROUP },
      },
    },
  }
}
