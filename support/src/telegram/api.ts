import { stat } from 'fs/promises'
import path from 'path'

import { Bot, GrammyError, InlineKeyboard, InputFile } from 'grammy'
import type { InlineKeyboardMarkup } from 'grammy/types'

import type { SupportAttachment, SupportTicket } from '@prisma-support'

import {
  MAX_UPLOAD_BYTES,
  SUPPORT_FILES_DIR,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  TELEGRAM_WEBHOOK_SECRET,
  TELEGRAM_WEBHOOK_URL,
} from '@config/env'
import { logger } from '@config/logger'

import { groupByRail } from '@core/card-rails'

// Type-only, and it must stay that way: this module is the bottom of the
// Telegram layer and a runtime import of an app service would close the cycle
// `chat.service -> @telegram/api -> chat.service`. `import type` is erased at
// compile time, so no `require()` is emitted.
import type { CardDeposit, UserCard } from '@apps/services/user-card.service'

import { topicIconFor } from './topic-icons'
import { classifyPermanentFailure, createHardenedTransport } from './transport'
import type { PermanentFailure } from './transport'
import {
  TELEGRAM_CAPTION_LIMIT,
  TELEGRAM_TEXT_LIMIT,
  escapeHtml,
  formatThreadTopicName,
  formatTopicName,
  parseTopicName,
  shortTicketId,
  splitText,
} from './text'

export {
  formatThreadTopicName,
  formatTopicName,
  parseTopicName,
  shortTicketId,
  escapeHtml,
}
export type { ParsedTopicName } from './text'
export type { PermanentFailure } from './transport'

/**
 * Dumb Telegram wrapper: sends bytes, returns ids, never decides anything.
 *
 * Layering — this file imports config and nothing from `@apps`. Orchestration
 * lives in `chat.service.ts` (which imports this), and the update router sits
 * above both. Keeping the arrows pointing one way is what stops the relay from
 * turning into a require-cycle.
 *
 * Failure contract — a Telegram problem must NEVER fail a user request. Every
 * exported function logs and returns `null` / `void` instead of throwing: the
 * message is already committed to Postgres by the time we get here, and the
 * user's send has to succeed even when the support group is misconfigured.
 */

// The asymmetry that shapes the whole inbound file path: a person using the
// Telegram CLIENT may upload up to 2 GB, but a BOT may only download 20 MB.
// So an agent can drop a 300 MB screen recording into the topic, watch it
// upload fine, and we still cannot fetch a single byte of it — the relay is
// impossible, not merely slow, and no retry or streaming trick changes it.
// Whoever hits this has to be told (see `noteSkippedFiles` in updates.ts),
// because from their side the file looks delivered.
const TELEGRAM_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024

/**
 * The real ceiling on anything arriving FROM Telegram: our own upload cap, or
 * Telegram's bot-download cap, whichever bites first.
 *
 * Exported so the update router can tell "too large to ever relay" apart from
 * "the download failed" and word its note accordingly — one is a permanent
 * property of the file, the other is worth retrying.
 */
export const DOWNLOAD_LIMIT_BYTES = Math.min(
  MAX_UPLOAD_BYTES,
  TELEGRAM_DOWNLOAD_LIMIT_BYTES
)

// Deletions are deliberately absent: the Bot API has no "message deleted"
// update, so an agent removing a bubble is handled by a command in the topic,
// not by a webhook.
const ALLOWED_UPDATES = ['message', 'edited_message', 'callback_query'] as const

export const ZHORA_REPLY_CALLBACK_PREFIX = 'zr:'
export const ZHORA_SEND_CALLBACK_PREFIX = 'zs:'
export const ZHORA_TRANSLATE_CALLBACK_PREFIX = 'zt:'
export const ZHORA_TRANSLATE_LANGUAGE_CALLBACK_PREFIX = 'ztl:'

/** Put the request action on a bot-authored copy of the customer message. */
export async function attachZhoraReplyButton(args: {
  chatId: number
  telegramMessageId: number
  customerMessageId: string
}): Promise<boolean> {
  const bot = getBot()
  if (!bot) return false
  const keyboard = new InlineKeyboard().text(
    'Жора, ответь',
    `${ZHORA_REPLY_CALLBACK_PREFIX}${args.customerMessageId}`
  )
  const result = await safeCall('editMessageReplyMarkup (zhora)', () =>
    bot.api.editMessageReplyMarkup(args.chatId, args.telegramMessageId, {
      reply_markup: keyboard,
    })
  )
  return result !== null
}

const CLOSE_NOTICE: Record<'USER' | 'AGENT' | 'SYSTEM', string> = {
  USER: '🔒 Пользователь закрыл обращение.',
  AGENT: '🔒 Обращение закрыто оператором.',
  SYSTEM: '🔒 Обращение закрыто автоматически — нет активности.',
}

export interface TicketTopicBinding {
  chatId: number
  topicId: number
  infoMessageId?: number
}

let cachedBot: Bot | null = null
let initPromise: Promise<void> | null = null

/**
 * The bot, or null when no token is configured.
 *
 * Same idiom as `alert-bot.service.ts`: an unconfigured token turns every
 * Telegram call into a logged no-op rather than a boot failure, so tests and
 * local dev run the full chat flow without a bot.
 */
export function getBot(): Bot | null {
  if (!TELEGRAM_BOT_TOKEN) return null
  if (!cachedBot) {
    const bot = new Bot(TELEGRAM_BOT_TOKEN)
    bot.api.config.use(createHardenedTransport())
    cachedBot = bot
  }
  return cachedBot
}

