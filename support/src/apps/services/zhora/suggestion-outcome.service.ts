import type { Prisma, SupportMessage } from '@prisma-support'
import { prismaSupport } from '@config/database'

const COPY_WINDOW_MS = 10 * 60_000
const SIMILARITY_THRESHOLD = 0.9

type Outcome = 'sent' | 'copied_sent' | 'edited' | 'ignored'

function normalized(text: string): string[] {
  return Array.from(text.toLocaleLowerCase().replace(/\s+/g, ' ').trim())
}

/** Character edit similarity; stop as soon as 90% becomes impossible. */
export function answerSimilarity(left: string, right: string): number {
  const a = normalized(left)
  const b = normalized(right)
  const longest = Math.max(a.length, b.length)
  if (!longest) return 1
  const limit = Math.floor(longest / 10)
  if (Math.abs(a.length - b.length) > limit) return 0
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let row = 1; row <= a.length; row++) {
    const current = new Array<number>(b.length + 1).fill(limit + 1)
    current[0] = row
    const start = Math.max(1, row - limit)
    const end = Math.min(b.length, row + limit)
    for (let column = start; column <= end; column++) {
      current[column] = Math.min(
        previous[column]! + 1,
        current[column - 1]! + 1,
        previous[column - 1]! + (a[row - 1] === b[column - 1] ? 0 : 1)
      )
    }
    previous = current
  }
  const distance = previous[b.length]!
  return distance <= limit ? 1 - distance / longest : 0
}

function savedAnswer(
  value: Prisma.JsonValue | null | undefined
): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return typeof value.answer === 'string' ? value.answer : null
}

const candidateSelect = {
  id: true,
  sourceSuggestionId: true,
  outcome: true,
  previewSentAt: true,
  sourceSuggestion: { select: { outcome: true } },
  job: { select: { result: true } },
} as const

type Candidate = Awaited<ReturnType<typeof findCandidates>>[number]

async function findCandidates(
  tx: Prisma.TransactionClient,
  ticketId: string,
  now: Date,
  replyToTgMessageId?: number
) {
  return tx.zhoraSuggestion.findMany({
    where: {
      targetMessage: { ticketId },
      // The ten-minute window applies only to similarity-based matching.
      // A reply identifies its preview directly, so it remains attributable later.
      previewSentAt:
        replyToTgMessageId === undefined
          ? { gte: new Date(now.getTime() - COPY_WINDOW_MS), lte: now }
          : { not: null, lte: now },
      job: { status: 'completed' },
      ...(replyToTgMessageId === undefined
        ? {}
        : { previewTgMessageId: replyToTgMessageId }),
    },
    select: candidateSelect,
    orderBy: { previewSentAt: 'desc' },
  })
}

/** Called in the same transaction as the customer-visible message append. */
export async function recordSuggestionOutcome(
  tx: Prisma.TransactionClient,
  message: SupportMessage,
  options: { suggestionId?: string; replyToTgMessageId?: number }
): Promise<void> {
  if (!message.text?.trim() || message.direction !== 'OUT' || message.autoKind)
    return

  let winner: Candidate | undefined
  let outcome: Outcome = 'sent'
  if (options.suggestionId) {
    winner =
      (await tx.zhoraSuggestion.findFirst({
        where: {
          id: options.suggestionId,
          targetMessage: { ticketId: message.ticketId },
          previewSentAt: { not: null },
          job: { status: 'completed' },
        },
        select: candidateSelect,
      })) ?? undefined
  } else {
    const replies =
      options.replyToTgMessageId === undefined
        ? []
        : await findCandidates(
            tx,
            message.ticketId,
            message.createdAt,
            options.replyToTgMessageId
          )
    if (replies.length) {
      winner = replies[0]
      const answer = savedAnswer(winner?.job.result)
      if (!answer) return
      outcome =
        answerSimilarity(message.text, answer) >= SIMILARITY_THRESHOLD
          ? 'copied_sent'
          : 'edited'
    } else {
      const candidates = await findCandidates(
        tx,
        message.ticketId,
        message.createdAt
      )
      let bestScore = SIMILARITY_THRESHOLD
      for (const candidate of candidates) {
        if (candidate.outcome || candidate.sourceSuggestion?.outcome) continue
        const answer = savedAnswer(candidate.job.result)
        if (!answer) continue
        const score = answerSimilarity(message.text, answer)
        if (score > bestScore || (score === bestScore && !winner)) {
          winner = candidate
          bestScore = score
        }
      }
      if (!winner) return
      outcome = 'copied_sent'
    }
  }
  if (!winner) return
  const rootId = winner.sourceSuggestionId ?? winner.id
  await tx.zhoraSuggestion.updateMany({
    where: { id: rootId, outcome: null },
    data: {
      outcome,
      sentMessageId: message.id,
      usedVariantId: winner.sourceSuggestionId ? winner.id : null,
      finalText: outcome === 'edited' ? message.text : null,
    },
  })
}

/** A later Telegram edit changes the recorded final customer text. */
export async function updateSuggestionOutcomeAfterEdit(
  message: SupportMessage
) {
  const suggestion = await prismaSupport.zhoraSuggestion.findFirst({
    where: { sentMessageId: message.id },
    select: {
      id: true,
      outcome: true,
      usedVariantId: true,
      job: { select: { result: true } },
    },
  })
  if (!suggestion || suggestion.outcome === 'sent') return
  const used = suggestion.usedVariantId
    ? await prismaSupport.zhoraSuggestion.findUnique({
        where: { id: suggestion.usedVariantId },
        select: { job: { select: { result: true } } },
      })
    : suggestion
  const answer = savedAnswer(used?.job.result ?? null)
  if (!answer || !message.text?.trim()) return
  const outcome =
    answerSimilarity(message.text, answer) >= SIMILARITY_THRESHOLD
      ? 'copied_sent'
      : 'edited'
  await prismaSupport.zhoraSuggestion.update({
    where: { id: suggestion.id },
    data: {
      outcome,
      finalText: outcome === 'edited' ? message.text : null,
    },
  })
}

/** Closed tickets make unused previews final; translations share their root. */
export async function finalizeIgnoredSuggestions(
  ticketId?: string
): Promise<void> {
  let cursor: string | undefined
  let finalized = 0
  while (ticketId || finalized < 50) {
    const pending = await prismaSupport.zhoraSuggestion.findMany({
      where: {
        sourceSuggestionId: null,
        previewSentAt: { not: null },
        previewTgMessageId: { not: null },
        outcome: null,
        job: { status: 'completed' },
        targetMessage: {
          ...(ticketId ? { ticketId } : {}),
          ticket: { status: 'CLOSED' },
        },
      },
      select: { id: true, job: { select: { result: true } } },
      orderBy: { id: 'asc' },
      take: 50,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })
    if (!pending.length) return
    for (const item of pending) {
      if (!savedAnswer(item.job.result)?.trim()) continue
      const updated = await prismaSupport.zhoraSuggestion.updateMany({
        where: { id: item.id, outcome: null },
        data: { outcome: 'ignored' },
      })
      finalized += updated.count
    }
    cursor = pending.at(-1)!.id
  }
}
