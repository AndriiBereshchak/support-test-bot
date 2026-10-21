import { PaymentType, Prisma } from '@prisma-exchange'

import { prismaExchange } from '@config/database'
import { logger } from '@config/logger'

/**
 * A user's withdrawals, for the `/withdrawals` command in a ticket topic.
 *
 * The twin of `deposit-list.service`, and deliberately a separate file: a
 * withdrawal answers different questions. "Where is my money" is about the
 * BRIDGE that is carrying it and the destination it is going to, neither of
 * which a deposit row has.
 *
 * The bridge is the one field an operator cannot get anywhere else in the bot.
 * It lives in `additionalData.paymeta.bridge`, written when the payout is
 * handed to PayMeta (exchange withdrawal.service). Internal transfers between
 * platform accounts never touch a bridge and are stamped `internal` at the
 * same place — which is why a missing bridge is shown as "—" rather than
 * guessed: a PENDING row simply has not been routed yet.
 */

/** At most this many rows — the full history is in the admin panel. */
export const WITHDRAWALS_LIMIT = 25

export interface WithdrawalListRow {
  /** Requested amount, in the account's currency. */
  amount: string
  /** Credited to the user in USD, as the admin panel shows it. */
  usd: string
  status: string
  /** Bridge that carried (or is carrying) the payout; '' when not routed yet. */
  bridge: string
  /** What the user actually receives after bridge fee and spread. */
  receiveUsd: string
  /** Destination address, and the chain it goes to. */
  address: string
  network: string
  /** On-chain hash once the bridge settles. */
  txHash: string
  createdAt: Date
  /** Manual admin edit / fake money — must be visible, never inferred. */
  isFake: boolean
}

function jsonObject(
  data: Prisma.JsonValue | null | undefined
): Record<string, unknown> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
  return data as Record<string, unknown>
}

function text(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  return typeof value === 'string'
    ? value
    : typeof value === 'number'
      ? String(value)
      : ''
}

function money(value: Prisma.Decimal | null | undefined): string {
  if (value == null) return '0.00'
  try {
    return value.toFixed(2)
  } catch {
    return '0.00'
  }
}

/** A raw JSON number → two decimals, so one amount reads the same everywhere. */
function jsonMoney(raw: string): string {
  if (!raw) return ''
  try {
    return new Prisma.Decimal(raw).toFixed(2)
  } catch {
    return ''
  }
}

/**
 * A user's withdrawals, newest first, EVERY status.
 *
 * Every status on purpose: a stuck or refused payout is the most common reason
 * someone opens a ticket, and filtering to COMPLETED would hide exactly the row
 * being asked about.
 *
 * Returns null when the query itself fails, so the caller can say "could not
 * read" instead of the definite "this user has no withdrawals" — the mistake
 * the RU-deposit path in the old operator bot made.
 */
export async function listUserWithdrawals(
  userId: string,
  limit: number = WITHDRAWALS_LIMIT
): Promise<WithdrawalListRow[] | null> {
  try {
    const rows = await prismaExchange.payment.findMany({
      where: { userId, type: PaymentType.WITHDRAWAL },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        amount: true,
        toUSDT: true,
        status: true,
        createdAt: true,
        additionalData: true,
        isFake: true,
        withdrawAddress: true,
        withdrawNetwork: true,
        destinationTxHash: true,
        sourceTxHash: true,
      },
    })

    return rows.map((row) => {
      const data = jsonObject(row.additionalData)
      const paymeta = jsonObject(data.paymeta as Prisma.JsonValue)
      return {
        amount: money(row.amount),
        usd: money(row.toUSDT),
        status: String(row.status),
        bridge: text(paymeta, 'bridge'),
        receiveUsd: jsonMoney(text(paymeta, 'receive_amount_usd')),
        address: row.withdrawAddress ?? '',
        // The dedicated column first — it is what the withdrawal flow writes.
        // The JSON keys are the fallback for rows that predate it.
        network:
          row.withdrawNetwork ||
          text(data, 'network') ||
          text(data, 'chain') ||
          text(paymeta, 'chain'),
        // Destination first: that is the hash the USER can look up. The source
        // hash is our side of the bridge and means nothing to them.
        txHash: row.destinationTxHash || row.sourceTxHash || '',
        createdAt: row.createdAt,
        isFake: row.isFake,
      }
    })
  } catch (err) {
    logger.error(
      `[withdrawal-list] query failed for ${userId}: ${(err as Error).message}`
    )
    return null
  }
}
