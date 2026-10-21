/**
 * Pure text helpers for the Telegram side of the relay.
 *
 * Everything here is deterministic and dependency-free so the limits that
 * actually bite in production (4096-char messages, 1024-char captions, topic
 * names typed by hand) can be unit-tested without a bot token.
 */

/** Telegram's hard cap on `sendMessage` text. */
export const TELEGRAM_TEXT_LIMIT = 4096
/** Telegram's hard cap on a photo/document caption. */
export const TELEGRAM_CAPTION_LIMIT = 1024
/** Telegram's hard cap on a forum topic name. */
export const TELEGRAM_TOPIC_NAME_LIMIT = 128

/**
 * Escape the three characters Telegram's HTML parser treats as markup.
 *
 * Same three as `alert-bot.service.ts` — quotes do NOT need escaping outside
 * attribute values, and escaping them would leak `&quot;` into text that
 * support staff read.
 */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Split a long word-less run at hard boundaries, preferring spaces.
 *
 * The hard cut only ever happens for a single "word" longer than a whole
 * message — a base64 blob or a tracking URL — where there is no boundary to
 * respect in the first place.
 */
function splitLine(line: string, limit: number): string[] {
  const pieces: string[] = []
  let current = ''

  for (const word of line.split(' ')) {
    if (word.length > limit) {
      if (current.length) {
        pieces.push(current)
        current = ''
      }
      for (let i = 0; i < word.length; i += limit) {
        pieces.push(word.slice(i, i + limit))
      }
      continue
    }

    const projected = current.length
      ? current.length + 1 + word.length
      : word.length
    if (projected <= limit) {
      current = current.length ? `${current} ${word}` : word
      continue
    }
    if (current.length) pieces.push(current)
    current = word
  }

  if (current.length) pieces.push(current)
  return pieces
}

/**
 * Split text into Telegram-sized chunks on line boundaries.
 *
 * Users paste stack traces, wallet dumps and bank statements into support
 * chats, so the split must preserve the shape of what they wrote: newlines
 * first, spaces second, mid-word only as a last resort. Chunks that are pure
 * whitespace are dropped — Telegram rejects them with a 400 and they carry no
 * information anyway.
 */
export function splitText(text: string, limit = TELEGRAM_TEXT_LIMIT): string[] {
  if (!text.length) return []
  if (limit <= 0) return [text]
  if (text.length <= limit) return text.trim().length ? [text] : []

  const chunks: string[] = []
  let current = ''
  const flush = (): void => {
    if (current.trim().length) chunks.push(current)
    current = ''
  }

  for (const line of text.split('\n')) {
    const projected = current.length
      ? current.length + 1 + line.length
      : line.length
    if (projected <= limit) {
      current = current.length ? `${current}\n${line}` : line
      continue
    }

    flush()
    if (line.length <= limit) {
      current = line
      continue
    }

    // Keep the tail of an over-long line buffered so the following lines can
    // still join it — otherwise every wrapped line would start a new message.
    const pieces = splitLine(line, limit)
    const tail = pieces.pop()
    for (const piece of pieces) {
      if (piece.trim().length) chunks.push(piece)
    }
    current = tail ?? ''
  }

  flush()
  return chunks
}

/** First 8 characters of the ticket uuid — what support staff read out loud. */
export function shortTicketId(ticketId: string): string {
  return ticketId.replace(/-/g, '').slice(0, 8).toLowerCase()
}

/**
 * Topic title: `<nId> · <short ticket id>`.
 *
 * Both halves are load-bearing — the nId is what an operator searches the
 * admin panel by, and the short id is what `parseTopicName` matches a
 * hand-created topic back onto.
 *
 * Deliberately carries NO status marker: open/closed is shown by the topic's
 * own icon (see `topic-icons.ts`), which Telegram renders in the forum list
 * next to the title. Putting it in the name too would mean rewriting the title
 * on close — and hand-made topics have titles an operator chose.
 */
export function formatTopicName(userNId: number, ticketId: string): string {
  return `${userNId} · ${shortTicketId(ticketId)}`.slice(
    0,
    TELEGRAM_TOPIC_NAME_LIMIT
  )
}

/**
 * Title of a user's PERMANENT topic: `<nId> · <email>`.
 *
 * No ticket id in it — the topic outlives every individual ticket now, so an
 * id there would name only the first conversation and mislead on all the rest.
 * The email is what an operator actually recognises a person by, and it keeps
 * the topic searchable in Telegram's own topic list.
 *
 * Falls back to the nId alone when there is no email: a title of `123 · ` reads
 * like something is broken.
 */
export function formatThreadTopicName(
  userNId: number,
  email?: string | null
): string {
  const clean = email?.trim()
  const name = clean ? `${userNId} · ${clean}` : `${userNId}`
  return name.slice(0, TELEGRAM_TOPIC_NAME_LIMIT)
}

export interface ParsedTopicName {
  userNId: number
  ticketShortId: string
}

// Liberal on purpose: admins create topics by hand and type whatever separator
// their keyboard offers, and Telegram clients happily prepend emoji. A
// separator is REQUIRED though — without one, `123456` is ambiguous between
// "nId 123, ticket 456" and "nId 123456, no ticket", and guessing wrong binds
// a stranger's topic to a live ticket.
const TOPIC_NAME_RE =
  /^[^0-9A-Za-z]*(\d{1,12})(?:\s+|\s*[·•∙・\-–—_|:/\\,.]+\s*)([0-9A-Za-z][0-9A-Za-z-]{2,63})\s*$/

/** Inverse of `formatTopicName`; null when the name is not ours to interpret. */
export function parseTopicName(name: string): ParsedTopicName | null {
  const match = TOPIC_NAME_RE.exec(name)
  if (!match) return null

  const [, rawNId, rawShortId] = match
  if (!rawNId || !rawShortId) return null

  const userNId = Number(rawNId)
  if (!Number.isSafeInteger(userNId) || userNId <= 0) return null

  return { userNId, ticketShortId: rawShortId.toLowerCase() }
}
