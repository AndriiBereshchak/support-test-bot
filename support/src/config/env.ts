import dotenv from 'dotenv'

// Safety net for entry points that are not server.ts (one-off scripts, a test
// run without the setup file). server.ts loads the same file from `load-env`
// before anything else, so by boot time this call is a no-op — `quiet` keeps it
// from printing "injected env (0) from .env" on every start, which reads like a
// configuration failure when it is the opposite.
dotenv.config({ quiet: true })

// House style: read once, export as consts, `?? default`. Anything without a
// safe default is validated in `assertRequiredEnv()` (called from server.ts)
// so a misconfigured deploy dies at boot instead of at the first user message.

export const NODE_ENV = process.env.NODE_ENV ?? 'development'
export const APP_NAME = process.env.APP_NAME ?? 'binodex-support'

// HTTP. The service is NOT publicly exposed: exchange proxies both the user
// API and the Telegram webhook to it over the docker network.
export const APP_PORT = process.env.APP_PORT
  ? Number(process.env.APP_PORT)
  : 3020

// Prometheus metrics on a separate port, published only on the WireGuard IP
// (same convention as exchange-api).
export const METRICS_ENABLED =
  (process.env.METRICS_ENABLED ?? 'true') !== 'false'
export const METRICS_PORT = process.env.METRICS_PORT
  ? Number(process.env.METRICS_PORT)
  : 9464

// Shared secret for the exchange -> support hop. Exchange sends it in
// `x-internal-token`; without a match every /v1/internal route 401s. Prevents
// anything else on the docker network from impersonating the proxy.
export const INTERNAL_TOKEN = process.env.SUPPORT_INTERNAL_TOKEN ?? ''

// ─── Telegram ────────────────────────────────────────────────────────────
export const TELEGRAM_BOT_TOKEN = process.env.SUPPORT_BOT_TOKEN ?? ''
// The forum supergroup that holds one topic per ticket. Negative id.
export const TELEGRAM_CHAT_ID = process.env.SUPPORT_CHAT_ID
  ? Number(process.env.SUPPORT_CHAT_ID)
  : 0
// Telegram echoes this on every webhook call (`X-Telegram-Bot-Api-Secret-Token`).
// Requests without it are dropped before any parsing happens.
export const TELEGRAM_WEBHOOK_SECRET = process.env.SUPPORT_WEBHOOK_SECRET ?? ''
// Public URL Telegram posts updates to, e.g.
// https://api.binodex.io/v1/support/tg-webhook. Empty = don't register a
// webhook at boot (local dev / tests).
export const TELEGRAM_WEBHOOK_URL = process.env.SUPPORT_WEBHOOK_URL ?? ''

// ─── Data ────────────────────────────────────────────────────────────────
export const DATABASE_SUPPORT = process.env.DATABASE_SUPPORT ?? ''
export const REDIS_HOST = process.env.REDIS_HOST ?? '127.0.0.1'
export const REDIS_PORT = process.env.REDIS_PORT
  ? Number(process.env.REDIS_PORT)
  : 6379
export const REDIS_PASSWORD = process.env.REDIS_PASSWORD ?? ''
export const NATS_URL = process.env.NATS_URL ?? 'nats://127.0.0.1:4222'
export const NATS_USER = process.env.NATS_USER ?? ''
export const NATS_PASSWORD = process.env.NATS_PASSWORD ?? ''

// ─── Files ───────────────────────────────────────────────────────────────
// Written here, served read-only by exchange at /support-files/* so links
// resolve on every mirror domain without extra nginx server_names.
export const SUPPORT_FILES_DIR =
  process.env.SUPPORT_FILES_DIR ?? '/app/storage/support'
/**
 * Read a numeric limit, falling back to the documented default for anything
 * that is not a positive number.
 *
 * A plain `Number(raw) || default` is wrong here: a typo makes `Number()`
 * return NaN, and NaN compares false against everything — the storage guard
 * would be silently OFF, which is exactly the failure it exists to prevent.
 * Falling back to the default fails towards the limit still being enforced.
 */
const limitEnv = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw)
  return raw && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const SIZE_UNITS: Record<string, number> = {
  '': 1,
  B: 1,
  K: 1024,
  KB: 1024,
  M: 1024 ** 2,
  MB: 1024 ** 2,
  G: 1024 ** 3,
  GB: 1024 ** 3,
  T: 1024 ** 4,
  TB: 1024 ** 4,
}

