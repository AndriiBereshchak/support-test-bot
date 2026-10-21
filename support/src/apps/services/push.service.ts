import { stringCodec, tryGetNatsConnection } from '@config/nats'
import { logger } from '@config/logger'

import { type SupportPush } from '@core/contracts'

// Exchange's cross-replica WebSocket fanout subject. Publishing here is the
// ONLY supported way for a sibling service to reach a user's browser: every
// exchange-api replica subscribes, and the one holding that user's socket
// emits `data` to it verbatim.
//
// Deliberately not going through the outbox/JetStream: the socket layer is
// best-effort by design (an offline user's push is dropped), so durability
// would buy nothing. Durability lives in Postgres instead — every pushed
// message is already persisted, and the browser re-reads the thread on
// reconnect, which is what actually recovers missed messages.
const WS_FANOUT_SUBJECT = 'ws.fanout'

// Exchange replicas self-skip an envelope only when `origin` equals their own
// per-process REPLICA_ID (a random uuid). A literal, non-uuid origin is
// therefore processed by every replica — and exactly one of them (the one
// with the socket) emits. That makes a SINGLE publish exactly-once delivery.
//
// Corollary, and the trap this constant exists to document: never publish the
// same envelope from more than one place. Two publishes = two bubbles in every
// open tab.
const FANOUT_ORIGIN = 'support-service'

interface FanoutEnvelope {
  kind?: 'emit' | 'disconnect'
  uid: string | null
  data?: unknown
  token?: string | null
  origin: string
}

/**
 * Push a payload to one user's browser sessions.
 *
 * Fire-and-forget by contract: a NATS hiccup must never fail the HTTP request
 * or the Telegram relay that triggered it — the message is already in
 * Postgres and the client will pick it up on its next thread read.
 */
export async function pushToUser(
  userId: string,
  payload: SupportPush
): Promise<void> {
  try {
    // Non-blocking on purpose: an HTTP request must never wait on the broker.
    // While NATS is down this returns undefined immediately (and re-dials in
    // the background) instead of parking the caller until the dial times out.
    const nc = tryGetNatsConnection()
    if (!nc) {
      logger.warn(`[push] fanout skipped for ${userId}: no NATS connection`)
      return
    }

    const envelope: FanoutEnvelope = {
      kind: 'emit',
      uid: userId,
      data: payload,
      origin: FANOUT_ORIGIN,
    }
    nc.publish(WS_FANOUT_SUBJECT, stringCodec.encode(JSON.stringify(envelope)))
  } catch (err) {
    logger.warn(
      `[push] fanout publish failed for ${userId}: ${(err as Error).message}`
    )
  }
}
