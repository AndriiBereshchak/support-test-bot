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

const prefix = '/v1/internal/zhora/kb'
const headers = { 'x-internal-token': 'synthetic-kb-token' }
const app = buildApp()
const payload = () => ({
  questions: [' How to log in? '],
  answerRu: ' Ответ ',
  tag: 'account',
  updatedById: 'test-user-1',
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

describe('Zhora KB internal management API', () => {
  it('creates a draft, reads it and activates it with partial translations and the supplied author', async () => {
    const response = await create()
    expect(response.statusCode).toBe(201)
    const entry = response.json()
    expect(entry).toMatchObject({
      questions: ['How to log in?'],
      answerRu: 'Ответ',
      translations: {},
      domains: [],
      status: 'draft',
      updatedById: 'test-user-1',
    })
    const update = await app.inject({
      method: 'PATCH',
      url: `${prefix}/${entry.id}`,
      headers,
      payload: {
        status: 'active',
        translations: { en: ' Answer ' },
        domains: ['BINODEX.IO', 'binodex.io'],
        updatedById: ' test-user-2 ',
      },
    })
    expect(update.statusCode).toBe(200)
    expect(update.json()).toMatchObject({
      status: 'active',
      translations: { en: 'Answer' },
      domains: ['binodex.io'],
      updatedById: 'test-user-2',
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
        ...(method === 'PATCH' && {
          payload: { status: 'active', updatedById: 'test-user-1' },
        }),
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
          payload: { updatedById: 'test-user-1' },
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

  it('requires the service token for every operation', async () => {
    for (const token of [undefined, 'wrong-token']) {
      const auth = token ? { 'x-internal-token': token } : {}
      for (const route of [
        { method: 'GET' as const, url: prefix },
        { method: 'GET' as const, url: `${prefix}/${randomUUID()}` },
        { method: 'POST' as const, url: prefix, payload: payload() },
        {
          method: 'PATCH' as const,
          url: `${prefix}/${randomUUID()}`,
          payload: { status: 'active', updatedById: 'test-user-1' },
        },
        { method: 'DELETE' as const, url: `${prefix}/${randomUUID()}` },
      ]) {
        expect((await app.inject({ ...route, headers: auth })).statusCode).toBe(
          401
        )
      }
    }
    expect(await prismaSupport.zhoraKbEntry.count()).toBe(0)
  })

  it('requires a nonblank author on creates and edits without changing stored data', async () => {
    const { updatedById: _author, ...withoutAuthor } = payload()
    expect((await create(withoutAuthor)).statusCode).toBe(400)
    expect((await create({ ...payload(), updatedById: ' ' })).statusCode).toBe(
      400
    )
    const entry = (await create()).json()
    for (const body of [
      { status: 'active' },
      { status: 'active', updatedById: ' ' },
    ]) {
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `${prefix}/${entry.id}`,
            headers,
            payload: body,
          })
        ).statusCode
      ).toBe(400)
    }
    const kept = await prismaSupport.zhoraKbEntry.findUniqueOrThrow({
      where: { id: entry.id },
    })
    expect(kept.status).toBe('draft')
    expect(kept.updatedById).toBe('test-user-1')
  })
})
