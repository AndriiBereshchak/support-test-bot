import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

import { shutdownPrisma } from '@config/database'
import { closeNats } from '@config/nats'

import { buildApp } from '../src/app'

// HTTP-layer smoke tests. They use `app.inject()` rather than a real socket, so
// nothing binds a port and the suite stays safe to run alongside a dev stand.
//
// Scope is deliberately the transport contract only — guards, status codes,
// validation and header shape. Ticket/message behaviour belongs to the service
// tests, not here.
describe('support HTTP app', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = buildApp()
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    await closeNats()
    await shutdownPrisma()
  })

  it('answers the health probe from the database', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })

  it('404s an unknown route as JSON', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' })
    expect(res.statusCode).toBe(404)
  })

  it('rejects a body that fails the schema', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/internal/messages',
      payload: { userId: 'u-1' }, // userNId missing
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects a message with neither text nor attachments', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/internal/messages',
      payload: { userId: 'u-1', userNId: 1, text: '   ' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('EMPTY_MESSAGE')
  })

  it('204s a typing signal from a user with no ticket', async () => {
    // Fired on a keystroke, so "nothing to signal" must look like success —
    // an error status here would surface in the UI while the user types.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/internal/typing',
      payload: { userId: 'u-1' },
    })
    expect(res.statusCode).toBe(204)
    expect(res.body).toBe('')
  })

  it('404s an attachment the caller does not own', async () => {
    // Well-formed uuid that belongs to nobody: the response must be
    // indistinguishable from somebody else's file.
    const res = await app.inject({
      method: 'GET',
      url: '/v1/internal/attachments/00000000-0000-4000-8000-000000000000/raw?userId=u-1',
    })
    expect(res.statusCode).toBe(404)
  })

  it('400s an attachment id that is not a uuid', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/internal/attachments/not-a-uuid/raw?userId=u-1',
    })
    expect(res.statusCode).toBe(400)
  })

  it('always 200s the Telegram webhook', async () => {
    // An update the router does not understand must still be acknowledged —
    // a non-2xx makes Telegram redeliver it forever.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/internal/tg-webhook',
      payload: { update_id: 1 },
    })
    expect(res.statusCode).toBe(200)
  })
})
