import { Prisma } from '@prisma-support'
import type {
  SupportMessage,
  SupportMessageDirection,
  SupportProduct,
  SupportSystemKind,
} from '@prisma-support'

import { prismaSupport } from '@config/database'

export interface AppendMessageInput {
  ticketId: string
  direction: SupportMessageDirection
  text?: string | null
  systemKind?: SupportSystemKind | null
  /**
   * Support's automatic reply code (`agent_greeting` / `agent_farewell`).
   * A column rather than an enum value — see the schema for why.
   */
  autoKind?: string | null
  /** Author, for OUT messages sent by a registered agent. */
  agentId?: string | null
  /** message_id inside the Telegram topic, when already known. */
  tgMessageId?: number | null
  /**
   * Idempotency key. `tg:<chatId>:<messageId>` for inbound Telegram relays,
   * the client-supplied request id for browser sends. Omitted for messages
   * the service authors itself (system notices).
   */
  dedupeKey?: string | null
  /** Staged attachment rows to bind to this message. */
  attachmentIds?: string[]
  /** Create a durable AI translation task with this customer message. */
  translationPending?: boolean
  /**
   * Refuse the append unless the ticket is still OPEN, checked inside the same
   * locked write that allocates `seq` — so no `/close` can slip in between.
   * Throws Prisma P2025 when it does not hold.
   *
   * Agent replies only. System notices (the closing bubble in particular) are
   * appended to CLOSED tickets by design.
   */
  requireOpen?: boolean
  /**
   * Append an OUT message WITHOUT raising the user's unread badge.
   *
   * For support's automatic greeting: it lands the instant the user presses
   * send, while they are looking at the conversation, so a badge they then have
   * to dismiss is noise about a message they already watched arrive. The
   * goodbye is deliberately NOT silent — that one can arrive long after the
   * user has left.
   */
  silent?: boolean
}

export interface AppendMessageResult {
  message: SupportMessage
  /**
   * False when `dedupeKey` matched an existing row — the caller must then
   * skip its side effects (no second Telegram post, no second push), which is
   * exactly what makes retries and Telegram redeliveries safe.
   */
  created: boolean
}

/**
 * Append a message to a ticket.
 *
 * Runs in one transaction so that the per-ticket `seq` allocation, the row
 * insert, the attachment binding and the ticket counters either all land or
 * none do — a crash mid-way can never leave a gap in `seq` (the history
 * cursor) or an orphaned attachment.
 */
export async function appendMessage(
  input: AppendMessageInput
): Promise<AppendMessageResult> {
  const {
    ticketId,
    direction,
    text = null,
    systemKind = null,
    autoKind = null,
    agentId = null,
    tgMessageId = null,
    dedupeKey = null,
    attachmentIds = [],
  } = input

  // Cheap pre-check outside the transaction. The unique index below is what
  // actually guarantees correctness under a race; this just avoids opening a
  // transaction for the common redelivery case.
  if (dedupeKey) {
    const existing = await prismaSupport.supportMessage.findUnique({
      where: { dedupeKey },
    })
    if (existing) return { message: existing, created: false }
  }

  try {
    const message = await prismaSupport.$transaction(async (tx) => {
      // Atomic allocator: the UPDATE takes a row lock, so concurrent appends
      // to the same ticket serialize here and each gets a distinct seq.
      //
      // `requireOpen` folds the status check into that same locked write, which
      // is the only way to make it race-free: a caller that reads the status
      // first leaves a window in which `/close` can land between the read and
      // this insert. Set ONLY for agent replies — closing a ticket appends its
      // own system message to an already-CLOSED row and must not be blocked.
      // No match → P2025, translated by the caller.
      const ticket = await tx.supportTicket.update({
        where: {
          id: ticketId,
          ...(input.requireOpen ? { status: 'OPEN' as const } : {}),
        },
        data: {
          lastSeq: { increment: 1 },
          lastMessageAt: new Date(),
          ...(direction === 'IN' ? { lastUserMessageAt: new Date() } : {}),
          // The same write that allocates the first/second customer message
          // makes classification discoverable after a crash or relay retry.
          ...(direction === 'IN' && input.translationPending
            ? { categoryClassifyPending: true }
            : {}),
          ...(direction === 'OUT'
            ? {
                lastAgentMessageAt: new Date(),
                // Only agent replies are unread for the user; the user's own
                // messages and system notices never raise the badge. `silent`
                // opts an OUT message out of it — see the flag's docstring.
                ...(input.silent ? {} : { unreadForUser: { increment: 1 } }),
              }
            : {}),
        },
        select: { lastSeq: true },
      })

      const created = await tx.supportMessage.create({
        data: {
          ticketId,
          seq: ticket.lastSeq,
          direction,
          text,
          systemKind,
          autoKind,
          agentId,
          tgMessageId,
          dedupeKey,
        },
      })

      if (input.translationPending && direction === 'IN') {
        await tx.zhoraTranslation.create({
          data: { messageId: created.id },
        })
      }

      if (attachmentIds.length) {
        // Scoped to this ticket on purpose: an attachment id from another
        // user's ticket must not be attachable here.
        await tx.supportAttachment.updateMany({
          where: { id: { in: attachmentIds }, ticketId, messageId: null },
          data: { messageId: created.id },
        })
      }

      return created
    })

    return { message, created: true }
  } catch (err) {
    // Lost the race against a concurrent identical append (same dedupeKey).
    // The transaction rolled back, so no seq was burned — return the winner.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002' &&
      dedupeKey
    ) {
      const existing = await prismaSupport.supportMessage.findUnique({
        where: { dedupeKey },
      })
      if (existing) return { message: existing, created: false }
    }
    throw err
  }
}

