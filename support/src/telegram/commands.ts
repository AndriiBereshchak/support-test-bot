import { InlineKeyboard } from 'grammy'
import type { SupportTicket } from '@prisma-support'
import type { Message } from 'grammy/types'

import { prismaExchange } from '@config/database'
import { logger } from '@config/logger'

import {
  AGENT_NAME_MAX_LENGTH,
  AGENT_TITLE_MAX_LENGTH,
  findAgentByTgId,
  sanitizeAgentText,
  setAgentAvatar,
  upsertAgent,
} from '@apps/services/agent.service'
import { saveAgentAvatar } from '@apps/services/attachment.service'
import {
  agentDeleteMessage,
  closeTicketEverywhere,
  openTicketForUser,
} from '@apps/services/chat.service'
import { findMessageByTelegramId } from '@apps/services/message.service'
import {
  DEPOSITS_LIMIT,
  DEPOSIT_FILTERS,
  FILTER_LABELS,
  type DepositFilter,
  isDepositFilter,
  listUserDeposits,
} from '@apps/services/deposit-list.service'
import {
  checkDeletable,
  deleteAccount,
} from '@apps/services/account-delete.service'
import { muteUser, unmuteUser } from '@apps/services/mute.service'
import { audit } from '@apps/services/operator-audit.service'
import {
  type PartnerInfo,
  bindPartner,
  findPartner,
  findPartnerByCode,
} from '@apps/services/partner-bind.service'
import {
  WITHDRAWALS_LIMIT,
  listUserWithdrawals,
} from '@apps/services/withdrawal-list.service'
import { findTicketByTopic } from '@apps/services/ticket.service'
import { getUserCard } from '@apps/services/user-card.service'

import { escapeHtml } from '@telegram/text'

import { DURATION_HINT, parseDuration } from '@core/duration'
import { ApiError } from '@core/errors/api-error'
import { prepareZhoraInvocation } from './zhora'
import { requestZhoraSuggestion } from '@apps/services/zhora/suggestion.service'

import {
  deleteTopicMessage,
  downloadFile,
  editTopicMessage,
  renderUserCard,
  sendPlainMessage,
  sendToTopic,
  topicUrl,
} from '@telegram/api'

/**
 * Bot commands typed by support staff inside the Telegram group.
 *
 * Layering: this file sits ABOVE the app services (it orchestrates them) and
 * below `@telegram/updates`, which is the only importer. It must never be
 * imported from `@apps/*` — that would close the cycle the layering rule
 * exists to prevent.
 *
 * Deliberate exception to "the bot is silent outside ticket topics": a slash
 * command is an explicit request addressed to the bot, so it gets an answer
 * wherever it was typed inside the support group — including the General
 * topic, which is the only place `/ticket <nId>` and `/setname` make sense
 * before a topic exists. Everything that is NOT a command still gets the
 * silent treatment; the router enforces that.
 */

const HELP_TEXT = [
  'Команды бота поддержки:',
  '',
  '/ticket <nId> — открыть (или найти) тикет по номеру пользователя',
  '/info — свежая карточка пользователя; работает внутри темы тикета',
  '/deposits — все депозиты пользователя, с фильтром по рельсу',
  '/withdrawals (/wd) — все выводы: сумма, статус, мост обработки',
  '/partner <id | код | ссылка> — привязать партнёра; только если его ещё нет',
  '/deleteuser — удалить аккаунт; нельзя, если были сделки или депозиты',
  '/mute <срок> [причина] — закрыть пользователю обращения в поддержку',
  `    ${DURATION_HINT}`,
  '/unmute — снять запрет досрочно',
  '/close — закрыть тикет; работает внутри темы тикета',
  '/del — ответом на сообщение: убрать его и здесь, и у пользователя',
  '/me — моя карточка оператора',
  '/setname <имя> — имя, которое видит пользователь',
  '/settitle <текст> — подпись под именем; без текста — убрать',
  '/setavatar — отправьте фото с этой подписью либо ответом на фото',
  '/help — это сообщение',
].join('\n')

/** Usage hint the router reuses for topics it cannot resolve to a user. */
export const TOPIC_NAME_HINT = [
  'Не удалось определить пользователя по названию темы.',
  'Назовите тему по номеру пользователя (например «#1234»)',
  'или используйте /ticket <nId>.',
].join('\n')

export interface ParsedCommand {
  /** Lowercase, without the leading slash and without the `@botname` suffix. */
  name: string
  /** Everything after the command word, trimmed. Empty string when absent. */
  args: string
}

export interface CommandContext {
  chatId: number
  /** Ticket topic the command was typed in; null for the General topic. */
  topicId: number | null
  fromId: number
  message: Message
}

/**
 * Recognise a bot command in a message or a photo caption.
 *
 * The `bot_command` entity at offset 0 is the authoritative signal, not the
 * leading slash: an agent reply that merely starts with "/" (a path, a date)
 * carries no entity and must be relayed to the user untouched.
 */
