import multipart from '@fastify/multipart'
import * as Sentry from '@sentry/node'
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'

import { MAX_UPLOAD_BYTES, METRICS_ENABLED } from '@config/env'
import { logger } from '@config/logger'
import { registerHttpMetrics } from '@config/metrics'

import { ApiError } from '@core/errors/api-error'

import { healthRoutes } from '@apps/routes/health.routes'
import { internalRoutes } from '@apps/routes/internal.routes'
import { telegramRoutes } from '@apps/routes/telegram.routes'
import {
  zhoraKbRoutes,
  type ZhoraKbRouteOptions,
} from '@apps/routes/zhora-kb.routes'

/**
 * The monorepo's first Fastify service — everything else is Express 5, so none
 * of the house middleware applies and this file is the whole HTTP surface.
 *
 * Reachable only from inside the docker network (exchange proxies the user API
 * and the Telegram webhook to it), which is why there is no CORS, no helmet and
 * no rate limiter here: those live one hop up, on the public edge.
 */
export function buildApp(
  options: { zhoraKb?: ZhoraKbRouteOptions } = {}
): FastifyInstance {
  const app = Fastify({
    // Fastify ships its own pino logger. Ours is winston, and every other
    // service in the fleet logs through it — two formats in one aggregation
    // pipeline is worse than none, so pino is off and the `onResponse` hook
    // below writes a failures-only access log instead.
    logger: false,
    // The service sits behind nginx + the exchange proxy; without this the
    // client ip in a Sentry event is always the proxy's.
    trustProxy: true,
  })

  void app.register(multipart, {
    limits: {
      fileSize: MAX_UPLOAD_BYTES,
      // One file per request: the upload endpoint stages exactly one
      // attachment, and allowing more would silently drop the extras.
      files: 1,
      // Only `userId` / `userNId` are ever read. Tight ceilings so a crafted
      // multipart body can't be used to allocate memory.
      fields: 8,
      fieldSize: 1024,
    },
  })

  if (METRICS_ENABLED) registerHttpMetrics(app)

  app.addHook('onResponse', async (request, reply) => {
    // The probe fires every few seconds on every replica; logging it drowns
    // out real traffic.
    if (request.routeOptions.url === '/healthz') return

    // Route PATTERN, and the path without its query string as the fallback:
    // the raw url carries `?userId=<uuid>` on the attachment route, and access
    // logs are the wrong place to accumulate user ids.
    const route =
      request.routeOptions.url ?? request.url.split('?')[0] ?? request.url
    const line = `${request.method} ${route} ${reply.statusCode} ${reply.elapsedTime.toFixed(1)}ms`

    // Successful requests stay at debug (off in production): every keystroke
    // -sized chat message is one of these, and at chat volume they bury the
    // lines somebody is actually paging through at 3am.
    if (reply.statusCode >= 500) logger.error(`[http] ${line}`)
    else if (reply.statusCode >= 400) logger.warn(`[http] ${line}`)
    else logger.debug(`[http] ${line}`)
  })

  app.setNotFoundHandler(async (_request, reply) =>
    reply.code(404).send({ message: 'Not found' })
  )

  // Explicit `FastifyError` annotation: without it TS widens the parameter to
  // `unknown` here and every `error.*` access below fails to compile.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    // Deliberate failure raised by a handler — it already chose its status.
    if (error instanceof ApiError) {
      return reply.code(error.status).send({
        message: error.message,
        ...(error.code ? { code: error.code } : {}),
      })
    }

    // Fastify's own 4xx: schema validation, malformed JSON, unsupported
    // content type, FST_REQ_FILE_TOO_LARGE. All caller mistakes — reporting
    // them would page the on-call for someone else's bad request.
    const status = error.statusCode
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.code(status).send({
        message: error.message,
        ...(error.code ? { code: error.code } : {}),
      })
    }

    // Anything left escaped a handler unclassified: that is a bug.
    logger.error(
      `[http] ${request.method} ${request.routeOptions.url ?? request.url} unhandled: ${
        error.stack ?? error.message
      }`
    )
    Sentry.captureException(error, {
      level: 'error',
      tags: { route: request.routeOptions.url ?? '<unmatched>' },
    })
    return reply.code(500).send({ message: 'Internal server error' })
  })

  void app.register(healthRoutes)
  void app.register(internalRoutes, { prefix: '/v1/internal' })
  // Same prefix, separate plugin — see telegram.routes.ts: this is what keeps
  // the webhook outside the internal-token hook while sharing the path space.
  void app.register(telegramRoutes, { prefix: '/v1/internal' })
  void app.register(zhoraKbRoutes, {
    ...options.zhoraKb,
    prefix: '/v1/internal/zhora/kb',
  })

  return app
}

export default buildApp
