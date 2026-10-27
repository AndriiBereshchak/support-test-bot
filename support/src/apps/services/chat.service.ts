import {
  Prisma,
  type SupportTicket,
  type SupportUserThread,
} from '@prisma-support'

import { prismaSupport } from '@config/database'
import { ZHORA_ENABLED } from '@config/env'
import { logger } from '@config/logger'
import { redisClient, supportKey } from '@config/redis'

import type { SupportMessageDto, SupportTicketDto } from '@core/contracts'
import { SUPPORT_WS_ACTIONS } from '@core/contracts'
import { AUTO_GREETING, AUTO_TEXT_FALLBACK } from '@core/contracts'

import {
  appendMessage,
  attachTelegramMessageId,
  editMessageByTelegramId,
  softDeleteMessage,
} from './message.service'
import { toMessageDto, toTicketDto } from './mappers'
import { pushToUser } from './push.service'
import {
  bindTicketToThread,
  closeTicket,
  countUnread,
  ensureOpenTicket,
  ensureUserThread,
  findOpenTicket,
  findPendingFeedback,
  findTicketByTopic,
  isThreadTopic,
  saveThreadBinding,
} from './ticket.service'
import { assertCanWrite } from './mute.service'
import { getUserCard } from './user-card.service'
import { updateSuggestionOutcomeAfterEdit } from './zhora/suggestion-outcome.service'
import * as telegram from '@telegram/api'

/**
 * Orchestration layer: the only place that combines persistence, the Telegram
 * relay and the browser push.
 *
 * Layering rule that keeps this cycle-free — `@telegram/api` is a dumb Telegram
 * wrapper with no app imports; `@telegram/updates` sits ABOVE this file and
 * calls into it. Never import `@telegram/updates` from here.
 *
 * Ordering rule everywhere below: persist first, then side-effect. A message
 * that exists in Postgres but failed to reach Telegram is recoverable (the
 * relay retries, support sees it on the next read); a message posted to
 * Telegram but missing from Postgres is invisible to the user forever.
 */

async function loadMessageDto(messageId: string): Promise<SupportMessageDto> {
  const row = await prismaSupport.supportMessage.findUniqueOrThrow({
    where: { id: messageId },
    include: { attachments: true, agent: true },
  })
  return toMessageDto(row)
}

/**
 * `requestId` is echoed back only for a message the user themselves just sent.
 * It is what lets the sending tab replace its optimistic bubble in place
 * instead of briefly rendering the message twice — see the field's comment in
 * contracts.ts. Omitted for agent replies and system notices, which no browser
 * has a placeholder for.
 */
async function pushMessage(
  userId: string,
  ticket: SupportTicket,
  messageId: string,
  requestId?: string | null
): Promise<void> {
  const [message, unread] = await Promise.all([
    loadMessageDto(messageId),
    countUnread(userId),
  ])
  await pushToUser(userId, {
    action: SUPPORT_WS_ACTIONS.message,
    message,
    ticket: toTicketDto(ticket),
    unread,
    ...(requestId ? { requestId } : {}),
  })
}

async function pushTicket(
  userId: string,
  ticket: SupportTicket
): Promise<void> {
  // On close, put the invitation to rate straight into the push: otherwise the
  // card would only show up after a thread reload, that is, at best on the next
  // visit — when the conversation has already been forgotten. Computed by the
  // same query as on a thread read, so "already rated" and a card more than a
  // day after the fact never surface.
  const pendingFeedback =
    ticket.status === 'CLOSED' ? await findPendingFeedback(userId) : null

  await pushToUser(userId, {
    action: SUPPORT_WS_ACTIONS.ticketUpdated,
    ticket: toTicketDto(ticket),
    unread: await countUnread(userId),
    ...(pendingFeedback ? { pendingFeedback } : {}),
  })
}

/**
 * In-flight topic creations, keyed by ticket id.
 *
 * The partial unique index guarantees ONE ticket per user; nothing guarantees
 * one TOPIC. Two sends racing on a brand-new ticket both read it while it is
 * still unbound, and each would call `createForumTopic` — the second bind
 * overwrites the first, leaving a stray empty topic in the support group with
 * the user's first message sitting in the one nobody is looking at.
 *
 * The entry is deleted as soon as the promise settles, so this is a coalescing
 * window rather than a cache: a later send still re-reads the row.
 */