export function parseCommand(message: Message): ParsedCommand | null {
  const raw = message.text ?? message.caption ?? ''
  if (!raw.startsWith('/')) return null

  const entities = message.entities ?? message.caption_entities
  const head = entities?.find(
    (entity) => entity.type === 'bot_command' && entity.offset === 0
  )
  if (head) {
    return {
      name: raw.slice(1, head.length).split('@')[0]?.toLowerCase() ?? '',
      args: raw.slice(head.length).trim(),
    }
  }

  // Fallback for payloads that carry no entities at all (hand-built updates in
  // tests, and the odd client that omits them).
  if (entities?.length) return null
  const match = /^\/([A-Za-z0-9_]{1,32})(?:@[A-Za-z0-9_]{1,32})?(?=\s|$)/.exec(
    raw
  )
  if (!match?.[1]) return null
  return {
    name: match[1].toLowerCase(),
    args: raw.slice(match[0].length).trim(),
  }
}

/**
 * Resolve an exchange user by the human-facing number support staff use.
 *
 * Lives here because `/ticket` is its primary consumer; the router imports it
 * for the manually-created-topic flow, which keeps the dependency
 * one-directional (updates -> commands, never the reverse).
 */
export async function findExchangeUserByNId(
  nId: number
): Promise<{ id: string; nId: number } | null> {
  return prismaExchange.user.findUnique({
    where: { nId },
    select: { id: true, nId: true },
  })
}

async function reply(ctx: CommandContext, text: string): Promise<void> {
  await sendPlainMessage({ chatId: ctx.chatId, topicId: ctx.topicId, text })
}

async function requestReplyDraft(args: {
  chatId: number
  topicId: number | null
  fromId: number
  eventKey: string
  tgMessageId?: number
  messageId?: string
}) {
  const invocation = await prepareZhoraInvocation(args)
  if (!invocation) return
  try {
    await requestZhoraSuggestion({
      eventKey: args.eventKey,
      ticketId: invocation.ticket.id,
      messageId: invocation.messageId,
      agentId: invocation.agentId,
    })
  } catch (error) {
    // Never expose provider errors or prompt/customer data in a topic notice.
    const text =
      error instanceof ApiError
        ? error.message
        : 'Не удалось запустить Жору. Попробуйте позже.'
    await sendPlainMessage({ chatId: args.chatId, topicId: args.topicId, text })
  }
}

export async function handleZhoraReplyCallback(args: {
  chatId: number
  topicId: number | null
  fromId: number
  callbackId: string
  messageId: string
}): Promise<void> {
  await requestReplyDraft({
    ...args,
    eventKey: `reply:tap:${args.callbackId}`,
  })
}

/**
 * Run a command. Any command shape is consumed here — an unknown one gets the
 * help text rather than being relayed, because Telegram rendered it as a
 * command and the user must never receive a mistyped `/clse`.
 */
export async function handleCommand(
  ctx: CommandContext,
  command: ParsedCommand
): Promise<void> {
  switch (command.name) {
    case 'zhora': {
      return requestReplyDraft({
        chatId: ctx.chatId,
        topicId: ctx.topicId,
        fromId: ctx.fromId,
        eventKey: `reply:cmd:${ctx.chatId}:${ctx.message.message_id}`,
        tgMessageId: ctx.message.reply_to_message?.message_id,
      })
    }
    case 'fix':
    case 'brief': {
      const invocation = await prepareZhoraInvocation({
        chatId: ctx.chatId,
        topicId: ctx.topicId,
        fromId: ctx.fromId,
        isBot: ctx.message.from?.is_bot,
        // /fix has its own draft-reply flow; do not require its source to be IN.
      })
      if (!invocation) return
      // Generation/fix/brief handlers are added in their own implementation
      // blocks. Keep the commands consumed and private in the meantime.
      return reply(ctx, 'Эта команда Жоры пока недоступна.')
    }
    case 'help':
    case 'start':
      return reply(ctx, HELP_TEXT)
    case 'me':
      return commandMe(ctx)
    case 'setname':
      return commandSetName(ctx, command.args)
    case 'settitle':
      return commandSetTitle(ctx, command.args)
    case 'setavatar':
      return commandSetAvatar(ctx)
    case 'close':
      return commandClose(ctx)
    case 'del':
    case 'delete':
      return commandDelete(ctx)
    case 'ticket':
      return commandTicket(ctx, command.args)
    case 'info':
      return commandInfo(ctx)
    case 'deposits':
      return commandDeposits(ctx)
    case 'withdrawals':
    case 'wd':
      return commandWithdrawals(ctx)
    case 'partner':
      return commandPartner(ctx, command.args)
    case 'deleteuser':
      return commandDeleteUser(ctx)
    case 'mute':
      return commandMute(ctx, command.args)
    case 'unmute':
      return commandUnmute(ctx)
    default:
      return reply(ctx, `Неизвестная команда /${command.name}.\n\n${HELP_TEXT}`)
  }
}

