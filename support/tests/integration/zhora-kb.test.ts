import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

const settings = vi.hoisted(() => ({ schema: '', url: '' }))
vi.mock('@config/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@config/database')>()
  const { PrismaClient } = await import('@prisma-support')
  const { randomUUID } = await import('node:crypto')
  settings.schema = `zhora_kb_${randomUUID().replaceAll('-', '')}`
  const url = new URL(process.env.DATABASE_SUPPORT!)
  url.searchParams.set('schema', settings.schema)
  settings.url = url.toString()
  return {
    ...actual,
    prismaSupport: new PrismaClient({
      datasources: { db: { url: settings.url } },
    }),
  }
})
vi.mock('@config/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@config/env')>()),
  INTERNAL_TOKEN: 'synthetic-kb-token',
}))

import { prismaSupport } from '@config/database'
import { buildApp } from '../../src/app'
import type { ZhoraKbActor } from '@apps/routes/zhora-kb.routes'

const prefix = '/v1/internal/zhora/kb'
const headers = { 'x-internal-token': 'synthetic-kb-token' }
let actor: ZhoraKbActor | null = { id: 'admin-one', isAdmin: true }
// Test-only resolver. No invented admin headers are exposed by the application.
const app = buildApp({ zhoraKb: { resolveActor: async () => actor } })
const payload = () => ({
  questions: [' How to log in? '],
  answerRu: ' Ответ ',
  tag: 'account',
})
const create = (body: object = payload()) =>
  app.inject({ method: 'POST', url: prefix, headers, payload: body })

