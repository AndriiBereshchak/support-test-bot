import { logger } from '@config/logger'
import { ApiError } from '@core/errors/api-error'
import { requestZhoraSuggestionAlternative } from '@apps/services/zhora/suggestion-alternative.service'
import { sendPlainMessage } from './api'
import { prepareZhoraDraftAction, type ZhoraInvocationInput } from './zhora'

/** A new callback is a new request; redelivery of the same callback is not. */
export async function handleZhoraAlternativeCallback(
  input: ZhoraInvocationInput & {
    suggestionId: string
    previewMessageId: number
    callbackId: string
  }
): Promise<void> {
  const note = (text: string) =>
    sendPlainMessage({
      chatId: input.chatId,
      topicId: input.topicId,
      text,
    })
  try {
    const current = await prepareZhoraDraftAction(input)
    if (!current) return
    const { created } = await requestZhoraSuggestionAlternative({
      eventKey: `suggestion-alternative:${input.callbackId}`,
      sourceSuggestionId: current.suggestion.id,
      agentId: current.prepared.agentId,
    })
    await note(
      created
        ? 'Готовлю ещё вариант ответа. Он появится в этой теме.'
        : 'Этот запрос уже принят. Проверьте тему.'
    )
  } catch (error) {
    logger.warn('[zhora] alternative request failed')
    await note(
      error instanceof ApiError
        ? error.message
        : 'Не удалось запросить ещё вариант ответа.'
    )
  }
}
