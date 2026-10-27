import { Prisma } from '@prisma-support'
import type {
  SupportProduct,
  SupportTicket,
  SupportTicketClosedBy,
  SupportUserThread,
} from '@prisma-support'

import { prismaSupport } from '@config/database'
import { logger } from '@config/logger'

import { getMuteState } from './mute.service'

import type {
  SupportMessageDto,
  SupportPendingFeedback,
  SupportThreadResponse,
} from '@core/contracts'
import { AUTO_FAREWELL, AUTO_TEXT_FALLBACK } from '@core/contracts'

import { appendMessage } from './message.service'
import { finalizeIgnoredSuggestions } from './zhora/suggestion-outcome.service'
import { toMessageDto, toTicketDto } from './mappers'

const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200

export interface EnsureTicketInput {
  userId: string
  userNId: number
  product?: SupportProduct
  /** Mirror domain the exchange proxy resolved for this request, if any. */
  originDomain?: string | null
}

export interface EnsureTicketResult {
  ticket: SupportTicket
  /** True only for the caller that actually created the row. */
  created: boolean
}

/**
 * Get the user's OPEN ticket, creating one if there is none.
 *
 * Correctness rests on the partial unique index
 * (`support_tickets_one_open_per_user`), not on this read-then-write: two
 * concurrent first messages both see "no open ticket", both INSERT, and the
 * database rejects the loser — which then re-reads the winner's row. Without
 * that index the user's thread would fork into two Telegram topics.
 */
export async function ensureOpenTicket(
  input: EnsureTicketInput
): Promise<EnsureTicketResult> {
  const { userId, userNId, product = 'PLATFORM', originDomain } = input

  const existing = await prismaSupport.supportTicket.findFirst({
    where: { userId, product, status: 'OPEN' },
  })
  if (existing) return { ticket: existing, created: false }

  try {
    const ticket = await prismaSupport.supportTicket.create({
      // The origin is written ONCE, here, and never updated afterwards. A user
      // who opens the same ticket on a second mirror mid-conversation would
      // otherwise rewrite it under the operator, who has already answered
      // questions ("go to …") based on the domain the card showed. First
      // write wins; the whole ticket keeps the origin it was opened from.
      data: {
        userId,
        userNId,
        product,
        status: 'OPEN',
        originDomain: originDomain ?? null,
      },
    })
    return { ticket, created: true }
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      const winner = await prismaSupport.supportTicket.findFirst({
        where: { userId, product, status: 'OPEN' },
      })
      if (winner) return { ticket: winner, created: false }
    }
    throw err
  }
}

/** Bind a ticket to its Telegram forum topic. */
export async function bindTicketTopic(
  ticketId: string,
  tgChatId: number,
  tgTopicId: number,
  tgInfoMessageId?: number
): Promise<SupportTicket> {
  return prismaSupport.supportTicket.update({
    where: { id: ticketId },
    data: {
      tgChatId: BigInt(tgChatId),
      tgTopicId,
      ...(tgInfoMessageId != null ? { tgInfoMessageId } : {}),
    },
  })
}

/**
 * Resolve the ticket a Telegram topic belongs to.
 *
 * A topic now holds every ticket of one user, so "the ticket" is a choice, not
 * a lookup: the OPEN one if there is one, otherwise the most recent. That order
 * is what makes the operator's tools behave — a reply goes to the live
 * conversation, and `/close`, `/del` and edits still reach a finished one.
 */
export async function findTicketByTopic(
  tgChatId: number,
  tgTopicId: number
): Promise<SupportTicket | null> {
  const where = { tgChatId: BigInt(tgChatId), tgTopicId }
  return (
    (await prismaSupport.supportTicket.findFirst({
      where: { ...where, status: 'OPEN' },
    })) ??
    (await prismaSupport.supportTicket.findFirst({
      where,
      orderBy: { createdAt: 'desc' },
    }))
  )
}

/**
 * The user's permanent thread row, created empty on first use.
 *
 * Empty means "no topic yet": the Telegram call happens outside, and this row
 * exists first so that two concurrent first messages contend on the unique
 * index here rather than both going off to create a topic.
 */
export async function ensureUserThread(ticket: {
  userId: string
  userNId: number
  product: SupportProduct
}): Promise<SupportUserThread> {
  const key = { product: ticket.product, userId: ticket.userId }

  const existing = await prismaSupport.supportUserThread.findUnique({
    where: { product_userId: key },
  })
  if (existing) return existing

  try {
    return await prismaSupport.supportUserThread.create({
      data: { ...key, userNId: ticket.userNId },
    })
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      const winner = await prismaSupport.supportUserThread.findUnique({
        where: { product_userId: key },
      })
      if (winner) return winner
    }
    throw err
  }
}

/**
 * Persist the Telegram coordinates on the user's permanent thread — but only
 * if nobody has bound it already.
 *
 * This is the cross-process half of the guard. The in-memory coalescing in
 * `ensureTopic` covers two sends inside ONE process; support runs an api
 * container and a worker container (the relay-retry loop calls `ensureTopic`
 * too), so two processes can each create a forum topic for the same user. An
 * unconditional UPDATE would let the second overwrite the first, leaving the
 * user's earlier messages in a topic nobody looks at.
 *
 * The conditional write makes the FIRST binding win: the loser gets the
 * winner's row back and uses that topic. Its own topic is left orphaned in
 * Telegram — empty, and cheap to delete by hand — which is the right trade
 * against a split conversation.
 */
