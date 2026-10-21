// Temporary ban on writing to support.
//
// What matters here:
//   • a banned user can neither write nor send a file
//   • the refusal happens BEFORE the ticket is created — otherwise support
//     would accumulate empty conversations made of rejected messages
//   • an expired deadline lifts the ban by itself, with no cleanup at all
//   • unmuting works, and a repeat unmute honestly says there was nothing
//     to lift
//   • the thread returns the deadline so the support window can show it
//   • muting and unmuting are pushed to the open tab over the socket, instead
//     of waiting for a reload
//   • an unavailable database must NOT lock the person out: support is their
//     only channel of communication
//
// Requires the infrastructure to be up:
//   yarn test:infra:up && yarn test:wait && yarn test:migrate

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@apps/services/push.service', () => ({
  pushToUser: vi.fn(async () => undefined),
}))
vi.mock('@telegram/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@telegram/api')>()),
  ...(await import('./_telegram-stub')).telegramStub(),
}))

import { prismaSupport, shutdownPrisma } from '@config/database'
import { closeRedis } from '@config/redis'

import { userSendMessage } from '@apps/services/chat.service'
import { getMuteState, muteUser, unmuteUser } from '@apps/services/mute.service'
import { pushToUser } from '@apps/services/push.service'
import { getThread } from '@apps/services/ticket.service'

import { cleanupTestUser, createTestUser, openTicketOf } from './_helpers'

const DAY = 24 * 3_600_000

beforeEach(() => {
  vi.clearAllMocks()
})

afterAll(async () => {
  await Promise.allSettled([shutdownPrisma(), closeRedis()])
})

describe('ban on writing to support', () => {
  it('a banned user cannot write, and no empty ticket is created', async () => {
    const user = await createTestUser()
    try {
      await muteUser({ userId: user.userId, userNId: user.userNId, ms: DAY })

      await expect(
        userSendMessage({
          userId: user.userId,
          userNId: user.userNId,
          text: 'Здравствуйте',
        })
      ).rejects.toThrow()

      // Refusal BEFORE ensureOpenTicket: otherwise every rejected message
      // would open a conversation without a single reply in it.
      expect(await openTicketOf(user.userId)).toBeNull()
    } finally {
      await cleanupTestUser(user.userId)
    }
  })

  it('writing is possible again after the ban is lifted', async () => {
    const user = await createTestUser()
    try {
      await muteUser({ userId: user.userId, userNId: user.userNId, ms: DAY })
      expect((await getMuteState(user.userId)).muted).toBe(true)

      expect(await unmuteUser({ userId: user.userId })).toBe(true)
      expect((await getMuteState(user.userId)).muted).toBe(false)

      await userSendMessage({
        userId: user.userId,
        userNId: user.userNId,
        text: 'Здравствуйте',
      })
      expect(await openTicketOf(user.userId)).not.toBeNull()
    } finally {
      await cleanupTestUser(user.userId)
    }
  })

  it('lifting a non-existent ban honestly returns false', async () => {
    const user = await createTestUser()
    try {
      // It helps the operator to see "there was nothing to lift" rather than
      // a cheerful "lifted".
      expect(await unmuteUser({ userId: user.userId })).toBe(false)
    } finally {
      await cleanupTestUser(user.userId)
    }
  })

  it('an expired deadline lifts the ban by itself, with no cleanup', async () => {
    const user = await createTestUser()
    try {
      await muteUser({ userId: user.userId, userNId: user.userNId, ms: DAY })
      // Deadline in the past: the row stays, and the comparison against time
      // is the source of truth.
      await prismaSupport.supportMute.updateMany({
        where: { userId: user.userId },
        data: { mutedUntil: new Date(Date.now() - 1000) },
      })

      expect((await getMuteState(user.userId)).muted).toBe(false)
      await userSendMessage({
        userId: user.userId,
        userNId: user.userNId,
        text: 'Снова здравствуйте',
      })
      expect(await openTicketOf(user.userId)).not.toBeNull()
    } finally {
      await cleanupTestUser(user.userId)
    }
  })

  it('a repeat mute extends from NOW, not from the end of the previous one', async () => {
    const user = await createTestUser()
    try {
      const week = await muteUser({
        userId: user.userId,
        userNId: user.userNId,
        ms: 7 * DAY,
      })
      const day = await muteUser({
        userId: user.userId,
        userNId: user.userNId,
        ms: DAY,
      })

      // "One more day" after a week must mean a day, not an eighth day.
      expect(day.getTime()).toBeLessThan(week.getTime())
      // And there is a single row — there is deliberately no history here.
      expect(
        await prismaSupport.supportMute.count({
          where: { userId: user.userId },
        })
      ).toBe(1)
    } finally {
      await cleanupTestUser(user.userId)
    }
  })

  it('the thread returns the deadline so the support window can show it', async () => {
    const user = await createTestUser()
    try {
      const until = await muteUser({
        userId: user.userId,
        userNId: user.userNId,
        ms: DAY,
      })

      const thread = await getThread(user.userId)
      expect(thread.mutedUntil).toBe(until.toISOString())

      await unmuteUser({ userId: user.userId })
      expect((await getThread(user.userId)).mutedUntil).toBeNull()
    } finally {
      await cleanupTestUser(user.userId)
    }
  })

  it('muting and unmuting are pushed to the open tab over the socket', async () => {
    const user = await createTestUser()
    try {
      const until = await muteUser({
        userId: user.userId,
        userNId: user.userNId,
        ms: DAY,
      })
      // Without this frame the ban would only show up after a page reload —
      // the person would keep typing into a field that no longer works.
      expect(pushToUser).toHaveBeenCalledWith(user.userId, {
        action: 'support_mute_updated',
        mutedUntil: until.toISOString(),
      })

      vi.mocked(pushToUser).mockClear()
      await unmuteUser({ userId: user.userId })
      // And the unmute all the more so: that is the whole point of this.
      expect(pushToUser).toHaveBeenCalledWith(user.userId, {
        action: 'support_mute_updated',
        mutedUntil: null,
      })
    } finally {
      await cleanupTestUser(user.userId)
    }
  })

  it('lifting a non-existent ban stays silent on the socket', async () => {
    const user = await createTestUser()
    try {
      // Otherwise the open tab would get a frame on every operator misfire.
      expect(await unmuteUser({ userId: user.userId })).toBe(false)
      expect(pushToUser).not.toHaveBeenCalled()
    } finally {
      await cleanupTestUser(user.userId)
    }
  })

  it('banning one user does not affect another', async () => {
    const muted = await createTestUser()
    const other = await createTestUser()
    try {
      await muteUser({ userId: muted.userId, userNId: muted.userNId, ms: DAY })

      expect((await getMuteState(other.userId)).muted).toBe(false)
      await userSendMessage({
        userId: other.userId,
        userNId: other.userNId,
        text: 'Я не при чём',
      })
      expect(await openTicketOf(other.userId)).not.toBeNull()
    } finally {
      await cleanupTestUser(muted.userId)
      await cleanupTestUser(other.userId)
    }
  })

  it('a zero or negative duration is rejected', async () => {
    const user = await createTestUser()
    try {
      for (const ms of [0, -1000, Number.NaN]) {
        await expect(
          muteUser({ userId: user.userId, userNId: user.userNId, ms })
        ).rejects.toThrow()
      }
      expect((await getMuteState(user.userId)).muted).toBe(false)
    } finally {
      await cleanupTestUser(user.userId)
    }
  })
})
