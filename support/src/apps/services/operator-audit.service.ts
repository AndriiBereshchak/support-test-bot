import type { Prisma } from '@prisma-support'

import { prismaSupport } from '@config/database'
import { logger } from '@config/logger'

/**
 * Append-only audit trail for the operator actions that CHANGE something
 * (partner bind, account deletion, relay reindex). Best-effort by design: a broken audit write must
 * never block the operator's action (the action itself is the point; the
 * trail is accountability, and the warn line below still leaves a trace in
 * the service logs).
 */
export async function audit(params: {
  tgUserId: number
  tgName: string
  /** The support agent, when the operator is registered. */
  agentId?: string | null
  /** The ticket the action was taken from. */
  ticketId?: string | null
  action: string
  params?: Record<string, unknown>
  result: 'ok' | 'refused' | 'error'
}): Promise<void> {
  try {
    await prismaSupport.operatorAction.create({
      data: {
        tgUserId: BigInt(params.tgUserId),
        tgName: params.tgName.slice(0, 128),
        agentId: params.agentId ?? null,
        ticketId: params.ticketId ?? null,
        action: params.action.slice(0, 64),
        params: (params.params ?? undefined) as
          | Prisma.InputJsonValue
          | undefined,
        result: params.result,
      },
    })
  } catch (err) {
    logger.warn(
      `[support-actions] audit write failed (${params.action}): ${
        (err as Error).message
      }`
    )
  }
}