/**
 * Apply an edit made on the Telegram side.
 *
 * Returns null when the message is unknown (edited in the general topic, or
 * older than this feature) so the caller can no-op instead of inventing a row.
 */
export async function editMessageByTelegramId(
  ticket: { id: string; userId: string; product: SupportProduct },
  tgMessageId: number,
  text: string | null
): Promise<SupportMessage | null> {
  const existing = await findMessageByTelegramId(ticket, tgMessageId)
  if (!existing) return null
  // Telegram fires edit events for non-text changes too (e.g. link preview
  // resolution). Skipping a no-op edit keeps `editedAt` honest, so the UI
  // doesn't flash an "edited" marker the agent never caused.
  if (existing.text === text) return existing

  return prismaSupport.supportMessage.update({
    where: { id: existing.id },
    data: { text, editedAt: new Date() },
  })
}

/**
 * The row a Telegram message id belongs to, or null when that id is not part
 * of this ticket's conversation.
 *
 * Null is the normal answer for anything the bot did not relay — the info card,
 * the topic-creation service message, an operator's internal note. Callers use
 * it as the ownership check before acting on a message an agent pointed at.
 */
export async function findMessageByTelegramId(
  ticket: { id: string; userId: string; product: SupportProduct },
  tgMessageId: number
): Promise<SupportMessage | null> {
  // Scoped to the USER's whole thread, not to one ticket.
  //
  // A permanent topic holds every conversation that person ever had, so an
  // operator scrolling up and editing — or `/del`-ing — a message from an
  // earlier, already-closed ticket is ordinary behaviour. Resolving only
  // within `ticket.id` (which is the OPEN one) would silently find nothing and
  // the edit would vanish.
  //
  // Still bounded, and by the right thing: a Telegram message id is unique per
  // chat, and the user scope is exactly the set of tickets sharing that topic.
  return prismaSupport.supportMessage.findFirst({
    where: {
      tgMessageId,
      deletedAt: null,
      ticket: { userId: ticket.userId, product: ticket.product },
    },
  })
}

/**
 * Soft-delete. The row stays so `seq` keeps its meaning as a gap-free cursor;
 * reads filter on `deletedAt`.
 */
export async function softDeleteMessage(
  messageId: string
): Promise<SupportMessage | null> {
  const existing = await prismaSupport.supportMessage.findUnique({
    where: { id: messageId },
  })
  if (!existing || existing.deletedAt) return null
  return prismaSupport.supportMessage.update({
    where: { id: messageId },
    data: { deletedAt: new Date(), text: null },
  })
}

/** Bind the Telegram message id once the relay has posted the bubble. */
export async function attachTelegramMessageId(
  messageId: string,
  tgMessageId: number
): Promise<void> {
  await prismaSupport.supportMessage.update({
    where: { id: messageId },
    data: { tgMessageId },
  })
}
