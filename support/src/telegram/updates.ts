import type { CallbackQuery, Message, Update } from 'grammy/types'

import type { SupportTicket } from '@prisma-support'

import { TELEGRAM_CHAT_ID } from '@config/env'
import { logger } from '@config/logger'

import { findAgentByTgId } from '@apps/services/agent.service'
import { saveTelegramFile } from '@apps/services/attachment.service'
import {
  agentEditMessage,
  agentSendMessage,
  announceTicketOpened,
} from '@apps/services/chat.service'
import {
  bindTicketTopic,
  ensureOpenTicket,
  findOpenTicket,
  findTicketByTopic,
} from '@apps/services/ticket.service'
import { getUserCard } from '@apps/services/user-card.service'

import {
  DOWNLOAD_LIMIT_BYTES,
  answerCallback,
  parseTopicNId,
  postTicketCard,
  sendPlainMessage,
  topicUrl,
  ZHORA_REPLY_CALLBACK_PREFIX,
  ZHORA_SEND_CALLBACK_PREFIX,
  ZHORA_ALTERNATIVE_CALLBACK_PREFIX,
  ZHORA_CARD_CALLBACK_PREFIX,
  ZHORA_TRANSLATE_CALLBACK_PREFIX,
  ZHORA_TRANSLATE_LANGUAGE_CALLBACK_PREFIX,
  ZHORA_TEMPLATE_CATEGORY_CALLBACK_PREFIX,
  ZHORA_TEMPLATE_SELECT_CALLBACK_PREFIX,
  ZHORA_TEMPLATE_SEND_CALLBACK_PREFIX,
} from '@telegram/api'

import {
  ACTION_CALLBACK_PREFIX,
  DEPOSITS_CALLBACK_PREFIX,
  handleActionCallback,
  TOPIC_NAME_HINT,
  findExchangeUserByNId,
  handleCommand,
  handleZhoraReplyCallback,
  handleDepositsCallback,
  parseCommand,
  type CommandContext,
} from './commands'
import { handleZhoraSendCallback } from './zhora-send'
import { handleZhoraAlternativeCallback } from './zhora-alternative'
import { handleZhoraCardCallback } from './zhora-card'
import {
  selectTemplate,
  sendTemplateDraft,
  showTemplateCategory,
} from './zhora-template'
import {
  handleZhoraTranslationMenu,
  handleZhoraTranslationSelection,
} from './zhora-translate'
import {
  ZHORA_TRANSLATION_LANGUAGES,
  type ZhoraTranslationLanguage,
} from '@apps/services/zhora/suggestion-variant.service'

/**
 * Telegram update router — the single entry point the Fastify webhook route
 * calls.
 *
 * Two hard rules shape everything below:
 *
 *  1. It never throws. Telegram retries any non-2xx webhook delivery forever,
 *     so one poisoned update would become an infinite redelivery storm. Every
 *     failure is logged and swallowed and the update is dropped.
 *  2. It is silent outside ticket topics. The group's General topic is the
 *     staff's own room and the bot must not react to a single message there.
 *     The one exception is an explicit slash command, which is by definition
 *     addressed to the bot (see `./commands`).
 *
 * Layering: this file sits above `chat.service` and imports it. Nothing under
 * `@apps/*` may import back, or the cycle the layering rule prevents closes.
 */

// Telegram numbers the General topic 1, but messages posted there normally
// carry no `message_thread_id` at all — a plain reply inside General does
// carry one (the thread root), which is why `is_topic_message` is the real
// discriminator and this constant is only the belt to its braces.
const GENERAL_TOPIC_ID = 1

// Album parts arrive as separate updates a few hundred milliseconds apart.
const ALBUM_DEBOUNCE_MS = 1500
// Telegram caps an album at 10; the margin absorbs a redelivered part.
const ALBUM_MAX_ITEMS = 20

export async function handleUpdate(update: Update): Promise<void> {
  try {
    if (update.message) {
      await onMessage(update.message)
      return
    }
    if (update.edited_message) {
      await onEditedMessage(update.edited_message)
      return
    }
    if (update.callback_query) {
      await onCallbackQuery(update.callback_query)
      return
    }
    // Channel posts, reactions, chat-member changes: not part of the support
    // flow. A silent no-op keeps the webhook at 2xx.
  } catch (err) {
    const error = err as Error
    logger.error(
      `[updates] dropped update ${update.update_id}: ${error.stack ?? error.message}`
    )
  }
}

