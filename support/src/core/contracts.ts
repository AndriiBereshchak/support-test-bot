/**
 * Wire contract for the support chat.
 *
 * Three consumers must agree on these shapes:
 *   1. this service (producer),
 *   2. the exchange proxy controller (pass-through, no reshaping),
 *   3. the browser (platform-web `useProcessUserSocket` + the chat UI).
 *
 * Anything sent to the browser is defined here and nowhere else. Keep it
 * JSON-only: it crosses a NATS hop and a WebSocket frame, so no Date, no
 * Decimal, no BigInt (exchange monkey-patches JSON.stringify with json-bigint,
 * this service does not — BigInt would throw).
 */

/**
 * Support's automatic replies. Stored in `SupportMessage.autoKind` and surfaced
 * to the browser through the same `systemKind` field as the lifecycle pills —
 * one field for "render this code, not stored text".
 */
export const AUTO_GREETING = 'agent_greeting'
export const AUTO_FAREWELL = 'agent_farewell'

/**
 * Russian fallback stored in `text` alongside the code.
 *
 * The code alone is the better contract — the client translates it into
 * whatever language the user is reading. But a browser holding a bundle older
 * than this feature knows no codes and no auto-text, and would render a bubble
 * with nothing in it. Storing the wording too costs a few hundred bytes a
 * ticket and makes every old tab degrade to readable Russian instead of an
 * empty grey box. Newer clients ignore it and translate the code.
 */
export const AUTO_TEXT_FALLBACK: Record<string, string> = {
  [AUTO_GREETING]:
    'Здравствуйте.\n\nМы получили ваше сообщение. Пожалуйста, опишите ситуацию как можно подробнее, пока оператор подключается к чату.',
  [AUTO_FAREWELL]:
    'На данный момент чат будет закрыт.\n\nЕсли у вас возникнут дополнительные вопросы или понадобится помощь, просто напишите нам снова в этот чат. Мы всегда готовы помочь.',
}

/** Message author side, as the browser understands it. */
export type SupportDirection = 'in' | 'out' | 'system'

export type SupportAttachmentKindDto =
  | 'image'
  | 'pdf'
  | 'video'
  | 'document'
  // Telegram sticker — same bytes as an image, drawn bare by the client.
  | 'sticker'

export interface SupportAttachmentDto {
  id: string
  kind: SupportAttachmentKindDto
  /** Original (sanitized) name — shown in the bubble, used as download name. */
  name: string
  mimeType: string
  sizeBytes: number
  /**
   * Path the browser fetches, relative to the platform API origin. Relative on
   * purpose: the FE prefixes its own origin so links keep working on every
   * mirror domain.
   *
   * TWO shapes, decided by `kind` (see `toAttachmentDto`):
   *   - `image` / `video` -> `/support-files/media/<ticketId>/<uuid>.<ext>`,
   *     a plain static file. Cacheable, and — the reason it exists — it answers
   *     Range requests, without which `<video>` cannot seek at all.
   *   - `pdf` / `document` -> `/v1/support-chat/files/<id>`, the authenticated
   *     stream. Those carry receipts and identity documents, and that route is
   *     also what names the download after `name` instead of a uuid.
   */
  url: string
  /**
   * Present for images so the UI can reserve space before the load. Never set
   * for video: nothing on the server decodes one (see attachment.service).
   */
  width?: number
  height?: number
  /**
   * The bytes were deleted by the retention sweep — the row and the file NAME
   * survive, the file does not. The UI must render a "removed" placeholder
   * instead of an <img>/<video>, whose URL would now 404.
   *
   * Support loses nothing: Telegram keeps its own copy of every relayed
   * attachment indefinitely, so the operator can still open it in the topic.
   */
  purged?: boolean
}

/** The support operator identity shown to the user — never a Telegram handle. */
export interface SupportAgentDto {
  id: string
  name: string
  title?: string
  /** Relative like `url` above; absent = render the default avatar. */
  avatarUrl?: string
}