export async function saveThreadBinding(
  threadId: string,
  bound: { chatId: number; topicId: number; infoMessageId?: number }
): Promise<SupportUserThread> {
  const claimed = await prismaSupport.supportUserThread.updateMany({
    where: { id: threadId, tgTopicId: null },
    data: {
      tgChatId: BigInt(bound.chatId),
      tgTopicId: bound.topicId,
      ...(bound.infoMessageId != null
        ? { tgInfoMessageId: bound.infoMessageId }
        : {}),
    },
  })

  const row = await prismaSupport.supportUserThread.findUniqueOrThrow({
    where: { id: threadId },
  })
  if (claimed.count === 0) {
    logger.warn(
      `[ticket] thread ${threadId} was already bound to topic ${row.tgTopicId} — ` +
        `topic ${bound.topicId} is orphaned and can be deleted`
    )
  }
  return row
}

/**
 * Copy the thread's topic onto the ticket.
 *
 * The ticket keeps its own copy of the coordinates rather than reading through
 * a relation: every relay, retry and close path already takes a `SupportTicket`
 * and reads `tgChatId`/`tgTopicId` off it, and threading a join through all of
 * them would be a far larger change than the feature warrants.
 */
export async function bindTicketToThread(
  ticket: SupportTicket,
  thread: SupportUserThread
): Promise<SupportTicket> {
  if (thread.tgChatId == null || thread.tgTopicId == null) return ticket

  return prismaSupport.supportTicket.update({
    where: { id: ticket.id },
    data: {
      tgChatId: thread.tgChatId,
      tgTopicId: thread.tgTopicId,
      tgInfoMessageId: thread.tgInfoMessageId,
    },
  })
}

/**
 * Drop a DELETED topic from the user's permanent thread.
 *
 * Without this the thread keeps pointing at a topic that no longer exists, and
 * `ensureTopic` cheerfully re-binds every new ticket to it — the conversation
 * becomes permanently unreachable instead of continuing in a fresh thread.
 * Clearing the ticket's own binding alone is not enough for exactly that
 * reason.
 *
 * `tgInfoMessageId` goes too: it names a pinned card inside the deleted topic.
 */
export async function forgetThreadTopic(
  tgChatId: bigint | null,
  tgTopicId: number | null
): Promise<void> {
  if (tgChatId == null || tgTopicId == null) return

  await prismaSupport.supportUserThread.updateMany({
    where: { tgChatId, tgTopicId },
    data: { tgTopicId: null, tgInfoMessageId: null },
  })
}

/** True when this topic is the user's permanent thread rather than a legacy one. */
export async function isThreadTopic(
  tgChatId: bigint | null,
  tgTopicId: number | null
): Promise<boolean> {
  if (tgChatId == null || tgTopicId == null) return false
  const thread = await prismaSupport.supportUserThread.findUnique({
    where: { tgChatId_tgTopicId: { tgChatId, tgTopicId } },
    select: { id: true },
  })
  return thread !== null
}

export async function findOpenTicket(
  userId: string,
  product: SupportProduct = 'PLATFORM'
): Promise<SupportTicket | null> {
  return prismaSupport.supportTicket.findFirst({
    where: { userId, product, status: 'OPEN' },
  })
}

/**
 * A freshly closed conversation that has not been asked about yet.
 *
 * The LAST closed one is taken: if the person did not answer the offer and
 * managed to close one more conversation, asking about the one from the day
 * before yesterday is pointless — he does not remember it any more.
 *
 * The offer's lifetime is bounded: a "how was support" rating a week after the
 * conversation is not so much useless as annoying — the person opened the chat
 * about a new matter and got a question about an old one.
 */
const FEEDBACK_WINDOW_HOURS = 48

export async function findPendingFeedback(
  userId: string,
  product: SupportProduct = 'PLATFORM'
): Promise<SupportPendingFeedback | null> {
  const since = new Date(Date.now() - FEEDBACK_WINDOW_HOURS * 3_600_000)
  const ticket = await prismaSupport.supportTicket.findFirst({
    where: {
      userId,
      product,
      status: 'CLOSED',
      ratedAt: null,
      closedAt: { gte: since },
    },
    orderBy: { closedAt: 'desc' },
    select: { id: true, closedAt: true },
  })
  if (!ticket) return null
  return {
    ticketId: ticket.id,
    closedAt: ticket.closedAt ? ticket.closedAt.toISOString() : null,
  }
}

/** Badge value: unread agent messages across every ticket the user has. */
export async function countUnread(
  userId: string,
  product: SupportProduct = 'PLATFORM'
): Promise<number> {
  const agg = await prismaSupport.supportTicket.aggregate({
    where: { userId, product },
    _sum: { unreadForUser: true },
  })
  return agg._sum.unreadForUser ?? 0
}

