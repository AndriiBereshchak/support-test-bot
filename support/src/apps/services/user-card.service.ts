import {
  AccountKind,
  PaymentStatus,
  PaymentType,
  Prisma,
} from '@prisma-exchange'

import { prismaExchange, prismaSupport } from '@config/database'
import { RAIL_BY_SOURCE, type CardRail } from '@core/card-rails'

import { logger } from '@config/logger'

/**
 * The profile snapshot pinned at the top of a Telegram ticket topic.
 *
 * Read-only, cross-database, and JSON-safe by contract: the card travels
 * through the Telegram formatter and can end up in a NATS payload, where
 * Decimal and BigInt do not survive `JSON.stringify`. Every money value is
 * therefore a pre-formatted string and every id that could be a BigInt is
 * either a plain number or absent.
 *
 * Unknown-value convention, so the renderer needs exactly one rule: strings
 * come back EMPTY when we could not read them, never invented. A blank field
 * renders as an em dash; it never renders as a wrong number.
 */
export interface UserCard {
  userId: string
  nId: number
  email: string
  fullName: string
  countryCode: string
  lang: string
  registeredAt: Date
  lastLoggedIn: Date | null
  kycLevel: string
  accountType: string
  isBlocked: boolean
  balanceReal: string
  balanceDemo: string
  depositsTotal: string
  withdrawalsTotal: string
  firstDepositAt: Date | null
  riskPriority: string | null
  riskFlags: unknown
  partnerId: number | null
  /** When the person went to leave a Trustpilot review after giving a 5. Null
   *  means there is no priority. */
  supportVipAt: Date | null
  /** The last rating of support's work, 1–5, and what the person wrote with
   *  it. */
  lastRating: number | null
  lastRatingComment: string | null
  /** Up to which moment tickets are closed for this person. null — they are
   *  open. */
  mutedUntil: Date | null
  /** The reason for the ban: for support only, never shown to the user. */
  muteReason: string | null
  cardDeposits: CardDeposit[]
}

/**
 * One card deposit, flattened to what an operator asks about: how much, in
 * which money, where it stands, when, and who processed it.
 *
 * Same JSON-safe contract as the card around it — `amount` is a string, not a
 * Decimal. Unreadable pieces come back EMPTY rather than guessed.
 */
export interface CardDeposit {
  /**
   * The PROVIDER's own order id (Pyrex order, BrPay order_id, NirvanaPay
   * trackerID) — the identifier that means something in the provider's own
   * panel, which is where an operator goes when a deposit is stuck.
   *
   * Empty when the row has none: onramper deposits do not carry one, and
   * falling back to our internal Payment id would hand the operator a string
   * that looks like an answer and matches nothing on the provider's side.
   */
  providerOrderId: string
  amount: string
  /** Currency of `amount`, uppercased ('RUB', 'USD'). */
  currency: string
  status: string
  createdAt: Date
  /** Provider label ('NirvanaPay (SBP)', 'moonpay'); empty when the row has none. */
  method: string
  /**
   * Which rail: rouble cards, Ukrainian ones (UPay) or worldwide (Onramper).
   *
   * The rail lives on the row rather than in three separate arrays: TWO
   * renderers draw the card (the pinned one and /info), and a
   * single field means a new rail will not require editing the signature in
   * both.
   */
  rail: CardRail
}

export type { CardRail } from '@core/card-rails'

// Epoch stands for "we could not read the profile". A real registration date
// is never 1970, so the renderer can treat it as unknown without a second flag.
const UNKNOWN_DATE = new Date(0)
const ZERO_MONEY = '0.00'

// Three, because this is a Telegram message an operator skims — the full
// payment history is one click away in the admin panel. Three PER RAIL: for a
// user with both rouble and hryvnia top-ups a shared limit showed whichever
// rail happened to be busier, and the deposit being asked about disappeared.
const CARD_DEPOSITS_SHOWN = 3