// ─── Routing ──────────────────────────────────────────────────────────────

/**
 * An inline-button press: the `/deposits` filters, and the confirmations for
 * the two actions that change something.
 *
 * Telegram must ALWAYS be answered, and first thing: without that the button
 * keeps spinning until it times out, even if the message has already been
 * redrawn.
 *
 * Foreign chats and unknown prefixes are dropped silently — the bot answers
 * only inside the support group, exactly as it does for messages.
 */
async function onCallbackQuery(query: CallbackQuery): Promise<void> {
  await answerCallback(query.id)

  const data = query.data ?? ''
  const message = query.message
  if (!message) return
  if (message.chat.id !== Number(TELEGRAM_CHAT_ID)) return

  if (data.startsWith(ZHORA_TEMPLATE_CATEGORY_CALLBACK_PREFIX)) {
    if (
      query.from.is_bot ||
      !message.is_topic_message ||
      !message.message_thread_id
    )
      return
    const categoryKey = data.slice(
      ZHORA_TEMPLATE_CATEGORY_CALLBACK_PREFIX.length
    )
    if (!/^[0-9a-f]{16}$/.test(categoryKey)) return
    await showTemplateCategory({
      chatId: message.chat.id,
      topicId: message.message_thread_id,
      fromId: query.from.id,
      categoryKey,
    })
    return
  }
  if (data.startsWith(ZHORA_TEMPLATE_SELECT_CALLBACK_PREFIX)) {
    if (
      query.from.is_bot ||
      !message.is_topic_message ||
      !message.message_thread_id
    )
      return
    const templateId = data.slice(ZHORA_TEMPLATE_SELECT_CALLBACK_PREFIX.length)
    if (!/^[0-9a-f-]{36}$/i.test(templateId)) return
    await selectTemplate({
      chatId: message.chat.id,
      topicId: message.message_thread_id,
      fromId: query.from.id,
      eventKey: `template:tap:${query.id}`,
      templateId,
    })
    return
  }
  if (data.startsWith(ZHORA_TEMPLATE_SEND_CALLBACK_PREFIX)) {
    if (
      query.from.is_bot ||
      !message.is_topic_message ||
      !message.message_thread_id
    )
      return
    const match = /^tsend:([0-9a-f-]{36}):(\d+)$/.exec(data)
    if (!match) return
    await sendTemplateDraft({
      chatId: message.chat.id,
      topicId: message.message_thread_id,
      fromId: query.from.id,
      draftId: match[1]!,
      version: Number(match[2]),
      previewMessageId: message.message_id,
    })
    return
  }

  if (data.startsWith(ZHORA_CARD_CALLBACK_PREFIX)) {
    const suggestionId = data.slice(ZHORA_CARD_CALLBACK_PREFIX.length)
    if (
      !/^[0-9a-f-]{36}$/i.test(suggestionId) ||
      query.from.is_bot ||
      !message.is_topic_message ||
      !message.message_thread_id ||
      message.message_thread_id <= 1
    )
      return
    await handleZhoraCardCallback({
      chatId: message.chat.id,
      topicId: message.message_thread_id,
      suggestionId,
      previewMessageId: message.message_id,
    })
    return
  }

  if (data.startsWith(ZHORA_ALTERNATIVE_CALLBACK_PREFIX)) {
    const suggestionId = data.slice(ZHORA_ALTERNATIVE_CALLBACK_PREFIX.length)
    if (
      !/^[0-9a-f-]{36}$/i.test(suggestionId) ||
      query.from.is_bot ||
      !message.is_topic_message ||
      !message.message_thread_id ||
      message.message_thread_id <= 1
    )
      return
    await handleZhoraAlternativeCallback({
      chatId: message.chat.id,
      topicId: message.message_thread_id,
      fromId: query.from.id,
      suggestionId,
      previewMessageId: message.message_id,
      callbackId: query.id,
    })
    return
  }

  if (data.startsWith(ZHORA_TRANSLATE_LANGUAGE_CALLBACK_PREFIX)) {
    const match = /^ztl:([0-9a-f-]{36}):([a-z]{2})$/i.exec(data)
    if (
      !match ||
      query.from.is_bot ||
      !message.is_topic_message ||
      !message.message_thread_id ||
      message.message_thread_id <= 1
    )
      return
    const language = match[2] as ZhoraTranslationLanguage
    if (!ZHORA_TRANSLATION_LANGUAGES.includes(language)) return
    await handleZhoraTranslationSelection({
      chatId: message.chat.id,
      topicId: message.message_thread_id,
      fromId: query.from.id,
      suggestionId: match[1]!,
      language,
    })
    return
  }

  if (data.startsWith(ZHORA_TRANSLATE_CALLBACK_PREFIX)) {
    const suggestionId = data.slice(ZHORA_TRANSLATE_CALLBACK_PREFIX.length)
    if (
      !/^[0-9a-f-]{36}$/i.test(suggestionId) ||
      query.from.is_bot ||
      !message.is_topic_message ||
      !message.message_thread_id ||
      message.message_thread_id <= 1
    )
      return
    await handleZhoraTranslationMenu({
      chatId: message.chat.id,
      topicId: message.message_thread_id,
      fromId: query.from.id,
      suggestionId,
      previewMessageId: message.message_id,
    })
    return
  }

  if (data.startsWith(ZHORA_SEND_CALLBACK_PREFIX)) {
    const suggestionId = data.slice(ZHORA_SEND_CALLBACK_PREFIX.length)
    if (!/^[0-9a-f-]{36}$/i.test(suggestionId) || query.from.is_bot) return
    // General replies can carry a thread ID without being a forum topic.
    if (
      !message.is_topic_message ||
      !message.message_thread_id ||
      message.message_thread_id <= 1
    )
      return
    await handleZhoraSendCallback({
      chatId: message.chat.id,
      topicId: message.message_thread_id,
      fromId: query.from.id,
      isBot: query.from.is_bot,
      suggestionId,
      previewMessageId: message.message_id,
    })
    return
  }

  if (data.startsWith(ZHORA_REPLY_CALLBACK_PREFIX)) {
    const fromId = query.from?.id
    const messageId = data.slice(ZHORA_REPLY_CALLBACK_PREFIX.length)
    if (fromId == null || !/^[0-9a-f-]{36}$/i.test(messageId)) return
    await handleZhoraReplyCallback({
      chatId: message.chat.id,
      topicId: message.message_thread_id ?? null,
      fromId,
      callbackId: query.id,
      messageId,
    })
    return
  }

  if (data.startsWith(DEPOSITS_CALLBACK_PREFIX)) {
    await handleDepositsCallback({
      chatId: message.chat.id,
      topicId: message.message_thread_id ?? null,
      messageId: message.message_id,
      filter: data.slice(DEPOSITS_CALLBACK_PREFIX.length),
    })
    return
  }

  if (data.startsWith(ACTION_CALLBACK_PREFIX)) {
    // `from` is the operator who TAPPED, not whoever typed the command — that
    // is who the audit row has to name.
    const fromId = query.from?.id
    if (fromId == null) return
    await handleActionCallback({
      chatId: message.chat.id,
      topicId: message.message_thread_id ?? null,
      fromId,
      payload: data.slice(ACTION_CALLBACK_PREFIX.length),
    })
  }
}