const topicCreations = new Map<string, Promise<SupportUserThread>>()

/**
 * Make sure the ticket has a live Telegram topic, creating it (plus the
 * pinned info card) on first use.
 *
 * Kept out of ticket creation so a Telegram outage degrades gracefully: the
 * ticket and the user's message still persist, and the topic is created on the
 * next relay attempt instead of failing the user's send.
 */
export async function ensureTopic(
  ticket: SupportTicket
): Promise<SupportTicket> {
  if (ticket.tgTopicId != null && ticket.tgChatId != null) return ticket

  // Keyed by the USER, not the ticket: a topic is permanent and shared by every
  // ticket that person opens, so two of their tickets racing here must coalesce
  // onto one creation. Keying by ticket id would let each win its own lock and
  // open a second "permanent" topic.
  //
  // What is SHARED is the thread, never a ticket row. An earlier version handed
  // the in-flight promise straight back, so a second caller received the FIRST
  // caller's ticket — including its status. The worker retries stuck messages on
  // CLOSED tickets too, so a user sending a new message could be handed a closed
  // ticket and watch their own composer lock itself. Each caller now binds its
  // OWN row to whatever thread the shared work produced.
  const key = `${ticket.product}:${ticket.userId}`
  let inFlight = topicCreations.get(key)
  if (!inFlight) {
    inFlight = createThreadTopic(ticket).finally(() => {
      topicCreations.delete(key)
    })
    topicCreations.set(key, inFlight)
  }

  const thread = await inFlight
  if (thread.tgTopicId == null || thread.tgChatId == null) return ticket
  return bindTicketToThread(ticket, thread)
}

/**
 * Produce the user's permanent thread WITH a live Telegram topic.
 *
 * Returns the thread, never a ticket: this runs once per user under the
 * coalescing window in `ensureTopic`, and every caller then binds its own
 * ticket to the result.
 *
 * Kept out of ticket creation so a Telegram outage degrades gracefully — the
 * ticket and the user's message still persist, and the topic is created on the
 * next relay attempt instead of failing the send.
 */
async function createThreadTopic(
  ticket: SupportTicket
): Promise<SupportUserThread> {
  const thread = await ensureUserThread(ticket)

  // Already has a topic from an earlier conversation. Reusing it IS the
  // feature: every ticket the person opens lands in one thread, in order.
  if (thread.tgTopicId != null && thread.tgChatId != null) {
    await announceNewConversation(ticket, thread)
    return prismaSupport.supportUserThread.findUniqueOrThrow({
      where: { id: thread.id },
    })
  }

  const card = await getUserCard(ticket.userId)
  const bound = await telegram.createTicketTopic({
    ticketId: ticket.id,
    userNId: ticket.userNId,
    card,
    originDomain: ticket.originDomain,
    category: ticket.category,
    threadTitle: true,
  })
  // Telegram disabled (no token) or refusing — leave the thread unbound and
  // let the next attempt try again.
  if (!bound) return thread

  return saveThreadBinding(thread.id, bound)
}

/**
 * Mark the start of a new conversation inside an existing thread.
 *
 * Everything an operator uses to read a topic's state was designed when a topic
 * WAS one conversation, and all three of them go stale in a permanent thread:
 *
 *   • the icon keeps the ✅ from the last close, so a live unanswered ticket
 *     looks handled in the forum list;
 *   • the pinned card is frozen at the thread's birth — balance, KYC, risk
 *     flags and deposits from possibly months ago;
 *   • nothing separates one conversation from the next, so a new message just
 *     appears under "🔒 Обращение закрыто".
 *
 * All three are refreshed here. Best-effort throughout: none of it is worth
 * costing the user their ticket.
 */
async function announceNewConversation(
  ticket: SupportTicket,
  thread: SupportUserThread
): Promise<void> {
  const chatId = Number(thread.tgChatId)
  const topicId = thread.tgTopicId
  if (!chatId || topicId == null) return

  try {
    await telegram.markTopicOpen(chatId, topicId)
    await telegram.sendPlainMessage({
      chatId,
      topicId,
      text: '🆕 Новое обращение — всё, что ниже, относится к нему.',
    })

    await refreshPinnedTicketCard(ticket, thread)
  } catch (err) {
    logger.warn(
      `[chat] could not announce a new conversation in topic ${topicId}: ${
        (err as Error).message
      }`
    )
  }
}