/**
 * grammY refuses to route an update on an uninitialized bot, and `init()` is a
 * `getMe` round-trip we only want to pay once. Callers that handle webhooks
 * await this; the send path does not need it.
 */
export async function ensureBotInitialized(): Promise<Bot | null> {
  const bot = getBot()
  if (!bot || bot.isInited()) return bot

  initPromise ??= bot.init().catch((err: unknown) => {
    // Drop the memo so a transient getMe failure at boot can be retried.
    initPromise = null
    throw err
  })
  await initPromise
  return bot
}

/**
 * Strip the bot token out of anything on its way to a log line.
 *
 * Nothing here logs the token deliberately — but the Bot API embeds it in
 * every URL (`/file/bot<TOKEN>/…` below most of all), and an HTTP client that
 * quotes the URL it choked on ("Failed to parse URL from …") puts it in an
 * error message nobody wrote. That message is the one realistic way the
 * service's single most sensitive secret ends up in log aggregation.
 */
const scrubToken = (text: string): string =>
  TELEGRAM_BOT_TOKEN ? text.split(TELEGRAM_BOT_TOKEN).join('<bot-token>') : text

/**
 * Optional out-param for the relay path: the one thing a caller can act on
 * about a swallowed failure.
 *
 * It exists because of the failure contract above — every function here logs
 * and returns null, which is right for the user's send (it must succeed either
 * way) but leaves the retry loop unable to tell "Telegram was down" from "that
 * topic no longer exists", and only the second one is fixed by re-creating the
 * topic instead of trying again.
 *
 * First failure wins: with several sends in one relay (text plus files), the
 * earliest rejection is the one that explains the rest.
 */
export interface RelayFailure {
  permanent: PermanentFailure | null
}

function noteFailure(failure: RelayFailure | undefined, err: unknown): void {
  if (!failure || failure.permanent || !(err instanceof GrammyError)) return
  failure.permanent = classifyPermanentFailure(err.error_code, err.description)
}

async function safeCall<T>(
  what: string,
  fn: () => Promise<T>,
  failure?: RelayFailure
): Promise<T | null> {
  try {
    return await fn()
  } catch (err) {
    noteFailure(failure, err)
    if (err instanceof GrammyError) {
      logger.error(
        `[telegram] ${what} rejected (${err.error_code}): ${err.description}`
      )
    } else {
      logger.error(
        `[telegram] ${what} failed: ${scrubToken((err as Error).message)}`
      )
    }
    return null
  }
}

function topicOf(
  ticket: SupportTicket
): { chatId: number; topicId: number } | null {
  const chatId = ticket.tgChatId != null ? Number(ticket.tgChatId) : 0
  const topicId = ticket.tgTopicId ?? 0
  if (!chatId || !topicId) return null
  return { chatId, topicId }
}

// ─── Sending ──────────────────────────────────────────────────────────────

const isRejectedFor = (err: unknown, pattern: RegExp): boolean =>
  err instanceof GrammyError &&
  err.error_code === 400 &&
  pattern.test(err.description ?? '')

/**
 * One HTML message into a topic, with one degradation that keeps a bad detail
 * from costing us the whole message: an entity-parse rejection re-sends as
 * plain text, so a caller that passed unescaped free text still gets it
 * delivered, just unformatted.
 */
async function sendHtmlChunk(
  bot: Bot,
  chatId: number,
  topicId: number,
  text: string,
  keyboard?: InlineKeyboard
): Promise<number | null> {
  const send = (html: boolean): Promise<{ message_id: number }> =>
    bot.api.sendMessage(chatId, text, {
      message_thread_id: topicId,
      ...(html ? { parse_mode: 'HTML' as const } : {}),
      ...(keyboard ? { reply_markup: keyboard } : {}),
      link_preview_options: { is_disabled: true },
    })

  try {
    return (await send(true)).message_id
  } catch (err) {
    if (
      isRejectedFor(
        err,
        /parse entities|unsupported start tag|tag .* is not (closed|supported)/i
      )
    ) {
      logger.warn('[telegram] HTML rejected, resending as plain text')
      const retried = await safeCall('sendMessage (plain)', () => send(false))
      return retried?.message_id ?? null
    }
    if (err instanceof GrammyError) {
      logger.error(
        `[telegram] sendMessage rejected (${err.error_code}): ${err.description}`
      )
    } else {
      logger.error(`[telegram] sendMessage failed: ${(err as Error).message}`)
    }
    return null
  }
}

/**
 * Bot-authored text into a topic. `text` is parsed as HTML, so callers must
 * pass markup they built themselves (see `renderUserCard`) or escape free text
 * with `escapeHtml` first.
 *
 * Returns the id of the FIRST message — the one an edit would target when the
 * text had to be split across several.
 */
export async function sendToTopic(args: {
  chatId: number
  topicId: number
  text: string
  /** Buttons under the message. Attached to the LAST chunk: Telegram splits
   *  long text, and a keyboard on the first chunk would end up far above,
   *  detached from the lines it belongs to. */
  keyboard?: InlineKeyboard
}): Promise<number | null> {
  const bot = getBot()
  if (!bot) return null

  const chunks = splitText(args.text)
  if (chunks.length === 0) return null

  let firstId: number | null = null
  for (let i = 0; i < chunks.length; i += 1) {
    const sent = await sendHtmlChunk(
      bot,
      args.chatId,
      args.topicId,
      chunks[i]!,
      i === chunks.length - 1 ? args.keyboard : undefined
    )
    if (sent === null) return firstId
    if (firstId === null) firstId = sent
  }
  return firstId
}

