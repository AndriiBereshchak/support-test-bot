// Shared fixtures + cleanup for the support integration tests.
//
// Doctrine, copied from `exchange/tests/integration/_helpers.ts`: real infra
// (the Postgres/Redis/NATS stack in docker-compose.test.yml), no transactional
// rollback. Every test creates randomized rows and drops them again in a
// `finally` / `afterAll`, so a crashed run leaves debris a later run tolerates
// instead of a poisoned fixture the whole suite depends on.

import { randomInt, randomUUID } from 'node:crypto'

import type {
  SupportMessage,
  SupportTicket,
  SupportAttachment,
} from '@prisma-support'

import { prismaExchange, prismaSupport } from '@config/database'

export interface TestUser {
  /** Exchange `User.id` — what every support row keys off. */
  userId: string
  /** Exchange `User.nId` — what the Telegram topic name is built from. */
  userNId: number
}

/**
 * The exchange side of the fixture.
 *
 * The support service reads the exchange database read-only through
 * `@prisma-exchange` for exactly two things: the ticket info card
 * (`getUserCard`) and "who is user #1234" (`findExchangeUserByNId`, which the
 * manual-topic-adoption path depends on). In the test stand DATABASE_EXCHANGE
 * points at the same `support_test` database, so this DDL puts a real `users`
 * table where the generated exchange client expects one — the query path stays
 * the real Prisma client against a real Postgres, only the surrounding schema
 * is trimmed to the columns those two reads select.
 *
 * `accounts` / `payments` are deliberately NOT created: `getUserCard` settles
 * each read independently, so their absence exercises its fail-soft path (a
 * degraded card must never fail a ticket) instead of hiding it.
 */
const enumType = (name: string, values: string[]): string =>
  // `$do$` rather than `$$` so the dollar-quoting can never be confused with a
  // bind placeholder, and a pg_type probe rather than an EXCEPTION block so the
  // statement stays a plain idempotent utility command.
  `DO $do$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = '${name}') THEN
       CREATE TYPE "${name}" AS ENUM (${values.map((v) => `'${v}'`).join(',')});
     END IF;
   END $do$`

const EXCHANGE_FIXTURE_SQL = [
  enumType('AccountType', [
    'DEMO',
    'MEMBER',
    'STANDARD',
    'PRO',
    'EXPERT',
    'DIAMOND',
  ]),
  enumType('KYCLevel', [
    'NO_DATA',
    'AI_REVIEW',
    'MANUAL_REVIEW',
    'INCOME_PROOF',
  ]),
  enumType('RiskPriority', ['GREEN', 'NORMAL', 'PURPLE', 'LOW']),
  `CREATE TABLE IF NOT EXISTS "users" (
     "id"                 TEXT PRIMARY KEY,
     "n_id"               INTEGER NOT NULL UNIQUE,
     "email"              VARCHAR(255) NOT NULL,
     "full_name"          VARCHAR(255) NOT NULL DEFAULT '',
     "country_code"       TEXT NOT NULL DEFAULT 'UA',
     "lang"               TEXT NOT NULL DEFAULT 'en',
     "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     -- Prisma writes it on EVERY update (@updatedAt). Without the column any
     -- write to a user failed with an empty error message.
     "updated_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "last_logged_in"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "kyc_level"          "KYCLevel" NOT NULL DEFAULT 'NO_DATA',
     "account_type"       "AccountType" NOT NULL DEFAULT 'DEMO',
     "blocked_up_to"      TIMESTAMP(3),
     "is_blocked_forever" BOOLEAN NOT NULL DEFAULT false,
     "first_deposit_at"   TIMESTAMP(3),
     "risk_priority"      "RiskPriority",
     "risk_flags"         JSONB,
     "partner_id"         INTEGER,
     -- Support VIP priority: set when the user goes to Trustpilot.
     "support_vip_at"     TIMESTAMP(3)
   )`,
  // The table is created with IF NOT EXISTS, so a database that survived the
  // previous run will not grow new columns — those have to be added separately
  // and idempotently. Without this a test for a new column fails only on a
  // machine where the test database was not recreated, that is, on everyone's
  // but the author's.
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "support_vip_at" TIMESTAMP(3)`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`,
  // Deposits and balances: the ticket card and the /deposits command read
  // them. Without these tables `getUserCard` did not fail — it settles every
  // read and silently returns zeros — so their absence went unnoticed for
  // years, and any test about deposits would have been checking emptiness.
  enumType('PaymentType', ['DEPOSIT', 'WITHDRAWAL']),
  enumType('PaymentStatus', [
    'PENDING',
    'PENDING_CRYPTO',
    'PENDING_ADMIN_REVIEW',
    'PROCESSING',
    'COMPLETED',
    'CANCELLED',
    'WITHDRAWAL_RETRY_POOL',
    'WITHDRAWAL_CHECK_COMPLETENESS_POOL',
    'FAILED',
    'PENDING_REFUND',
  ]),
  enumType('AccountKind', ['USER', 'PLATFORM']),
  `CREATE TABLE IF NOT EXISTS "payments" (
     "id"              TEXT PRIMARY KEY,
     "user_id"         TEXT NOT NULL,
     "tx_id"           TEXT,
     "type"            "PaymentType" NOT NULL,
     "status"          "PaymentStatus" NOT NULL DEFAULT 'PENDING',
     "amount"          DECIMAL(30,8) NOT NULL DEFAULT 0,
     "to_usdt"         DECIMAL(30,8) NOT NULL DEFAULT 0,
     "is_fake"         BOOLEAN NOT NULL DEFAULT false,
     "source_tx_hash"  TEXT,
     "additional_data" JSONB,
     "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
   )`,
  `CREATE TABLE IF NOT EXISTS "accounts" (
     "id"        TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
     "user_id"   TEXT,
     "kind"      "AccountKind" NOT NULL DEFAULT 'USER',
     "is_demo"   BOOLEAN NOT NULL DEFAULT false,
     "available" DECIMAL(30,8) NOT NULL DEFAULT 0
   )`,
]

