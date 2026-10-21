import { Redis } from 'ioredis'

import { REDIS_HOST, REDIS_PASSWORD, REDIS_PORT } from './env'
import { logger } from './logger'

/** House key namespace. Everything this service writes lives under it. */
export const SUPPORT_KEY_PREFIX = 'binodex:support:'

export const supportKey = (suffix: string): string =>
  `${SUPPORT_KEY_PREFIX}${suffix}`

/**
 * Single shared client.
 *
 * `lazyConnect` matters here: Redis is used by exactly one thing (the sweeper's
 * multi-replica lock), but `server.ts` imports `closeRedis` unconditionally for
 * the shutdown path. Without lazy connect, every api-role replica — which never
 * issues a command — would still open and hold a Redis socket just because the
 * module got loaded. ioredis dials on the first command instead.
 */
export const redisClient = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  password: REDIS_PASSWORD,
  lazyConnect: true,
})

redisClient.on('error', (err: Error) => {
  logger.error(`[redis] ${err.message}`)
})

export async function closeRedis(): Promise<void> {
  // 'wait' = lazy client that never dialled; quitting it throws.
  if (redisClient.status === 'wait' || redisClient.status === 'end') return
  try {
    await redisClient.quit()
    logger.debug('[redis] connection closed')
  } catch (err) {
    logger.warn(`[redis] error closing: ${(err as Error).message}`)
  }
}
