import { prismaSupport } from '@config/database'
import { logger } from '@config/logger'
import { findTicketByTopic } from '@apps/services/ticket.service'
import { sendPlainMessage } from './api'
import { sendTicketCard } from './commands'

/** Show the current ticket's card using the existing /info action. */
export async function handleZhoraCardCallback(input: {
  chatId: number
  topicId: number
  suggestionId: string
  previewMessageId: number
}): Promise<void> {
  const note = (text: string) =>
    sendPlainMessage({ chatId: input.chatId, topicId: input.topicId, text })
  try {
    const suggestion = await prismaSupport.zhoraSuggestion.findUnique({
      where: { id: input.suggestionId },
      select: {
        previewSentAt: true,
        previewTgMessageId: true,
        job: { select: { status: true } },
        targetMessage: { select: { ticketId: true } },
      },
    })
    if (
      !suggestion?.previewSentAt ||
      suggestion.previewTgMessageId !== input.previewMessageId ||
      suggestion.job.status !== 'completed'
    ) {
      await note('Черновик недоступен. Вызовите Жору заново.')
      return
    }
    const ticket = await findTicketByTopic(input.chatId, input.topicId)
    if (!ticket || ticket.id !== suggestion.targetMessage.ticketId) {
      await note('Этот черновик относится к другому тикету.')
      return
    }
    await sendTicketCard({
      chatId: input.chatId,
      topicId: input.topicId,
      ticket,
    })
  } catch {
    logger.warn('[zhora] operator card quick action failed')
    await note('Не удалось получить карточку. Попробуйте /info.')
  }
}
