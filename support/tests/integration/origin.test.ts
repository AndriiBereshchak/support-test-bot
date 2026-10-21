import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import type { FastifyInstance } from 'fastify'

// The same two boundaries as the rest of the suite. Everything below goes in
// through the real HTTP route, because the origin only ever arrives as a field
// on it — the exchange proxy is the only thing that knows which mirror the
// browser is on, and it puts the answer in the request body.
vi.mock('@apps/services/push.service', () => ({
  pushToUser: vi.fn(async () => undefined),
}))
vi.mock('@telegram/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@telegram/api')>()),
  ...(await import('./_telegram-stub')).telegramStub(),
}))

import { shutdownPrisma } from '@config/database'

import { closeTicketEverywhere } from '@apps/services/chat.service'

import * as telegram from '@telegram/api'

import { buildApp } from '../../src/app'
import { PNG_BYTES } from '../fixtures/bytes'
import {
  cleanupTestUser,
  createTestUser,
  listTickets,
  openTicketOf,
  type TestUser,
} from './_helpers'

const MAIN = 'binodex.com'
const MIRROR = 'binodex.pro'

let app: FastifyInstance

beforeAll(async () => {
  app = buildApp()
  await app.ready()
})

beforeEach(() => {
  // Call history only — the stub's incrementing ids must survive.
  vi.clearAllMocks()
})

afterAll(async () => {
  await app.close()
  await shutdownPrisma()
})

const send = (user: TestUser, text: string, originDomain?: string) =>
  app.inject({
    method: 'POST',
    url: '/v1/internal/messages',
    payload: {
      userId: user.userId,
      userNId: user.userNId,
      text,
      ...(originDomain ? { originDomain } : {}),
    },
  })

const BOUNDARY = '----binodexOriginTest'

/**
 * The multipart body the upload route parses, with the file part FIRST.
 *
 * That order is load-bearing: the handler drains the file before reading
 * `data.fields`, because busboy fills them incrementally — a field sent before
 * the file would be the only one it could see, and one sent after is exactly
 * what this exercises.
 */
function multipartBody(user: TestUser, originDomain: string): Buffer {
  const part = (headers: string, body: Buffer): Buffer =>
    Buffer.concat([
      Buffer.from(`--${BOUNDARY}\r\n${headers}\r\n\r\n`),
      body,
      Buffer.from('\r\n'),
    ])

  return Buffer.concat([
    part(
      'Content-Disposition: form-data; name="file"; filename="shot.png"\r\nContent-Type: image/png',
      PNG_BYTES
    ),
    part(
      'Content-Disposition: form-data; name="userId"',
      Buffer.from(user.userId)
    ),
    part(
      'Content-Disposition: form-data; name="userNId"',
      Buffer.from(String(user.userNId))
    ),
    part(
      'Content-Disposition: form-data; name="originDomain"',
      Buffer.from(originDomain)
    ),
    Buffer.from(`--${BOUNDARY}--\r\n`),
  ])
}

const upload = (user: TestUser, originDomain: string) =>
  app.inject({
    method: 'POST',
    url: '/v1/internal/attachments',
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    payload: multipartBody(user, originDomain),
  })

describe('the mirror a ticket was opened from', () => {
  it('is recorded once and never rewritten by a later mirror', async () => {
    const user = await createTestUser()
    try {
      expect((await send(user, 'не приходит депозит', MAIN)).statusCode).toBe(
        200
      )

      const ticket = (await openTicketOf(user.userId))!
      expect(ticket.originDomain).toBe(MAIN)

      // What the operator actually sees: the value has to reach the info card,
      // not just the column.
      expect(vi.mocked(telegram.createTicketTopic)).toHaveBeenCalledTimes(1)
      expect(
        vi.mocked(telegram.createTicketTopic).mock.calls[0]![0]
      ).toMatchObject({ originDomain: MAIN })

      // The same user continues the conversation from a second mirror — a real
      // case (the smart link sends people to whichever domain resolves). The
      // operator has already answered questions based on the domain the card
      // showed, so the ticket must keep it.
      expect(
        (await send(user, 'пишу со второго зеркала', MIRROR)).statusCode
      ).toBe(200)
      expect((await openTicketOf(user.userId))!.originDomain).toBe(MAIN)

      // And a message with no origin at all (an older FE build, a proxy that
      // could not resolve the header) must not blank it either.
      expect((await send(user, 'и ещё раз')).statusCode).toBe(200)
      expect((await openTicketOf(user.userId))!.originDomain).toBe(MAIN)
    } finally {
      await cleanupTestUser(user.userId)
    }
  })

  it('is recorded by an upload too, since a file can open the ticket', async () => {
    const user = await createTestUser()
    try {
      // Attaching a file before typing anything is the OTHER way a ticket is
      // born, and a ticket opened that way deserves the same origin as one
      // opened by typing.
      const response = await upload(user, MIRROR)
      expect(response.statusCode).toBe(200)

      const ticket = (await openTicketOf(user.userId))!
      expect(ticket.originDomain).toBe(MIRROR)
    } finally {
      await cleanupTestUser(user.userId)
    }
  })

  it('follows the user to the next ticket rather than sticking to them', async () => {
    const user = await createTestUser()
    try {
      await send(user, 'первое обращение', MAIN)
      const first = (await openTicketOf(user.userId))!
      await closeTicketEverywhere(first.id, 'USER')

      // First-write-wins is a property of the TICKET, not of the user: the next
      // conversation is opened somewhere else, and the card has to say so.
      await send(user, 'второе обращение', MIRROR)

      const tickets = await listTickets(user.userId)
      expect(tickets).toHaveLength(2)
      expect(tickets.map((t) => t.originDomain)).toEqual([MAIN, MIRROR])
    } finally {
      await cleanupTestUser(user.userId)
    }
  })

  it('stays null when nothing ever supplied one', async () => {
    const user = await createTestUser()
    try {
      // Every ticket opened before this feature shipped is in exactly this
      // state, and the card renders without the line rather than with an empty
      // one — the write is create-only, so nothing backfills it later.
      await send(user, 'без заголовка origin')

      expect((await openTicketOf(user.userId))!.originDomain).toBeNull()
      expect(
        vi.mocked(telegram.createTicketTopic).mock.calls[0]![0].originDomain
      ).toBeNull()
    } finally {
      await cleanupTestUser(user.userId)
    }
  })
})
