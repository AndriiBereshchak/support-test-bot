import { describe, expect, it } from 'vitest'

import {
  QueueOverflowError,
  SendScheduler,
  backoffDelayMs,
  classifyFailure,
  classifyPermanentFailure,
  fullBucket,
  penalizeBucket,
  reserveToken,
  type BucketConfig,
} from '@telegram/transport'

// One token per second, burst of two.
const SLOW: BucketConfig = { capacity: 2, refillPerMs: 1 / 1000 }
// Effectively unlimited — used to isolate the per-chat budget under test.
const FREE: BucketConfig = { capacity: 1000, refillPerMs: 1 }

describe('reserveToken', () => {
  it('lets a burst through up to the capacity', () => {
    let state = fullBucket(SLOW, 0)

    const first = reserveToken(state, 0, SLOW)
    expect(first.delayMs).toBe(0)
    state = first.state

    const second = reserveToken(state, 0, SLOW)
    expect(second.delayMs).toBe(0)
  })

  it('queues callers behind each other instead of bunching them up', () => {
    // The regression this guards: reservations made at the same millisecond
    // must get *increasing* delays, or the whole burst fires together the
    // moment they wake up.
    let state = fullBucket(SLOW, 0)
    const delays: number[] = []
    for (let i = 0; i < 5; i++) {
      const reserved = reserveToken(state, 0, SLOW)
      delays.push(reserved.delayMs)
      state = reserved.state
    }
    expect(delays).toEqual([0, 0, 1000, 2000, 3000])
  })

  it('refills over time and never exceeds the capacity', () => {
    const drained = { tokens: 0, updatedAtMs: 0 }
    expect(reserveToken(drained, 1000, SLOW).delayMs).toBe(0)
    // Idle for an hour: still only a two-message burst.
    let state = { tokens: 0, updatedAtMs: 0 }
    for (let i = 0; i < 2; i++)
      state = reserveToken(state, 3_600_000, SLOW).state
    expect(reserveToken(state, 3_600_000, SLOW).delayMs).toBe(1000)
  })
})

describe('penalizeBucket', () => {
  it('blocks the bucket for the flood wait', () => {
    const penalized = penalizeBucket(fullBucket(SLOW, 0), 0, 30_000)
    expect(reserveToken(penalized, 0, SLOW).delayMs).toBe(30_000)
  })

  it('never shortens a longer freeze already in place', () => {
    const long = penalizeBucket(fullBucket(SLOW, 0), 0, 30_000)
    const short = penalizeBucket(long, 0, 1_000)
    expect(reserveToken(short, 0, SLOW).delayMs).toBe(30_000)
  })
})

describe('backoffDelayMs', () => {
  it('grows exponentially and caps out', () => {
    const config = { baseMs: 500, maxMs: 8_000 }
    const noJitter = () => 0
    expect(backoffDelayMs(1, config, noJitter)).toBe(250)
    expect(backoffDelayMs(2, config, noJitter)).toBe(500)
    expect(backoffDelayMs(3, config, noJitter)).toBe(1_000)
    expect(backoffDelayMs(99, config, noJitter)).toBe(4_000)
  })

  it('keeps the jittered delay inside [half, full]', () => {
    const config = { baseMs: 500, maxMs: 8_000 }
    expect(backoffDelayMs(3, config, () => 1)).toBe(2_000)
    expect(backoffDelayMs(3, config, () => 0.5)).toBe(1_500)
  })
})

describe('classifyFailure', () => {
  it('retries floods, 5xx and bodiless failures — nothing else', () => {
    expect(classifyFailure(429)).toBe('flood')
    expect(classifyFailure(500)).toBe('transient')
    expect(classifyFailure(502)).toBe('transient')
    expect(classifyFailure(undefined)).toBe('transient')
    expect(classifyFailure(400)).toBe('fatal')
    expect(classifyFailure(403)).toBe('fatal')
    expect(classifyFailure(409)).toBe('fatal')
  })
})