/** Refresh the active ticket's pinned card after a category change. */
export async function refreshPinnedTicketCard(
  ticket: SupportTicket,
  knownThread?: SupportUserThread
): Promise<void> {
  const latest =
    (await prismaSupport.supportTicket.findUnique({
      where: { id: ticket.id },
    })) ?? ticket
  const thread =
    knownThread ??
    (await prismaSupport.supportUserThread.findUnique({
      where: {
        product_userId: { product: ticket.product, userId: ticket.userId },
      },
    }))
  const chatId = Number(thread?.tgChatId ?? latest.tgChatId)
  const topicId = thread?.tgTopicId ?? latest.tgTopicId
  if (!chatId || topicId == null) return
  if (!knownThread) {
    const current = await findTicketByTopic(chatId, topicId)
    if (current?.id !== latest.id) return
  }
  try {
    const card = await getUserCard(latest.userId)
    const messageId = thread?.tgInfoMessageId ?? latest.tgInfoMessageId
    const args = {
      chatId,
      topicId,
      ticketId: latest.id,
      userNId: latest.userNId,
      card,
      originDomain: latest.originDomain,
      category: latest.category,
    }
    const edited =
      messageId != null &&
      (await telegram.editTicketCard({ ...args, messageId }))
    if (edited) return
    const posted = await telegram.postTicketCard(args)
    if (posted == null) return
    if (thread) {
      await prismaSupport.supportUserThread.update({
        where: { id: thread.id },
        data: { tgInfoMessageId: posted },
      })
    }
    await prismaSupport.supportTicket.update({
      where: { id: latest.id },
      data: { tgInfoMessageId: posted },
    })
  } catch {
    logger.warn('[zhora] ticket category card refresh failed')
  }
}

/**
 * How long one relay may hold its message's slot.
 *
 * Generous because it bounds a SEND, not a request: the hardened transport
 * queues behind the group's ~20-per-minute budget and honours a `retry_after`
 * of up to a minute, so a relay legitimately in flight can take a while. The
 * only cost of it being too long is that a message stranded by a hard crash
 * waits this out before the retry loop adopts it.
 */
const RELAY_CLAIM_TTL_SEC = 120

/**
 * Claim the exclusive right to relay one message into Telegram.
 *
 * The two relay paths — a user's send, and the worker's retry loop — run in
 * DIFFERENT processes, so this is a Redis claim rather than the in-process
 * coalescing `topicCreations` uses. The retry loop's age gate makes an overlap
 * unlikely on its own; this makes it impossible, and what it prevents is the
 * user's message appearing in the support topic twice (the transport can hold a
 * send behind a minute-long flood wait, far longer than any age gate we would
 * want to wait out before rescuing a message).
 *
 * Fails OPEN, unlike `claimTypingSlot`: with Redis down the retry loop cannot
 * take its own pass lock and is inert, so there is nothing left to collide with
 * — and refusing to relay would turn a Redis outage into a support outage.
 */
async function claimRelaySlot(messageId: string): Promise<boolean> {
  try {
    const claimed = await redisClient.set(
      supportKey(`relay:claim:${messageId}`),
      '1',
      'EX',
      RELAY_CLAIM_TTL_SEC,
      'NX'
    )
    return claimed === 'OK'
  } catch (err) {
    logger.debug(
      `[chat] relay claim unavailable, relaying anyway: ${(err as Error).message}`
    )
    return true
  }
}

async function releaseRelaySlot(messageId: string): Promise<void> {
  try {
    await redisClient.del(supportKey(`relay:claim:${messageId}`))
  } catch {
    // The TTL is the real release; this only shortens it. A stranded claim
    // costs the retry loop one pass, never a message.
  }
}

/**
 * What one relay attempt did, in the only terms a caller can act on.
 *
 * `busy` is not a failure: somebody else is relaying this exact message right
 * now, so the right response is to leave it alone, not to retry it.
 */
export type RelayAttempt =
  | { status: 'relayed'; tgMessageId: number }
  | { status: 'busy' }
  | { status: 'failed'; permanent: telegram.PermanentFailure | null }