/**
 * Text into a topic with NO parse mode.
 *
 * The load-bearing difference from `sendToTopic`, and the right default for
 * anything containing values we did not author: a relayed user message must
 * reach support verbatim (escaping would show `&lt;` where the user typed `<`,
 * and HTML parsing would let a stray `<b>` reformat — or, if malformed, block
 * outright — their own support message), and an operator notice quoting a user
 * name or a URL has the same problem.
 */
/**
 * Plain text in the operator Telegram group. `topicId: null` targets General;
 * ticket translations pass their topic and reply to the mirrored user message.
 * This does not deliver a reply to the customer on the website.
 */
export async function sendPlainMessage(args: {
  chatId: number
  topicId: number | null
  text: string
  replyToMessageId?: number
  replyMarkup?: InlineKeyboardMarkup
}): Promise<number | null> {
  const bot = getBot()
  if (!bot) return null
  return sendPlainToTopic(
    bot,
    args.chatId,
    args.topicId,
    args.text,
    undefined,
    args.replyToMessageId,
    args.replyMarkup
  )
}

/** One exact text fragment rendered as a tappable Telegram code block. */
export async function sendMonospaceMessage(args: {
  chatId: number
  topicId: number
  text: string
  replyToMessageId?: number
  replyMarkup?: InlineKeyboardMarkup
}): Promise<number | null> {
  if (!args.text || args.text.length > TELEGRAM_TEXT_LIMIT) return null
  const bot = getBot()
  if (!bot) return null
  const sent = await safeCall('sendMessage (zhora copy)', () =>
    bot.api.sendMessage(args.chatId, args.text, {
      message_thread_id: args.topicId,
      ...(args.replyToMessageId !== undefined
        ? { reply_parameters: { message_id: args.replyToMessageId } }
        : {}),
      entities: [{ type: 'pre', offset: 0, length: args.text.length }],
      ...(args.replyMarkup ? { reply_markup: args.replyMarkup } : {}),
      link_preview_options: { is_disabled: true },
    })
  )
  return sent?.message_id ?? null
}

async function sendPlainToTopic(
  bot: Bot,
  chatId: number,
  topicId: number | null,
  text: string,
  failure?: RelayFailure,
  replyToMessageId?: number,
  replyMarkup?: InlineKeyboardMarkup
): Promise<number | null> {
  let firstId: number | null = null
  const chunks = splitText(text)
  for (const [index, chunk] of chunks.entries()) {
    const sent = await safeCall(
      'sendMessage (relay)',
      () =>
        bot.api.sendMessage(chatId, chunk, {
          ...(topicId != null ? { message_thread_id: topicId } : {}),
          ...(replyToMessageId !== undefined
            ? { reply_parameters: { message_id: replyToMessageId } }
            : {}),
          link_preview_options: { is_disabled: true },
          ...(index === chunks.length - 1 && replyMarkup
            ? { reply_markup: replyMarkup }
            : {}),
        }),
      failure
    )
    if (!sent) return firstId
    if (firstId === null) firstId = sent.message_id
  }
  return firstId
}

/**
 * Show the native "typing…" indicator inside a ticket topic.
 *
 * Fire and forget by construction: Telegram clears the indicator on its own
 * after ~5 seconds (or as soon as the next message lands in the topic), so
 * there is nothing to cancel, nothing to confirm, and no failure the caller
 * could act on — a rejected action costs one frame of animation, never a
 * message. Hence `void` and the usual swallow-and-log.
 *
 * NOT metered by the per-chat message bucket (see `GROUP_MESSAGE_METHODS` in
 * transport.ts): a typing action is not a message, and queueing it behind the
 * relay FIFO would deliver it long after the user stopped typing. The rate
 * ceiling that does apply is `chat.service.userTyping`'s Redis claim.
 *
 * The reverse direction — an AGENT typing in Telegram, mirrored to the
 * platform — is impossible and not merely unimplemented: the Bot API delivers
 * no chat-action updates to bots (`Update` has no such field), so a bot can
 * only ever send this signal, never receive it.
 */
export async function sendTypingToTopic(
  chatId: number,
  topicId: number
): Promise<void> {
  const bot = getBot()
  if (!bot) return

  try {
    await bot.api.sendChatAction(chatId, 'typing', {
      message_thread_id: topicId,
    })
  } catch (err) {
    // Quiet on purpose, unlike every other call in this file: this one fires
    // per typing event, and whatever breaks it (Telegram down, bot removed
    // from the topic) also breaks the very next relay — which does log an
    // error. A dropped indicator on its own is not worth a line.
    logger.debug(
      `[telegram] typing in topic ${topicId} failed: ${(err as Error).message}`
    )
  }
}

/** Edit a message in place (agent card refresh, resolved-alert style edits). */
export async function editTopicMessage(args: {
  chatId: number
  messageId: number
  text: string
  keyboard?: InlineKeyboard
}): Promise<void> {
  const bot = getBot()
  if (!bot) return

  // An edit cannot spill into a second message, so an over-long replacement is
  // truncated rather than silently rejected by Telegram.
  const [head] = splitText(args.text)
  if (!head) return

  try {
    await bot.api.editMessageText(args.chatId, args.messageId, head, {
      parse_mode: 'HTML',
      ...(args.keyboard ? { reply_markup: args.keyboard } : {}),
      link_preview_options: { is_disabled: true },
    })
  } catch (err) {
    // Re-sending identical text is a normal outcome of an idempotent refresh,
    // not an error worth paging anyone about.
    if (isRejectedFor(err, /message is not modified/i)) return
    if (err instanceof GrammyError) {
      logger.error(
        `[telegram] editMessageText ${args.messageId} rejected (${err.error_code}): ${err.description}`
      )
    } else {
      logger.error(
        `[telegram] editMessageText ${args.messageId} failed: ${(err as Error).message}`
      )
    }
  }
}

