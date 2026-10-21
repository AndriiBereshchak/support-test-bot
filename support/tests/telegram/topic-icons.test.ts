import type { Bot } from 'grammy'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { logger } from '@config/logger'

import { resetTopicIconCache, topicIconFor } from '@telegram/topic-icons'

/**
 * Telegram hands out topic icons as opaque `custom_emoji_id`s, so the glyph is
 * all we can pin down — the id has to be looked up every boot. These cases
 * cover the ways that lookup can go sideways against a real Bot API.
 */

type Sticker = { emoji?: string; custom_emoji_id?: string }

const botWith = (
  stickers: Sticker[] | Error
): { bot: Bot; calls: () => number } => {
  let calls = 0
  const getForumTopicIconStickers = vi.fn(async () => {
    calls += 1
    if (stickers instanceof Error) throw stickers
    return stickers
  })
  return {
    bot: { api: { getForumTopicIconStickers } } as unknown as Bot,
    calls: () => calls,
  }
}

describe('topicIconFor', () => {
  beforeEach(() => {
    resetTopicIconCache()
    vi.restoreAllMocks()
  })

  it('resolves both states from the icon set', async () => {
    const { bot } = botWith([
      { emoji: '💬', custom_emoji_id: 'chat' },
      { emoji: '‼️', custom_emoji_id: 'bangbang' },
      { emoji: '✅', custom_emoji_id: 'check' },
    ])

    expect(await topicIconFor(bot, 'OPEN')).toBe('bangbang')
    expect(await topicIconFor(bot, 'CLOSED')).toBe('check')
  })

  it('matches regardless of the variation selector', async () => {
    // `‼️` is U+203C + U+FE0F. Telegram may return either form, and to a Map
    // they are two different strings — a miss here means no icon at all.
    const { bot } = botWith([
      { emoji: '‼', custom_emoji_id: 'bangbang' },
      { emoji: '✅', custom_emoji_id: 'check' },
    ])

    expect(await topicIconFor(bot, 'OPEN')).toBe('bangbang')
  })

  it('returns undefined, and warns, when the glyph is missing', async () => {
    const warn = vi
      .spyOn(logger, 'warn')
      .mockImplementation((() => logger) as never)
    const { bot } = botWith([{ emoji: '🍕', custom_emoji_id: 'pizza' }])

    expect(await topicIconFor(bot, 'OPEN')).toBeUndefined()
    expect(warn).toHaveBeenCalled()
  })

  it('resolves once and reuses the answer', async () => {
    const { bot, calls } = botWith([
      { emoji: '‼️', custom_emoji_id: 'bangbang' },
      { emoji: '✅', custom_emoji_id: 'check' },
    ])

    await topicIconFor(bot, 'OPEN')
    await topicIconFor(bot, 'OPEN')
    await topicIconFor(bot, 'CLOSED')

    expect(calls()).toBe(1)
  })

  it('never throws when Telegram is unreachable, and retries next time', async () => {
    vi.spyOn(logger, 'warn').mockImplementation((() => logger) as never)
    const { bot, calls } = botWith(new Error('ETIMEDOUT'))

    // An icon is a nicety: a failed lookup must not take a topic down with it.
    expect(await topicIconFor(bot, 'OPEN')).toBeUndefined()

    // And the failure must not be memoised, or one bad minute at boot costs
    // icons until the next deploy.
    expect(await topicIconFor(bot, 'OPEN')).toBeUndefined()
    expect(calls()).toBe(2)
  })
})
