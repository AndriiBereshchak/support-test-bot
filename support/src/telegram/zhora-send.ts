import { prismaSupport } from '@config/database'
import { logger } from '@config/logger'
import { agentSendMessage } from '@apps/services/chat.service'
import { sendPlainMessage } from './api'
import { prepareZhoraInvocation, type ZhoraInvocationInput } from './zhora'

/** Only the operator's explicit callback may deliver a saved draft. */
export async function handleZhoraSendCallback(
  input: ZhoraInvocationInput & {
    suggestionId: string
    previewMessageId: number
  }
): Promise<void> {
  const note = (text: string) =>
    sendPlainMessage({
      chatId: input.chatId,
      topicId: input.topicId,
      text,
    })
  try {
    const suggestion = await prismaSupport.zhoraSuggestion.findUnique({
      where: { id: input.suggestionId },
      include: {
        job: { select: { status: true, result: true } },
        targetMessage: { select: { ticketId: true } },
      },
    })
    if (
      !suggestion?.previewSentAt ||
      suggestion.previewTgMessageId !== input.previewMessageId ||
      suggestion.job.status !== 'completed'
    ) {
      await note('Черновик недоступен для отправки. Вызовите Жору заново.')
      return
    }
    const prepared = await prepareZhoraInvocation({
      ...input,
      ticketId: suggestion.targetMessage.ticketId,
      messageId: suggestion.targetMessageId,
    })
    if (!prepared) return

    const result = suggestion.job.result
    const answer =
      result && typeof result === 'object' && !Array.isArray(result)
        ? result.answer
        : null
    if (typeof answer !== 'string' || !answer.trim()) {
      await note('Черновик недоступен для отправки. Вызовите Жору заново.')
      return
    }
    // The unique message key arbitrates concurrent taps, including taps by
    // different operators. The winning append determines the actual author.
    // Only the saved answer goes to the client, never the Telegram preview.
    const sent = await agentSendMessage({
      ticket: prepared.ticket,
      agentId: prepared.agentId,
      text: answer,
      tgMessageId: suggestion.previewTgMessageId,
      dedupeKey: `zhora:send:${suggestion.id}`,
    })
    await note(
      sent === 'closed'
        ? 'Тикет закрыт. Ответ не отправлен.'
        : sent === null
          ? 'Этот черновик уже отправлен.'
          : 'Ответ отправлен клиенту.'
    )
  } catch {
    logger.warn('[zhora] operator draft send failed')
    await note(
      'Не удалось подтвердить отправку. Проверьте переписку и повторите нажатие: дубль не будет создан.'
    )
  }
}