/**
 * Post a persisted user message into its ticket topic and record the id.
 *
 * The single definition of "this message reached Telegram": `tgMessageId` going
 * from NULL to a number is what makes it stop being a candidate for the retry
 * loop, so the send and the stamp have to live together in one place. Never
 * throws — every outcome is a value, because both callers (a user's HTTP
 * request and a background pass) have to survive a Telegram outage.
 */
export async function relayIncomingMessage(
  ticket: SupportTicket,
  message: { id: string; text: string | null }
): Promise<RelayAttempt> {
  if (!(await claimRelaySlot(message.id))) return { status: 'busy' }

  const failure: telegram.RelayFailure = { permanent: null }
  try {
    const attachments = await prismaSupport.supportAttachment.findMany({
      where: { messageId: message.id },
    })
    const tgMessageId = await telegram.relayUserMessage({
      ticket,
      text: message.text,
      attachments,
      failure,
    })
    if (tgMessageId === null) {
      return { status: 'failed', permanent: failure.permanent }
    }

    await attachTelegramMessageId(message.id, tgMessageId)
    if (ZHORA_ENABLED && ticket.tgChatId !== null) {
      await telegram.attachZhoraReplyButton({
        chatId: Number(ticket.tgChatId),
        telegramMessageId: tgMessageId,
        customerMessageId: message.id,
      })
    }
    return { status: 'relayed', tgMessageId }
  } catch (err) {
    logger.error(
      `[chat] relay of message ${message.id} threw: ${(err as Error).message}`
    )
    return { status: 'failed', permanent: failure.permanent }
  } finally {
    // Always, even on success: once `tgMessageId` is stamped the message is no
    // longer a retry candidate, so holding the claim to its TTL protects
    // nothing and only delays a genuine second attempt.
    await releaseRelaySlot(message.id)
  }
}

export interface UserSendInput {
  userId: string
  userNId: number
  text?: string | null
  attachmentIds?: string[]
  /** Client-supplied uuid; makes a retried send collapse onto one message. */
  requestId?: string | null
  /**
   * Mirror the user is writing from, resolved by the exchange proxy. Only ever
   * used by the ticket this send OPENS — see `ensureOpenTicket`.
   */
  originDomain?: string | null
}

export interface UserSendResult {
  ticket: SupportTicketDto
  message: SupportMessageDto
  unread: number
}

/**
 * A message written by the user in the platform chat window.
 *
 * Opens a ticket if there is none (which is how "user writes -> topic appears
 * in Telegram" happens), persists, echoes to the user's OTHER tabs, then
 * relays into the Telegram topic.
 */
export async function userSendMessage(
  input: UserSendInput
): Promise<UserSendResult> {
  const {
    userId,
    userNId,
    text = null,
    attachmentIds = [],
    requestId,
    originDomain,
  } = input

  // The check runs BEFORE the ticket is created: otherwise a muted user would
  // open an empty ticket with every rejected message, and support would pile up
  // conversations without a single line in them.
  await assertCanWrite(userId)

  const { ticket: openTicket, created } = await ensureOpenTicket({
    userId,
    userNId,
    originDomain,
  })

  // First ticket message pair: the opening system notice gives the user a
  // visible anchor and separates this ticket from previous ones in the feed.
  if (created) {
    await appendMessage({
      ticketId: openTicket.id,
      direction: 'SYSTEM',
      systemKind: 'TICKET_OPENED',
    })
  }

  const { message, created: isNew } = await appendMessage({
    ticketId: openTicket.id,
    direction: 'IN',
    text,
    attachmentIds,
    dedupeKey: requestId ? `web:${requestId}` : null,
    translationPending: ZHORA_ENABLED && !!text && /\p{L}/u.test(text),
  })

  const ticket = await ensureTopic(openTicket)

  if (isNew) {
    // Echo to every session of this user, INCLUDING the sender's own tab —
    // which is why `requestId` rides along: that tab still shows an optimistic
    // bubble and must swap it in place rather than append a duplicate while it
    // waits for the HTTP response.
    await pushMessage(userId, ticket, message.id, requestId)

    // Support greets AFTER the user's own message, never before it: the user
    // wrote first, and a greeting above their message would read as a reply to
    // nothing. Exactly one per ticket whichever path opened it (a ticket can
    // also be created by staging a file), and never once an operator has
    // spoken — see `greetOnce`.
    await greetOnce(userId, ticket)

    // Relay last: a Telegram failure must not roll back a persisted message.
    const attempt = await relayIncomingMessage(ticket, message)
    if (attempt.status === 'failed') {
      // Warn, not error: the message is persisted with a NULL `tgMessageId`,
      // which is exactly the state the retry loop drains. The error line — and
      // the Sentry event — belongs to that loop running out of attempts, not to
      // one try that Telegram happened to refuse.
      logger.warn(
        `[chat] message ${message.id} did not reach telegram — left for the retry loop`
      )
    }
  }

  return {
    ticket: toTicketDto(ticket),
    message: await loadMessageDto(message.id),
    unread: await countUnread(userId),
  }
}

