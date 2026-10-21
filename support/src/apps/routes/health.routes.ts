import type { FastifyPluginAsync } from 'fastify'

import { prismaSupport } from '@config/database'

import { ApiError } from '@core/errors/api-error'

/**
 * Liveness/readiness probe for the orchestrator and the load balancer.
 *
 * Unprefixed and unguarded on purpose — the probe runs on the docker network
 * without the internal token, and it exposes nothing beyond "this replica can
 * still talk to its database".
 */
export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/healthz', async (_request, reply) => {
    try {
      // Cheapest possible round-trip: proves the pool still has a live socket
      // without touching a table or a planner.
      await prismaSupport.$queryRaw`SELECT 1`
    } catch (err) {
      // 503 (an ApiError) rather than letting it escape as a 500: a database
      // blip already pages via its own alerting, and routing every probe
      // failure into Sentry would bury the actual incident in noise.
      throw new ApiError(
        `database unavailable: ${(err as Error).message}`,
        503,
        'DB_UNAVAILABLE'
      )
    }

    return reply.code(200).send({ status: 'ok' })
  })
}

export default healthRoutes
