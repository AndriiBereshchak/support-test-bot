import { connect, type NatsConnection, StringCodec } from 'nats'

import { NATS_PASSWORD, NATS_URL, NATS_USER } from './env'
import { logger } from './logger'

export const stringCodec = StringCodec()

// How long the boot handshake waits for the broker before giving up on THIS
// attempt. `waitOnFirstConnect` (below) makes the underlying dial retry forever
// and never settle while NATS is down, so without a bound `run()` stops before
// `app.listen()`: a replica that serves nothing and fails its healthcheck
// because a best-effort dependency happened to start late. The dial keeps
// running and is adopted the moment it lands, so a timeout costs nothing but
// the pushes sent in the meantime.
const CONNECT_TIMEOUT_MS = 5000

let connection: NatsConnection | undefined
// The in-flight dial, shared by every caller. Without it, each request that
// pushes during an outage would start its own forever-retrying connection.
let dialing: Promise<NatsConnection> | undefined

function dial(): Promise<NatsConnection> {
  dialing ??= connect({
    servers: NATS_URL,
    user: NATS_USER,
    pass: NATS_PASSWORD,
    reconnect: true,
    maxReconnectAttempts: -1,
    reconnectTimeWait: 2000,
    waitOnFirstConnect: true,
  })
    .then((nc) => {
      connection = nc
      void nc.closed().then((err) => {
        connection = undefined
        // Cleared too, so the next push re-dials instead of handing out a
        // promise that already resolved to a dead connection.
        dialing = undefined
        if (err) logger.error(`[nats] connection closed: ${err.message}`)
      })
      logger.debug(`[nats] connected to ${NATS_URL}`)
      return nc
    })
    .catch((err: Error) => {
      dialing = undefined
      throw err
    })

  return dialing
}

/**
 * The connection if one is live RIGHT NOW, otherwise undefined — with a dial
 * kicked off in the background so a later call can succeed.
 *
 * For the push path, which is fire-and-forget by contract: making a user's send
 * wait out the timeout above (once per request, for as long as the outage
 * lasts) buys nothing. The message is already committed to Postgres and the
 * browser re-reads the thread on reconnect, so a dropped push costs a redraw
 * and a blocked request costs the user a five-second spinner.
 */
export function tryGetNatsConnection(): NatsConnection | undefined {
  if (connection) return connection
  // Deliberately not awaited: this only guarantees a dial is in flight, and
  // `dial()` memoizes so a burst of pushes shares one attempt. The catch is
  // what keeps a failed dial from surfacing as an unhandled rejection.
  void dial().catch(() => undefined)
  return undefined
}

export async function getNatsConnection(): Promise<NatsConnection> {
  if (connection) return connection

  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(new Error(`connect timed out after ${CONNECT_TIMEOUT_MS}ms`)),
      CONNECT_TIMEOUT_MS
    )
    // A pending push must never be the reason the process refuses to exit.
    timer.unref()
  })

  try {
    // Racing leaves the dial itself running: `Promise.race` has attached its
    // own handlers to it, so a later failure is never an unhandled rejection.
    return await Promise.race([dial(), deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function closeNats(): Promise<void> {
  // Drop the dial first: shutdown must not leave a forever-retrying connect
  // attempt behind, and a caller racing the teardown gets a fresh one.
  dialing = undefined
  if (!connection) return
  try {
    await connection.drain()
    logger.debug('[nats] connection drained')
  } catch (err) {
    logger.error(`[nats] error draining: ${(err as Error).message}`)
  } finally {
    connection = undefined
  }
}