async function commandMe(ctx: CommandContext): Promise<void> {
  const agent = await findAgentByTgId(ctx.fromId)
  if (!agent) {
    return reply(
      ctx,
      'Вы ещё не зарегистрированы как оператор. Ваши ответы уходят от общего имени поддержки.\nЗадайте имя: /setname <имя>'
    )
  }

  return reply(
    ctx,
    [
      'Ваша карточка оператора:',
      `Имя: ${agent.displayName}`,
      `Подпись: ${agent.title ?? '—'}`,
      `Аватар: ${agent.avatarPath ? 'есть' : 'нет'}`,
      `Статус: ${agent.isActive ? 'активен' : 'отключён'}`,
    ].join('\n')
  )
}

async function commandSetName(
  ctx: CommandContext,
  args: string
): Promise<void> {
  const displayName = sanitizeAgentText(args, AGENT_NAME_MAX_LENGTH)
  if (!displayName) {
    return reply(ctx, 'Укажите имя: /setname Иван')
  }

  await upsertAgent(ctx.fromId, { displayName })
  return reply(ctx, `Готово. Пользователи видят вас как «${displayName}».`)
}

async function commandSetTitle(
  ctx: CommandContext,
  args: string
): Promise<void> {
  const title = sanitizeAgentText(args, AGENT_TITLE_MAX_LENGTH)
  // Empty argument clears the subtitle — hence `null`, not `undefined`.
  await upsertAgent(ctx.fromId, { title: title || null })
  return reply(
    ctx,
    title ? `Подпись обновлена: «${title}».` : 'Подпись убрана.'
  )
}

async function commandSetAvatar(ctx: CommandContext): Promise<void> {
  // Either the command is the caption of a photo, or it answers one. The
  // largest PhotoSize is last in the array.
  const photo = (ctx.message.photo ?? ctx.message.reply_to_message?.photo)?.at(
    -1
  )
  if (!photo) {
    return reply(
      ctx,
      'Отправьте фото с подписью /setavatar или ответьте этой командой на фото.'
    )
  }

  const downloaded = await downloadFile(photo.file_id)
  if (!downloaded) {
    return reply(
      ctx,
      'Не удалось скачать фото из Telegram. Попробуйте ещё раз.'
    )
  }

  const fileName = await saveAgentAvatar(ctx.fromId, downloaded.buffer)
  await setAgentAvatar(ctx.fromId, fileName)
  return reply(ctx, 'Аватар обновлён.')
}

async function commandClose(ctx: CommandContext): Promise<void> {
  if (ctx.topicId == null) {
    return reply(ctx, 'Команду /close нужно отправлять внутри темы тикета.')
  }

  const ticket = await findTicketByTopic(ctx.chatId, ctx.topicId)
  if (!ticket) return reply(ctx, TOPIC_NAME_HINT)
  if (ticket.status === 'CLOSED') {
    return reply(ctx, 'Тикет уже закрыт.')
  }

  // Attribute the close to whoever typed it. Unregistered senders still close
  // the ticket — the command must never depend on analytics — they just leave
  // it unattributed.
  const agent = await findAgentByTgId(ctx.fromId)

  // No confirmation reply on success: the relay posts its own closing notice
  // into the topic and then archives it, so a second message here would either
  // duplicate that notice or fail against an already-archived topic.
  await closeTicketEverywhere(ticket.id, 'AGENT', agent?.id ?? null)
}

/**
 * Retract a message from both sides.
 *
 * WHY A COMMAND AND NOT A DELETE EVENT: the Bot API does not tell bots when a
 * message is deleted. There is no update type for it in a group — only business
 * accounts get `deleted_business_messages` — so a plain swipe-delete in the
 * topic is, to this service, indistinguishable from nothing happening. A reply
 * with `/del` is the one signal that actually arrives.
 *
 * Silent by design: the bubble disappears from the user's feed with no "message
 * deleted" placeholder, the message goes from the topic, and the command itself
 * is removed too — so the thread reads as if it was never sent.
 */
async function commandDelete(ctx: CommandContext): Promise<void> {
  if (ctx.topicId == null) {
    return reply(ctx, 'Команду /del нужно отправлять внутри темы тикета.')
  }

  const target = ctx.message.reply_to_message
  if (!target) {
    return reply(
      ctx,
      'Ответьте командой /del на сообщение, которое нужно удалить.'
    )
  }

  const ticket = await findTicketByTopic(ctx.chatId, ctx.topicId)
  if (!ticket) return reply(ctx, TOPIC_NAME_HINT)

  // Ownership check, and the reason this cannot delete the wrong thing: only
  // messages the relay itself put on the wire have a row. The info card, the
  // topic-creation service message and an operator's internal note all miss,
  // and Telegram makes the FIRST post in a topic look like a reply to that
  // service message — so without this an accidental `/del` would report
  // success on something the user never saw.
  const message = await findMessageByTelegramId(ticket, target.message_id)
  if (!message) {
    return reply(ctx, 'Это сообщение не из переписки с пользователем.')
  }

  await agentDeleteMessage(ticket, message.id)
  await deleteTopicMessage(ctx.chatId, target.message_id)
  await deleteTopicMessage(ctx.chatId, ctx.message.message_id)
}

