import { prismaSupport } from '@config/database'
import { TELEGRAM_CHAT_ID, ZHORA_ENABLED } from '@config/env'
import { logger } from '@config/logger'
import { ApiError } from '@core/errors/api-error'
import { findAgentByTgId } from '@apps/services/agent.service'
import { findTicketByTopic } from '@apps/services/ticket.service'
import { assertZhoraTicketAvailable } from '@apps/services/zhora/access.service'
import { sendPlainMessage } from './api'

export interface ZhoraInvocationInput {
  chatId: number
  /** The router must derive this from is_topic_message, not thread ID alone. */
  topicId: number | null
  /** Sender of a command or the person pressing a callback, not its author. */
  fromId: number
  isBot?: boolean
  /** Stored ticket binding for a future callback; never rebind it to a new ticket. */
  ticketId?: string
  /** Telegram ID of the customer message a reply/button refers to. */
  tgMessageId?: number
  /** Database ID embedded in a bot-authored button callback. */
  messageId?: string
}

/** Validate a button on an original or reworded draft before requesting work. */
export async function prepareZhoraDraftAction(
  input: ZhoraInvocationInput & {
    suggestionId: string
    previewMessageId?: number
  }
) {
  const suggestion = await prismaSupport.zhoraSuggestion.findUnique({
    where: { id: input.suggestionId },
    select: {
      id: true,
      sourceSuggestionId: true,
      previewSentAt: true,
      previewTgMessageId: true,
      targetMessageId: true,
      targetMessage: { select: { ticketId: true } },
      job: { select: { status: true } },
    },
  })
  if (
    !suggestion ||
    suggestion.sourceSuggestionId ||
    !suggestion.previewSentAt ||
    suggestion.job.status !== 'completed' ||
    (input.previewMessageId !== undefined &&
      suggestion.previewTgMessageId !== input.previewMessageId)
  )
    throw new ApiError('Черновик недоступен.', 409)
  const prepared = await prepareZhoraInvocation({
    ...input,
    ticketId: suggestion.targetMessage.ticketId,
    messageId: suggestion.targetMessageId,
  })
  return prepared ? { suggestion, prepared } : null
}

/** Common command/callback preflight. Only reads local state and can reply to
 * the operator. No ticket creation, paid calls or customer message delivery. */
export async function prepareZhoraInvocation(input: ZhoraInvocationInput) {
  if (
    !TELEGRAM_CHAT_ID ||
    input.chatId !== TELEGRAM_CHAT_ID ||
    input.isBot ||
    !Number.isSafeInteger(input.fromId) ||
    input.fromId <= 0
  )
    return null

  try {
    if (
      input.topicId === null ||
      !Number.isSafeInteger(input.topicId) ||
      input.topicId <= 1
    ) {
      throw new ApiError(
        'Команду Жоры нужно отправлять внутри темы тикета.',
        400
      )
    }
    if (!ZHORA_ENABLED) throw new ApiError('Жора выключен.', 409)

    const ticket = await findTicketByTopic(input.chatId, input.topicId)
    if (!ticket) throw new ApiError('Для этой темы не найден тикет.', 404)
    if (input.ticketId !== undefined && input.ticketId !== ticket.id) {
      throw new ApiError(
        'Это действие относится к другому тикету. Вызовите Жору заново.',
        409
      )
    }
    await assertZhoraTicketAvailable(ticket)

    let messageId: string | undefined
    if (input.tgMessageId !== undefined || input.messageId !== undefined) {
      const message = await prismaSupport.supportMessage.findFirst({
        where: {
          ticketId: ticket.id,
          ...(input.messageId !== undefined
            ? { id: input.messageId }
            : { tgMessageId: input.tgMessageId }),
          direction: 'IN',
          deletedAt: null,
          autoKind: null,
        },
        select: { id: true },
      })
      if (!message) {
        throw new ApiError(
          'Выберите сообщение клиента из текущего тикета.',
          404
        )
      }
      messageId = message.id
    }
    // Match the existing group access model: all operators are equal and a
    // missing SupportAgent profile uses the ordinary unattributed fallback.
    const agent = await findAgentByTgId(input.fromId)
    return { ticket, agentId: agent?.id ?? null, messageId }
  } catch (error) {
    let text = 'Не удалось проверить доступность Жоры. Попробуйте позже.'
    if (error instanceof ApiError) {
      text =
        error.code === 'TICKET_CLOSED'
          ? 'Тикет закрыт. Жора недоступен.'
          : error.code === 'SUPPORT_MUTED'
            ? 'У пользователя действует запрет на обращения. Жора недоступен.'
            : error.message
    } else {
      // Database errors may contain customer data; log no raw error/arguments.
      logger.warn('[zhora] Telegram invocation check failed')
    }
    await sendPlainMessage({
      chatId: input.chatId,
      topicId: input.topicId && input.topicId > 1 ? input.topicId : null,
      text,
    })
    return null
  }
}