describe('classifyPermanentFailure', () => {
  it('names the three rejections no retry can fix', () => {
    expect(
      classifyPermanentFailure(400, 'Bad Request: message thread not found')
    ).toBe('topic-missing')
    expect(classifyPermanentFailure(400, 'Bad Request: chat not found')).toBe(
      'chat-missing'
    )
    expect(
      classifyPermanentFailure(
        403,
        'Forbidden: bot was kicked from the supergroup chat'
      )
    ).toBe('bot-removed')
    expect(
      classifyPermanentFailure(400, 'Bad Request: not enough rights to send')
    ).toBe('bot-removed')
  })

  it('condemns nothing that might work next time', () => {
    // Telegram never got far enough to have an opinion about the destination,
    // so even a matching phrase would not make these permanent.
    expect(classifyPermanentFailure(500, 'Internal Server Error')).toBeNull()
    expect(classifyPermanentFailure(429, 'Too Many Requests')).toBeNull()
    expect(classifyPermanentFailure(undefined, undefined)).toBeNull()
    // An unrecognised 400: the retry budget bounds it anyway, and guessing
    // "permanent" here would strand a message the next attempt would deliver.
    expect(
      classifyPermanentFailure(400, 'Bad Request: message is not modified')
    ).toBeNull()
  })
})

/** Clock whose only way to move forward is a scheduler sleep. */
function fakeClock() {
  let nowMs = 0
  return {
    now: () => nowMs,
    sleep: async (ms: number): Promise<void> => {
      nowMs += ms
    },
  }
}

describe('SendScheduler', () => {
  it('paces a burst to the per-chat budget and keeps FIFO order', async () => {
    const clock = fakeClock()
    const scheduler = new SendScheduler({
      chat: SLOW,
      global: FREE,
      maxQueueDepth: 100,
      now: clock.now,
      sleep: clock.sleep,
    })

    const ran: Array<{ label: string; at: number }> = []
    const send = (label: string) =>
      scheduler.schedule('chat', async () => {
        ran.push({ label, at: clock.now() })
        return label
      })

    await Promise.all([send('a'), send('b'), send('c'), send('d')])

    expect(ran.map((r) => r.label)).toEqual(['a', 'b', 'c', 'd'])
    expect(ran.map((r) => r.at)).toEqual([0, 0, 1000, 2000])
  })

  it('keeps the queue moving after a failed send', async () => {
    const clock = fakeClock()
    const scheduler = new SendScheduler({
      chat: FREE,
      global: FREE,
      maxQueueDepth: 100,
      now: clock.now,
      sleep: clock.sleep,
    })

    const failing = scheduler.schedule('chat', async () => {
      throw new Error('telegram said no')
    })
    const following = scheduler.schedule('chat', async () => 'delivered')

    await expect(failing).rejects.toThrow('telegram said no')
    await expect(following).resolves.toBe('delivered')
  })

  it('refuses to queue past the configured depth', async () => {
    const clock = fakeClock()
    const scheduler = new SendScheduler({
      chat: SLOW,
      global: FREE,
      maxQueueDepth: 2,
      now: clock.now,
      sleep: clock.sleep,
    })

    const first = scheduler.schedule('chat', async () => 1)
    const second = scheduler.schedule('chat', async () => 2)
    const third = scheduler.schedule('chat', async () => 3)

    await expect(third).rejects.toBeInstanceOf(QueueOverflowError)
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2])
  })

  it('does not serialize calls that carry no chat', async () => {
    const clock = fakeClock()
    const scheduler = new SendScheduler({
      chat: SLOW,
      global: FREE,
      maxQueueDepth: 2,
      now: clock.now,
      sleep: clock.sleep,
    })

    // Ten getFile-style calls in a row must not be capped at the group's
    // 20-per-minute message budget.
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        scheduler.schedule(null, async () => i)
      )
    )
    expect(results).toHaveLength(10)
    expect(clock.now()).toBe(0)
  })
})