/**
 * Telegram keeps the indicator up for roughly 5 seconds. Refreshing it just
 * under that keeps a continuously typing user's bubble alive without a gap,
 * while still collapsing a burst of keystrokes into one API call.
 */
const TYPING_THROTTLE_SEC = 4

/**
 * Claim this ticket's typing slot for the current window.
 *
 * In Redis rather than a process-local map for two reasons: the FE debounce is
 * a hint we cannot trust (a stale tab, a hand-rolled client, a double-mounted
 * component), and `api` runs several replicas that would otherwise each honour
 * their own budget.
 *
 * Fails CLOSED — no claim, no indicator. With Redis down the alternative is
 * every keystroke of every user turning into a Telegram call, competing with
 * actual replies for the global rate budget; the indicator is cosmetic, the
 * replies are not.
 */
async function claimTypingSlot(ticketId: string): Promise<boolean> {
  try {
    const claimed = await redisClient.set(
      supportKey(`typing:${ticketId}`),
      '1',
      'EX',
      TYPING_THROTTLE_SEC,
      'NX'
    )
    return claimed === 'OK'
  } catch (err) {
    // Debug: this fires once per typing event, so a Redis outage would turn
    // into a per-keystroke warn — and the outage itself is already reported
    // once by the client's own `error` handler in config/redis.ts.
    logger.debug(
      `[chat] typing throttle unavailable, skipping: ${(err as Error).message}`
    )
    return false
  }
}

/**
 * The user is typing in the platform chat window — mirror it into the topic.
 *
 * Deliberately does NOT call `ensureOpenTicket` / `ensureTopic`: typing is not
 * a message, and a ticket (or a forum topic) conjured out of somebody tapping
 * the input and walking away is an empty thread the support group has to
 * triage. No ticket, or a ticket Telegram has never seen, means no signal —
 * the first real message creates both, and carries the intent to.
 */
export async function userTyping(userId: string): Promise<void> {
  const ticket = await findOpenTicket(userId)
  if (!ticket || ticket.tgChatId == null || ticket.tgTopicId == null) return

  if (!(await claimTypingSlot(ticket.id))) return

  await telegram.sendTypingToTopic(Number(ticket.tgChatId), ticket.tgTopicId)
}

export interface AgentSendInput {
  ticket: SupportTicket
  text?: string | null
  agentId?: string | null
  tgMessageId: number
  /** Stable identity for an operator-approved draft across callback retries. */
  dedupeKey?: string
  /** Attachment rows already persisted by the Telegram download step. */
  attachmentIds?: string[]
  /** A direct Zhora send or an operator reply to a saved preview. */
  zhoraUse?: { suggestionId?: string; replyToTgMessageId?: number }
}

/**
 * A reply written by support inside the Telegram topic.
 *
 * By default `dedupeKey` is derived from the Telegram coordinates. Approved
 * drafts supply their own stable key, so retries cannot double-post either.
 *
 * Returns `'closed'` when the ticket is no longer open — the caller reports
 * that back into the topic so the agent is not left believing they delivered
 * something.
 */