/**
 * Clear the "spinner" on the pressed button.
 *
 * Mandatory and always: without an answer Telegram keeps the spinner on the
 * button until it times out, and the operator sees a stuck press even when the
 * message has already been repainted. The error is swallowed — an expired
 * callback (a button older than a day) is a normal outcome, not a reason to
 * fail.
 */
export async function answerCallback(
  callbackQueryId: string,
  text?: string
): Promise<void> {
  const bot = getBot()
  if (!bot) return
  try {
    await bot.api.answerCallbackQuery(callbackQueryId, {
      ...(text ? { text } : {}),
    })
  } catch (err) {
    logger.warn(
      `[telegram] answerCallbackQuery failed: ${(err as Error).message}`
    )
  }
}

// ─── Attachments ──────────────────────────────────────────────────────────

/**
 * What to hand Telegram for this attachment: its own `file_id` when the bytes
 * already live on their servers (an agent's upload coming back the other way),
 * otherwise a stream from the shared volume.
 *
 * A FACTORY, not a value, because an `InputFile` is single-use — grammY throws
 * on the second request built from the same instance. The photo→document
 * fallback below is exactly that second request.
 */
async function attachmentSource(
  attachment: SupportAttachment
): Promise<(() => InputFile | string) | null> {
  const fileId = attachment.tgFileId
  if (fileId) return () => fileId

  const root = path.resolve(SUPPORT_FILES_DIR)
  const absolute = path.resolve(root, attachment.storagePath)
  // `storagePath` is service-generated, so this can only fire on a future bug —
  // but one line here turns "trusted the DB" into a log entry instead of the
  // support group receiving /etc/passwd.
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    logger.error(
      `[telegram] attachment ${attachment.id} escapes the storage root`
    )
    return null
  }

  try {
    await stat(absolute)
  } catch (err) {
    logger.error(
      `[telegram] attachment ${attachment.id} unreadable at ${attachment.storagePath}: ${
        (err as Error).message
      }`
    )
    return null
  }

  // Path, not a Buffer: grammY streams it, so a 20 MB upload never sits in the
  // heap of a service whose main job is holding chat state.
  return () => new InputFile(absolute, attachment.fileName)
}

async function sendAttachment(
  bot: Bot,
  chatId: number,
  topicId: number,
  attachment: SupportAttachment,
  caption: string | null,
  failure?: RelayFailure
): Promise<number | null> {
  const source = await attachmentSource(attachment)
  if (!source) return null

  const options = {
    message_thread_id: topicId,
    // No parse mode — the caption is the user's own text (see sendPlainToTopic).
    ...(caption ? { caption } : {}),
  }

  const label = `send ${attachment.kind.toLowerCase()} ${attachment.id}`
  if (attachment.kind === 'IMAGE') {
    try {
      const sent = await bot.api.sendPhoto(chatId, source(), options)
      return sent.message_id
    } catch (err) {
      // Telegram refuses plenty of legitimate images as photos (HEIC, huge
      // dimensions, >10 MB). Support still needs to see the file, so fall back
      // to the document path rather than dropping it.
      logger.warn(
        `[telegram] ${label} as photo failed, retrying as document: ${(err as Error).message}`
      )
    }
  }

  if (attachment.kind === 'VIDEO') {
    try {
      const sent = await bot.api.sendVideo(chatId, source(), {
        ...options,
        // Lets an operator scrub the recording inside Telegram instead of
        // downloading it whole to see the ten seconds that matter.
        supports_streaming: true,
        // Without these Telegram lays the player out SQUARE: a horizontal
        // recording reaches the operator looking cropped, and a portrait one
        // letterboxed. They are read from the container at upload time (see
        // core/video-meta.ts) — omitted only when the file was not ISO-BMFF,
        // in which case Telegram falls back to its own probe.
        ...(attachment.width && attachment.height
          ? { width: attachment.width, height: attachment.height }
          : {}),
      })
      return sent.message_id
    } catch (err) {
      // Same shape as the photo fallback, and for the same reason: Telegram
      // rejects containers it cannot make a thumbnail of (.mov with an exotic
      // codec, a webm it dislikes). As a document it still reaches support.
      // The retry below rebuilds the InputFile from the factory — an InputFile
      // is single-use, and reusing this one would throw inside grammY.
      logger.warn(
        `[telegram] ${label} as video failed, retrying as document: ${(err as Error).message}`
      )
    }
  }

  // The document path is the last one every kind funnels through, so this is
  // also where a "the topic is gone" rejection is recorded for the caller —
  // the photo/video fallbacks above are expected to fail on their own merits.
  const sent = await safeCall(
    label,
    () => bot.api.sendDocument(chatId, source(), options),
    failure
  )
  return sent?.message_id ?? null
}

// ─── Info card ────────────────────────────────────────────────────────────

// `user-card.service` fills unreadable strings with '' and unreadable dates
// with the epoch rather than inventing values, so "unknown" is one check here
// and the card never shows a wrong number.
const EPOCH_MS = 0

const esc = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  const s = String(value).trim()
  return s.length ? escapeHtml(s) : null
}