let exchangeFixtureReady: Promise<void> | null = null

/** Idempotent, and memoized per test process — the DDL only has to run once. */
export function ensureExchangeFixture(): Promise<void> {
  exchangeFixtureReady ??= (async () => {
    for (const statement of EXCHANGE_FIXTURE_SQL) {
      await prismaExchange.$executeRawUnsafe(statement)
    }
  })()
  return exchangeFixtureReady
}

/**
 * A user that exists on both sides: a row in the (fixture) exchange `users`
 * table and nothing at all in the support database yet — the first message is
 * what creates the ticket, and several tests assert exactly that.
 *
 * `nId` is randomized over a wide range rather than sequential so re-runs
 * against a persistent database never collide on the unique index.
 */
export async function createTestUser(opts?: {
  fullName?: string
  riskFlags?: unknown
}): Promise<TestUser> {
  await ensureExchangeFixture()

  const userId = randomUUID()
  const userNId = randomInt(1_000_000, 2_000_000_000)

  await prismaExchange.$executeRawUnsafe(
    `INSERT INTO "users"
       ("id","n_id","email","full_name","country_code","lang",
        "kyc_level","account_type","risk_priority","risk_flags")
     VALUES ($1,$2,$3,$4,'UA','ru','NO_DATA','DIAMOND','NORMAL',$5::jsonb)`,
    userId,
    userNId,
    `support-${userId}@binodex.test`,
    opts?.fullName ?? 'Тестовый Пользователь',
    JSON.stringify(opts?.riskFlags ?? { hedging: true, pnlPositive: false })
  )

  return { userId, userNId }
}

/**
 * Best-effort cleanup. Tickets cascade to messages and attachments, so the
 * ticket delete is the only one that has to succeed; everything is wrapped
 * because a test that failed halfway may have created nothing at all.
 */
export async function cleanupTestUser(userId: string): Promise<void> {
  // The write ban lives on the user and survives deleting the tickets — left
  // behind, it would break the next run against the same database.
  await prismaSupport.supportMute
    .deleteMany({ where: { userId } })
    .catch(() => undefined)
  await prismaExchange
    .$executeRawUnsafe('DELETE FROM "payments" WHERE "user_id" = $1', userId)
    .catch(() => undefined)
  await prismaSupport.supportTicket
    .deleteMany({ where: { userId } })
    .catch(() => undefined)
  await prismaExchange
    .$executeRawUnsafe(`DELETE FROM "users" WHERE "id" = $1`, userId)
    .catch(() => undefined)
}

export async function cleanupTestUsers(userIds: string[]): Promise<void> {
  for (const id of userIds) await cleanupTestUser(id)
}

/** Every ticket the user has, oldest first. */
export async function listTickets(userId: string): Promise<SupportTicket[]> {
  return prismaSupport.supportTicket.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
  })
}

/** The user's single OPEN ticket, or null. Read straight from the DB. */
export async function openTicketOf(
  userId: string
): Promise<SupportTicket | null> {
  return prismaSupport.supportTicket.findFirst({
    where: { userId, status: 'OPEN' },
  })
}

export async function reloadTicket(ticketId: string): Promise<SupportTicket> {
  return prismaSupport.supportTicket.findUniqueOrThrow({
    where: { id: ticketId },
  })
}

/** One ticket's messages in `seq` order — including soft-deleted ones. */
export async function listMessages(
  ticketId: string
): Promise<SupportMessage[]> {
  return prismaSupport.supportMessage.findMany({
    where: { ticketId },
    orderBy: { seq: 'asc' },
  })
}

export async function listAttachments(
  ticketId: string
): Promise<SupportAttachment[]> {
  return prismaSupport.supportAttachment.findMany({
    where: { ticketId },
    orderBy: { createdAt: 'asc' },
  })
}

/** Sum of the badge counter across ALL of a user's tickets, read from the DB. */
export async function unreadInDb(userId: string): Promise<number> {
  const agg = await prismaSupport.supportTicket.aggregate({
    where: { userId },
    _sum: { unreadForUser: true },
  })
  return agg._sum.unreadForUser ?? 0
}

/** Poll until `check` is true, or fail the test with a readable message. */
export async function waitFor(
  what: string,
  check: () => Promise<boolean>,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${what}`)
}
