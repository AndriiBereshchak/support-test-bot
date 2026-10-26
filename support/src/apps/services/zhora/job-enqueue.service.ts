import { Prisma, type ZhoraJob } from '@prisma-support'
import { prismaSupport } from '@config/database'
import { getZhoraModel, type OpenRouterInput } from './openrouter'

/** Stable event keys prevent retries and duplicate deliveries from paying twice. */
export async function enqueueZhoraJob(args: {
  eventKey: string
  input: OpenRouterInput
  ticketId?: string | null
  agentId?: string | null
}): Promise<ZhoraJob> {
  getZhoraModel(args.input)
  if (!args.eventKey.trim() || args.eventKey.length > 160)
    throw new Error('[zhora] invalid_job_event_key')
  const { systemPrompt, input, knowledge, cachePrompt } = args.input
  try {
    return await prismaSupport.zhoraJob.upsert({
      where: { eventKey: args.eventKey },
      create: {
        eventKey: args.eventKey,
        operation: args.input.operation,
        input: {
          systemPrompt,
          input,
          ...(knowledge !== undefined ? { knowledge } : {}),
          ...(cachePrompt !== undefined ? { cachePrompt } : {}),
        },
        ticketId: args.ticketId ?? null,
        agentId: args.agentId ?? null,
      },
      update: {},
    })
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      const existing = await prismaSupport.zhoraJob
        .findUnique({ where: { eventKey: args.eventKey } })
        .catch(() => null)
      if (existing) return existing
    }
    // Query arguments may contain customer text.
    throw new Error('[zhora] job_enqueue_failed')
  }
}
