import { logger } from '@config/logger'
import { ApiError } from '@core/errors/api-error'
import {
  requestZhoraSuggestionVariant,
  ZHORA_TRANSLATION_LANGUAGES,
  type ZhoraTranslationLanguage,
} from '@apps/services/zhora/suggestion-variant.service'
import {
  sendPlainMessage,
  ZHORA_TRANSLATE_LANGUAGE_CALLBACK_PREFIX,
} from './api'
import { prepareZhoraDraftAction, type ZhoraInvocationInput } from './zhora'

type Input = ZhoraInvocationInput & {
  suggestionId: string
  previewMessageId?: number
}

async function note(
  input: Input,
  text: string,
  replyMarkup?: {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>
  }
) {
  await sendPlainMessage({
    chatId: input.chatId,
    topicId: input.topicId,
    text,
    ...(replyMarkup ? { replyMarkup } : {}),
  })
}

/** The menu is operator-only and does not start an AI call. */
export async function handleZhoraTranslationMenu(input: Input): Promise<void> {
  try {
    if (!(await prepareZhoraDraftAction(input))) return
    const rows = []
    for (let i = 0; i < ZHORA_TRANSLATION_LANGUAGES.length; i += 4) {
      rows.push(
        ZHORA_TRANSLATION_LANGUAGES.slice(i, i + 4).map((language) => ({
          text: language,
          callback_data: `${ZHORA_TRANSLATE_LANGUAGE_CALLBACK_PREFIX}${input.suggestionId}:${language}`,
        }))
      )
    }
    await note(input, 'Выберите язык перевода:', { inline_keyboard: rows })
  } catch (error) {
    logger.warn('[zhora] translation menu failed')
    await note(
      input,
      error instanceof ApiError
        ? error.message
        : 'Не удалось открыть выбор языка.'
    )
  }
}

/** A saved variant gives Send/Copy an unambiguous text and language. */
export async function handleZhoraTranslationSelection(
  input: Input & { language: ZhoraTranslationLanguage }
): Promise<void> {
  try {
    const current = await prepareZhoraDraftAction(input)
    if (!current) return
    const { suggestion, created } = await requestZhoraSuggestionVariant({
      sourceSuggestionId: current.suggestion.id,
      language: input.language,
      agentId: current.prepared.agentId,
    })
    await note(
      input,
      suggestion.id === current.suggestion.id
        ? 'Черновик уже на выбранном языке.'
        : created
          ? 'Перевод готовится. Он появится в этой теме.'
          : 'Перевод для этого языка уже запрошен. Проверьте тему.'
    )
  } catch (error) {
    logger.warn('[zhora] translation request failed')
    await note(
      input,
      error instanceof ApiError
        ? error.message
        : 'Не удалось запросить перевод.'
    )
  }
}