/**
 * A byte size written the way a human writes it: `20M`, `200MB`, `50G`, `1.5G`,
 * or a bare byte count.
 *
 * Base 1024, matching `numfmt --from=iec` in infra/scripts/support-files-quota.sh
 * — the filesystem cap and the service quota that must stay below it are set by
 * the same operator minutes apart, and `50G` meaning two different numbers in
 * the two places is a trap nobody would find until the disk filled.
 *
 * THROWS on a malformed value instead of falling back. That is the opposite of
 * `limitEnv` above, and deliberate: a missing variable means "use the default",
 * but `SUPPORT_STORAGE_QUOTA=50 Gb!` means the operator intended a number and
 * got it wrong. Quietly enforcing 4 GB on a 50 GB volume would look like it
 * worked right up until uploads started failing for no visible reason.
 */
const sizeEnv = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw.trim() === '') return fallback

  const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(raw)
  const unit = match ? SIZE_UNITS[(match[2] ?? '').toUpperCase()] : undefined
  if (!match || unit === undefined) {
    throw new Error(
      `[support] cannot parse size "${raw}" — use a number with an optional ` +
        `unit, e.g. 20M, 200MB, 50G, 1.5G, or a byte count.`
    )
  }

  const bytes = Math.floor(Number(match[1]) * unit)
  if (!Number.isFinite(bytes) || bytes <= 0) {
    throw new Error(`[support] size "${raw}" resolves to ${bytes} bytes`)
  }
  return bytes
}

// Hard ceiling for a single upload in either direction. Telegram caps *bot
// downloads* at 20 MB, so anything above that can be sent by an agent but
// never fetched by us — keep the two aligned.
export const MAX_UPLOAD_BYTES = sizeEnv(
  process.env.SUPPORT_MAX_UPLOAD_SIZE,
  20 * 1024 * 1024
)

// Age at which the retention pass unlinks the BYTES of an attachment (the row
// survives — see SupportAttachment.purgedAt). 7 days: a support conversation
// is resolved in hours, and Telegram keeps its own copy of every relayed file
// forever, so nothing an operator needs is lost when the volume stops holding
// screenshots from last quarter.
export const FILE_RETENTION_DAYS = limitEnv(
  process.env.SUPPORT_FILE_RETENTION_DAYS,
  7
)

// Total non-purged bytes ONE user may have on the volume. 200 MB is ten of the
// largest uploads we accept (MAX_UPLOAD_BYTES) — well past what a real ticket
// needs, and small enough that a hundred abusive accounts cannot fill the disk
// between two retention passes.
export const USER_STORAGE_QUOTA_BYTES = sizeEnv(
  process.env.SUPPORT_USER_STORAGE_QUOTA,
  200 * 1024 * 1024
)

// Uploads one user may start per hour. A person attaching evidence to a ticket
// sends a handful; 30 leaves that untouched while capping a scripted loop at a
// rate a human pace never reaches.
export const UPLOAD_RATE_PER_HOUR = limitEnv(
  process.env.SUPPORT_UPLOAD_RATE_PER_HOUR,
  30
)

// The size the operator wants the shared support-files volume capped at. Past
// it EVERY upload is refused, including the Telegram relay: a full volume is
// also exchange's volume, and losing one attachment is cheaper than losing
// whatever else the host needs to write.
//
// MUST BE SET PER ENVIRONMENT, and set BELOW the size of the filesystem
// provisioned by infra/scripts/support-files-quota.sh (prod 50G, dev 5G). The
// two limits guard the same disk from opposite sides: this one refuses an
// upload politely, with a message the user understands; the filesystem refuses
// it with ENOSPC in the middle of a write, which surfaces as a generic failure.
// Leaving this ABOVE the image size means the ugly one always wins. The default
// below is deliberately conservative for the same reason — an unset value must
// not out-run a small volume.
export const STORAGE_QUOTA_BYTES = sizeEnv(
  process.env.SUPPORT_STORAGE_QUOTA,
  4 * 1024 * 1024 * 1024
)

// ─── Behaviour ───────────────────────────────────────────────────────────
// Idle time after which the sweeper closes an OPEN ticket.
export const TICKET_IDLE_CLOSE_HOURS = process.env.SUPPORT_IDLE_CLOSE_HOURS
  ? Number(process.env.SUPPORT_IDLE_CLOSE_HOURS)
  : 48

// How long a user message may sit unanswered before the bot nudges the topic.
// Minutes, because this one is measured against somebody actively waiting with
// the chat open — unlike the idle-close threshold, which is measured in hours.
export const REPLY_REMINDER_MINUTES = limitEnv(
  process.env.SUPPORT_REPLY_REMINDER_MINUTES,
  10
)

// ─── Relay retry ─────────────────────────────────────────────────────────
// The delivery guarantee for user messages: an IN message whose `tgMessageId`
// is still NULL never reached Telegram, and the worker keeps trying until it
// does. See relay-retry.service.ts.

