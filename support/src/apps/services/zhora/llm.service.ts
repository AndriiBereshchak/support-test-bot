import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { Prisma } from '@prisma-support'

import { prismaSupport } from '@config/database'
import { logger } from '@config/logger'

import {
  generateZhoraText,
  getZhoraModel,
  getOpenRouterGenerationCost,
  OpenRouterError,
  type OpenRouterInput,
  type OpenRouterMetadata,
  type OpenRouterResult,
} from './openrouter'
import {
  assertZhoraBudget,
  refreshZhoraBudget,
  ZhoraBudgetError,
} from './budget.service'

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
  call: { id: string; createdAt: Date },
  operation: OpenRouterInput['operation'],
  context: CallContext,
  metadata: OpenRouterMetadata,
  outcome: string
): Promise<void> {
  const data = {
    ...call,
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
      // Finish the pending record. Reuse its ID even if an acknowledgement
      // is lost; recomputed budget totals cannot double-count the retry.
      await prismaSupport.zhoraLlmCall.upsert({
        where: { id: data.id },
        create: data,
        update: data,
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

async function completeCall(
  call: { id: string; createdAt: Date },
  input: OpenRouterInput,
  context: CallContext,
  metadata: OpenRouterMetadata,
  outcome: string
): Promise<void> {
  if (metadata.usage.costUsd === null && metadata.generationId) {
    try {
      metadata.usage.costUsd = await getOpenRouterGenerationCost(
        metadata.generationId
      )
    } catch {
      // Keep unknown cost null; the next admission must reconcile key usage.
      logger.warn('[zhora] generation cost is unavailable')
    }
  }
  await recordCall(call, input.operation, context, metadata, outcome)
  try {
    await refreshZhoraBudget(call.createdAt)
  } catch {
    // A ready paid result is still returned. The durable pending/unknown
    // journal row makes the next admission reconcile or refuse a new call.
    logger.warn('[zhora] budget refresh failed after generation')
  }
}

/** Application entry point for budget-checked, audited text generation.
 * Retries only journal writes; never repeats the paid generation. */
export async function generateZhoraTextWithJournal(
  input: OpenRouterInput,
  context: CallContext = {}
): Promise<OpenRouterResult> {
  const model = getZhoraModel(input)
  await assertZhoraBudget()
  const call = { id: randomUUID(), createdAt: new Date() }
  try {
    // A durable pending row survives a process crash or failed final write.
    // It is not a monetary reservation and does not serialize AI requests.
    await prismaSupport.zhoraLlmCall.create({
      data: {
        ...call,
        operation: input.operation,
        model,
        ticketId: context.ticketId ?? null,
        agentId: context.agentId ?? null,
      },
    })
  } catch {
    throw new ZhoraBudgetError('budget_unavailable')
  }
  let result: OpenRouterResult
  try {
    result = await generateZhoraText(input)
  } catch (error) {
    if (error instanceof OpenRouterError && error.details) {
      await completeCall(call, input, context, error.details, error.code)
    }
    throw error
  }
  await completeCall(call, input, context, result, 'ok')
  return result
}