async function onMessage(message: Message): Promise<void> {
  if (!isSupportChat(message)) return
  // Bots never receive their own messages, so this mainly filters other bots —
  // and GroupAnonymousBot, which means a message sent "as the group" by an
  // anonymous admin is dropped rather than relayed to a user unattributed.
  if (message.from?.is_bot) return

  const fromId = message.from?.id
  if (fromId == null) return

  const chatId = message.chat.id
  const topicId = topicIdOf(message)

  const command = parseCommand(message)
  if (command) {
    const ctx: CommandContext = { chatId, topicId, fromId, message }
    await handleCommand(ctx, command)
    return
  }

  if (topicId == null) return // General topic — stay silent.

  // Telegram hands us a topic NAME only on its own service messages, or when
  // a message explicitly answers the creation notice. That name is the only
  // way to recognise a topic an admin opened by hand.
  const serviceName =
    message.forum_topic_created?.name ?? message.forum_topic_edited?.name

  let ticket = await findTicketByTopic(chatId, topicId)
  if (!ticket) {
    const name =
      serviceName ?? message.reply_to_message?.forum_topic_created?.name
    ticket = name ? await adoptTopic(chatId, topicId, name) : null
    if (!ticket) {
      await hintOnce(chatId, topicId, TOPIC_NAME_HINT)
      return
    }
  }

  // The topic is bound now; the service message itself carries nothing to
  // relay, so the adoption above was its whole purpose.
  if (serviceName) return

  if (message.media_group_id) {
    bufferAlbumPart(message, { chatId, topicId, fromId })
    return
  }

  const files = extractFiles(message)
  const text = message.text ?? message.caption ?? null

  if (!text && !files.length) {
    // Pins, joins, renames and the media kinds the product refuses all land
    // here. Only the last of those deserves an answer.
    if (hasUnsupportedMedia(message)) {
      await sendPlainMessage({
        chatId,
        topicId,
        text: 'Такое вложение пользователю не доставляется. Отправьте изображение, видео или файл — PDF либо документ.',
      })
    }
    return
  }

  const agent = await findAgentByTgId(fromId)
  await relay({
    ticket,
    text,
    files,
    agentId: agent?.id ?? null,
    tgMessageId: message.message_id,
  })
}