async function commandTicket(ctx: CommandContext, args: string): Promise<void> {
  // Strict rather than `parseInt`, which would happily read "12" out of
  // "12abc" and open a ticket for the wrong person. `#1234` is accepted
  // because that is how the topics themselves are named.
  const token = args.trim().split(/\s+/)[0] ?? ''
  const nId = /^#?\d{1,9}$/.test(token) ? Number(token.replace('#', '')) : 0
  if (!nId) {
    return reply(ctx, 'Укажите номер пользователя: /ticket 1234')
  }

  const user = await findExchangeUserByNId(nId)
  if (!user) {
    return reply(ctx, `Пользователь #${nId} не найден.`)
  }

  const { ticket, created } = await openTicketForUser(user.id, nId)
  if (ticket.tgChatId == null || ticket.tgTopicId == null) {
    logger.warn(`[commands] /ticket ${nId}: ticket ${ticket.id} has no topic`)
    return reply(
      ctx,
      `Тикет для #${nId} открыт, но тему создать не удалось. Проверьте права бота в группе.`
    )
  }

  const link = topicUrl(ticket.tgChatId, ticket.tgTopicId)
  return reply(
    ctx,
    created
      ? `Тикет для #${nId} открыт: ${link}`
      : `У #${nId} уже есть открытый тикет: ${link}`
  )
}

// ─── On-demand user card and deposits ─────────────────────────────────────

/**
 * The user behind the topic the command was typed in.
 *
 * One resolve for both commands: the ticket is the only link between a topic
 * and a user, and the second way of deriving it (from the topic name) has
 * already proven fragile.
 */
async function userOfTopic(
  ctx: CommandContext,
  commandName: string
): Promise<{ ticket: SupportTicket; topicId: number } | null> {
  if (ctx.topicId == null) {
    await reply(
      ctx,
      `Команду /${commandName} нужно отправлять внутри темы тикета.`
    )
    return null
  }
  const ticket = await findTicketByTopic(ctx.chatId, ctx.topicId)
  if (!ticket) {
    await reply(ctx, TOPIC_NAME_HINT)
    return null
  }
  // The whole ticket, not just userId: callers also need `userNId`, and a
  // second lookup for the same row would mean a "what if we don't find it"
  // fallback path where finding it is mandatory. The topic is returned along
  // with it so the caller gets it ALREADY narrowed to number — otherwise
  // everyone would write `ctx.topicId!`, and that exclamation mark hides
  // exactly the case this function has just checked.
  return { ticket, topicId: ctx.topicId }
}

/**
 * Re-issue the user card — the same thing that is pinned as the first
 * message, but with current data.
 *
 * As a NEW message, not an edit of the pinned one: the operator asks for this
 * command in the middle of a conversation so that the fresh numbers land under
 * the latest replies. The pinned card stays where it is — its own flow updates
 * it.
 */
async function commandInfo(ctx: CommandContext): Promise<void> {
  const found = await userOfTopic(ctx, 'info')
  if (!found) return

  await sendTicketCard({
    chatId: ctx.chatId,
    topicId: found.topicId,
    ticket: found.ticket,
  })
}

/** The same fresh operator card for /info and Zhora's quick action. */
export async function sendTicketCard(args: {
  chatId: number
  topicId: number
  ticket: Pick<SupportTicket, 'id' | 'userId'>
}): Promise<void> {
  const card = await getUserCard(args.ticket.userId)
  // The real ticket id, not a synthetic string: the card prints it inside
  // <code>, i.e. it is copied by a tap, and a fake one would send the operator
  // looking for a ticket that does not exist.
  await sendToTopic({
    chatId: args.chatId,
    topicId: args.topicId,
    text: renderUserCard(card, args.ticket.id),
  })
}

/** Filter keyboard. The active one is marked with a check — otherwise after a
 *  redraw it is unclear which list is currently on screen. */
function depositsKeyboard(active: DepositFilter): InlineKeyboard {
  const keyboard = new InlineKeyboard()
  DEPOSIT_FILTERS.forEach((filter, index) => {
    const label = FILTER_LABELS[filter]
    keyboard.text(
      filter === active ? `✓ ${label}` : label,
      `${DEPOSITS_CALLBACK_PREFIX}${filter}`
    )
    // Three per row: five buttons on one line get squeezed by Telegram into
    // something unreadable.
    if (index % 3 === 2) keyboard.row()
  })
  return keyboard
}

