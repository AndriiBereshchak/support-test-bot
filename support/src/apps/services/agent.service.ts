import type { SupportAgent } from '@prisma-support'

import { prismaSupport } from '@config/database'

/**
 * Support operator identities, managed entirely from inside the bot
 * (`/setname`, `/settitle`, `/setavatar`).
 *
 * Agents are keyed by Telegram user id and NEVER by @username: a handle can be
 * changed or reused by someone else, and a rename would silently re-attribute
 * every historical message. The Telegram identity stays server-side — the only
 * things that reach a browser are `displayName` / `title` / `avatarPath`.
 */

// Mirrors the VarChar(64) columns. Enforced here rather than at the call site
// so an over-long name fails as a truncation, not as a Postgres 22001 error.
export const AGENT_NAME_MAX_LENGTH = 64
export const AGENT_TITLE_MAX_LENGTH = 64

/**
 * Neutral fallback for a row created by `/settitle` or `/setavatar` before the
 * operator ever picked a name.
 *
 * Deliberately NOT the Telegram `first_name`: falling back to it would leak a
 * real identity into the user's chat window, which is the one thing this model
 * exists to prevent.
 */
const DEFAULT_DISPLAY_NAME = 'Поддержка'

// Control characters (they would break the single-line rendering of a name)
// plus the bidi overrides, which let a crafted name reverse the text around it
// in the user's chat window.
const UNSAFE_TEXT =
  /[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g

/**
 * Make an agent-supplied string safe to store and to render verbatim.
 *
 * Clamping is by code point, matching how Postgres counts VarChar length —
 * slicing the UTF-16 string instead would cut an emoji in half and still
 * overflow the column for astral characters.
 */
export function sanitizeAgentText(raw: string, maxLength: number): string {
  const cleaned = raw.replace(UNSAFE_TEXT, ' ').replace(/\s+/g, ' ').trim()
  return Array.from(cleaned).slice(0, maxLength).join('')
}

export interface AgentPatch {
  displayName?: string
  /** `null` clears the subtitle; `undefined` leaves it untouched. */
  title?: string | null
  isActive?: boolean
}

export async function findAgentByTgId(
  tgUserId: number
): Promise<SupportAgent | null> {
  return prismaSupport.supportAgent.findUnique({
    where: { tgUserId: BigInt(tgUserId) },
  })
}

/**
 * Create or patch the caller's agent row.
 *
 * Upsert rather than read-then-write because two commands typed in quick
 * succession would otherwise race on the create and one of them would hit the
 * `tg_user_id` unique index.
 */
export async function upsertAgent(
  tgUserId: number,
  patch: AgentPatch
): Promise<SupportAgent> {
  return prismaSupport.supportAgent.upsert({
    where: { tgUserId: BigInt(tgUserId) },
    create: {
      tgUserId: BigInt(tgUserId),
      displayName: patch.displayName || DEFAULT_DISPLAY_NAME,
      title: patch.title ?? null,
      ...(patch.isActive != null ? { isActive: patch.isActive } : {}),
    },
    update: {
      ...(patch.displayName ? { displayName: patch.displayName } : {}),
      // `undefined` and `null` mean different things here, so test for
      // presence rather than truthiness — `/settitle` with no argument must
      // clear the subtitle.
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.isActive != null ? { isActive: patch.isActive } : {}),
    },
  })
}

/**
 * Point the agent at an avatar the attachment layer has already written into
 * `SUPPORT_FILES_DIR/agents/`. Upserts for the same reason as above: an
 * operator may set a picture before ever running `/setname`.
 */
export async function setAgentAvatar(
  tgUserId: number,
  fileName: string
): Promise<SupportAgent> {
  return prismaSupport.supportAgent.upsert({
    where: { tgUserId: BigInt(tgUserId) },
    create: {
      tgUserId: BigInt(tgUserId),
      displayName: DEFAULT_DISPLAY_NAME,
      avatarPath: fileName,
    },
    update: { avatarPath: fileName },
  })
}
