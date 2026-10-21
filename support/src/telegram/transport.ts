import { InputFile, type Transformer } from 'grammy'

import { logger } from '@config/logger'

/**
 * Transport hardening for every Telegram call this service makes.
 *
 * Installed once as a grammY API transformer (`bot.api.config.use`), so it
 * covers the whole surface — including calls made by the updates router and
 * the attachment layer — instead of each call site inventing its own retry.
 *
 * Three problems it exists to solve, none of which the rest of the monorepo
 * has ever had to deal with:
 *
 *  1. Telegram answers a burst with `429 + retry_after`. A chat relay hits
 *     this on day one, and an unhandled 429 is a support reply that silently
 *     never arrives.
 *  2. The per-group limit is ~20 messages per MINUTE — far tighter than the
 *     ~30/s global one, and every ticket topic lives in the SAME group, so
 *     they all share that budget. Sends must queue, not fail.
 *  3. Telegram 5xx / TLS resets are routine. They deserve a retry; a 400
 *     ("message not modified", "chat not found") never does.
 *
 * The maths (token bucket, backoff, error classification) is exported as pure
 * functions so it can be tested without a bot token or a clock.
 */

// ─── Token bucket ─────────────────────────────────────────────────────────

export interface BucketConfig {
  /** Burst size: how many calls may go out back to back after an idle spell. */
  capacity: number
  /** Steady-state refill rate, in tokens per millisecond. */
  refillPerMs: number
}

export interface BucketState {
  /** Tokens available at `updatedAtMs`. May be fractional. */
  tokens: number
  /**
   * Wall clock the token count is valid for. Deliberately allowed to sit in
   * the FUTURE — that is how an already-handed-out slot is recorded.
   */
  updatedAtMs: number
}

export interface Reservation {
  /** How long the caller must wait before it may send. */
  delayMs: number
  state: BucketState
}

export function fullBucket(config: BucketConfig, nowMs: number): BucketState {
  return { tokens: config.capacity, updatedAtMs: nowMs }
}

/**
 * Claim one send slot, returning how long the caller has to wait for it.
 *
 * The elapsed term is deliberately NOT clamped at zero. When `updatedAtMs` is
 * in the future (a slot handed to an earlier caller), the negative term is
 * exactly what makes this caller queue BEHIND it rather than being told to
 * wait the same interval from now — without it, ten simultaneous relays would
 * all sleep 3s and then all fire at once, which is the burst we are avoiding.
 */
export function reserveToken(
  state: BucketState,
  nowMs: number,
  config: BucketConfig
): Reservation {
  const tokens = Math.min(
    config.capacity,
    state.tokens + (nowMs - state.updatedAtMs) * config.refillPerMs
  )

  if (tokens >= 1) {
    return { delayMs: 0, state: { tokens: tokens - 1, updatedAtMs: nowMs } }
  }

  const delayMs = Math.ceil((1 - tokens) / config.refillPerMs)
  return { delayMs, state: { tokens: 0, updatedAtMs: nowMs + delayMs } }
}

/**
 * Freeze a bucket for `ms`.
 *
 * Used when Telegram answers `retry_after`: its number is authoritative and
 * applies to the whole chat, so every queued send behind the one that tripped
 * it has to wait too.
 *
 * The bucket resumes with exactly ONE token rather than zero — `retry_after`
 * means "you may send again after N seconds", so making the next caller then
 * wait out a further refill interval would turn every flood wait into
 * `retry_after + 3s`. Never shortens a freeze that already reaches further
 * out, and never hands back tokens in that case either.
 */
export function penalizeBucket(
  state: BucketState,
  nowMs: number,
  ms: number
): BucketState {
  const until = nowMs + ms
  if (until <= state.updatedAtMs) return state
  return { tokens: 1, updatedAtMs: until }
}

// ─── Backoff ──────────────────────────────────────────────────────────────

export interface BackoffConfig {
  baseMs: number
  maxMs: number
}

/**
 * Equal-jitter exponential backoff: half the capped delay is fixed, half is
 * random. Full jitter would occasionally retry almost instantly (pointless
 * against a struggling server); no jitter would make concurrent relays retry
 * in lockstep and re-create the burst that failed.
 */
export function backoffDelayMs(
  attempt: number,
  config: BackoffConfig,
  random: () => number = Math.random
): number {
  const ceiling = Math.min(
    config.maxMs,
    config.baseMs * 2 ** Math.max(0, attempt - 1)
  )
  const half = ceiling / 2
  return Math.round(half + random() * half)
}

// ─── Error classification ─────────────────────────────────────────────────

export type FailureKind = 'flood' | 'transient' | 'fatal'