/**
 * Date in UTC — same as in the admin panel and in the provider dashboards.
 * Operators sit in different time zones, and local time here would get in the
 * way of matching up rows.
 */
function dtShort(value: Date): string {
  if (Number.isNaN(value.getTime()) || value.getTime() === 0) return '—'
  return value.toISOString().replace('T', ' ').slice(0, 16)
}

/** Callback-data prefix. The filter itself is everything they carry: the user
 *  is re-resolved from the topic the button was pressed in, so there is no
 *  need to drag an id along (and no room — callback_data is only 64 bytes). */
export const DEPOSITS_CALLBACK_PREFIX = 'dep:'

/** Deposit-list text for the selected filter. */
export async function renderDeposits(
  userId: string,
  filter: DepositFilter
): Promise<string> {
  const rows = await listUserDeposits(userId, filter)
  const title = `<b>Депозиты — ${escapeHtml(FILTER_LABELS[filter])}</b>`
  // A read failure and "nothing there" are different answers. The operator
  // takes "nothing there" as a fact about the user and goes to the client
  // with it.
  if (rows === null) {
    return `${title}\n\n⚠️ Не удалось прочитать депозиты — попробуй ещё раз.`
  }
  if (!rows.length) {
    return `${title}\n\nНичего нет.`
  }

  const lines = rows.map((row) => {
    // <code> — Telegram copies such a span on a tap: the operator carries the
    // id over into the provider dashboard without retyping it off a phone
    // screen.
    const reference = row.providerOrderId
      ? `<code>${escapeHtml(row.providerOrderId)}</code>`
      : row.txHash
        ? `<code>${escapeHtml(row.txHash.slice(0, 20))}…</code>`
        : null
    const parts = [
      `<b>${escapeHtml(row.amount)} ${escapeHtml(row.currency)}</b>`,
      // Show dollars only when they differ from what was paid — for crypto it
      // is the same number, and the duplicate just takes up the line.
      row.currency !== 'USD' && row.usd !== '0.00' ? `≈ $${row.usd}` : null,
      escapeHtml(row.status),
      dtShort(row.createdAt),
      row.method ? escapeHtml(row.method) : null,
      reference,
      row.isFake ? '⚠️ фантик' : null,
    ].filter((part): part is string => part !== null)
    return `· ${parts.join(' · ')}`
  })

  // "25 of 25" says nothing about the list being truncated, so the cap is
  // named outright — otherwise the operator assumes they see the whole
  // history.
  const capped = rows.length >= DEPOSITS_LIMIT
  return [
    `${title} (${rows.length}${capped ? `, показаны последние ${DEPOSITS_LIMIT}` : ''})`,
    '',
    ...lines,
  ].join('\n')
}

async function commandDeposits(ctx: CommandContext): Promise<void> {
  const found = await userOfTopic(ctx, 'deposits')
  if (!found) return

  await sendToTopic({
    chatId: ctx.chatId,
    topicId: found.topicId,
    text: await renderDeposits(found.ticket.userId, 'all'),
    keyboard: depositsKeyboard('all'),
  })
}

/**
 * Every withdrawal of the user behind this topic.
 *
 * No filter keyboard, unlike deposits: a withdrawal has one rail (crypto out),
 * and the question an operator brings here is always the same one — where is
 * this payout and what is carrying it.
 */
async function commandWithdrawals(ctx: CommandContext): Promise<void> {
  const found = await userOfTopic(ctx, 'withdrawals')
  if (!found) return

  await sendToTopic({
    chatId: ctx.chatId,
    topicId: found.topicId,
    text: await renderWithdrawals(found.ticket.userId),
  })
}

/** Withdrawal-list text. Exported for the tests that pin the wording. */
export async function renderWithdrawals(userId: string): Promise<string> {
  const rows = await listUserWithdrawals(userId)
  const title = '<b>Выводы</b>'
  // A read failure and "nothing there" are different answers — the operator
  // takes "nothing there" as a fact about the user and goes to the client
  // with it.
  if (rows === null) {
    return `${title}\n\n⚠️ Не удалось прочитать выводы — попробуй ещё раз.`
  }
  if (!rows.length) {
    return `${title}\n\nНичего нет.`
  }

  const lines = rows.map((row) => {
    const parts = [
      `<b>$${escapeHtml(row.usd)}</b>`,
      escapeHtml(row.status),
      // The bridge is the reason this command exists. An unrouted row has no
      // bridge yet, and saying so beats an empty gap the operator has to
      // interpret.
      `мост: ${row.bridge ? escapeHtml(row.bridge) : '—'}`,
      // Only when it differs from the requested sum: on an internal transfer
      // the two are equal and the duplicate just eats the line.
      row.receiveUsd && row.receiveUsd !== row.usd
        ? `к получению $${escapeHtml(row.receiveUsd)}`
        : null,
      dtShort(row.createdAt),
      row.network ? escapeHtml(row.network) : null,
      // <code> — Telegram copies such a span on a tap, so the operator carries
      // the address over without retyping it off a phone screen.
      row.address ? `<code>${escapeHtml(row.address)}</code>` : null,
      row.txHash
        ? `<code>${escapeHtml(row.txHash.slice(0, 20))}…</code>`
        : null,
      row.isFake ? '⚠️ фантик' : null,
    ].filter((part): part is string => part !== null)
    return `· ${parts.join(' · ')}`
  })

  // "25 of 25" says nothing about the list being truncated, so the cap is
  // named outright.
  const capped = rows.length >= WITHDRAWALS_LIMIT
  return [
    `${title} (${rows.length}${capped ? `, показаны последние ${WITHDRAWALS_LIMIT}` : ''})`,
    '',
    ...lines,
  ].join('\n')
}