async function onEditedMessage(message: Message): Promise<void> {
  if (!isSupportChat(message)) return
  if (message.from?.is_bot) return
  // Editing an existing operator reply into /fix (or another command) must
  // neither execute the command nor replace the customer's text with it.
  if (parseCommand(message)) return

  const topicId = topicIdOf(message)
  if (topicId == null) return

  const ticket = await findTicketByTopic(message.chat.id, topicId)
  if (!ticket) return

  // Caption edits count: a photo's caption IS that bubble's text on our side.
  await agentEditMessage(
    ticket,
    message.message_id,
    message.text ?? message.caption ?? null
  )
}

// ─── Relay ────────────────────────────────────────────────────────────────

interface RelayInput {
  ticket: SupportTicket
  text: string | null
  files: TelegramFileRef[]
  agentId: string | null
  /** Telegram message id the dedupe key is derived from. */
  tgMessageId: number
}

/**
 * Turn one Telegram message (or one flushed album) into one chat bubble.
 *
 * Files are persisted BEFORE the message is appended so the bubble is never
 * momentarily attachment-less in the user's feed — `agentSendMessage` pushes
 * over the socket the instant the row exists.
 */
async function relay(input: RelayInput): Promise<void> {
  const { ticket, text, files, agentId, tgMessageId } = input

  // Fast path, deliberately BEFORE `persistFiles`. The authoritative check is
  // the re-read inside `agentSendMessage` — this one exists to stop the
  // DOWNLOAD, not the delivery.
  //
  // Without it, every file dropped into an archived topic is still pulled from
  // Telegram (up to 20 MB each, up to a 20-item album) and written to the
  // volume as an attachment row that `appendMessage` never links — an orphan.
  // Those bytes count toward the GLOBAL storage total that gates uploads for
  // every conversation on the platform, and they are only released by the
  // retention sweep days later.
  if (ticket.status !== 'OPEN') {
    // Logged, not silent: from the outside a blocked reply and a reply that was
    // never routed here look identical, and the first question after a deploy
    // is always "did the gate actually fire?".
    logger.info(
      `[updates] blocked agent reply to CLOSED ticket ${ticket.id} ` +
        `(topic ${ticket.tgTopicId}, tg message ${tgMessageId})`
    )
    await noteClosedTicket(ticket)
    return
  }

  const { ids: attachmentIds, skipped } = await persistFiles(ticket.id, files)

  // Deliberately BEFORE the empty-relay bail-out below: a dropped file is the
  // one failure the agent cannot see from their side — Telegram showed them a
  // finished upload — and the case where nothing else survives to relay is
  // exactly the case where they most need telling.
  await noteSkippedFiles(ticket, skipped)

  if (!text && !attachmentIds.length) {
    logger.warn(
      `[updates] nothing left to relay for tg message ${tgMessageId} on ticket ${ticket.id}`
    )
    return
  }

  const sent = await agentSendMessage({
    ticket,
    text,
    agentId,
    tgMessageId,
    attachmentIds,
  })

  // Telegram already showed the agent their own message, so swallowing it
  // silently would read as "delivered". Say so in the same topic instead.
  if (sent === 'closed') await noteClosedTicket(ticket)
}