// How often the worker drains that backlog. Seconds, not minutes: this runs
// after a user message has ALREADY failed to reach support, so the clock the
// interval is measured against is somebody waiting for an answer.
export const RELAY_RETRY_INTERVAL_SEC = limitEnv(
  process.env.SUPPORT_RELAY_RETRY_INTERVAL_SEC,
  30
)

// Messages per pass. Small on purpose — a backlog built up during a Telegram
// outage drains over several passes instead of firing hundreds of sends into a
// group whose budget is ~20 messages a minute anyway.
export const RELAY_RETRY_BATCH_SIZE = limitEnv(
  process.env.SUPPORT_RELAY_RETRY_BATCH_SIZE,
  25
)

// Attempts before a message is declared undeliverable and escalated to a human.
// Six spread over the interval covers any outage measured in minutes; past that
// the failure is structural (topic deleted, bot kicked, wrong chat id) and more
// attempts only delay the messages queued behind it.
export const RELAY_RETRY_MAX_ATTEMPTS = limitEnv(
  process.env.SUPPORT_RELAY_RETRY_MAX_ATTEMPTS,
  6
)

// How old a message must be before the retry loop touches it. The inline relay
// in `userSendMessage` owns a fresh message; this is the grace period that
// keeps the loop from competing with a send that is still in flight.
export const RELAY_RETRY_MIN_AGE_SEC = limitEnv(
  process.env.SUPPORT_RELAY_RETRY_MIN_AGE_SEC,
  15
)
// Role gate, mirroring EXCHANGE_ROLE / AFFILIATE_ROLE.
//   api    — HTTP (user API + Telegram webhook). No background loops.
//   worker — inactivity sweeper and any future background work.
//   all    — both. Default for dev / single-process deploys.
export const SUPPORT_ROLE = (process.env.SUPPORT_ROLE ?? 'all') as
  | 'api'
  | 'worker'
  | 'all'

export const SENTRY_DSN = process.env.SENTRY_DSN ?? ''

// PayMeta merchant API — the same base + Bearer key exchange already uses
// (exchange/src/apps/services/wallet-api/paymeta.service.ts). Read-only
// here: GET /v1/ru-deposits and GET /v1/ru-deposits/:id. Empty = RU request
// lookups degrade to the p-prefix heuristic with a warning in the reply.
export const PAYMETA_API_BASE = process.env.PAYMETA_API_BASE ?? ''
export const PAYMETA_API_KEY = process.env.PAYMETA_API_KEY ?? ''

// Exchange gRPC server — account deletion goes through the SAME rpc the
// admin panel uses (Exchange.DeleteUser), so session teardown and the
// soft-delete semantics stay in one place. Default mirrors admin's env.
export const GRPC_EXCHANGE_SERVER =
  process.env.GRPC_EXCHANGE_SERVER ?? 'exchange:50051'

// Affiliate database — read-only, for partner existence checks and the
// partner line on the user card. Empty = partner features degrade with a
// clear message instead of failing.
export const DATABASE_AFFILIATE = process.env.DATABASE_AFFILIATE ?? ''

// ─── Zhora ───────────────────────────────────────────────────────────────
// Unlike optional display settings, a misspelled AI flag or budget must not
// silently enable paid calls or remove a spending limit. Never echo secrets.
const zhoraEnabled = process.env.ZHORA_ENABLED?.trim() || 'false'
if (zhoraEnabled !== 'true' && zhoraEnabled !== 'false') {
  throw new Error('[support] ZHORA_ENABLED must be true or false')
}
export const ZHORA_ENABLED = zhoraEnabled === 'true'

const zhoraNumberEnv = (key: string, fallback: number): number => {
  const raw = process.env[key]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`[support] ${key} must be a positive number`)
  }
  return value
}

export const ZHORA_OPENROUTER_API_KEY =
  process.env.ZHORA_OPENROUTER_API_KEY?.trim() ?? ''

// Explicit IDs, no model fallback: swapping a model must be a conscious
// configuration change. These operations will be connected in later blocks.
export const ZHORA_MODEL_TRANSLATE =
  process.env.ZHORA_MODEL_TRANSLATE?.trim() ?? ''
export const ZHORA_MODEL_REPLY = process.env.ZHORA_MODEL_REPLY?.trim() ?? ''
export const ZHORA_MODEL_FIX = process.env.ZHORA_MODEL_FIX?.trim() ?? ''
export const ZHORA_MODEL_BRIEF = process.env.ZHORA_MODEL_BRIEF?.trim() ?? ''
export const ZHORA_MODEL_TAGS = process.env.ZHORA_MODEL_TAGS?.trim() ?? ''
export const ZHORA_MODEL_CLUSTER = process.env.ZHORA_MODEL_CLUSTER?.trim() ?? ''
export const ZHORA_MODEL_CANDIDATES =
  process.env.ZHORA_MODEL_CANDIDATES?.trim() ?? ''
