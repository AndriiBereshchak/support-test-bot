import { prismaSupport } from '@config/database'
import { sendPlainMessage } from './api'

/** A vote belongs to the logical draft; translations share the root vote. */
export async function rateZhoraSuggestion(input: {
  chatId: number
  topicId: number
  fromId: number
  suggestionId: string
  previewMessageId: number
  rating: 1 | -1
}): Promise<void> {
  const suggestion = await prismaSupport.zhoraSuggestion.findUnique({
    where: { id: input.suggestionId },
    select: {
      id: true,
      sourceSuggestionId: true,
      previewSentAt: true,
      previewTgMessageId: true,
      job: { select: { status: true } },
      targetMessage: {
        select: { ticket: { select: { tgChatId: true, tgTopicId: true } } },
      },
    },
  })
  if (
    !suggestion?.previewSentAt ||
    suggestion.previewTgMessageId !== input.previewMessageId ||
    suggestion.job.status !== 'completed' ||
    Number(suggestion.targetMessage.ticket.tgChatId) !== input.chatId ||
    suggestion.targetMessage.ticket.tgTopicId !== input.topicId
  )
    return

  await prismaSupport.zhoraSuggestion.update({
    where: { id: suggestion.sourceSuggestionId ?? suggestion.id },
    data: {
      rating: input.rating,
      ratedAt: new Date(),
      ratedByTgUserId: BigInt(input.fromId),
    },
  })
  await sendPlainMessage({
    chatId: input.chatId,
    topicId: input.topicId,
    text: 'Оценка Жоры сохранена.',
  })
}