/**
 * Tell the agent their message stayed inside Telegram.
 *
 * A group admin can still post into an archived forum topic, and that post
 * arrives over the webhook indistinguishable from a live reply — this is the
 * only signal they get that the conversation on the user's side is over.
 *
 * The wording is deliberate about the message being LOST rather than queued.
 * A closed ticket is never reopened: `ensureOpenTicket` creates a new row when
 * the user writes again, and that row starts with no topic, so `ensureTopic`
 * opens a fresh one. This archived topic never revives. Telling an agent their
 * answer would arrive "later" is how a payout instruction ends up sitting in a
 * dead thread while everyone believes it was sent.
 *
 * Sent through `hintOnce` for the same reason it exists for mis-named topics:
 * an agent pasting five screenshots would otherwise get five identical
 * warnings, and each one competes for the group's shared ~20 msg/min budget
 * against live replies to other users.
 */
async function noteClosedTicket(ticket: SupportTicket): Promise<void> {
  const chatId = ticket.tgChatId != null ? Number(ticket.tgChatId) : 0
  const topicId = ticket.tgTopicId ?? 0
  if (!chatId || !topicId) return

  // Keyed by the TICKET, not by the topic. A topic is now permanent — one per
  // user, for life — so a topic-scoped "once" would show this warning to an
  // operator a single time ever, and every later reply into a finished
  // conversation would vanish in silence. That is the very failure this notice
  // exists to prevent.
  await hintOnce(
    chatId,
    topicId,
    '⚠️ Сообщение НЕ доставлено: обращение закрыто, пользователь его не увидит.\n' +
      'Оно не уйдёт и позже. Дождитесь, пока пользователь напишет снова — ' +
      'обращение откроется здесь же, в этой теме, и тогда повторите ответ.',
    ticket.id
  )
}

interface TelegramFileRef {
  fileId: string
  fileName: string
  mimeType: string
  sizeBytes: number
  /**
   * Telegram sticker. The bytes are an ordinary .webp, so only this flag —
   * carried from the update — can tell the storage layer to label it a sticker
   * and let the client render it without bubble chrome.
   */
  isSticker?: boolean
}

/**
 * The attachment kinds the product allows: images, video and documents.
 * Everything else is reported by `hasUnsupportedMedia` rather than pushed into
 * a chat window that cannot render it.
 *
 * Every branch feeds the same `saveTelegramFile`, so the declared `mimeType`
 * below is a hint and nothing more — the file guard re-sniffs the downloaded
 * bytes and has the final say on kind.
 */
function extractFiles(message: Message): TelegramFileRef[] {
  const files: TelegramFileRef[] = []

  const photo = message.photo?.at(-1)
  if (photo) {
    files.push({
      fileId: photo.file_id,
      // Telegram never names a photo. `file_unique_id` is stable across a
      // redelivery, so the same picture keeps the same name.
      fileName: `photo-${photo.file_unique_id}.jpg`,
      mimeType: 'image/jpeg',
      sizeBytes: photo.file_size ?? 0,
    })
  }

  const video = message.video
  if (video) {
    files.push({
      fileId: video.file_id,
      fileName: video.file_name ?? `video-${video.file_unique_id}.mp4`,
      mimeType: video.mime_type ?? 'video/mp4',
      sizeBytes: video.file_size ?? 0,
    })
  }

  // A round "telescope" video note: same bytes as a video, but Telegram gives
  // it neither a name nor a mime type, so both are synthesized.
  const videoNote = message.video_note
  if (videoNote) {
    files.push({
      fileId: videoNote.file_id,
      fileName: `video-note-${videoNote.file_unique_id}.mp4`,
      mimeType: 'video/mp4',
      sizeBytes: videoNote.file_size ?? 0,
    })
  }

  // A GIF, which Telegram stores as a soundless MP4 and delivers as
  // `animation`. Relayed as video: it plays in the bubble, and the alternative
  // (dropping it) loses the "look, this is what my screen does" reply support
  // sends most often.
  // Stickers come in three formats and only one of them is a picture a browser
  // can draw:
  //   • static  — .webp, renders anywhere, relayed as-is;
  //   • video   — .webm (VP9 with alpha), which Safari handles unreliably and
  //               which the feed would dress up as a black video player;
  //   • animated— .tgs, a gzipped Lottie. Nothing built in can draw it, and the
  //               file guard rejects gzip containers outright.
  // For the latter two Telegram already ships a static preview, so the user
  // sees the sticker frozen rather than nothing at all. Playing them properly
  // needs a Lottie runtime and is deliberately out of scope here.
  const sticker = message.sticker
  if (sticker) {
    const isPicture = !sticker.is_animated && !sticker.is_video
    const source = isPicture ? sticker : sticker.thumbnail
    if (source) {
      files.push({
        fileId: source.file_id,
        // Telegram names none of these; `file_unique_id` is stable across a
        // redelivery, so the same sticker keeps the same file name.
        fileName: `sticker-${sticker.file_unique_id}.webp`,
        mimeType: 'image/webp',
        sizeBytes: source.file_size ?? 0,
        isSticker: true,
      })
    }
  }

  const animation = message.animation
  if (animation) {
    files.push({
      fileId: animation.file_id,
      fileName:
        animation.file_name ?? `animation-${animation.file_unique_id}.mp4`,
      mimeType: animation.mime_type ?? 'video/mp4',
      sizeBytes: animation.file_size ?? 0,
    })
  }

  // For backward compatibility Telegram ALSO fills `document` on an animation
  // message, pointing at the very same file. Taking both would download it
  // twice and hang two identical attachments off one bubble.
  const document = animation ? undefined : message.document
  if (document) {
    files.push({
      fileId: document.file_id,
      fileName: document.file_name ?? `file-${document.file_unique_id}`,
      mimeType: document.mime_type ?? 'application/octet-stream',
      sizeBytes: document.file_size ?? 0,
    })
  }

  return files
}