/**
 * `undefined` means the call never produced an HTTP status at all (socket
 * reset, DNS blip, timeout) — always worth one more try. A 4xx other than 429
 * is Telegram telling us the request itself is wrong; retrying it just burns
 * the rate budget and delays the log line that explains the bug.
 */
export function classifyFailure(errorCode?: number): FailureKind {
  if (errorCode === undefined) return 'transient'
  if (errorCode === 429) return 'flood'
  if (errorCode >= 500) return 'transient'
  return 'fatal'
}

/**
 * Why a send can never land as addressed — the destination is wrong, not busy.
 *
 * `classifyFailure` above answers the question this transformer asks ("retry
 * this HTTP call?"). This one answers the question the RELAY RETRY LOOP asks
 * across restarts ("is another attempt in a minute worth anything?"), and the
 * two are not the same: both say "don't retry now" about a 400, but only this
 * one can tell a deleted topic (recoverable — create a new one) from a wrong
 * chat id or a kicked bot (a human has to fix the group).
 *
 * Description matching rather than error_code, because Telegram answers all
 * three with the same 400/403 and puts the only distinguishing information in
 * free text. Loose patterns on purpose: the wording has changed before, and
 * mistaking a permanent failure for a transient one only costs a few retries,
 * while the reverse strands a user's message.
 */
export type PermanentFailure =
  | 'topic-missing'
  | 'topic-closed'
  | 'chat-missing'
  | 'bot-removed'

const PERMANENT_DESCRIPTIONS: Array<[RegExp, PermanentFailure]> = [
  [/message thread not found|topic_deleted/i, 'topic-missing'],
  // An ARCHIVED topic, which is a different thing from a deleted one: the
  // thread and its history are intact and it can be reopened. Without this
  // entry the send is classified as transient, burns every retry and then goes
  // to Sentry — while the user's message quietly never arrives.
  [/topic_closed/i, 'topic-closed'],
  [/chat not found|group chat was upgraded/i, 'chat-missing'],
  [
    /bot was kicked|bot is not a member|not enough rights|have no rights|need administrator rights|chat_write_forbidden/i,
    'bot-removed',
  ],
]

export function classifyPermanentFailure(
  errorCode: number | undefined,
  description: string | undefined
): PermanentFailure | null {
  // A network error or a 5xx says nothing about the destination — Telegram
  // never got far enough to have an opinion about it.
  if (classifyFailure(errorCode) !== 'fatal') return null

  const text = description ?? ''
  for (const [pattern, kind] of PERMANENT_DESCRIPTIONS) {
    if (pattern.test(text)) return kind
  }
  return null
}

/** Non-`ok` Bot API envelope, narrowed to the fields we act on. */
interface TelegramFailure {
  error_code?: number
  description?: string
  parameters?: { retry_after?: number }
}

// ─── Scheduler ────────────────────────────────────────────────────────────

export class QueueOverflowError extends Error {
  constructor(chatKey: string, depth: number) {
    super(
      `[telegram] send queue for chat ${chatKey} is full (${depth} waiting)`
    )
    this.name = 'QueueOverflowError'
  }
}

export interface SchedulerConfig {
  /** Per-chat budget. Telegram: ~20 messages per minute to one group. */
  chat: BucketConfig
  /** Cross-chat budget. Telegram: ~30 messages per second overall. */
  global: BucketConfig
  /**
   * Refuse rather than queue past this depth. An hours-long Telegram outage
   * must not turn into an unbounded array of pending relays holding file
   * handles and memory — the messages are already safe in Postgres, and
   * support reads them from the platform side.
   */
  maxQueueDepth: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Serializes sends per chat and paces them against both buckets.
 *
 * FIFO per chat is not just politeness: a support topic where the reply lands
 * above the question it answers is unreadable, and Telegram gives no ordering
 * guarantee for concurrent requests.
 */
export class SendScheduler {
  private readonly chatBuckets = new Map<string, BucketState>()
  private readonly tails = new Map<string, Promise<unknown>>()
  private readonly depths = new Map<string, number>()
  private globalBucket: BucketState
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly config: SchedulerConfig) {
    this.now = config.now ?? Date.now
    this.sleep = config.sleep ?? defaultSleep
    this.globalBucket = fullBucket(config.global, this.now())
  }

  /** Claim a slot; returns the total wait across both buckets. */
  public reserve(chatKey: string | null): number {
    const now = this.now()
    let delayMs = 0

    if (chatKey !== null) {
      const state =
        this.chatBuckets.get(chatKey) ?? fullBucket(this.config.chat, now)
      const reserved = reserveToken(state, now, this.config.chat)
      this.chatBuckets.set(chatKey, reserved.state)
      delayMs = reserved.delayMs
    }

    // Reserved from the moment the chat bucket lets this call through, so the
    // two budgets compose instead of double-counting the same wait.
    const global = reserveToken(
      this.globalBucket,
      now + delayMs,
      this.config.global
    )
    this.globalBucket = global.state
    return delayMs + global.delayMs
  }