/**
 * One continuous feed across all of the user's tickets, newest page first.
 *
 * Paged by an opaque message-id cursor rather than `seq`, because `seq`
 * restarts per ticket and the user sees the whole history as a single scroll.
 */
export async function getThread(
  userId: string,
  beforeId?: string,
  limit = DEFAULT_PAGE_SIZE,
  product: SupportProduct = 'PLATFORM'
): Promise<SupportThreadResponse> {
  const take = Math.min(Math.max(limit, 1), MAX_PAGE_SIZE)

  const rows = await prismaSupport.supportMessage.findMany({
    where: { ticket: { userId, product }, deletedAt: null },
    include: { attachments: true, agent: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    // One extra row is the cheapest reliable "is there more above?" probe.
    take: take + 1,
    ...(beforeId ? { cursor: { id: beforeId }, skip: 1 } : {}),
  })

  const hasMore = rows.length > take
  const page = hasMore ? rows.slice(0, take) : rows

  // Query is newest-first for the cursor; the UI renders oldest-first.
  const messages: SupportMessageDto[] = page.map(toMessageDto).reverse()

  const [openTicket, unread, pendingFeedback, mute] = await Promise.all([
    findOpenTicket(userId, product),
    countUnread(userId, product),
    findPendingFeedback(userId, product),
    getMuteState(userId),
  ])

  return {
    ticket: openTicket ? toTicketDto(openTicket) : null,
    pendingFeedback,
    mutedUntil: mute.until,
    messages,
    hasMore,
    nextCursor:
      hasMore && page.length ? (page[page.length - 1]?.id ?? null) : null,
    unread,
  }
}

/** Clear the badge for the whole thread. Returns the new (zero) total. */
export async function markThreadRead(
  userId: string,
  product: SupportProduct = 'PLATFORM'
): Promise<number> {
  await prismaSupport.supportTicket.updateMany({
    where: { userId, product, unreadForUser: { gt: 0 } },
    data: { unreadForUser: 0 },
  })
  return 0
}

export interface CloseTicketResult {
  ticket: SupportTicket
  /** The system bubble both sides see; null if the ticket was already closed. */
  systemMessage: Awaited<ReturnType<typeof appendMessage>>['message'] | null
  /**
   * Support's automatic goodbye, appended just before the close. Null when the
   * ticket was already closed — a second `/close` must not post it again.
   */
  farewellMessage: Awaited<ReturnType<typeof appendMessage>>['message'] | null
}

/**
 * Close a ticket and stamp the closing system message.
 *
 * Idempotent: closing an already-closed ticket is a no-op, so a double /close
 * from Telegram, a user click and the inactivity sweeper racing each other
 * produce exactly one closing bubble.
 */
export async function closeTicket(
  ticketId: string,
  closedBy: SupportTicketClosedBy,
  /**
   * The operator who typed `/close`, when there is one.
   *
   * Without it `closedBy: 'AGENT'` says only "a human", and per-operator
   * analytics cannot exist. Null for the user's own close and for the
   * inactivity sweeper, and null too when the sender has no agent row yet.
   */
  closedByAgentId: string | null = null
): Promise<CloseTicketResult> {
  const current = await prismaSupport.supportTicket.findUnique({
    where: { id: ticketId },
  })
  if (!current) throw new Error(`[ticket] not found: ${ticketId}`)
  if (current.status === 'CLOSED') {
    return { ticket: current, systemMessage: null, farewellMessage: null }
  }

  // Support's goodbye goes FIRST, while the ticket is still open, so the feed
  // reads the way the conversation did: a last word from support, then the
  // separator saying it ended. Appended as OUT, not SYSTEM — it is a message
  // from support, not a grey pill — and carries only the code, so the user
  // reads it in whatever language they are using now.
  const { message: farewellMessage } = await appendMessage({
    ticketId,
    direction: 'OUT',
    autoKind: AUTO_FAREWELL,
    text: AUTO_TEXT_FALLBACK[AUTO_FAREWELL] ?? null,
    // Exactly once per ticket. `closeTicket` already returns early on an
    // already-CLOSED row, but the key makes that guarantee independent of
    // that check surviving future edits.
    dedupeKey: `farewell:${ticketId}`,
  })

  // The system message is appended BEFORE flipping the status so it lands
  // inside the ticket's own numbering; the update below is what makes the
  // close visible, and a crash between the two just leaves a harmless
  // "closed" bubble on a still-open ticket (recoverable by closing again).
  const { message } = await appendMessage({
    ticketId,
    direction: 'SYSTEM',
    systemKind: 'TICKET_CLOSED',
  })

  const ticket = await prismaSupport.supportTicket.update({
    where: { id: ticketId },
    data: {
      status: 'CLOSED',
      closedAt: new Date(),
      closedBy,
      closedByAgentId,
    },
  })

  // Outcome accounting must finish even when the Zhora worker is disabled.
  await finalizeIgnoredSuggestions(ticket.id).catch(() => {
    logger.warn('[zhora] closed-ticket outcome finalization failed')
  })

  logger.info(`[ticket] closed ${ticketId} by ${closedBy}`)
  return { ticket, systemMessage: message, farewellMessage }
}