function hasUnsupportedMedia(message: Message): boolean {
  // What is left after images, video, documents and stickers: sound with no
  // picture. Stickers used to be here too — see `extractFiles` for how the
  // three Telegram sticker formats are reduced to something a browser renders.
  return Boolean(message.audio ?? message.voice)
}

interface SkippedFile {
  fileName: string
  /**
   * True when the size ALONE makes the relay impossible. A bot may download at
   * most 20 MB out of Telegram while the agent's own client uploads up to 2 GB,
   * so this is a permanent property of the file, not a transient failure —
   * which is why it gets different wording from everything else.
   */
  tooLarge: boolean
}

interface PersistedFiles {
  ids: string[]
  skipped: SkippedFile[]
}

/**
 * Download and persist each file, one at a time.
 *
 * Sequential on purpose: an album of ten fires ten `getFile` + download pairs,
 * and Telegram answers a parallel burst with 429s that would cost the whole
 * album. A single failure only drops its own attachment — the caption and the
 * remaining files still reach the user.
 */
async function persistFiles(
  ticketId: string,
  files: TelegramFileRef[]
): Promise<PersistedFiles> {
  const ids: string[] = []
  const skipped: SkippedFile[] = []

  for (const file of files) {
    // Classified from the size Telegram announced, before the attempt: once
    // `saveTelegramFile` has answered null the reason is gone (it logs and
    // swallows), and "too large" is the only rejection worth naming precisely.
    const tooLarge = file.sizeBytes > DOWNLOAD_LIMIT_BYTES
    try {
      const saved = await saveTelegramFile({
        ticketId,
        fileId: file.fileId,
        fileName: file.fileName,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        uploadedByAgent: true,
        isSticker: file.isSticker === true,
      })
      if (saved) {
        ids.push(saved.id)
        continue
      }
    } catch (err) {
      logger.error(
        `[updates] attachment ${file.fileId} failed on ticket ${ticketId}: ${(err as Error).message}`
      )
    }
    skipped.push({ fileName: file.fileName, tooLarge })
  }

  return { ids, skipped }
}

const MEGABYTE = 1024 * 1024

/**
 * Tell the agent, in their own topic, that a file did not reach the user.
 *
 * Without this the failure is invisible on both sides: Telegram reports the
 * upload as successful, and the user simply never sees an attachment they were
 * never told about. The note goes ONLY into the topic — the user's feed shows
 * nothing at all rather than a broken bubble, which is the whole point of
 * `saveTelegramFile` returning null instead of throwing.
 */