/**
 * Filter tap: redraw the same list in place.
 *
 * An edit of the message, not a new one: the operator clicks through filters
 * one after another, and a new message per click would bury the topic under
 * copies of the same list.
 */
export async function handleDepositsCallback(args: {
  chatId: number
  topicId: number | null
  messageId: number
  filter: string
}): Promise<void> {
  if (args.topicId == null) return
  if (!isDepositFilter(args.filter)) return

  const ticket = await findTicketByTopic(args.chatId, args.topicId)
  if (!ticket) return

  await editTopicMessage({
    chatId: args.chatId,
    messageId: args.messageId,
    text: await renderDeposits(ticket.userId, args.filter),
    keyboard: depositsKeyboard(args.filter),
  })
}

// ─── Support write ban ────────────────────────────────────────────────────

/**
 * Lift date in UTC — as everywhere in the bot: operators sit in different time
 * zones, and one of them seeing local time tells the others nothing.
 */
function untilText(until: Date): string {
  return `${until.toISOString().replace('T', ' ').slice(0, 16)} UTC`
}

/**
 * `/mute <duration> [reason]` — close support requests for the user.
 *
 * Nothing is sent to the user: they will see the restriction only when they
 * open the support window themselves. That is how the customer decided it, and
 * it also removes the question of "what do we write in the notification".
 */
async function commandMute(ctx: CommandContext, args: string): Promise<void> {
  const found = await userOfTopic(ctx, 'mute')
  if (!found) return
  const { ticket } = found

  const [rawDuration, ...rest] = args.trim().split(/\s+/)
  if (!rawDuration) {
    return reply(ctx, `Укажи срок. ${DURATION_HINT}`)
  }
  const parsed = parseDuration(rawDuration)
  if (!parsed) {
    // Show exactly what we failed to parse: "didn't understand the duration"
    // without an echo leaves the operator guessing whether they made a typo or
    // the format is different.
    return reply(ctx, `Не понял срок «${rawDuration}». ${DURATION_HINT}`)
  }

  const agent = await findAgentByTgId(ctx.fromId)
  const reason = rest.join(' ').trim() || null

  const until = await muteUser({
    userId: ticket.userId,
    userNId: ticket.userNId,
    ms: parsed.ms,
    reason,
    agentId: agent?.id ?? null,
  })

  await reply(
    ctx,
    `🔇 Обращения в поддержку закрыты на ${parsed.label} — до ${untilText(until)}.` +
      (reason ? `\nПричина: ${reason}` : '') +
      '\nПользователю ничего не отправлено: он увидит это, когда откроет чат.'
  )
}

/** `/unmute` — lift the ban early. */
async function commandUnmute(ctx: CommandContext): Promise<void> {
  const found = await userOfTopic(ctx, 'unmute')
  if (!found) return
  const { ticket } = found

  const agent = await findAgentByTgId(ctx.fromId)
  const lifted = await unmuteUser({
    userId: ticket.userId,
    agentId: agent?.id ?? null,
  })

  await reply(
    ctx,
    lifted
      ? '🔈 Запрет снят — пользователь снова может писать.'
      : 'Запрета не было: пользователь и так может писать.'
  )
}

// ─── Actions that CHANGE something ────────────────────────────────────────
//
// Both live behind an inline confirmation, and both re-run their checks at the
// moment the button is pressed. The button carries the TARGET explicitly —
// user number, partner id — rather than leaning on per-operator state: a stale
// button scrolled back to, or a second operator working in parallel, must not
// be able to redirect the action onto somebody else.
//
// The topic is what identifies the user when the command is TYPED; from there
// on the identity travels in the callback data, where it can be read back.

export const ACTION_CALLBACK_PREFIX = 'act:'

/**
 * Who the audit row is about.
 *
 * The registered operator, not just the raw Telegram id: an investigation
 * reads "Boroda удалил #4211", and a nine-digit number sends whoever is
 * reading it looking ids up by hand. The id stays the identity of record, so
 * an operator who never ran /setname is still attributable — they just have no
 * agent row to join against.
 */