// Money arrives pre-formatted as a fixed-2 string (Decimal does not survive the
// JSON hop), so the renderer only adds the sign.
const money = (value: string | null | undefined): string | null =>
  value && value.trim().length ? `$${escapeHtml(value.trim())}` : null

// Kyiv, matching every other operational message this platform sends staff.
const moment = (value: Date | null | undefined): string | null => {
  if (!value) return null
  const ms = value.getTime()
  if (Number.isNaN(ms) || ms === EPOCH_MS) return null
  return value.toLocaleString('ru-RU', {
    timeZone: 'Europe/Kyiv',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * `riskFlags` is raw JSON off the exchange row, and its shape has changed
 * several times (array of codes, then a per-flag boolean map with extras like
 * `purpleActive`). Read whichever it currently is and show only what is ON —
 * an operator wants the tripped flags, not the full checklist.
 */
// Flags the exchange has RETIRED. Stored riskFlags JSON is never rewritten, so
// a row written before a removal keeps the key forever and this card would go
// on naming a flag that no longer exists — a grep for it finds nothing, and the
// operator has no way to know it is stale.
//
// `nightTrading` was removed on 2026-08-14. Bookkeeping keys such as
// `purpleActive` and `pnlNegativeMinus1` are deliberately NOT here: they still
// mean something to an operator, and hiding them is a separate decision.
const RETIRED_RISK_FLAG_KEYS = new Set(['nightTrading'])

function riskFlagNames(flags: unknown): string[] {
  if (Array.isArray(flags)) {
    return flags
      .filter((f) => typeof f !== 'string' || !RETIRED_RISK_FLAG_KEYS.has(f))
      .map((f) => esc(f))
      .filter((f): f is string => f !== null)
  }
  if (typeof flags === 'object' && flags !== null) {
    return Object.entries(flags as Record<string, unknown>)
      .filter(([key, on]) => on === true && !RETIRED_RISK_FLAG_KEYS.has(key))
      .map(([key]) => esc(key))
      .filter((f): f is string => f !== null)
  }
  return []
}

/**
 * The pinned first message of a ticket topic: everything an operator would
 * otherwise open three admin tabs for.
 *
 * HTML with `<b>/<code>/<i>` only — free text is escaped, so a user whose
 * display name is `<script>` cannot break the card (or Telegram's parser,
 * which would reject the whole send).
 */
export function renderUserCard(
  card: UserCard,
  ticketId: string,
  originDomain?: string | null
): string {
  const lines: string[] = [
    `🎫 <b>Тикет</b> <code>${shortTicketId(ticketId)}</code>`,
    '',
  ]

  const name = esc(card.fullName)
  lines.push(`👤 ${name ? `<b>${name}</b> · ` : ''}<code>${card.nId}</code>`)
  if (card.isBlocked) lines.push('⛔️ <b>Аккаунт заблокирован</b>')

  const email = esc(card.email)
  if (email) lines.push(`Email: <code>${email}</code>`)

  const geo = [esc(card.countryCode), esc(card.lang)].filter(Boolean)
  if (geo.length) lines.push(`Гео: ${geo.join(' · ')}`)

  // Omitted, never "unknown": tickets opened before the column existed (and
  // any request that reached us without the origin header) have nothing to
  // show, and a placeholder would read as a fact about the user.
  const domain = esc(originDomain)
  if (domain) lines.push(`Домен: <code>${domain}</code>`)

  const profile = [
    ...(esc(card.accountType) ? [`Тип: ${esc(card.accountType)}`] : []),
    ...(esc(card.kycLevel) ? [`KYC: ${esc(card.kycLevel)}`] : []),
  ]
  if (profile.length) lines.push(profile.join(' · '))

  const registered = moment(card.registeredAt)
  if (registered) lines.push(`Регистрация: ${registered}`)
  const lastLogin = moment(card.lastLoggedIn)
  if (lastLogin) lines.push(`Последний вход: ${lastLogin}`)

  const real = money(card.balanceReal)
  const demo = money(card.balanceDemo)
  if (real || demo) {
    lines.push(`Баланс: ${real ?? '—'}${demo ? ` · демо ${demo}` : ''}`)
  }

  const deposits = money(card.depositsTotal)
  const withdrawals = money(card.withdrawalsTotal)
  if (deposits || withdrawals) {
    lines.push(`Депозиты: ${deposits ?? '—'} · Выводы: ${withdrawals ?? '—'}`)
    const firstDeposit = moment(card.firstDepositAt)
    if (firstDeposit) lines.push(`Первый депозит: ${firstDeposit}`)
  }

  const priority = esc(card.riskPriority)
  const flags = riskFlagNames(card.riskFlags)
  if (priority || flags.length) {
    const suffix = flags.length ? ` (${flags.join(', ')})` : ''
    lines.push(`Риск: <b>${priority ?? '—'}</b>${suffix}`)
  }

  if (card.partnerId != null) {
    lines.push(`Партнёр: <code>${card.partnerId}</code>`)
  }

  // The write ban comes first among the service marks: without it the next
  // operator sees a silent person and does not understand why they are not
  // answering.
  const muted = moment(card.mutedUntil)
  if (muted) {
    const why = esc(card.muteReason)
    lines.push(
      `🔇 <b>Обращения закрыты до ${muted}</b>${why ? ` · ${why}` : ''}`
    )
  }

  // VIP priority goes above ratings and deposits: it changes HOW the operator
  // runs the conversation, not what they will find out in it.
  const vip = moment(card.supportVipAt)
  if (vip) lines.push(`⭐️ <b>VIP-приоритет</b> · Trustpilot ${vip}`)

  if (card.lastRating != null) {
    const comment = esc(card.lastRatingComment)
    lines.push(
      `Оценка поддержки: <b>${card.lastRating}/5</b>` +
        (comment ? ` · <i>${comment}</i>` : '')
    )
  }

  // By rail: rubles, hryvnias and worldwide cards are different money and
  // different providers, and in a single list the operator had to read the
  // currency off every line to tell which deposit was meant.
  //
  // The lines are rendered BEFORE the heading: a group where every line turned
  // out to be unreadable must not leave a dangling heading.
  for (const group of groupByRail(card.cardDeposits)) {
    const rendered = group.items
      .map(cardDepositLine)
      .filter((line): line is string => line !== null)
    if (rendered.length) lines.push(`💳 ${group.label}:`, ...rendered)
  }

  return lines.join('\n')
}

/**
 * One card deposit on ONE line — the card is a Telegram message an operator
 * skims on a phone, so three of these must not push the risk flags off screen.
 *
 * Null when the amount is unreadable: a deposit line without a sum is noise.
 */
function cardDepositLine(deposit: CardDeposit): string | null {
  const amount = esc(deposit.amount)
  if (!amount) return null

  const currency = esc(deposit.currency)
  // `<code>` and not plain text: Telegram copies a code span to the clipboard
  // on tap, which is the whole reason the id is on the card — an operator moves
  // it into the provider's panel without retyping it off a phone screen.
  //
  // Omitted entirely when the row has no provider order id (onramper), rather
  // than substituted with our internal Payment id: a wrong-but-plausible
  // identifier costs more than a missing one.
  const orderId = esc(deposit.providerOrderId)
  const parts = [
    orderId ? `<code>${orderId}</code>` : null,
    `<b>${amount}${currency ? ` ${currency}` : ''}</b>`,
    esc(deposit.status),
    moment(deposit.createdAt),
    esc(deposit.method),
  ].filter((part): part is string => part !== null)

  return `· ${parts.join(' · ')}`
}

/**
 * Post the info card into an EXISTING topic and pin it.
 *
 * Split out of `createTicketTopic` because a topic an admin created by hand
 * needs the same card without the creation step (see `adoptTopic` in the
 * update router). Returns the pinned message_id.
 */
/**
 * Refresh a pinned info card in place.
 *
 * Exists because a permanent thread outlives every card posted into it: the
 * balance, KYC level, risk flags and deposit history an operator reads are
 * whatever they were when the thread was born, unless something rewrites them.
 *
 * Returns false when the edit could not be applied, so the caller can post a
 * fresh card instead of leaving a stale one pinned.
 */
export async function editTicketCard(args: {
  chatId: number
  topicId: number
  messageId: number
  ticketId: string
  userNId: number
  card: UserCard
  originDomain?: string | null
}): Promise<boolean> {
  const bot = getBot()
  if (!bot) return false

  const ok = await safeCall(`editMessageText card ${args.messageId}`, () =>
    bot.api.editMessageText(
      args.chatId,
      args.messageId,
      renderUserCard(args.card, args.ticketId, args.originDomain),
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    )
  )
  // "not modified" means the card is already current — a success, not a miss.
  return ok !== null
}

export async function postTicketCard(args: {
  chatId: number
  topicId: number
  ticketId: string
  userNId: number
  card: UserCard
  /** Mirror the ticket was opened from; null on tickets older than the column. */
  originDomain?: string | null
}): Promise<number | null> {
  const bot = getBot()
  if (!bot) return null

  const messageId = await sendToTopic({
    chatId: args.chatId,
    topicId: args.topicId,
    text: renderUserCard(args.card, args.ticketId, args.originDomain),
  })
  if (messageId === null) return null

  await safeCall('pinChatMessage', () =>
    bot.api.pinChatMessage(args.chatId, messageId, {
      disable_notification: true,
    })
  )
  return messageId
}

// ─── Topics ───────────────────────────────────────────────────────────────

/**
 * `t.me` deep link to a topic, for pointing an operator at another thread.
 *
 * Private supergroups have no username, so the link uses the `/c/` form, which
 * takes the chat id with its `-100` supergroup prefix stripped. Returns an
 * empty string when the ticket has no topic yet — a caller interpolating it
 * gets a short sentence, not the word "null".
 */
export function topicUrl(
  chatId: number | bigint | null | undefined,
  topicId: number | null | undefined
): string {
  if (chatId == null || topicId == null) return ''
  const internal = chatId.toString().replace(/^-100/, '').replace(/^-/, '')
  if (!internal) return ''
  return `https://t.me/c/${internal}/${topicId}`
}

/**
 * Just the nId out of a topic name, for callers that only need to resolve the
 * user (the short ticket id in the name identifies the ticket the topic was
 * born with, which is not necessarily the user's currently open one).
 */
export function parseTopicNId(name: string): number | null {
  return parseTopicName(name)?.userNId ?? null
}

/**
 * Create the ticket's forum topic and pin its info card.
 *
 * Returns null when Telegram is unconfigured or refuses the topic — the caller
 * leaves the ticket unbound and tries again on the next message, so a missing
 * `can_manage_topics` permission costs support the topic, not the user's
 * message.
 */
export async function createTicketTopic(args: {
  ticketId: string
  userNId: number
  card: UserCard
  /** Mirror the ticket was opened from; null on tickets older than the column. */
  originDomain?: string | null
  /** Title it as the user's permanent thread (`<nId> · <email>`). */
  threadTitle?: boolean
}): Promise<TicketTopicBinding | null> {
  const bot = getBot()
  if (!bot || !TELEGRAM_CHAT_ID) {
    logger.warn(
      `[telegram] no topic for ticket ${args.ticketId} — SUPPORT_BOT_TOKEN / SUPPORT_CHAT_ID not set`
    )
    return null
  }

  // The user's permanent topic is titled by WHO it belongs to, not by which
  // ticket happened to open it — every later ticket lands in the same thread.
  const name = args.threadTitle
    ? formatThreadTopicName(args.userNId, args.card.email)
    : formatTopicName(args.userNId, args.ticketId)
  const icon = await topicIconFor(bot, 'OPEN')
  const topic = await safeCall(`createForumTopic "${name}"`, () =>
    bot.api.createForumTopic(
      TELEGRAM_CHAT_ID,
      name,
      icon ? { icon_custom_emoji_id: icon } : {}
    )
  )
  if (!topic) return null

  const binding: TicketTopicBinding = {
    chatId: TELEGRAM_CHAT_ID,
    topicId: topic.message_thread_id,
  }

  // The card is a convenience, not a precondition — a topic without it still
  // relays messages, so its failure never invalidates the binding.
  const infoMessageId = await postTicketCard({
    chatId: binding.chatId,
    topicId: binding.topicId,
    ticketId: args.ticketId,
    userNId: args.userNId,
    card: args.card,
    originDomain: args.originDomain,
  })

  if (infoMessageId !== null) binding.infoMessageId = infoMessageId

  logger.info(
    `[telegram] topic ${binding.topicId} created for ticket ${args.ticketId}`
  )
  return binding
}

/**
 * Relay one user message into its topic.
 *
 * Returns the message_id of the message CARRYING THE TEXT — that is the one an
 * edit on the platform would have to target. With no text at all, the first
 * file's id stands in so the row still has a Telegram anchor.
 */
export async function relayUserMessage(args: {
  ticket: SupportTicket
  text?: string | null
  attachments: SupportAttachment[]
  /**
   * Filled in when Telegram refused the destination itself. The retry loop
   * passes one and acts on it; the inline send does not care, because it has
   * that loop behind it.
   */
  failure?: RelayFailure
}): Promise<number | null> {
  const bot = getBot()
  if (!bot) return null

  const topic = topicOf(args.ticket)
  if (!topic) {
    logger.warn(
      `[telegram] ticket ${args.ticket.id} has no topic — nothing relayed`
    )
    return null
  }

  const body = args.text && args.text.length ? args.text : null
  const files = args.attachments

  // One file plus a short note: send it as a caption. Two bubbles where one
  // would do makes a topic much harder to read at 3am. Kind-agnostic on
  // purpose — a photo, a video and a document all take the same 1024-character
  // caption, so the rule stays one rule.
  const single = files.length === 1 ? files[0] : undefined
  if (single && body && body.length <= TELEGRAM_CAPTION_LIMIT) {
    const sent = await sendAttachment(
      bot,
      topic.chatId,
      topic.topicId,
      single,
      body,
      args.failure
    )
    if (sent !== null) return sent
    // Caption path failed (unreadable file, rejected upload) — fall through so
    // the text still reaches support on its own.
  }

  let textMessageId: number | null = null
  if (body) {
    textMessageId = await sendPlainToTopic(
      bot,
      topic.chatId,
      topic.topicId,
      body,
      args.failure
    )
  }

  for (const file of files) {
    const sent = await sendAttachment(
      bot,
      topic.chatId,
      topic.topicId,
      file,
      null,
      args.failure
    )
    if (textMessageId === null) textMessageId = sent
  }

  return textMessageId
}

/**
 * Archive a ticket's topic.
 *
 * Closed, never deleted: the topic IS the support history, and Telegram is the
 * only place where the operator-side context (who handled it, internal notes)
 * lives.
 */
/**
 * Remove one message from a topic.
 *
 * Best-effort on purpose. Telegram refuses to delete a message older than 48
 * hours, and one an operator already removed by hand is simply gone — neither
 * is a reason to fail the caller, whose platform-side delete has happened
 * either way. The asymmetry is deliberate: a bubble left in Telegram is an
 * operator's problem to see, a bubble left on the platform is the user's.
 */
export async function deleteTopicMessage(
  chatId: number,
  messageId: number
): Promise<void> {
  const bot = getBot()
  if (!bot) return

  await safeCall(`deleteMessage ${messageId}`, () =>
    bot.api.deleteMessage(chatId, messageId)
  )
}

export async function closeTicketTopic(
  ticket: SupportTicket,
  closedBy: 'USER' | 'AGENT' | 'SYSTEM',
  /**
   * True when this topic is the user's PERMANENT thread. Then the topic must
   * NOT be archived: their next message belongs in the same thread, and
   * Telegram refuses ordinary posts into a closed topic — the conversation
   * would come back to a thread nobody can write in.
   */
  isPermanentThread = false
): Promise<void> {
  const bot = getBot()
  if (!bot) return

  const topic = topicOf(ticket)
  if (!topic) return

  await sendToTopic({
    chatId: topic.chatId,
    topicId: topic.topicId,
    text: CLOSE_NOTICE[closedBy],
  })
  // Flip the icon BEFORE archiving — the edit should never be the operation
  // that has to work on an already-closed topic. The NAME is deliberately left
  // alone: on a hand-adopted topic it is a title an operator chose, and the
  // icon carries the state on its own.
  //
  // Every step here is best-effort by design. `safeCall` swallows a failed
  // edit and the close still runs: a stale icon is cosmetic, a topic left open
  // in the operators' list is not.
  const icon = await topicIconFor(bot, 'CLOSED')
  if (icon) {
    await safeCall(`editForumTopic ${topic.topicId}`, () =>
      bot.api.editForumTopic(topic.chatId, topic.topicId, {
        icon_custom_emoji_id: icon,
      })
    )
  }
  // Archiving is for the old one-topic-per-ticket layout, where a finished
  // topic really was finished. A permanent thread keeps its ✅ icon and stays
  // open, so the next conversation continues right below.
  if (isPermanentThread) return

  await safeCall(`closeForumTopic ${topic.topicId}`, () =>
    bot.api.closeForumTopic(topic.chatId, topic.topicId)
  )
}

/**
 * Un-archive a topic.
 *
 * Needed because a permanent thread can still end up closed by hand — an
 * operator tidying the forum list — and after that every relay into it fails
 * with TOPIC_CLOSED. Reopening is cheaper than minting a new topic and losing
 * the thread's history.
 */
export async function markTopicOpen(
  chatId: number,
  topicId: number
): Promise<void> {
  const bot = getBot()
  if (!bot) return
  const icon = await topicIconFor(bot, 'OPEN')
  if (!icon) return
  await safeCall(`editForumTopic ${topicId} (reopen icon)`, () =>
    bot.api.editForumTopic(chatId, topicId, { icon_custom_emoji_id: icon })
  )
}

export async function reopenTopic(
  chatId: number,
  topicId: number
): Promise<boolean> {
  const bot = getBot()
  if (!bot) return false
  const ok = await safeCall(`reopenForumTopic ${topicId}`, () =>
    bot.api.reopenForumTopic(chatId, topicId)
  )
  return ok !== null
}

// ─── Files ────────────────────────────────────────────────────────────────

/**
 * Fetch an agent's upload out of Telegram.
 *
 * Capped at 20 MB in three places because none of them alone is trustworthy:
 * `getFile` reports a size (absent for some types), the response advertises a
 * content-length (absent on chunked replies), and only the bytes we actually
 * read are a fact.
 */
export async function downloadFile(
  fileId: string
): Promise<{ buffer: Buffer; filePath: string } | null> {
  const bot = getBot()
  if (!bot) return null

  const file = await safeCall(`getFile ${fileId}`, () =>
    bot.api.getFile(fileId)
  )
  if (!file) return null
  if (!file.file_path) {
    logger.error(`[telegram] getFile ${fileId} returned no file_path`)
    return null
  }
  if (file.file_size != null && file.file_size > DOWNLOAD_LIMIT_BYTES) {
    logger.warn(
      `[telegram] file ${fileId} is ${file.file_size} bytes, over the ${DOWNLOAD_LIMIT_BYTES} limit`
    )
    return null
  }

  // The bot token is part of this URL — it must never reach a log line, hence
  // `file_path` (not `url`) in every message below, and `scrubToken` on the
  // one message we did not write ourselves.
  const url = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`
  try {
    const response = await fetch(url)
    if (!response.ok) {
      logger.error(
        `[telegram] downloading ${file.file_path} failed with HTTP ${response.status}`
      )
      return null
    }

    const declared = Number(response.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > DOWNLOAD_LIMIT_BYTES) {
      logger.warn(
        `[telegram] ${file.file_path} advertises ${declared} bytes — refusing`
      )
      return null
    }

    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > DOWNLOAD_LIMIT_BYTES) {
      logger.warn(
        `[telegram] ${file.file_path} downloaded ${buffer.length} bytes — discarding`
      )
      return null
    }
    return { buffer, filePath: file.file_path }
  } catch (err) {
    logger.error(
      `[telegram] downloading ${file.file_path} failed: ${scrubToken(
        (err as Error).message
      )}`
    )
    return null
  }
}

// ─── Webhook ──────────────────────────────────────────────────────────────

/**
 * Point Telegram at our webhook. Idempotent, so it can run on every boot of
 * every replica.
 *
 * `drop_pending_updates` stays false deliberately: a redelivered update is
 * deduped by `dedupeKey`, whereas a dropped one is a support reply the user
 * never sees.
 */
export async function registerWebhook(): Promise<void> {
  const bot = getBot()
  if (!bot) {
    logger.warn('[telegram] SUPPORT_BOT_TOKEN not set — webhook not registered')
    return
  }

  // Boot is the only good moment to pay for the getMe round-trip the update
  // router needs, whether or not a webhook URL is configured.
  await safeCall('bot.init', () => ensureBotInitialized())

  if (!TELEGRAM_WEBHOOK_URL) {
    logger.warn(
      '[telegram] SUPPORT_WEBHOOK_URL empty — running without a webhook'
    )
    return
  }

  const registered = await safeCall('setWebhook', () =>
    bot.api.setWebhook(TELEGRAM_WEBHOOK_URL, {
      ...(TELEGRAM_WEBHOOK_SECRET
        ? { secret_token: TELEGRAM_WEBHOOK_SECRET }
        : {}),
      allowed_updates: [...ALLOWED_UPDATES],
      drop_pending_updates: false,
    })
  )
  // Debug, not info: every way this can fail is already loud (no token, no
  // URL, a rejected setWebhook), so a silent boot means it registered.
  if (registered)
    logger.debug(`[telegram] webhook registered at ${TELEGRAM_WEBHOOK_URL}`)
}