/**
 * What marks a `Payment` row as paid by CARD rather than in crypto.
 *
 * `additionalData.source` is the same discriminator the user's own
 * transactions list branches on (`TransactionRow.tsx`: `ru_card` is the RU
 * cascade, `ua_card` the Ukrainian UPay rail, `kz_card` the Kazakh KZT rail,
 * `onramper` the ordinary card purchase), so the operator and the person they
 * are talking to are looking at the same set of rows. Crypto deposits carry
 * `paymeta`, admin top-ups `admin_edit_balance`.
 *
 * Every fiat rail must be listed here: a missing one does not degrade to
 * "shown as crypto", it vanishes from the card entirely — the operator sees
 * "no card deposits" for a user who has them. That is exactly what `kz_card`
 * did until it was added.
 */
const CARD_DEPOSIT_SOURCES = [
  'ru_card',
  'ua_card',
  'kz_card',
  'in_card',
  'onramper',
] as const

/**
 * Decimal -> string at the service boundary.
 *
 * Two decimals rather than the column's full 8: this is an info card an
 * operator reads at a glance, and `1234.56000000` is noise. Anything that
 * needs exact amounts reads the admin panel.
 */
function money(value: Prisma.Decimal | null | undefined): string {
  if (value == null) return ZERO_MONEY
  try {
    return value.toFixed(2)
  } catch {
    return ZERO_MONEY
  }
}

