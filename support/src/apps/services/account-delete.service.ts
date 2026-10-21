import { PaymentStatus, PaymentType } from '@prisma-exchange'

import { prismaExchange } from '@config/database'

import { grpcDeleteUser } from '@core/exchange-grpc'

/**
 * Account deletion for the support bot, gated harder than the admin panel:
 *
 *   1. real trades / futures positions / prediction-market bets — the SAME
 *      check the admin route runs before its delete (`UserService.hasTrades`:
 *      any non-demo Trade, Position or PredictOrder row);
 *   2. completed real deposits — ADDITIONAL, fixed by Artyom 01.08.2026: an
 *      account that has ever successfully paid in must not be deletable
 *      from the bot, even if it never traded.
 *
 * The delete itself goes through the exchange gRPC (`Exchange.DeleteUser`) —
 * the exact rpc the admin panel calls — so soft-delete semantics and session
 * teardown stay in one place.
 */

export type DeleteCheck =
  | { allowed: true; userId: string }
  | { allowed: false; reason: string }

export async function checkDeletable(userNId: number): Promise<DeleteCheck> {
  const user = await prismaExchange.user.findUnique({
    where: { nId: userNId },
    select: { id: true, isDelete: true },
  })
  if (!user) return { allowed: false, reason: 'Пользователь не найден' }
  if (user.isDelete) return { allowed: false, reason: 'Аккаунт уже удалён' }

  const [trade, position, predictOrder, deposit] = await Promise.all([
    prismaExchange.trade.findFirst({
      where: { userId: user.id, isDemo: false },
      select: { id: true },
    }),
    prismaExchange.position.findFirst({
      where: { userId: user.id, isDemo: false },
      select: { id: true },
    }),
    prismaExchange.predictOrder.findFirst({
      where: { userId: user.id, isDemo: false },
      select: { id: true },
    }),
    prismaExchange.payment.findFirst({
      where: {
        userId: user.id,
        type: PaymentType.DEPOSIT,
        status: PaymentStatus.COMPLETED,
        isFake: false,
      },
      select: { id: true },
    }),
  ])

  if (trade || position || predictOrder) {
    return {
      allowed: false,
      reason:
        'Нельзя удалить: у пользователя есть реальные сделки. ' +
        'Такие аккаунты удаляются только через админку и Серёгу.',
    }
  }
  if (deposit) {
    return {
      allowed: false,
      reason:
        'Нельзя удалить: у пользователя есть завершённый депозит. ' +
        'Аккаунты с реальными деньгами из бота не удаляем.',
    }
  }
  return { allowed: true, userId: user.id }
}

export async function deleteAccount(userId: string): Promise<void> {
  await grpcDeleteUser(userId)
}