export async function agentSendMessage(
  input: AgentSendInput
): Promise<SupportMessageDto | null | 'closed'> {
  const { ticket, text = null, agentId = null, tgMessageId } = input
  const attachmentIds = input.attachmentIds ?? []

  // The status check is `requireOpen`, enforced INSIDE the locked write that
  // allocates `seq` — not a read before it. The caller's `ticket` object can be
  // an album debounce plus a file download old, and re-reading it here would
  // still leave a window for `/close` to land between the read and the insert.
  //
  // Why this is needed at all: a Telegram group admin can still write into an
  // ARCHIVED forum topic, and that webhook is indistinguishable from a live
  // reply. Delivering it did damage beyond the stray bubble — `appendMessage`
  // raises `unreadForUser` and `lastMessageAt`, so the user got a badge for a
  // conversation whose composer is already disabled: a message they could see
  // and could not answer.
  //
  // Deliberately NOT enforced in `findTicketByTopic`: `/close`, `/del` and
  // message edits all resolve a ticket by topic and must keep working on a
  // closed one. Status decides DELIVERY, not lookup.
  let appended
  try {
    appended = await appendMessage({
      ticketId: ticket.id,
      direction: 'OUT',
      text,
      agentId,
      tgMessageId,
      attachmentIds,
      zhoraUse: input.zhoraUse,
      dedupeKey:
        input.dedupeKey ??
        `tg:${ticket.tgChatId?.toString() ?? '0'}:${tgMessageId}`,
      requireOpen: true,
    })
  } catch (err) {
    // P2025 = the guarded UPDATE matched nothing, i.e. the ticket is no longer
    // OPEN. Any other failure is a real error and must keep propagating.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2025'
    ) {
      return 'closed'
    }
    throw err
  }

  const { message, created } = appended
  if (!created) return null

  await pushMessage(ticket.userId, ticket, message.id)
  return loadMessageDto(message.id)
}

/**
 * An agent edited their message in Telegram — mirror it in the user's feed.
 *
 * Deliberately NOT gated on ticket status, unlike `agentSendMessage`: an agent
 * must be able to correct or retract something they already delivered, and a
 * ticket can close between the send and the fix.
 *
 * The residual channel is accepted knowingly: an edit replaces the bubble's
 * whole text, so an agent could in principle push NEW content into a closed
 * conversation by rewriting an old message. It is bounded — the edit only
 * reaches a bubble the user already has, and it never raises `unreadForUser`,
 * so nothing notifies them — which is why it is not worth blocking at the cost
 * of losing retractions.
 */
export async function agentEditMessage(
  ticket: SupportTicket,
  tgMessageId: number,
  text: string | null
): Promise<void> {
  const updated = await editMessageByTelegramId(ticket, tgMessageId, text)
  if (!updated || !updated.editedAt) return

  await updateSuggestionOutcomeAfterEdit(updated)

  await pushToUser(ticket.userId, {
    action: SUPPORT_WS_ACTIONS.messageUpdated,
    id: updated.id,
    ticketId: ticket.id,
    text: updated.text,
    editedAt: updated.editedAt.toISOString(),
    deleted: false,
  })
}

/** Remove a bubble from the user's feed (agent deleted it in Telegram). */
export async function agentDeleteMessage(
  ticket: SupportTicket,
  messageId: string
): Promise<void> {
  const deleted = await softDeleteMessage(messageId)
  if (!deleted) return

  await pushToUser(ticket.userId, {
    action: SUPPORT_WS_ACTIONS.messageUpdated,
    id: deleted.id,
    ticketId: ticket.id,
    text: null,
    editedAt: null,
    deleted: true,
  })
}

/**
 * Close a ticket from any of the three entry points (user button, /close in
 * the topic, inactivity sweeper) and settle both sides.
 */
export async function closeTicketEverywhere(
  ticketId: string,
  closedBy: 'USER' | 'AGENT' | 'SYSTEM',
  /** Operator who closed it — see `closeTicket`. */
  closedByAgentId: string | null = null
): Promise<SupportTicketDto> {
  const { ticket, systemMessage, farewellMessage } = await closeTicket(
    ticketId,
    closedBy,
    closedByAgentId
  )

  if (systemMessage) {
    // Goodbye first, then the separator — the order they were appended in, and
    // the order they have to arrive in for the feed to read correctly.
    if (farewellMessage) {
      await pushMessage(ticket.userId, ticket, farewellMessage.id)
    }
    await pushMessage(ticket.userId, ticket, systemMessage.id)
    await pushTicket(ticket.userId, ticket)
    // Post the closing notice and flip the icon. Whether the topic is also
    // ARCHIVED depends on which layout it belongs to: a legacy per-ticket topic
    // is finished for good, a permanent thread has to stay writable for the
    // user's next conversation.
    try {
      const permanent = await isThreadTopic(ticket.tgChatId, ticket.tgTopicId)
      await telegram.closeTicketTopic(ticket, closedBy, permanent)
    } catch (err) {
      logger.warn(
        `[chat] closing telegram topic failed for ${ticket.id}: ${
          (err as Error).message
        }`
      )
    }
  }

  return toTicketDto(ticket)
}

