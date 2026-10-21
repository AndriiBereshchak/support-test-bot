import type { Bot } from 'grammy'

import { logger } from '@config/logger'

/**
 * The badge Telegram draws next to a topic in the forum list — needs-attention
 * vs done, readable without opening the thread.
 *
 * WHY A RUNTIME LOOKUP AND NOT A CONSTANT: a topic icon is not an emoji
 * character. It is a `custom_emoji_id`, and Telegram only accepts ids from the
 * one set it hands out through `getForumTopicIconStickers`. Those ids are not
 * documented, not stable across accounts, and cannot be guessed — so while the
 * GLYPHS below are fixed, their ids still have to be fetched and matched.
 *
 * WHY NOT `icon_color`: `createForumTopic` accepts one of six fixed colours,
 * and `editForumTopic` has no parameter to change it afterwards. A topic
 * created green could never turn red on close, which is the whole point.
 */

export type TicketTopicState = 'OPEN' | 'CLOSED'

/** Both are in Telegram's topic-icon set; no fallback needed. */
const ICON_EMOJI: Record<TicketTopicState, string> = {
  OPEN: '‼️',
  CLOSED: '✅',
}

/**
 * Emoji equality, minus the variation selector.
 *
 * Load-bearing for `‼️`: it is U+203C followed by U+FE0F, and Telegram is
 * inconsistent about whether it returns the selector. Without this the lookup
 * misses and the icon silently never appears.
 */
const normalize = (emoji: string): string => emoji.replace(/️/g, '')

type IconMap = Partial<Record<TicketTopicState, string>>

let cached: Promise<IconMap> | null = null

async function resolve(bot: Bot): Promise<IconMap> {
  const stickers = await bot.api.getForumTopicIconStickers()

  const byEmoji = new Map<string, string>()
  for (const sticker of stickers) {
    const emoji = sticker.emoji ? normalize(sticker.emoji) : ''
    if (emoji && sticker.custom_emoji_id && !byEmoji.has(emoji)) {
      byEmoji.set(emoji, sticker.custom_emoji_id)
    }
  }

  const map: IconMap = {}
  for (const state of Object.keys(ICON_EMOJI) as TicketTopicState[]) {
    const id = byEmoji.get(normalize(ICON_EMOJI[state]))
    if (id) {
      map[state] = id
    } else {
      logger.warn(
        `[telegram] topic icon ${ICON_EMOJI[state]} for ${state} is not in this bot's icon set`
      )
    }
  }

  // Once per process, and worth it: this line is the only confirmation the
  // icons are live without opening the group.
  logger.info(
    `[telegram] topic icons resolved: ${
      Object.keys(map).length === 2 ? 'OPEN ‼️ CLOSED ✅' : 'incomplete'
    }`
  )

  return map
}

/**
 * The icon id for a ticket state, or undefined when Telegram offers nothing
 * suitable (or is unreachable).
 *
 * Undefined is a normal answer, not an error: callers omit the parameter and
 * Telegram falls back to its own default. An icon is a nicety, and no topic
 * operation may ever fail because of one.
 */
export async function topicIconFor(
  bot: Bot,
  state: TicketTopicState
): Promise<string | undefined> {
  if (!cached) {
    cached = resolve(bot).catch((err: unknown) => {
      // Drop the memo so the next topic retries. Caching a failure forever
      // would mean one bad minute at boot costs icons until the next deploy.
      cached = null
      logger.warn(
        `[telegram] topic icons unavailable: ${(err as Error).message}`
      )
      return {}
    })
  }

  return (await cached)[state]
}

/** Test seam — the memo is process-wide and would leak between cases. */
export function resetTopicIconCache(): void {
  cached = null
}