export const ZHORA_MODEL_EMBEDDING =
  process.env.ZHORA_MODEL_EMBEDDING?.trim() ?? ''

export const ZHORA_MONTHLY_BUDGET_USD = zhoraNumberEnv(
  'ZHORA_MONTHLY_BUDGET_USD',
  300
)
export const ZHORA_CANDIDATE_MIN_REPETITIONS = zhoraNumberEnv(
  'ZHORA_CANDIDATE_MIN_REPETITIONS',
  3
)
if (!Number.isSafeInteger(ZHORA_CANDIDATE_MIN_REPETITIONS)) {
  throw new Error(
    '[support] ZHORA_CANDIDATE_MIN_REPETITIONS must be an integer'
  )
}
export const ZHORA_CANDIDATE_SIMILARITY_THRESHOLD = zhoraNumberEnv(
  'ZHORA_CANDIDATE_SIMILARITY_THRESHOLD',
  0.9
)
if (ZHORA_CANDIDATE_SIMILARITY_THRESHOLD > 1) {
  throw new Error('[support] ZHORA_CANDIDATE_SIMILARITY_THRESHOLD must be <= 1')
}
// Recent ticket messages used to prepare a reply, oldest first.
export const ZHORA_CONTEXT_MESSAGE_LIMIT = zhoraNumberEnv(
  'ZHORA_CONTEXT_MESSAGE_LIMIT',
  20
)
if (!Number.isSafeInteger(ZHORA_CONTEXT_MESSAGE_LIMIT)) {
  throw new Error(
    '[support] ZHORA_CONTEXT_MESSAGE_LIMIT must be a safe integer'
  )
}
// Initial transport/generation defaults, not product requirements. Validate
// them against the selected model when implementing the OpenRouter client.
export const ZHORA_TIMEOUT_MS = zhoraNumberEnv('ZHORA_TIMEOUT_MS', 30_000)
// Node.js timers cannot represent a delay above this limit correctly.
if (!Number.isInteger(ZHORA_TIMEOUT_MS) || ZHORA_TIMEOUT_MS > 2_147_483_647) {
  throw new Error('[support] ZHORA_TIMEOUT_MS must be an integer <= 2147483647')
}

export const ZHORA_MAX_OUTPUT_TOKENS = zhoraNumberEnv(
  'ZHORA_MAX_OUTPUT_TOKENS',
  2048
)
if (!Number.isSafeInteger(ZHORA_MAX_OUTPUT_TOKENS)) {
  throw new Error('[support] ZHORA_MAX_OUTPUT_TOKENS must be a safe integer')
}

/**
 * Fail fast on a misconfigured deploy. Only checks what has no safe default
 * and would otherwise surface as a confusing runtime error much later (a
 * ticket that silently never reaches Telegram, an unauthenticated internal
 * API). Tests and local dev set NODE_ENV != production and skip the Telegram
 * requirements, so the service still boots without a bot token.
 */
export function assertRequiredEnv(): void {
  const missing: string[] = []
  if (!DATABASE_SUPPORT) missing.push('DATABASE_SUPPORT')
  if (ZHORA_ENABLED) {
    const required = {
      ZHORA_OPENROUTER_API_KEY,
      ZHORA_MODEL_TRANSLATE,
      ZHORA_MODEL_REPLY,
      ZHORA_MODEL_FIX,
      ZHORA_MODEL_BRIEF,
      ZHORA_MODEL_TAGS,
      ZHORA_MODEL_CLUSTER,
      ZHORA_MODEL_CANDIDATES,
      ZHORA_MODEL_EMBEDDING,
    }
    for (const [key, value] of Object.entries(required)) {
      if (!value) missing.push(key)
    }
  }
  if (NODE_ENV === 'production') {
    if (!INTERNAL_TOKEN) missing.push('SUPPORT_INTERNAL_TOKEN')
    if (!TELEGRAM_BOT_TOKEN) missing.push('SUPPORT_BOT_TOKEN')
    if (!TELEGRAM_CHAT_ID) missing.push('SUPPORT_CHAT_ID')
    if (!TELEGRAM_WEBHOOK_SECRET) missing.push('SUPPORT_WEBHOOK_SECRET')
    // An operator bot with an empty whitelist would refuse everyone — that
    // is safe but useless, and always a deploy mistake. Die loudly instead.
  }
  if (missing.length) {
    throw new Error(
      `[support] missing required env: ${missing.join(', ')}. Refusing to boot.`
    )
  }
}
