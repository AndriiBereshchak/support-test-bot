import type { SupportProduct } from '@prisma-support'

import { prismaSupport } from '@config/database'
import { logger } from '@config/logger'

import { SUPPORT_WS_ACTIONS } from '@core/contracts'
import { ApiError } from '@core/errors/api-error'

import { pushToUser } from './push.service'

/**
 * A temporary ban on writing to support.
 *
 * The user is told NOTHING — no email, no popup notification: the state is
 * visible only inside the support window itself. That is the customer's
 * decision, and it also dictates the shape — the ban is not an event but a
 * property the chat reads on every open.
 *
 * The property is LIVE, though: granting and lifting are pushed into the open
 * tab as a `support_mute_updated` frame. Without it a lift would only arrive
 * on a page reload — someone with the window open would keep seeing the ban
 * after the operator had lifted it, which is exactly the case it gets lifted
 * for.
 */

export interface MuteState {
  /** Whether the ban is in force RIGHT NOW. */
  muted: boolean
  /** Until when, ISO. null — there is no ban. */
  until: string | null
}

const NOT_MUTED: MuteState = { muted: false, until: null }

/**
 * Whether the ban is in force now.
 *
 * An expired deadline is not cleaned up separately: the row stays, and the
 * comparison against the current time is the source of truth. A background
 * cleanup would add a window in which the ban has already expired while the
 * row still says otherwise.
 */
export async function getMuteState(
  userId: string,
  // The product is threaded through the same way as in every other support
  // read: the row is unique by (product, userId), and reading by userId alone
  // would pick an arbitrary one of the two once partner support appears.
  product: SupportProduct = 'PLATFORM'
): Promise<MuteState> {
  try {
    const row = await prismaSupport.supportMute.findUnique({
      where: { product_userId: { product, userId } },
      select: { mutedUntil: true },
    })
    if (!row?.mutedUntil) return NOT_MUTED
    if (row.mutedUntil.getTime() <= Date.now()) return NOT_MUTED
    return { muted: true, until: row.mutedUntil.toISOString() }
  } catch (err) {
    // Fail OPEN, unlike the money checks: an unavailable database must not
    // take away someone's ability to reach support — it is their only channel
    // of contact, and the cost of a false ban is higher than that of a missed
    // one.
    logger.warn(
      `[mute] не смог прочитать запрет для ${userId}: ${(err as Error).message}`
    )
    return NOT_MUTED
  }
}

/** Throws 403 if writing is not allowed right now. The lift time goes into
 *  details — the client shows it in the window. */
export async function assertCanWrite(
  userId: string,
  product: SupportProduct = 'PLATFORM'
): Promise<void> {
  const state = await getMuteState(userId, product)
  if (!state.muted) return
  throw new ApiError(
    'Support access is temporarily restricted',
    403,
    'SUPPORT_MUTED'
  )
}

/**
 * Grant (or extend) the ban.
 *
 * The duration counts from NOW, not from the end of the previous one: "one
 * more day" after a week-long block must mean a day, not the eighth day.
 * Granting again rewrites the row — there is deliberately no history here, it
 * lives in `OperatorAction`.
 */
export async function muteUser(input: {
  userId: string
  userNId: number
  ms: number
  reason?: string | null
  agentId?: string | null
  product?: SupportProduct
}): Promise<Date> {
  if (!Number.isFinite(input.ms) || input.ms <= 0) {
    throw new ApiError('Bad duration', 400, 'BAD_DURATION')
  }
  const until = new Date(Date.now() + input.ms)
  const reason = input.reason?.trim().slice(0, 500) || null

  await prismaSupport.supportMute.upsert({
    where: {
      product_userId: {
        product: input.product ?? 'PLATFORM',
        userId: input.userId,
      },
    },
    create: {
      product: input.product ?? 'PLATFORM',
      userId: input.userId,
      userNId: input.userNId,
      mutedUntil: until,
      reason,
      mutedByAgentId: input.agentId ?? null,
      mutedAt: new Date(),
    },
    update: {
      mutedUntil: until,
      reason,
      mutedByAgentId: input.agentId ?? null,
      mutedAt: new Date(),
      // The lift happened earlier and has nothing to do with the new ban —
      // otherwise the card would show "lifted by so-and-so" on an active
      // block.
      unmutedByAgentId: null,
      unmutedAt: null,
    },
  })

  // A frame into the open tab. Separate from the log and after the write: the
  // source of truth is the row in the database, and the socket only saves a
  // reload. An error inside is swallowed by pushToUser itself — the operator
  // has no reason to see a NATS refusal in response to "blocked".
  await pushToUser(input.userId, {
    action: SUPPORT_WS_ACTIONS.muteUpdated,
    mutedUntil: until.toISOString(),
  })

  logger.info(
    `[mute] юзеру ${input.userNId} закрыта поддержка до ${until.toISOString()}`
  )
  return until
}

/**
 * Lift the ban.
 *
 * The row is NOT deleted: `mutedUntil = null` preserves both the fact that the
 * person was restricted and who lifted it. Returns false if there was no ban —
 * it is useful for the operator to see that rather than get a breezy "lifted".
 */
export async function unmuteUser(input: {
  userId: string
  agentId?: string | null
  product?: SupportProduct
}): Promise<boolean> {
  const row = await prismaSupport.supportMute.findUnique({
    where: {
      product_userId: {
        product: input.product ?? 'PLATFORM',
        userId: input.userId,
      },
    },
    select: { id: true, mutedUntil: true },
  })
  if (!row?.mutedUntil) return false

  await prismaSupport.supportMute.update({
    where: { id: row.id },
    data: {
      mutedUntil: null,
      unmutedByAgentId: input.agentId ?? null,
      unmutedAt: new Date(),
    },
  })
  await pushToUser(input.userId, {
    action: SUPPORT_WS_ACTIONS.muteUpdated,
    mutedUntil: null,
  })

  logger.info(`[mute] запрет снят для ${input.userId}`)
  return true
}