async function auditActor(
  tgUserId: number
): Promise<{ tgUserId: number; tgName: string; agentId: string | null }> {
  try {
    const agent = await findAgentByTgId(tgUserId)
    return {
      tgUserId,
      tgName: agent?.displayName || String(tgUserId),
      agentId: agent?.id ?? null,
    }
  } catch {
    // The audit must never be what stops the action.
    return { tgUserId, tgName: String(tgUserId), agentId: null }
  }
}

/** Confirmation keyboard shared by both actions. */
function confirmKeyboard(
  confirmLabel: string,
  payload: string
): InlineKeyboard {
  return new InlineKeyboard()
    .text(confirmLabel, `${ACTION_CALLBACK_PREFIX}${payload}`)
    .text('❌ Отмена', `${ACTION_CALLBACK_PREFIX}cancel`)
}

/**
 * Bind a partner to the user behind this topic.
 *
 * Stricter than the admin panel by one rule, at the product's request: the bot
 * only ever binds a user who has NO partner yet. Re-attributing an existing
 * one is a commercial decision with money attached to it, and it stays in the
 * admin panel where it is visible.
 */
/**
 * Pull the referral code out of whatever the operator pasted.
 *
 * Support usually has the LINK, not a code: they copy it out of the ticket. So
 * a full URL is accepted and the code is taken from the query string — `aff`
 * is the user-facing parameter. A bare code is passed through untouched.
 *
 * Returns null when a URL carries no code we recognise, so the caller can say
 * that instead of searching for the whole URL as if it were a code.
 */