/**
 * Support-initiated conversation: an admin asks the bot to open a ticket for a
 * user (or manually creates a correctly-named topic). Returns null when the
 * user already has an open ticket — the caller then reuses that topic instead
 * of creating a second one.
 */
export async function openTicketForUser(
  userId: string,
  userNId: number
): Promise<{ ticket: SupportTicket; created: boolean }> {
  const existing = await findOpenTicket(userId)
  if (existing) return { ticket: await ensureTopic(existing), created: false }

  const { ticket } = await ensureOpenTicket({ userId, userNId })
  const bound = await ensureTopic(ticket)
  await announceTicketOpened(userId, bound)
  await pushTicket(userId, bound)
  return { ticket: bound, created: true }
}

/**
 * Write the opening marker AND put it on the wire.
 *
 * Appending alone is not enough on a support-initiated ticket. The row lands in
 * the table, but a client that is already sitting on the chat only learns about
 * it at the next refetch — so the agent's first message, which DOES push,
 * arrives ahead of the marker and reads as the start of the dialog. Ordering
 * only looks right after a reload, which is precisely when nobody is watching.
 *
 * Deliberately not used on the user-initiated paths: there the person who
 * opened the ticket is the one typing, and their own message is already on
 * screen optimistically.
 */
export async function announceTicketOpened(
  userId: string,
  ticket: SupportTicket
): Promise<void> {
  const { message } = await appendMessage({
    ticketId: ticket.id,
    direction: 'SYSTEM',
    systemKind: 'TICKET_OPENED',
  })
  await pushMessage(userId, ticket, message.id)
  // No automatic greeting here, deliberately. This path is support opening the
  // conversation itself, and the greeting answers a user who reached out
  // ("we received your message… while an operator connects"). Sending it to
  // someone who wrote nothing, immediately before a live operator's own first
  // line, would be nonsense on both counts.
}

/**
 * Post support's automatic greeting into a ticket, at most once.
 *
 * `dedupeKey` carries the guarantee rather than a "was it just created?" flag:
 * a ticket can be opened by a plain message, by staging a file, or by support
 * itself, and each of those would otherwise need its own correct answer to
 * "did anyone greet yet?".
 *
 * Carries no text — only the code. The wording is resolved by the client in
 * whatever language the user is reading, which also means the greeting in an
 * old conversation re-reads correctly after they switch languages.
 */
async function greetOnce(userId: string, ticket: SupportTicket): Promise<void> {
  // Never greet a conversation an operator is already having.
  //
  // Support can open a ticket itself and write first; the user's reply is then
  // the first IN message, and an unconditional greeting would drop
  // "describe your situation while an operator connects" into the middle of a
  // live exchange with the operator who is right there. A human OUT message —
  // one with no `autoKind` — is exactly "support has already spoken".
  const humanReply = await prismaSupport.supportMessage.findFirst({
    where: { ticketId: ticket.id, direction: 'OUT', autoKind: null },
    select: { id: true },
  })
  if (humanReply) return

  const { message, created } = await appendMessage({
    ticketId: ticket.id,
    direction: 'OUT',
    autoKind: AUTO_GREETING,
    text: AUTO_TEXT_FALLBACK[AUTO_GREETING] ?? null,
    dedupeKey: `greet:${ticket.id}`,
    silent: true,
  })
  if (created) await pushMessage(userId, ticket, message.id)
}

/** Clear the badge and tell every open tab. */
export async function markRead(userId: string): Promise<number> {
  const { markThreadRead } = await import('./ticket.service')
  const unread = await markThreadRead(userId)
  const ticket = await findOpenTicket(userId)
  if (ticket) await pushTicket(userId, ticket)
  return unread
}