  /** Apply Telegram's `retry_after` to the chat that tripped it. */
  public penalize(chatKey: string | null, ms: number): void {
    const now = this.now()
    if (chatKey !== null) {
      const state =
        this.chatBuckets.get(chatKey) ?? fullBucket(this.config.chat, now)
      this.chatBuckets.set(chatKey, penalizeBucket(state, now, ms))
    }
    // A per-chat flood wait says nothing about the global budget, so only a
    // token pause here — freezing every chat for another chat's minute-long
    // penalty would be self-inflicted downtime.
    this.globalBucket = penalizeBucket(
      this.globalBucket,
      now,
      Math.min(ms, 1000)
    )
  }

  public schedule<T>(
    chatKey: string | null,
    task: () => Promise<T>
  ): Promise<T> {
    if (chatKey === null) return this.runPaced(null, task)

    const depth = (this.depths.get(chatKey) ?? 0) + 1
    if (depth > this.config.maxQueueDepth) {
      return Promise.reject(new QueueOverflowError(chatKey, depth - 1))
    }
    this.depths.set(chatKey, depth)

    const previous = this.tails.get(chatKey) ?? Promise.resolve()
    // Both settle handlers run the task: one failed relay must never break the
    // chain for the messages queued behind it.
    const run = previous.then(
      () => this.runPaced(chatKey, task),
      () => this.runPaced(chatKey, task)
    )

    const tail: Promise<void> = run.then(
      () => this.release(chatKey, tail),
      () => this.release(chatKey, tail)
    )
    this.tails.set(chatKey, tail)
    return run
  }

  private async runPaced<T>(
    chatKey: string | null,
    task: () => Promise<T>
  ): Promise<T> {
    const delayMs = this.reserve(chatKey)
    if (delayMs > 0) await this.sleep(delayMs)
    return task()
  }

  private release(chatKey: string, tail: Promise<unknown>): void {
    const left = (this.depths.get(chatKey) ?? 1) - 1
    if (left > 0) {
      this.depths.set(chatKey, left)
      return
    }
    this.depths.delete(chatKey)
    // Only the LAST link may drop the chain — a newer send may already have
    // chained onto a tail that is not this one.
    if (this.tails.get(chatKey) === tail) this.tails.delete(chatKey)
  }
}

// ─── Defaults ─────────────────────────────────────────────────────────────

/** ~20 messages/minute to one group, with a 20-message opening burst. */
export const DEFAULT_CHAT_BUCKET: BucketConfig = {
  capacity: 20,
  refillPerMs: 20 / 60_000,
}

/** ~30 messages/second overall. */
export const DEFAULT_GLOBAL_BUCKET: BucketConfig = {
  capacity: 30,
  refillPerMs: 30 / 1000,
}

export const DEFAULT_BACKOFF: BackoffConfig = { baseMs: 500, maxMs: 8_000 }

/** One initial call plus three retries. */
export const DEFAULT_MAX_ATTEMPTS = 4

/**
 * Give up on a flood wait longer than this instead of parking the whole topic
 * queue behind it. The message is already persisted; holding the queue would
 * delay every later reply too.
 */
export const DEFAULT_MAX_RETRY_AFTER_MS = 60_000

/**
 * Methods that count against the per-group message budget.
 *
 * Everything else (getFile, setWebhook, getMe, pin/unpin, closeForumTopic)
 * only passes through the global bucket — throttling those at 20/min would add
 * minutes of latency to operations Telegram does not meter that way.
 *
 * `sendChatAction` is absent BY DESIGN, not by omission. A typing indicator is
 * not a message: Telegram does not charge it against the group's ~20/min
 * budget, and it expires by itself after ~5s. Listing it here would do two
 * kinds of damage — it would spend message tokens that a real support reply
 * needs, and it would chain the action into the per-chat FIFO behind whatever
 * relays are queued, so the "typing…" bubble would appear minutes after the
 * user stopped typing. An indicator that late is worse than none. Its rate
 * ceiling lives in `chat.service.userTyping` instead (one per ticket per 4s,
 * claimed in Redis so it holds across replicas).
 */
const GROUP_MESSAGE_METHODS = new Set<string>([
  'sendMessage',
  'sendPhoto',
  'sendDocument',
  'sendVideo',
  'sendAnimation',
  'sendAudio',
  'sendVoice',
  'sendMediaGroup',
  'copyMessage',
  'forwardMessage',
  'createForumTopic',
])

