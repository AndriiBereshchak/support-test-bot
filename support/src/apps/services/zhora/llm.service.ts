import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { Prisma } from '@prisma-support'

import { prismaSupport } from '@config/database'
import { logger } from '@config/logger'

import {
  generateZhoraText,
  OpenRouterError,
  type OpenRouterInput,
  type OpenRouterMetadata,
  type OpenRouterResult,
} from './openrouter'

interface CallContext {
  ticketId?: string | null
  /** SupportAgent.id, not the operator's Telegram user ID. */
  agentId?: string | null
}

function temporaryDatabaseError(error: unknown): boolean {
  const code =
    error instanceof Prisma.PrismaClientKnownRequestError
      ? error.code
      : error instanceof Prisma.PrismaClientInitializationError
        ? error.errorCode
        : undefined
  return ['P1001', 'P1002', 'P1008', 'P1017', 'P2024'].includes(code ?? '')
}

async function recordCall(
  operation: OpenRouterInput['operation'],
  context: CallContext,
  metadata: OpenRouterMetadata,
  outcome: string
): Promise<void> {
  const data = {
    id: randomUUID(),
    createdAt: new Date(),
    operation,
    ticketId: context.ticketId ?? null,
    agentId: context.agentId ?? null,
    model: metadata.model,
    inputTokens: metadata.usage.inputTokens,
    outputTokens: metadata.usage.outputTokens,
    costUsd: metadata.usage.costUsd,
    durationMs: metadata.durationMs,
    outcome,
  }
  const retryDelays = [100, 300]
  for (let attempt = 0; ; attempt++) {
    try {
      // The previous write may have committed even if its acknowledgement
      // was lost. Reuse the ID so retrying cannot duplicate the charge.
      await prismaSupport.zhoraLlmCall.upsert({
        where: { id: data.id },
        create: data,
        update: {},
      })
      return
    } catch (error) {
      const retryDelay = retryDelays[attempt]
      if (temporaryDatabaseError(error) && retryDelay !== undefined) {
        await delay(retryDelay)
        continue
      }
      // Prisma errors can contain query arguments. Never log the raw error,
      // prompt or response. Logging failure must not discard a paid result.
      logger.warn(
        `[zhora] call journal write failed: ${data.id} (${operation})`
      )
      return
    }
  }
}

/** Application entry point for text calls with usage auditing.
 * Retries only journal writes; never repeats the paid generation. */
export async function generateZhoraTextWithJournal(
  input: OpenRouterInput,
  context: CallContext = {}
): Promise<OpenRouterResult> {
  let result: OpenRouterResult
  try {
    result = await generateZhoraText(input)
  } catch (error) {
    // Errors without transport metadata are local refusals (disabled,
    // invalid input or missing configuration), not provider calls.
    if (error instanceof OpenRouterError && error.details) {
      await recordCall(input.operation, context, error.details, error.code)
    }
    throw error
  }
  await recordCall(input.operation, context, result, 'ok')
  return result
}
