import { Prisma } from '@prisma-support'

import { prismaSupport } from '@config/database'
import { TELEGRAM_CHAT_ID, ZHORA_MONTHLY_BUDGET_USD } from '@config/env'
import { logger } from '@config/logger'
import { sendPlainMessage } from '@telegram/api'

import { getOpenRouterMonthlyUsage } from './openrouter'

export class ZhoraBudgetError extends Error {
  constructor(public readonly code: 'budget_exhausted' | 'budget_unavailable') {
    super(`[zhora] ${code}`)
    this.name = 'ZhoraBudgetError'
  }
}

/** Telegram has no idempotency key for sendMessage. A row lock prevents
 * concurrent/repeated successful notices; an ambiguous delivery/DB commit
 * failure can still require a retry. Failed delivery is not marked as sent. */
async function notifyExhausted(month: string): Promise<void> {
  if (!TELEGRAM_CHAT_ID) return
  try {
    await prismaSupport.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT month FROM zhora_monthly_budgets WHERE month = ${month} FOR UPDATE`
        const budget = await tx.zhoraMonthlyBudget.findUniqueOrThrow({
          where: { month },
        })
        if (!budget.exhaustedAt || budget.notifiedAt) return
        const messageId = await sendPlainMessage({
          chatId: TELEGRAM_CHAT_ID,
          topicId: null,
          text: `Жора отключён: достигнут месячный лимит расходов за ${month} (UTC). Новые AI-операции, включая перевод, недоступны.`,
        })
        if (messageId === null) {
          logger.warn('[zhora] budget notice delivery failed')
          return
        }
        await tx.zhoraMonthlyBudget.update({
          where: { month },
          data: { notifiedAt: new Date() },
        })
      },
      { timeout: 45_000 }
    )
  } catch {
    logger.warn('[zhora] budget notice could not be confirmed')
  }
}

/** Recompute from the journal rather than incrementing for each write retry.
 * spentUsd never decreases; provider totals and local totals are NOT added. */
export async function refreshZhoraBudget(
  date: Date = new Date()
): Promise<void> {
  const month = date.toISOString().slice(0, 7)
  const from = new Date(`${month}-01T00:00:00.000Z`)
  const to = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1)
  )
  const where = { createdAt: { gte: from, lt: to } }
  const [budget, totals, unknown] = await prismaSupport.$transaction([
    prismaSupport.zhoraMonthlyBudget.findUnique({ where: { month } }),
    prismaSupport.zhoraLlmCall.aggregate({ where, _sum: { costUsd: true } }),
    prismaSupport.zhoraLlmCall.count({ where: { ...where, costUsd: null } }),
  ])
  const localSpent = totals._sum.costUsd ?? new Prisma.Decimal(0)
  let spent = Prisma.Decimal.max(localSpent, budget?.spentUsd ?? 0)
  // Bootstrap from the dedicated key once. Pending/unknown journal records
  // (including a crashed final write) keep provider reconciliation necessary.
  const needsProvider = !budget || unknown > 0 || spent.gt(localSpent)
  let accountingFailed = false
  if (needsProvider) {
    try {
      const provider = await getOpenRouterMonthlyUsage()
      if (provider.month !== month) throw new Error()
      spent = Prisma.Decimal.max(spent, provider.costUsd)
    } catch {
      accountingFailed = true
    }
  }
  // Still persist a locally known exhaustion even when reconciliation fails.
  // If the month has no baseline yet, a failed lookup must not create one.
  if (budget || !accountingFailed || spent.gte(ZHORA_MONTHLY_BUDGET_USD)) {
    const updated = await prismaSupport.$transaction(async (tx) => {
      await tx.zhoraMonthlyBudget.upsert({
        where: { month },
        create: { month, spentUsd: spent },
        update: {},
      })
      await tx.zhoraMonthlyBudget.updateMany({
        where: { month, spentUsd: { lt: spent } },
        data: { spentUsd: spent },
      })
      await tx.zhoraMonthlyBudget.updateMany({
        where: {
          month,
          exhaustedAt: null,
          spentUsd: { gte: ZHORA_MONTHLY_BUDGET_USD },
        },
        data: { exhaustedAt: new Date() },
      })
      return tx.zhoraMonthlyBudget.findUniqueOrThrow({ where: { month } })
    })
    if (updated.exhaustedAt) await notifyExhausted(month)
  }
  if (accountingFailed) throw new ZhoraBudgetError('budget_unavailable')
}

/** No reservations: calls already admitted may finish beyond the limit.
 * A previous month's exhaustion remains a stop until manual recovery is
 * specified; a calendar rollover or process restart never clears it. */
export async function assertZhoraBudget(): Promise<void> {
  try {
    const blocked = await prismaSupport.zhoraMonthlyBudget.findFirst({
      where: { exhaustedAt: { not: null } },
      orderBy: { month: 'asc' },
    })
    if (blocked) {
      await notifyExhausted(blocked.month)
      throw new ZhoraBudgetError('budget_exhausted')
    }
    await refreshZhoraBudget()
    const exhausted = await prismaSupport.zhoraMonthlyBudget.findFirst({
      where: { exhaustedAt: { not: null } },
    })
    if (exhausted) throw new ZhoraBudgetError('budget_exhausted')
  } catch (error) {
    if (error instanceof ZhoraBudgetError) throw error
    throw new ZhoraBudgetError('budget_unavailable')
  }
}
