import type { Bot } from 'grammy'
import type { Update } from 'grammy/types'
import { describe, expect, it, vi } from 'vitest'

import { startLocalTelegramPolling } from './dev/telegram-polling'

describe('local Telegram polling', () => {
  it('keeps pending updates and advances the offset after handling them', async () => {
    const offsets: Array<number | undefined> = []
    const handled: number[] = []
    let finish!: () => void
    const received = new Promise<void>((resolve) => {
      finish = resolve
    })
    const bot = {
      api: {
        deleteWebhook: vi.fn(async () => true),
        getUpdates: vi.fn(
          async (
            options: { offset?: number },
            signal: {
              addEventListener: (name: string, listener: () => void) => void
            }
          ) => {
            offsets.push(options.offset)
            if (offsets.length <= 2)
              return [{ update_id: offsets.length } as Update]
            return new Promise<Update[]>((_resolve, reject) => {
              signal.addEventListener('abort', () =>
                reject(new Error('stopped'))
              )
            })
          }
        ),
      },
    } as unknown as Bot

    const stop = await startLocalTelegramPolling(bot, async (update) => {
      handled.push(update.update_id)
      if (handled.length === 2) finish()
    })
    await received
    await stop()

    expect(bot.api.deleteWebhook).toHaveBeenCalledWith({
      drop_pending_updates: false,
    })
    expect(handled).toEqual([1, 2])
    expect(offsets.slice(0, 2)).toEqual([undefined, 2])
  })
})
