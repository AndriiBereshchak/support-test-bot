import * as Sentry from '@sentry/node'
import type { FastifyPluginAsync } from 'fastify'
import type { Update } from 'grammy/types'

import { NODE_ENV, TELEGRAM_WEBHOOK_SECRET } from '@config/env'
import { logger } from '@config/logger'

import { ApiError } from '@core/errors/api-error'
import { constantTimeEqual } from '@core/utils/constant-time'

import { handleUpdate } from '@telegram/updates'

/**
 * The Telegram -> support hop.
 *
 * Registered as its own plugin even though it shares the `/v1/internal` prefix:
 * Fastify hooks are encapsulated per plugin, so this route sits OUTSIDE the
 * `x-internal-token` guard. It authenticates with Telegram's own secret header
 * instead — Telegram cannot send our internal token, and exchange does not sign
 * the pass-through.
 *
 * This is also the only file allowed to import `@telegram/updates`: the update
 * router sits above `chat.service`, so importing it anywhere lower reintroduces
 * the import cycle the layering rule exists to prevent.
 */
export const telegramRoutes: FastifyPluginAsync = async (app) => {
  app.post('/tg-webhook', async (request, reply) => {
    const supplied = request.headers['x-telegram-bot-api-secret-token']

    // Local dev / tests run without a configured secret; production cannot —
    // `assertRequiredEnv()` refuses to boot without one.
    const secretRequired =
      Boolean(TELEGRAM_WEBHOOK_SECRET) || NODE_ENV === 'production'
    if (secretRequired) {
      if (
        typeof supplied !== 'string' ||
        !constantTimeEqual(supplied, TELEGRAM_WEBHOOK_SECRET)
      ) {
        // 401 is safe here precisely BECAUSE the caller is not Telegram — the
        // retry-forever hazard below only applies to authenticated updates.
        throw new ApiError('Unauthorized', 401, 'WEBHOOK_SECRET_INVALID')
      }
    }

    try {
      // Cast, not validation: the router narrows every field it reads and
      // ignores the rest, and a schema here would reject tomorrow's Telegram
      // update type — which Telegram would then retry forever.
      await handleUpdate(request.body as Update)
    } catch (err) {
      // Swallow deliberately. Telegram re-sends an update until it gets a 2xx,
      // so surfacing a handler bug as a 5xx turns one broken message into an
      // endless redelivery loop that also blocks every later update in the
      // queue. The error is reported instead, and the update is dropped.
      const error = err as Error
      logger.error(
        `[tg-webhook] update handling failed: ${error.stack ?? error.message}`
      )
      Sentry.captureException(error, { tags: { handler: 'tg-webhook' } })
    }

    return reply.code(200).send({ ok: true })
  })
}

export default telegramRoutes