export interface SupportMessageDto {
  id: string
  ticketId: string
  /** Gap-free per-ticket ordinal. The history cursor and the sort key. */
  seq: number
  direction: SupportDirection
  /** Raw text: newlines and every character preserved verbatim. */
  text: string | null
  attachments: SupportAttachmentDto[]
  /** Set only for `out` messages whose sender is a registered agent. */
  agent: SupportAgentDto | null
  /**
   * A code the client renders instead of stored text.
   *
   * `ticket_opened` / `ticket_closed` are the grey separator pills on `system`
   * messages. `agent_greeting` / `agent_farewell` ride on `out` messages and
   * render as ordinary support bubbles — the wording lives in the client's
   * translations so it follows the language the user is reading in.
   */
  systemKind:
    | 'ticket_opened'
    | 'ticket_closed'
    | 'agent_greeting'
    | 'agent_farewell'
    | null
  createdAt: string
  editedAt: string | null
}

export interface SupportTicketDto {
  id: string
  status: 'open' | 'closed'
  createdAt: string
  closedAt: string | null
  /** Rating of support's work, 1–5. null — not rated yet. */
  rating: number | null
}

/**
 * A closed conversation the user has not been asked to rate yet.
 *
 * Separate from `ticket`: that one holds the OPEN ticket, while the rating
 * window has to be shown for a closed one. This same field is also how the
 * window reaches those who were offline at the moment of closing — they missed
 * the WS push, but they read the thread on their next visit.
 */
export interface SupportPendingFeedback {
  ticketId: string
  closedAt: string | null
}

/**
 * GET /v1/support-chat/thread
 *
 * The user sees ONE continuous feed spanning every past ticket, separated by
 * `system` messages — so paging is by an opaque cursor over the whole feed,
 * not by the per-ticket `seq` (which restarts at 1 for each new ticket).
 */
export interface SupportThreadResponse {
  /** The currently OPEN ticket, or null — then the UI shows the empty state. */
  ticket: SupportTicketDto | null
  /** Oldest-first, ready to render top to bottom. */
  messages: SupportMessageDto[]
  /** True when older messages exist above `messages[0]`. */
  hasMore: boolean
  /** Cursor to pass back as `beforeId` to fetch the previous page. */
  nextCursor: string | null
  /** Unread `out` messages across every ticket; drives the badge. */
  unread: number
  /** The closed conversation waiting to be rated, or null. */
  pendingFeedback: SupportPendingFeedback | null
  /**
   * Up to which moment the user is barred from writing to support, ISO. null —
   * there is no ban.
   *
   * A property, not an event: nothing is sent to the user, he sees the
   * restriction only when he opens the window himself. That is why it rides in
   * the thread rather than in a push of its own.
   */
  mutedUntil: string | null
}

// ─── WebSocket push ───────────────────────────────────────────────────────
//
// Delivered through the EXISTING user socket: this service publishes a
// `ws.fanout` envelope and exchange emits `data` verbatim to the browser. So
// `data` must itself be `{ action, ... }` — one extra wrapping level and the
// FE silently drops the frame.
//
// New action strings (deliberately NOT the legacy `message_from_support` /
// `support_chat_closed`, which still have live handlers pointing at the old
// RTK Query cache).

export const SUPPORT_WS_ACTIONS = {
  message: 'support_message',
  messageUpdated: 'support_message_updated',
  ticketUpdated: 'support_ticket_updated',
  muteUpdated: 'support_mute_updated',
} as const

export interface SupportMessagePush {
  action: typeof SUPPORT_WS_ACTIONS.message
  message: SupportMessageDto
  ticket: SupportTicketDto
  /** Recomputed total, so the badge never drifts from the server. */
  unread: number
  /**
   * The sender's own `requestId`, echoed back on IN messages.
   *
   * Without it the sending tab cannot tell this push apart from a brand-new
   * message: it dedupes by the server id, which the optimistic bubble does not
   * have yet, so it appends a SECOND bubble and the placeholder only disappears
   * when the HTTP response lands — a visible double-message flash for as long
   * as that race lasts. With the id, the browser replaces the placeholder in
   * place and nothing flickers.
   */
  requestId?: string | null
}

