import { prismaSupport } from '@config/database'
import { logger } from '@config/logger'
import {
  sendMonospaceMessage,
  sendPlainMessage,
  ZHORA_ALTERNATIVE_CALLBACK_PREFIX,
  ZHORA_SEND_CALLBACK_PREFIX,
  ZHORA_TRANSLATE_CALLBACK_PREFIX,
} from '@telegram/api'
import { splitText, TELEGRAM_TEXT_LIMIT } from '@telegram/text'

const SEND_LEASE_MS = 60_000
const BATCH_SIZE = 10
const COPY_TEXT_LIMIT = 256

/** Partition the copyable answer without dropping separators or splitting emoji. */
function exactCopyChunks(answer: string): string[] {
  const chunks: string[] = []
  for (let start = 0; start < answer.length; ) {
    let end = Math.min(start + TELEGRAM_TEXT_LIMIT, answer.length)
    if (end < answer.length) {
      const next = answer.charCodeAt(end)
      if (next >= 0xdc00 && next <= 0xdfff) end -= 1
    }
    chunks.push(answer.slice(start, end))
    start = end
  }
  return chunks
}

function previewText(
  result: unknown,
  options: { language?: string; alternative?: boolean } = {}
): string {
  if (!result || typeof result !== 'object')
    throw new Error('invalid_suggestion_result')
  const value = result as Record<string, unknown>
  if (
    typeof value.answer !== 'string' ||
    !value.answer.trim() ||
    typeof value.answerRu !== 'string' ||
    typeof value.needsReview !== 'boolean' ||
    !Array.isArray(value.sources)
  )
    throw new Error('invalid_suggestion_result')

  const singleLine = (text: string) => text.replace(/\s+/g, ' ').trim()
  const sources = value.sources.map((item) => {
    if (!item || typeof item !== 'object')
      throw new Error('invalid_suggestion_source')
    const source = item as Record<string, unknown>
    if (typeof source.question !== 'string')
      throw new Error('invalid_suggestion_source')
    const code =
      typeof source.code === 'string' ? `${singleLine(source.code)} ` : ''
    const question = singleLine(source.question)
    return `KB ${code}«${question}»`
  })
  return [
    options.language
      ? `Жора — перевод (${options.language})`
      : options.alternative
        ? 'Жора — ещё вариант ответа'
        : 'Жора — черновик ответа',
    value.answer,
    `RU: ${value.answerRu}`,
    sources.length
      ? `Источник: ${sources.join('; ')}`
      : 'Источник: ⚠ в базе нет ответа',
    ...(value.needsReview ? ['⚠ не уверен, проверь'] : []),
  ].join('\n\n')
}

/** Send a completed draft only into its operator topic, never to the client. */
export async function runZhoraSuggestionPreviewPass(): Promise<void> {
  const now = new Date()
  const pending = await prismaSupport.zhoraSuggestion.findMany({
    where: {
      previewSentAt: null,
      OR: [{ previewSendingUntil: null }, { previewSendingUntil: { lt: now } }],
      job: { status: { in: ['completed', 'failed', 'uncertain'] } },
      targetMessage: {
        ticket: { tgChatId: { not: null }, tgTopicId: { not: null } },
      },
    },
    include: {
      job: { select: { status: true, result: true, input: true } },
      targetMessage: {
        select: {
          tgMessageId: true,
          ticket: { select: { tgChatId: true, tgTopicId: true } },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
    take: BATCH_SIZE,
  })

  for (const row of pending) {
    const claimed = await prismaSupport.zhoraSuggestion.updateMany({
      where: {
        id: row.id,
        previewSentAt: null,
        OR: [
          { previewSendingUntil: null },
          { previewSendingUntil: { lt: now } },
        ],
      },
      data: {
        previewSendingUntil: new Date(Date.now() + SEND_LEASE_MS),
      },
    })
    if (!claimed.count) continue

    let body = 'Не удалось подготовить черновик Жоры. Попробуйте ещё раз.'
    let answer: string | null = null
    if (row.job.status === 'completed') {
      try {
        body = previewText(row.job.result, {
          ...(row.sourceSuggestionId ? { language: row.language } : {}),
          alternative:
            row.job.input !== null &&
            typeof row.job.input === 'object' &&
            !Array.isArray(row.job.input) &&
            row.job.input.kind === 'suggestion-alternative',
        })
        answer = (row.job.result as { answer: string }).answer
      } catch {
        logger.warn('[zhora] completed suggestion has invalid result')
      }
    }
    const previewChunks = splitText(body)
    const copyChunks =
      answer && answer.length > COPY_TEXT_LIMIT ? exactCopyChunks(answer) : []
    const totalChunks = previewChunks.length + copyChunks.length
    for (let index = row.nextChunkIndex; index < totalChunks; index++) {
      let sentId: number | null = null
      try {
        // Persist each Telegram message before sending the next. A failed copy
        // block resumes without repeating the already delivered preview.
        const copyChunk = copyChunks[index - previewChunks.length]
        const complete = index === totalChunks - 1
        const replyMarkup =
          answer && complete
            ? {
                inline_keyboard: [
                  [
                    {
                      text: 'Отправить',
                      callback_data: `${ZHORA_SEND_CALLBACK_PREFIX}${row.id}`,
                    },
                    ...(copyChunks.length
                      ? []
                      : [{ text: 'Скопировать', copy_text: { text: answer } }]),
                  ],
                  ...(row.sourceSuggestionId
                    ? []
                    : [
                        [
                          {
                            text: 'Перевести',
                            callback_data: `${ZHORA_TRANSLATE_CALLBACK_PREFIX}${row.id}`,
                          },
                          {
                            text: 'Ещё вариант',
                            callback_data: `${ZHORA_ALTERNATIVE_CALLBACK_PREFIX}${row.id}`,
                          },
                        ],
                      ]),
                ],
              }
            : undefined
        const args = {
          chatId: Number(row.targetMessage.ticket.tgChatId!),
          topicId: row.targetMessage.ticket.tgTopicId!,
          replyToMessageId: row.targetMessage.tgMessageId ?? undefined,
          ...(replyMarkup ? { replyMarkup } : {}),
        }
        sentId =
          copyChunk === undefined
            ? await sendPlainMessage({ ...args, text: previewChunks[index]! })
            : await sendMonospaceMessage({ ...args, text: copyChunk })
      } catch {
        logger.warn('[zhora] suggestion preview delivery failed')
      }
      if (!sentId) break
      const complete = index === totalChunks - 1
      await prismaSupport.zhoraSuggestion.update({
        where: { id: row.id },
        data: {
          nextChunkIndex: index + 1,
          previewTgMessageId: sentId,
          previewSentAt: complete ? new Date() : null,
          previewSendingUntil: complete
            ? null
            : new Date(Date.now() + SEND_LEASE_MS),
        },
      })
    }
  }
}