beforeAll(async () => {
  const cli = path.join(
    path.dirname(require.resolve('prisma/package.json')),
    'build/index.js'
  )
  execFileSync(
    process.execPath,
    [cli, 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'],
    {
      cwd: path.resolve(__dirname, '../..'),
      env: { ...process.env, DATABASE_SUPPORT: settings.url },
      stdio: 'pipe',
    }
  )
  await app.ready()
})
beforeEach(async () => {
  actor = { id: 'admin-one', isAdmin: true }
  await prismaSupport.zhoraKbEntry.deleteMany()
})
afterAll(async () => {
  await app.close()
  try {
    await prismaSupport.$executeRawUnsafe(
      `DROP SCHEMA IF EXISTS "${settings.schema}" CASCADE`
    )
  } finally {
    await prismaSupport.$disconnect()
  }
})

describe('Zhora KB management API (prepared admin adapter)', () => {
  it('creates a draft, reads it and activates it with partial translations and a verified author', async () => {
    const response = await create({
      ...payload(),
      updatedById: 'forged-author',
    })
    expect(response.statusCode).toBe(201)
    const entry = response.json()
    expect(entry).toMatchObject({
      questions: ['How to log in?'],
      answerRu: 'Ответ',
      translations: {},
      domains: [],
      status: 'draft',
      updatedById: 'admin-one',
    })
    actor = { id: 'admin-two', isAdmin: true }
    const update = await app.inject({
      method: 'PATCH',
      url: `${prefix}/${entry.id}`,
      headers,
      payload: {
        status: 'active',
        translations: { en: ' Answer ' },
        domains: ['BINODEX.IO', 'binodex.io'],
      },
    })
    expect(update.statusCode).toBe(200)
    expect(update.json()).toMatchObject({
      status: 'active',
      translations: { en: 'Answer' },
      domains: ['binodex.io'],
      updatedById: 'admin-two',
      createdAt: entry.createdAt,
    })
    const read = await app.inject({
      method: 'GET',
      url: `${prefix}/${entry.id}`,
      headers,
    })
    expect(read.json()).toEqual(update.json())
  })

  it('filters and paginates the management list, including drafts', async () => {
    await create()
    await create({ ...payload(), status: 'active' })
    await create({ ...payload(), tag: 'payments' })
    const list = await app.inject({
      method: 'GET',
      url: `${prefix}?tag=account&limit=1&offset=1`,
      headers,
    })
    expect(list.statusCode).toBe(200)
    expect(list.json()).toMatchObject({ total: 2, limit: 1, offset: 1 })
    expect(list.json().items).toHaveLength(1)
    const active = await app.inject({
      method: 'GET',
      url: `${prefix}?status=active`,
      headers,
    })
    expect(active.json().total).toBe(1)
    expect(active.json().items[0].status).toBe('active')
  })

  it('physically deletes an entry and returns 404 for missing records', async () => {
    const entry = (await create()).json()
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `${prefix}/${entry.id}`,
          headers,
        })
      ).statusCode
    ).toBe(204)
    expect(
      await prismaSupport.zhoraKbEntry.findUnique({ where: { id: entry.id } })
    ).toBeNull()
    for (const method of ['GET', 'PATCH', 'DELETE'] as const) {
      const response = await app.inject({
        method,
        url: `${prefix}/${entry.id}`,
        headers,
        ...(method === 'PATCH' && { payload: { status: 'active' } }),
      })
      expect(response.statusCode).toBe(404)
      expect(response.json().code).toBe('KB_NOT_FOUND')
    }
  })

  it('rejects invalid content, languages, domains, status, pagination and empty updates', async () => {
    for (const invalid of [
      { questions: [] },
      { answerRu: ' ' },
      { translations: { pl: 'Answer' } },
      { translations: { en: ' ' } },
      { domains: ['https://binodex.io/path'] },
      { status: 'published' },
    ])
      expect((await create({ ...payload(), ...invalid })).statusCode).toBe(400)
    expect(await prismaSupport.zhoraKbEntry.count()).toBe(0)
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `${prefix}/${randomUUID()}`,
          headers,
          payload: { updatedById: 'forged-author' },
        })
      ).statusCode
    ).toBe(400)
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `${prefix}/${randomUUID()}`,
          headers,
          payload: {},
        })
      ).statusCode
    ).toBe(400)
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `${prefix}/invalid-id`,
          headers,
        })
      ).statusCode
    ).toBe(400)
    expect(
      (await app.inject({ method: 'GET', url: `${prefix}?limit=201`, headers }))
        .statusCode
    ).toBe(400)
  })

  it('requires both the service token and a verified administrator for every operation', async () => {
    for (const access of ['no-token', 'no-actor', 'not-admin'] as const) {
      actor =
        access === 'no-actor'
          ? null
          : { id: 'operator', isAdmin: access !== 'not-admin' }
      const auth = access === 'no-token' ? {} : headers
      for (const method of ['GET', 'POST', 'PATCH', 'DELETE'] as const) {
        const url =
          method === 'PATCH' || method === 'DELETE'
            ? `${prefix}/${randomUUID()}`
            : prefix
        const response = await app.inject({
          method,
          url,
          headers: auth,
          ...(method === 'POST' && { payload: payload() }),
          ...(method === 'PATCH' && { payload: { status: 'active' } }),
        })
        expect(response.statusCode).toBe(access === 'not-admin' ? 403 : 401)
      }
    }
    expect(await prismaSupport.zhoraKbEntry.count()).toBe(0)
  })

  it('mounts the API but refuses access until the admin adapter is connected', async () => {
    const application = buildApp()
    try {
      expect(
        (await application.inject({ method: 'GET', url: prefix })).statusCode
      ).toBe(401)
      for (const method of ['GET', 'POST', 'PATCH', 'DELETE'] as const) {
        const response = await application.inject({
          method,
          url:
            method === 'PATCH' || method === 'DELETE'
              ? `${prefix}/${randomUUID()}`
              : prefix,
          headers,
          ...(method === 'POST' && { payload: payload() }),
          ...(method === 'PATCH' && { payload: { status: 'active' } }),
        })
        expect(response.statusCode).toBe(503)
        expect(response.json().code).toBe('KB_AUTH_NOT_CONFIGURED')
      }
      expect(await prismaSupport.zhoraKbEntry.count()).toBe(0)
    } finally {
      await application.close()
    }
  })
})