async function noteSkippedFiles(
  ticket: SupportTicket,
  skipped: SkippedFile[]
): Promise<void> {
  if (!skipped.length) return

  const chatId = ticket.tgChatId != null ? Number(ticket.tgChatId) : 0
  const topicId = ticket.tgTopicId ?? 0
  if (!chatId || !topicId) return

  const limitMb = Math.floor(DOWNLOAD_LIMIT_BYTES / MEGABYTE)
  // No parse mode downstream (`sendPlainMessage`), so the agent's own file name
  // goes in verbatim — no escaping, and no risk of a stray `<` costing us the
  // whole notice.
  const lines = skipped.map((file) =>
    file.tooLarge
      ? `⚠️ «${file.fileName}» не доставлен пользователю: бот может забрать из Telegram файл не больше ${limitMb} МБ. Сожмите видео или отправьте фрагмент.`
      : `⚠️ «${file.fileName}» не доставлен пользователю — файл не удалось забрать из Telegram. Попробуйте отправить его ещё раз.`
  )

  await sendPlainMessage({ chatId, topicId, text: lines.join('\n') })
}

// ─── Albums ───────────────────────────────────────────────────────────────

interface PendingAlbum {
  chatId: number
  topicId: number
  fromId: number
  /** Lowest message id in the album — the group's dedupe key derives from it. */
  firstMessageId: number
  caption: string | null
  files: TelegramFileRef[]
  timer: NodeJS.Timeout
}

/**
 * Album parts share a `media_group_id` but arrive as independent updates, so
 * they are debounced into one bubble carrying N attachments.
 *
 * Trade-off, taken deliberately: the buffer is in-memory, so a restart mid
 * album loses the grouping — parts already flushed stay, parts still buffered
 * are gone from the feed (Telegram will not redeliver them, we already 2xx'd).
 * Persisting a 1.5-second window would cost a table and a sweeper to save an
 * occasional cosmetic regrouping.
 *
 * Second consequence: the dedupe key comes from the album's FIRST message id,
 * so a part redelivered after the flush would open a new buffer and post a
 * second bubble. Telegram only redelivers on a non-2xx response, which
 * `handleUpdate` never returns.
 */
const pendingAlbums = new Map<string, PendingAlbum>()

interface AlbumOrigin {
  chatId: number
  topicId: number
  fromId: number
}

function bufferAlbumPart(message: Message, origin: AlbumOrigin): void {
  const key = `${origin.chatId}:${message.media_group_id}`
  const existing = pendingAlbums.get(key)
  const files = extractFiles(message)

  if (existing) {
    clearTimeout(existing.timer)
    existing.firstMessageId = Math.min(
      existing.firstMessageId,
      message.message_id
    )
    // Exactly one part of an album carries the caption, and it is not
    // guaranteed to be the part that arrives first.
    existing.caption ??= message.caption ?? null
    if (existing.files.length < ALBUM_MAX_ITEMS) existing.files.push(...files)
    existing.timer = scheduleAlbumFlush(key)
    return
  }

  pendingAlbums.set(key, {
    ...origin,
    firstMessageId: message.message_id,
    caption: message.caption ?? null,
    files,
    timer: scheduleAlbumFlush(key),
  })
}

function scheduleAlbumFlush(key: string): NodeJS.Timeout {
  const timer = setTimeout(() => {
    void flushAlbum(key)
  }, ALBUM_DEBOUNCE_MS)
  // A half-collected album must not hold the process open during a shutdown.
  timer.unref?.()
  return timer
}

async function flushAlbum(key: string): Promise<void> {
  const album = pendingAlbums.get(key)
  if (!album) return
  pendingAlbums.delete(key)

  try {
    if (!album.files.length && !album.caption) return

    // Re-read instead of caching the row: the ticket may have been closed in
    // the second and a half spent waiting for the rest of the album.
    const ticket = await findTicketByTopic(album.chatId, album.topicId)
    if (!ticket) return

    const agent = await findAgentByTgId(album.fromId)
    await relay({
      ticket,
      text: album.caption,
      files: album.files,
      agentId: agent?.id ?? null,
      tgMessageId: album.firstMessageId,
    })
  } catch (err) {
    // Nothing above us can catch this — the flush runs off a timer, long after
    // the webhook returned.
    logger.error(
      `[updates] album ${key} failed to flush: ${(err as Error).message}`
    )
  }
}

// ─── Manually created topics ──────────────────────────────────────────────

/**
 * Adopt a forum topic an admin created by hand.
 *
 * Deliberately NOT routed through `chat.service.openTicketForUser`: that
 * helper creates a brand new Telegram topic for the ticket, which here would
 * leave a stray empty topic next to the one the admin just made. So the ticket
 * is created unbound and this function binds it to the existing topic.
 *
 * Idempotent — the bind happens before anything that can fail, so a redelivery
 * resolves the topic normally and never reaches this path again.
 */