export function extractReferralCode(input: string): string | null {
  const value = input.trim()
  if (!value) return null
  if (!/^https?:\/\//i.test(value)) return value

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  // `aff` first — that is the user-facing referral parameter. `r` is the
  // PARTNER-recruiting link and must not be used to attribute a trader, so it
  // is deliberately absent from this list.
  for (const key of ['aff', 'a', 'ref', 'code']) {
    const found = url.searchParams.get(key)
    if (found?.trim()) return found.trim()
  }
  return null
}

/** General partner facts for the confirmation — deliberately no money. */
function partnerSummary(partner: PartnerInfo, source?: string): string {
  const parts = [
    `Партнёр <b>#${partner.id}</b>`,
    partner.nick ? escapeHtml(partner.nick) : null,
    escapeHtml(partner.email),
    partner.isBlocked ? '🚫 заблокирован' : null,
    source ? `найден по: ${escapeHtml(source)}` : null,
  ].filter((part): part is string => part !== null)
  return parts.join('\n')
}

async function commandPartner(
  ctx: CommandContext,
  args: string
): Promise<void> {
  const found = await userOfTopic(ctx, 'partner')
  if (!found) return

  const token = args.trim().split(/\s+/)[0] ?? ''
  if (!token) {
    return reply(
      ctx,
      'Укажите партнёра: /partner 1234 — по ID, либо /partner <код или ссылка> — по реферальной ссылке.'
    )
  }

  const user = await prismaExchange.user.findUnique({
    where: { id: found.ticket.userId },
    select: { nId: true, email: true, partnerId: true },
  })
  if (!user) return reply(ctx, 'Пользователь не найден.')
  if (user.partnerId != null) {
    return reply(
      ctx,
      `У пользователя #${user.nId} уже есть партнёр #${user.partnerId}. ` +
        'Переприязка — только через админку.'
    )
  }

  // A bare number is an id; anything else is a referral code or a link. The
  // two namespaces do not overlap — a partner id is not a code — so there is
  // nothing to disambiguate.
  let partner: PartnerInfo
  let source: string | undefined
  if (/^#?\d{1,9}$/.test(token)) {
    const byId = await findPartner(Number(token.replace('#', '')))
    if (byId === 'unavailable') {
      return reply(ctx, 'База партнёрки недоступна — привязка невозможна.')
    }
    if (!byId) return reply(ctx, `Партнёр ${escapeHtml(token)} не найден.`)
    partner = byId
  } else {
    const code = extractReferralCode(token)
    if (!code) {
      return reply(
        ctx,
        'В этой ссылке нет реферального кода. Пришлите код или ID партнёра.'
      )
    }
    const match = await findPartnerByCode(code)
    if (match === 'unavailable') {
      return reply(ctx, 'База партнёрки недоступна — привязка невозможна.')
    }
    if (match === 'ambiguous') {
      // Codes are not unique across company links; guessing here would
      // mis-attribute the trader to another partner's revenue.
      return reply(
        ctx,
        `Код <code>${escapeHtml(code)}</code> ведёт на несколько разных партнёров — ` +
          'привяжите по ID, чтобы не ошибиться.'
      )
    }
    if (!match) {
      return reply(ctx, `Код <code>${escapeHtml(code)}</code> не найден.`)
    }
    partner = match.partner
    source = match.source
  }

  const keyboard = confirmKeyboard(
    '✅ Привязать',
    `bind:${user.nId}:${partner.id}`
  )
  await sendToTopic({
    chatId: ctx.chatId,
    topicId: found.topicId,
    text:
      `Привязать пользователя #${user.nId} (${escapeHtml(user.email)})?\n\n` +
      partnerSummary(partner, source),
    keyboard: keyboard ?? undefined,
  })
}

/**
 * Delete the account behind this topic — same rules as the admin panel, plus
 * the deposit rule the product added: an account that has ever paid in is not
 * deletable from a chat.
 */
async function commandDeleteUser(ctx: CommandContext): Promise<void> {
  const found = await userOfTopic(ctx, 'deleteuser')
  if (!found) return

  const user = await prismaExchange.user.findUnique({
    where: { id: found.ticket.userId },
    select: { nId: true, email: true },
  })
  if (!user) return reply(ctx, 'Пользователь не найден.')

  const check = await checkDeletable(user.nId)
  if (!check.allowed) {
    await audit({
      ...(await auditActor(ctx.fromId)),
      ticketId: found.ticket.id,
      action: 'account_delete',
      params: { nId: user.nId, reason: check.reason },
      result: 'refused',
    })
    return reply(ctx, `❌ ${check.reason}`)
  }

  await sendToTopic({
    chatId: ctx.chatId,
    topicId: found.topicId,
    text:
      `Удалить аккаунт #${user.nId} (${escapeHtml(user.email)})?\n` +
      'Сделок и завершённых депозитов нет. Удаление мягкое, сессии закрываются.',
    keyboard: confirmKeyboard('🗑 Да, удалить', `del:${user.nId}`) ?? undefined,
  })
}

/**
 * A confirmation button was pressed.
 *
 * Every check runs AGAIN here: the first one ran when the button was drawn,
 * and between then and the tap the user may have deposited, traded, or been
 * given a partner by somebody else.
 */
export async function handleActionCallback(params: {
  chatId: number
  topicId: number | null
  fromId: number
  payload: string
}): Promise<void> {
  const actor = await auditActor(params.fromId)
  // The topic the button was pressed in IS the ticket — the same link the
  // command used when it drew the button.
  const ticket =
    params.topicId == null
      ? null
      : await findTicketByTopic(params.chatId, params.topicId)
  const ticketId = ticket?.id ?? null

  const say = async (text: string): Promise<void> => {
    await sendPlainMessage({
      chatId: params.chatId,
      topicId: params.topicId,
      text,
    })
  }

  if (params.payload === 'cancel') return say('Отменено.')

  const bind = /^bind:(\d{1,9}):(\d{1,9})$/.exec(params.payload)
  if (bind) {
    const nId = Number(bind[1])
    const partnerId = Number(bind[2])
    // The "no partner yet" rule, re-checked: two operators can be looking at
    // the same ticket, and the second tap must not overwrite the first bind.
    const user = await prismaExchange.user.findUnique({
      where: { nId },
      select: { partnerId: true },
    })
    if (!user) return say('Пользователь не найден.')
    if (user.partnerId != null) {
      await audit({
        ...actor,
        ticketId,
        action: 'partner_bind',
        params: { nId, partnerId, reason: 'already_bound' },
        result: 'refused',
      })
      return say(`❌ У #${nId} уже есть партнёр #${user.partnerId}.`)
    }
    const result = await bindPartner(nId, partnerId)
    await audit({
      ...actor,
      ticketId,
      action: 'partner_bind',
      params: {
        nId,
        partnerId,
        ...(result.ok ? {} : { reason: result.reason }),
      },
      result: result.ok ? 'ok' : 'refused',
    })
    return say(
      result.ok
        ? `✅ Пользователь #${nId} привязан к партнёру #${partnerId}.`
        : `❌ ${result.reason}`
    )
  }

  const del = /^del:(\d{1,9})$/.exec(params.payload)
  if (del) {
    const nId = Number(del[1])
    const check = await checkDeletable(nId)
    if (!check.allowed) {
      await audit({
        ...actor,
        ticketId,
        action: 'account_delete',
        params: { nId, reason: check.reason },
        result: 'refused',
      })
      return say(`❌ ${check.reason}`)
    }
    try {
      await deleteAccount(check.userId)
      await audit({
        ...actor,
        ticketId,
        action: 'account_delete',
        params: { nId },
        result: 'ok',
      })
      return say(`✅ Аккаунт #${nId} удалён (мягко, сессии закрыты).`)
    } catch (err) {
      // Unlike the old bot's partner path, a throw is audited too — an attempt
      // that blew up is exactly the one an investigation needs to see.
      await audit({
        ...actor,
        ticketId,
        action: 'account_delete',
        params: { nId, error: (err as Error).message },
        result: 'error',
      })
      return say(`❌ Ошибка удаления: ${(err as Error).message}`)
    }
  }
}
