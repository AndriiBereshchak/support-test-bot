import { Prisma, type ZhoraJob } from '@prisma-support'
import { prismaSupport } from '@config/database'
import { ApiError } from '@core/errors/api-error'
import { assertZhoraTicketAvailable } from './access.service'
import { buildZhoraContext } from './context.service'
import { generateZhoraTextWithJournal } from './llm.service'
import { getZhoraModel } from './openrouter'
import { buildZhoraReplyPrompt, parseZhoraReply } from './prompt.service'

export async function requestZhoraSuggestion(args: {
  eventKey: string
  ticketId: string
  messageId?: string
  agentId?: string | null
}) {
  if (!args.eventKey || args.eventKey.length > 160)
    throw new ApiError('Invalid Zhora event', 400)

  // Reading before any context/embedding call also avoids paying twice for a
  // redelivered command or callback. The unique job key handles racing copies.
  const existing = await prismaSupport.zhoraJob.findUnique({
    where: { eventKey: args.eventKey },
    include: { suggestion: true },
  })
  if (existing?.suggestion)
    return { suggestion: existing.suggestion, created: false }

  const ticket = await prismaSupport.supportTicket.findUnique({
    where: { id: args.ticketId },
  })
  if (!ticket) throw new ApiError('Ticket not found', 404)
  await assertZhoraTicketAvailable(ticket)

  const target = await prismaSupport.supportMessage.findFirst({
    where: {
      ticketId: ticket.id,
      direction: 'IN',
      deletedAt: null,
      autoKind: null,
      ...(args.messageId ? { id: args.messageId } : {}),
    },
    orderBy: { seq: 'desc' },
    select: {
      id: true,
      seq: true,
      text: true,
      translation: { select: { detectedLang: true, errorCode: true } },
    },
  })
  if (!target) throw new ApiError('В этом тикете нет сообщения клиента.', 404)

  // A newer language-bearing message may still be in the translation queue.
  // Never answer it using the language detected for an earlier message.
  if (target.seq > ticket.detectedLangSeq && /\p{L}/u.test(target.text ?? '')) {
    const pending =
      target.translation !== null &&
      target.translation.detectedLang === null &&
      target.translation.errorCode === null
    throw new ApiError(
      pending
        ? 'Язык сообщения ещё определяется. Повторите запрос чуть позже.'
        : 'Не удалось определить язык этого сообщения.',
      409,
      'ZHORA_LANGUAGE_UNAVAILABLE'
    )
  }
  const language = ticket.detectedLang
  if (!language || language === 'und') {
    throw new ApiError('Язык клиента пока не определён.', 409)
  }

  getZhoraModel({
    operation: 'reply',
    systemPrompt: 'pending',
    input: 'pending',
  })

  try {
    const job = await prismaSupport.zhoraJob.create({
      data: {
        eventKey: args.eventKey,
        operation: 'reply',
        input: { kind: 'suggestion' },
        ticketId: ticket.id,
        agentId: args.agentId ?? null,
        suggestion: {
          create: { targetMessageId: target.id, language },
        },
      },
      include: { suggestion: true },
    })
    return { suggestion: job.suggestion!, created: true }
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      const repeated = await prismaSupport.zhoraJob.findUnique({
        where: { eventKey: args.eventKey },
        include: { suggestion: true },
      })
      if (repeated?.suggestion)
        return { suggestion: repeated.suggestion, created: false }
    }
    throw new Error('[zhora] suggestion_enqueue_failed')
  }
}

/** The existing leased worker owns both the KB embedding and reply call. */
export async function generateZhoraSuggestion(job: ZhoraJob) {
  const suggestion = await prismaSupport.zhoraSuggestion.findUnique({
    where: { jobId: job.id },
    include: { targetMessage: { include: { ticket: true } } },
  })
  if (!suggestion || suggestion.targetMessage.ticketId !== job.ticketId)
    throw new ApiError('Zhora suggestion target not found', 404)

  const ticket = suggestion.targetMessage.ticket
  const context = await buildZhoraContext({
    ticketId: ticket.id,
    userId: ticket.userId,
    product: ticket.product,
    messageId: suggestion.targetMessageId,
    agentId: job.agentId,
    // No calibrated similarity threshold yet. Review source quality with the
    // real KB before introducing a cutoff that could discard useful records.
    minScore: -1,
  })
  const input = buildZhoraReplyPrompt(context, suggestion.language)
  const result = await generateZhoraTextWithJournal(input, {
    ticketId: ticket.id,
    agentId: job.agentId,
    jobId: job.id,
  })
  const reply = parseZhoraReply(result.text, context)
  return {
    ...reply,
    // The model cites UUIDs; snapshot human-readable source labels from the
    // exact KB context it saw. Later KB edits cannot change this preview.
    sources: reply.sourceKbIds.map((id) => {
      const entry = context.knowledge?.find((item) => item.id === id)!
      return { code: entry.code, question: entry.question }
    }),
  }
}