async function adoptTopic(
  chatId: number,
  topicId: number,
  topicName: string
): Promise<SupportTicket | null> {
  // Only the nId matters here: the short ticket id in the name identifies the
  // ticket the topic was born with, which is not necessarily the user's
  // currently open one.
  const nId = parseTopicNId(topicName)
  if (nId == null) {
    await hintOnce(chatId, topicId, TOPIC_NAME_HINT)
    return null
  }

  const user = await findExchangeUserByNId(nId)
  if (!user) {
    await hintOnce(chatId, topicId, `Пользователь #${nId} не найден.`)
    return null
  }

  const open = await findOpenTicket(user.id)
  if (open?.tgTopicId != null && open.tgTopicId !== topicId) {
    // Rebinding would orphan the thread support is already working in, so
    // point them at it and leave this topic unbound.
    await hintOnce(
      chatId,
      topicId,
      `У пользователя #${nId} уже есть открытый тикет: ${topicUrl(
        open.tgChatId ?? chatId,
        open.tgTopicId
      )}`
    )
    return null
  }

  const { ticket, created } = await ensureOpenTicket({
    userId: user.id,
    userNId: nId,
  })
  let bound = await bindTicketTopic(ticket.id, chatId, topicId)

  if (created) {
    // The opening bubble is what separates this ticket from the previous one
    // in the user's single continuous feed — and it has to reach an open tab
    // live, not just the table, or the agent's first message pushes in ahead
    // of it and reads as the start of the dialog.
    await announceTicketOpened(user.id, bound)
  }

  // Context card last: it is the only step whose failure costs nothing, and
  // the binding above already survives it.
  try {
    const card = await getUserCard(user.id)
    const infoMessageId = await postTicketCard({
      chatId,
      topicId,
      ticketId: ticket.id,
      userNId: nId,
      card,
      // Null when the operator opened this ticket before the user ever wrote —
      // there is no request to have read an origin from.
      originDomain: bound.originDomain,
    })
    if (infoMessageId != null) {
      bound = await bindTicketTopic(ticket.id, chatId, topicId, infoMessageId)
    }
  } catch (err) {
    logger.warn(
      `[updates] info card failed for adopted topic ${topicId}: ${(err as Error).message}`
    )
  }

  logger.info(`[updates] adopted topic ${topicId} for ticket ${ticket.id}`)
  return bound
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function isSupportChat(message: Message): boolean {
  // An unset SUPPORT_CHAT_ID (local dev) means no chat is the support chat —
  // the bot stays inert rather than answering in whatever group it was added to.
  if (!TELEGRAM_CHAT_ID) return false
  return message.chat.id === TELEGRAM_CHAT_ID
}

/**
 * The ticket topic a message belongs to, or null when it belongs to General.
 *
 * `is_topic_message` is the discriminator: a plain reply inside General also
 * carries a `message_thread_id` (the thread root), and reading that as a topic
 * id would make the bot speak in the one room it must stay silent in.
 */
function topicIdOf(message: Message): number | null {
  const threadId = message.message_thread_id
  if (threadId == null || threadId === GENERAL_TOPIC_ID) return null
  if (message.is_topic_message !== true) return null
  return threadId
}

const hintedTopics = new Set<string>()
// Cheap bound: the set only exists to suppress a burst, so forgetting it after
// a few hundred topics costs one extra hint at worst.
const HINTED_TOPICS_CAP = 500

/**
 * Post a hint into a topic at most once per process.
 *
 * Without the guard every message in an unroutable topic draws another copy —
 * an admin pasting five screenshots into a mis-named topic would get five
 * identical replies.
 */
async function hintOnce(
  chatId: number,
  topicId: number,
  text: string,
  /**
   * Extra scope for the "once".
   *
   * Without it the key is the topic, which was right when a topic meant one
   * conversation. It no longer does, so any notice that is per-CONVERSATION
   * has to say so — otherwise it fires once per user and never again.
   */
  scope?: string
): Promise<void> {
  const key = scope ? `${chatId}:${topicId}:${scope}` : `${chatId}:${topicId}`
  if (hintedTopics.has(key)) return
  if (hintedTopics.size >= HINTED_TOPICS_CAP) hintedTopics.clear()
  hintedTopics.add(key)

  await sendPlainMessage({ chatId, topicId, text })
}