function chatKeyFor(method: string, payload: unknown): string | null {
  if (!GROUP_MESSAGE_METHODS.has(method)) return null
  const chatId = (payload as { chat_id?: number | string } | null | undefined)
    ?.chat_id
  return chatId === undefined || chatId === null ? null : String(chatId)
}

/**
 * True when the payload uploads bytes.
 *
 * Such a call is sent ONCE, never retried: a grammY `InputFile` is single-use
 * and throws "Cannot reuse InputFile data source" on the second attempt — which
 * would replace the real failure with a confusing one and burn the whole retry
 * budget doing it. Re-uploading needs a fresh source, which only the call site
 * can build (see `attachmentSource` in api.ts).
 */
function carriesUpload(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false
  for (const value of Object.values(payload)) {
    if (value instanceof InputFile) return true
    // sendMediaGroup hides its files one level down, inside the media array.
    if (
      Array.isArray(value) &&
      value.some(
        (item) =>
          typeof item === 'object' &&
          item !== null &&
          (item as { media?: unknown }).media instanceof InputFile
      )
    ) {
      return true
    }
  }
  return false
}

export interface TransportConfig {
  maxAttempts?: number
  backoff?: BackoffConfig
  maxRetryAfterMs?: number
  scheduler?: SendScheduler
  random?: () => number
  sleep?: (ms: number) => Promise<void>
}

/**
 * Build the transformer.
 *
 * Note what it does NOT do: it never swallows a failure. A non-retryable
 * response is returned untouched so grammY still raises `GrammyError` at the
 * call site — turning that into a logged `null` is the wrapper's job in
 * `api.ts`, because only the call site knows whether the caller can cope with
 * nothing coming back.
 */
export function createHardenedTransport(
  config: TransportConfig = {}
): Transformer {
  const maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const backoff = config.backoff ?? DEFAULT_BACKOFF
  const maxRetryAfterMs = config.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS
  const random = config.random ?? Math.random
  const sleep = config.sleep ?? defaultSleep
  const scheduler =
    config.scheduler ??
    new SendScheduler({
      chat: DEFAULT_CHAT_BUCKET,
      global: DEFAULT_GLOBAL_BUCKET,
      maxQueueDepth: 200,
      sleep,
    })

  return async (prev, method, payload, signal) => {
    const name = String(method)
    const chatKey = chatKeyFor(name, payload)
    const attemptBudget = carriesUpload(payload) ? 1 : maxAttempts

    const attemptAll = async (): Promise<Awaited<ReturnType<typeof prev>>> => {
      for (let attempt = 1; attempt <= attemptBudget; attempt++) {
        let response: Awaited<ReturnType<typeof prev>>
        try {
          response = await prev(method, payload, signal)
        } catch (err) {
          // No envelope at all — grammY throws before Telegram answered.
          if (attempt >= attemptBudget || signal?.aborted) throw err
          const wait = backoffDelayMs(attempt, backoff, random)
          logger.warn(
            `[telegram] ${name} network error (attempt ${attempt}/${attemptBudget}), retrying in ${wait}ms: ${
              (err as Error).message
            }`
          )
          await sleep(wait)
          continue
        }

        if (response.ok) return response

        const failure = response as unknown as TelegramFailure
        const kind = classifyFailure(failure.error_code)

        if (kind === 'flood') {
          // Telegram's own number, not our guess. Applied to the bucket even
          // when we give up, so the next send does not walk into the same wall.
          const retryAfterMs = Math.max(
            1_000,
            (failure.parameters?.retry_after ?? 1) * 1_000
          )
          scheduler.penalize(chatKey, retryAfterMs)
          if (
            retryAfterMs > maxRetryAfterMs ||
            attempt >= attemptBudget ||
            signal?.aborted
          ) {
            logger.error(
              `[telegram] ${name} flood-limited for ${retryAfterMs}ms — giving up after ${attempt} attempt(s)`
            )
            return response
          }
          logger.warn(
            `[telegram] ${name} flood-limited, waiting ${retryAfterMs}ms (attempt ${attempt}/${attemptBudget})`
          )
          await sleep(retryAfterMs)
          continue
        }

        if (kind === 'fatal' || attempt >= attemptBudget || signal?.aborted) {
          return response
        }

        const wait = backoffDelayMs(attempt, backoff, random)
        logger.warn(
          `[telegram] ${name} failed with ${failure.error_code} (attempt ${attempt}/${attemptBudget}), retrying in ${wait}ms: ${
            failure.description ?? 'no description'
          }`
        )
        await sleep(wait)
      }

      // Unreachable: the final iteration always returns or throws.
      throw new Error(`[telegram] ${name}: retry loop exhausted`)
    }

    return scheduler.schedule(chatKey, attemptAll)
  }
}
