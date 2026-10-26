import { setTimeout as delay } from 'node:timers/promises'

import type { Bot } from 'grammy'
import type { Update } from 'grammy/types'

import { logger } from '@config/logger'

/** Receive test-bot updates without exposing the local HTTP server. */
export async function startLocalTelegramPolling(
  bot: Bot,
  handleUpdate: (update: Update) => Promise<void>
): Promise<() => Promise<void>> {
  // Telegram does not allow getUpdates while a webhook is registered.
  await bot.api.deleteWebhook({ drop_pending_updates: false })

  const controller = new AbortController()
  let offset: number | undefined
  const loop = (async () => {
    while (!controller.signal.aborted) {
      try {
        const updates = await bot.api.getUpdates(
          {
            offset,
            timeout: 5,
            allowed_updates: ['message', 'edited_message', 'callback_query'],
          },
          // grammY types its signal with its own AbortSignal package; Node's
          // signal has the same runtime methods needed to cancel this call.
          controller.signal as unknown as Parameters<
            typeof bot.api.getUpdates
          >[1]
        )
        for (const update of updates) {
          if (controller.signal.aborted) break
          await handleUpdate(update)
          offset = update.update_id + 1
        }
      } catch {
        if (controller.signal.aborted) break
        logger.warn('[telegram] local polling failed; retrying')
        await delay(1500, undefined, { signal: controller.signal }).catch(
          () => undefined
        )
      }
    }
  })()

  return async () => {
    controller.abort()
    await loop
  }
}