/** Emitted when an agent edits (or deletes) their Telegram message. */
export interface SupportMessageUpdatedPush {
  action: typeof SUPPORT_WS_ACTIONS.messageUpdated
  id: string
  ticketId: string
  text: string | null
  editedAt: string | null
  /** True = the message was removed; the UI drops the bubble. */
  deleted: boolean
}

/** Ticket lifecycle (opened / closed / unread reset). */
export interface SupportTicketUpdatedPush {
  action: typeof SUPPORT_WS_ACTIONS.ticketUpdated
  ticket: SupportTicketDto
  unread: number
  /**
   * Filled in at the moment of closing — the browser uses it to open the
   * rating window straight away, without waiting for a thread reload.
   */
  pendingFeedback?: SupportPendingFeedback | null
}

/**
 * The ban on writing to support was granted or lifted.
 *
 * An action of its own rather than a field on `ticketUpdated`: the ban lives
 * outside tickets — it is granted and lifted when there is no open
 * conversation at all, and tying it to a ticket would mean the lift fails to
 * arrive in exactly the case it is made for.
 *
 * For the user this is NOT a notification: the screen shows the state, there
 * is no sound and no popup here, by the customer's decision.
 */
export interface SupportMuteUpdatedPush {
  action: typeof SUPPORT_WS_ACTIONS.muteUpdated
  /** ISO moment when it ends; null — there is no ban any more. */
  mutedUntil: string | null
}

export type SupportPush =
  | SupportMessagePush
  | SupportMessageUpdatedPush
  | SupportTicketUpdatedPush
  | SupportMuteUpdatedPush

// ─── Internal API (exchange -> support) ───────────────────────────────────

/** POST /v1/internal/thread — body. */
export interface InternalThreadRequest {
  userId: string
  /** Opaque cursor from `nextCursor`; page backwards from it (exclusive). */
  beforeId?: string
  limit?: number
}

/** POST /v1/internal/messages — body. */
export interface InternalSendMessageRequest {
  userId: string
  text?: string
  attachmentIds?: string[]
  /**
   * Client-generated uuid. Makes the send idempotent end to end: a retried
   * request (flaky mobile network, double tap) collapses onto the same row
   * instead of posting the message twice into the Telegram topic.
   */
  requestId?: string
}

/**
 * POST /v1/internal/read — body.
 *
 * Marks the whole thread read. There is no partial "up to message X": the
 * badge is a single number for one continuous feed, and the user only sees it
 * by opening the window, at which point everything is on screen.
 */
export interface InternalMarkReadRequest {
  userId: string
}

/** POST /v1/internal/close — body. */
export interface InternalCloseTicketRequest {
  userId: string
}

/** POST /v1/internal/feedback — the rating of a closed conversation. */
export interface InternalFeedbackRequest {
  userId: string
  ticketId: string
  /** 1–5. */
  rating: number
  /** Optional comment; only arrives together with low ratings. */
  comment?: string | null
}

/**
 * POST /v1/internal/feedback/trustpilot — the user went off to leave a review.
 *
 * An endpoint of its own rather than a field on the rating: the click happens
 * AFTER the rating is submitted, on the window's second step, and may not
 * happen at all.
 */
export interface InternalTrustpilotClickRequest {
  userId: string
}

/**
 * POST /v1/internal/typing — body. Answers 204, always.
 *
 * One-way by nature: it drives Telegram's native "печатает…" indicator inside
 * the ticket topic. There is no push in the other direction because the Bot
 * API delivers no chat-action updates to bots at all — an agent typing in
 * Telegram is invisible to us, so no WS action exists for it.
 */
export interface InternalTypingRequest {
  userId: string
}

/** POST /v1/internal/attachments — multipart field names. */
export const ATTACHMENT_FIELD = 'file'