/** One string out of a Payment's untyped `additionalData` blob. */
function jsonText(
  data: Prisma.JsonValue | null | undefined,
  key: string
): string {
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    return ''
  const value = (data as Record<string, unknown>)[key]
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/**
 * A fiat amount that lives in JSON as a string ("5000.00") and could be
 * anything at all. Parsed through Decimal so a garbage blob degrades to "no
 * fiat amount" instead of reaching the operator as a bogus number.
 */
function jsonMoney(raw: string): string | null {
  if (!raw) return null
  try {
    return new Prisma.Decimal(raw).toFixed(2)
  } catch {
    return null
  }
}

interface CardDepositRow {
  amount: Prisma.Decimal
  status: PaymentStatus
  createdAt: Date
  additionalData: Prisma.JsonValue | null
}

function toCardDeposit(row: CardDepositRow): CardDeposit {
  // What the user PAID, in the money they paid it with: the answer to "I sent
  // 5000 roubles" is the RUB figure, and a pending RU row has no USD
  // value at all yet (`toUSDT` stays 0 until the credit webhook lands).
  // Without those fields the row's own `amount` is already the credited USD.
  const fiat = jsonMoney(jsonText(row.additionalData, 'fiat_amount'))
  const currency = jsonText(row.additionalData, 'fiat_currency')

  // Paymeta's human label ("NirvanaPay (SBP)") beats the raw slug; the raw
  // slug beats nothing. Sliced because it is provider-supplied free text.
  const method =
    jsonText(row.additionalData, 'provider_display_name') ||
    jsonText(row.additionalData, 'provider') ||
    jsonText(row.additionalData, 'payment_method')

  return {
    providerOrderId: jsonText(row.additionalData, 'provider_order_id').slice(
      0,
      64
    ),
    amount: fiat && currency ? fiat : money(row.amount),
    currency: (fiat && currency ? currency : 'USD').slice(0, 8).toUpperCase(),
    status: String(row.status),
    createdAt: row.createdAt,
    method: method.slice(0, 40),
    rail: RAIL_BY_SOURCE[jsonText(row.additionalData, 'source')] ?? 'world',
  }
}

function settled<T>(
  result: PromiseSettledResult<T>,
  fallback: T,
  what: string,
  userId: string
): T {
  if (result.status === 'fulfilled') return result.value
  logger.warn(
    `[user-card] ${what} failed for ${userId}: ${
      (result.reason as Error)?.message ?? result.reason
    }`
  )
  return fallback
}

/**
 * Build the support info card for one user.
 *
 * Never throws. A Telegram info card is not worth failing a ticket over: the
 * caller is `ensureTopic`, and a degraded card still gets the topic created
 * and the user's message delivered. Each read is settled independently so one
 * slow aggregate cannot take the profile down with it.
 */
export async function getUserCard(userId: string): Promise<UserCard> {
  const [
    profileResult,
    accountsResult,
    depositsResult,
    withdrawalsResult,
    cardDepositsResult,
    lastRatingResult,
    muteResult,
  ] = await Promise.allSettled([
    prismaExchange.user.findUnique({
      where: { id: userId },
      select: {
        nId: true,
        email: true,
        fullName: true,
        countryCode: true,
        lang: true,
        createdAt: true,
        lastLoggedIn: true,
        kycLevel: true,
        accountType: true,
        blockedUpTo: true,
        isBlockedForever: true,
        firstDepositAt: true,
        riskPriority: true,
        riskFlags: true,
        partnerId: true,
        supportVipAt: true,
      },
    }),
    // `Account.available` is the authoritative balance — the User balance
    // columns were dropped with the TigerBeetle removal. One row per
    // (userId, isDemo), so both balances come from a single read.
    prismaExchange.account.findMany({
      where: { userId, kind: AccountKind.USER },
      select: { isDemo: true, available: true },
    }),
    // `isFake: false` excludes admin-credited fake money: counting it as
    // deposits would tell the operator the user paid money they never sent.
    // Sums use `toUSDT` (the USD value), which is what the admin panel and
    // the risk flags both read — the numbers have to agree across screens.
    prismaExchange.payment.aggregate({
      where: {
        userId,
        type: PaymentType.DEPOSIT,
        status: PaymentStatus.COMPLETED,
        isFake: false,
      },
      _sum: { toUSDT: true },
    }),
    // COMPLETED only, on both sides: the card answers "how much has actually
    // moved", and an in-flight payout is a separate question the agent asks
    // the admin panel. Mixing the two would double-count a retried payout.
    prismaExchange.payment.aggregate({
      where: {
        userId,
        type: PaymentType.WITHDRAWAL,
        status: PaymentStatus.COMPLETED,
        isFake: false,
      },
      _sum: { toUSDT: true },
    }),
    // The last few card payments, EVERY status included: a deposit stuck in
    // PENDING is the single most common reason a user opens a ticket, so
    // filtering to COMPLETED would hide exactly the row being asked about.
    // `isFake` is excluded for the same reason as the sums above — an admin
    // may tag a manual credit with a card source (MANUAL_DEPOSIT_SOURCES in
    // admin-balance.service), and fake money is not money the user sent.
    // One query PER RAIL, not one query over all of them with a shared limit.
    // A user who tops up in hryvnia and in roubles has both, and a single
    // `take: 3` over the union hands the operator whichever rail happened to
    // be busier — the RU deposit they are asking about disappears behind three
    // Ukrainian ones. One cheap indexed read per rail answers "the last three
    // per rail", which is the question actually being asked.
    Promise.all(
      CARD_DEPOSIT_SOURCES.map(async (source) =>
        prismaExchange.payment.findMany({
          where: {
            userId,
            type: PaymentType.DEPOSIT,
            isFake: false,
            additionalData: { path: ['source'], equals: source },
          },
          orderBy: { createdAt: 'desc' },
          take: CARD_DEPOSITS_SHOWN,
          select: {
            amount: true,
            status: true,
            createdAt: true,
            additionalData: true,
          },
        })
      )
    ).then((groups) => groups.flat()),
    // The last rating of support's work — out of our own database, so cheap.
    // The last one rather than the average: the operator opens the card to
    // understand what the person has come with NOW, and an average over every
    // conversation does not say that.
    prismaSupport.supportTicket.findFirst({
      where: { userId, ratedAt: { not: null } },
      orderBy: { ratedAt: 'desc' },
      select: { rating: true, ratingComment: true },
    }),
    prismaSupport.supportMute.findFirst({
      where: { userId },
      select: { mutedUntil: true, reason: true },
    }),
  ])

  const lastRating = settled(
    lastRatingResult,
    null as { rating: number | null; ratingComment: string | null } | null,
    'last rating',
    userId
  )

  const mute = settled(
    muteResult,
    null as { mutedUntil: Date | null; reason: string | null } | null,
    'mute state',
    userId
  )
  // An expired ban is the absence of a ban: the row lives on, and the
  // comparison against the current time is the source of truth (see
  // mute.service).
  const activeMute =
    mute?.mutedUntil && mute.mutedUntil.getTime() > Date.now() ? mute : null

  const profile = settled(profileResult, null, 'profile read', userId)
  if (profileResult.status === 'fulfilled' && !profileResult.value) {
    logger.warn(`[user-card] no exchange user for ${userId}`)
  }

  const accounts = settled(accountsResult, [], 'balance read', userId)
  const real = accounts.find((account) => !account.isDemo)
  const demo = accounts.find((account) => account.isDemo)

  const deposits = settled(depositsResult, null, 'deposit sum', userId)
  const withdrawals = settled(withdrawalsResult, null, 'withdrawal sum', userId)
  const cardDeposits = settled(
    cardDepositsResult,
    [] as CardDepositRow[],
    'card deposits',
    userId
  )

  // `blockedUpTo` is a naive UTC timestamp column; Prisma hands it back as a
  // UTC-based Date, so a plain comparison against now is correct.
  const isBlocked =
    (profile?.isBlockedForever ?? false) ||
    (profile?.blockedUpTo != null && profile.blockedUpTo.getTime() > Date.now())

  return {
    userId,
    nId: profile?.nId ?? 0,
    email: profile?.email ?? '',
    fullName: profile?.fullName ?? '',
    countryCode: profile?.countryCode ?? '',
    lang: profile?.lang ?? '',
    registeredAt: profile?.createdAt ?? UNKNOWN_DATE,
    lastLoggedIn: profile?.lastLoggedIn ?? null,
    kycLevel: profile?.kycLevel ?? '',
    accountType: profile?.accountType ?? '',
    isBlocked,
    balanceReal: money(real?.available),
    balanceDemo: money(demo?.available),
    depositsTotal: money(deposits?._sum.toUSDT),
    withdrawalsTotal: money(withdrawals?._sum.toUSDT),
    firstDepositAt: profile?.firstDepositAt ?? null,
    riskPriority: profile?.riskPriority ?? null,
    riskFlags: profile?.riskFlags ?? null,
    partnerId: profile?.partnerId ?? null,
    supportVipAt: profile?.supportVipAt ?? null,
    lastRating: lastRating?.rating ?? null,
    lastRatingComment: lastRating?.ratingComment ?? null,
    mutedUntil: activeMute?.mutedUntil ?? null,
    muteReason: activeMute?.reason ?? null,
    cardDeposits: cardDeposits.map(toCardDeposit),
  }
}

/**
 * Resolve the human-facing account number support staff actually quote.
 *
 * Used by the bot commands that address a user by number (`/open 12345`).
 * Deleted users are deliberately NOT filtered out — a closed account is
 * exactly the kind of thing someone opens a ticket about.
 *
 * Unlike `getUserCard` this one throws on a database failure: returning null
 * would tell the operator "no such user", which is a different and much more
 * misleading answer than "the lookup broke".
 */
export async function findUserByNId(
  nId: number
): Promise<{ id: string; nId: number } | null> {
  if (!Number.isInteger(nId) || nId <= 0) return null

  return prismaExchange.user.findUnique({
    where: { nId },
    select: { id: true, nId: true },
  })
}
