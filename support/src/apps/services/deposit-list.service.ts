import { PaymentStatus, PaymentType, Prisma } from '@prisma-exchange'

import { RAIL_BY_SOURCE, type CardRail } from '@core/card-rails'

import { prismaExchange } from '@config/database'
import { logger } from '@config/logger'

/**
 * The full list of a user's deposits, for the `/deposits` command in a ticket
 * topic.
 *
 * Separate from `user-card.service`: the card shows the THREE most recent per
 * rail and must not grow — the operator reads it on a phone. The question here
 * is a different one: "show everything he ever paid in", sometimes filtered by
 * rail.
 */

/** What we show. `crypto` is everything that is not a card (including manual
 *  credits). */
export type DepositFilter = 'all' | CardRail | 'crypto'

// Same order as RAIL_ORDER, with `all` first and `crypto` last: the filter
// keyboard is redrawn in place, so a rail moving position between redraws
// would move the button under the operator's thumb.
export const DEPOSIT_FILTERS: DepositFilter[] = [
  'all',
  'ru',
  'ua',
  'kz',
  'in',
  'world',
  'crypto',
]

export const FILTER_LABELS: Record<DepositFilter, string> = {
  all: 'Все',
  ru: '₽ карты',
  ua: '₴ карты',
  kz: '₸ карты',
  in: '₹ карты',
  world: 'Карты (мир)',
  crypto: 'Крипта',
}

export function isDepositFilter(value: string): value is DepositFilter {
  return (DEPOSIT_FILTERS as string[]).includes(value)
}

export interface DepositListRow {
  /** The identifier in the PROVIDER's panel — the one the operator pastes
   *  there. Empty when there is none: our internal id would look like an
   *  answer and would match nothing on the provider's side. */
  providerOrderId: string
  /** On-chain hash for crypto; empty for cards. */
  txHash: string
  amount: string
  currency: string
  /** Credited in USD — the same figure the admin panel shows. */
  usd: string
  status: string
  createdAt: Date
  method: string
  kind: CardRail | 'crypto'
  isFake: boolean
}

/** At most this many rows: a Telegram message gets split into parts as it is,
 *  and the full history is in the admin panel anyway. */
export const DEPOSITS_LIMIT = 25

const CARD_SOURCES = Object.keys(RAIL_BY_SOURCE)

function jsonText(data: Prisma.JsonValue | null | undefined, key: string) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ''
  const value = (data as Record<string, unknown>)[key]
  return typeof value === 'string'
    ? value
    : typeof value === 'number'
      ? String(value)
      : ''
}

/** A raw number out of JSON → two decimals, the same as in the ticket card.
 *  Without this the same amount read as "1500" in the list and "1500.00" in
 *  the card, and the operator did not immediately see it was one row. */
function jsonMoney(raw: string): string | null {
  if (!raw) return null
  try {
    return new Prisma.Decimal(raw).toFixed(2)
  } catch {
    return null
  }
}

function money(value: Prisma.Decimal | null | undefined): string {
  if (value == null) return '0.00'
  try {
    return value.toFixed(2)
  } catch {
    return '0.00'
  }
}

/**
 * The source condition for the selected filter.
 *
 * `crypto` is built as "NOT a card" rather than by enumerating the crypto
 * sources: the set of rails is finite and known, while the ways to bring
 * crypto in keep being added, and an enumeration would silently lose the new
 * ones.
 */
function whereForFilter(filter: DepositFilter): Prisma.PaymentWhereInput {
  if (filter === 'all') return {}
  if (filter === 'crypto') {
    // One `NOT` is not enough for "NOT a card": on a row without a `source`
    // key the comparison yields SQL NULL, `NOT NULL` is NULL too, and the row
    // drops out of the result. That way all crypto older than the May source
    // tagging was lost, along with any deposit with an empty additionalData —
    // the operator got "Nothing here" for a deposit that is perfectly visible
    // under "All".
    return {
      OR: [
        {
          NOT: {
            OR: CARD_SOURCES.map((source) => ({
              additionalData: { path: ['source'], equals: source },
            })),
          },
        },
        { additionalData: { equals: Prisma.DbNull } },
        { additionalData: { path: ['source'], equals: Prisma.AnyNull } },
      ],
    }
  }
  const source = CARD_SOURCES.find((key) => RAIL_BY_SOURCE[key] === filter)
  return source ? { additionalData: { path: ['source'], equals: source } } : {}
}

/**
 * A user's deposits, newest first.
 *
 * Every status: an unfinished deposit is the most common reason someone opens
 * a ticket, and filtering by COMPLETED would hide exactly the row being asked
 * about. Fake money (`isFake`) is NOT filtered out, but it is marked: the
 * operator has to see a manual credit rather than guess why the list holds an
 * amount the user never sent.
 */
export async function listUserDeposits(
  userId: string,
  filter: DepositFilter = 'all',
  limit: number = DEPOSITS_LIMIT
): Promise<DepositListRow[] | null> {
  try {
    const rows = await prismaExchange.payment.findMany({
      where: {
        userId,
        type: PaymentType.DEPOSIT,
        ...whereForFilter(filter),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        amount: true,
        toUSDT: true,
        status: true,
        createdAt: true,
        additionalData: true,
        isFake: true,
        sourceTxHash: true,
      },
    })

    return rows.map((row) => {
      const source = jsonText(row.additionalData, 'source')
      const kind = RAIL_BY_SOURCE[source] ?? 'crypto'
      const fiat = jsonMoney(jsonText(row.additionalData, 'fiat_amount'))
      const fiatCurrency = jsonText(row.additionalData, 'fiat_currency')
      const method =
        jsonText(row.additionalData, 'provider_display_name') ||
        jsonText(row.additionalData, 'provider') ||
        jsonText(row.additionalData, 'payment_method') ||
        source

      return {
        providerOrderId: jsonText(
          row.additionalData,
          'provider_order_id'
        ).slice(0, 64),
        txHash: (
          row.sourceTxHash ?? jsonText(row.additionalData, 'source_tx_hash')
        ).slice(0, 80),
        // What the user PAID, in the money they paid it with: the answer to
        // "I sent 1500 hryvnia" is the figure in hryvnia, and an uncredited
        // card row has no dollar value at all yet.
        amount: fiat && fiatCurrency ? fiat : money(row.amount),
        currency: (fiat && fiatCurrency ? fiatCurrency : 'USD')
          .slice(0, 8)
          .toUpperCase(),
        usd: money(row.toUSDT),
        status: String(row.status ?? PaymentStatus.PENDING),
        createdAt: row.createdAt,
        method: method.slice(0, 40),
        kind,
        isFake: row.isFake,
      }
    })
  } catch (err) {
    logger.warn(
      `[deposit-list] read failed for ${userId}: ${(err as Error).message}`
    )
    // null, not []: "there are no deposits" and "could not read them" are
    // different answers, and the operator takes the first one as a fact about
    // the user.
    return null
  }
}
