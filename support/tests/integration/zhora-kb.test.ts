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
  question: ' How to log in? ',
  variants: ['Login help?'],
  answer_ru: ' Ответ ',
  category: 'account',
  updatedById: 'test-user-1',
})
const create = (body: object = payload()) =>
  app.inject({ method: 'POST', url: prefix, headers, payload: body })

function upload(
  content: string,
  filename = 'kb.json',
  author: string | null = 'test-user-1'
) {
  const boundary = 'synthetic-kb-import-boundary'
  const body = [
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n${content}\r\n`,
    // Deliberately after the file, as allowed by multipart.
    ...(author === null
      ? []
      : [
          `--${boundary}\r\nContent-Disposition: form-data; name="updatedById"\r\n\r\n${author}\r\n`,
        ]),
    `--${boundary}--\r\n`,
  ].join('')
  return app.inject({
    method: 'POST',
    url: `${prefix}/import`,
    headers: {
      ...headers,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: body,
  })
}

const csvCell = (value: unknown) =>
  `"${(typeof value === 'string' ? value : JSON.stringify(value)).replaceAll('"', '""')}"`

// Same structure as the supplied document, without copying its product data.
const document = () => ({
  version: '4.0',
  language: 'ru',
  product: 'Test product',
  rules: { style: ['Be concise.'], product: ['Verify the request status.'] },
  config: {
    full_version_url: 'https://example.test/full',
    ios_url: 'https://example.test/ios',
    android_url: 'https://example.test/android',
  },
  entries: [
    {
      id: 'TEST_001',
      category: 'account',
      question: ' How to open the full version? ',
      variants: ['How to open the full version?', 'Where is the full version?'],
      answer_ru:
        'Откройте {full_version_url}. iOS: {ios_url}. Android: {android_url}. Ваш ID: {nId}.',
      translations: { en: 'Open {full_version_url}. Your ID: {nId}.' },
      notes: ['Verify the required information.'],
      dynamic_fields: ['nId'],
      ask_user: ['Device type'],
      status: 'active',
      is_temporary: true,
    },
  ],
})

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
  await prismaSupport.zhoraKbConfig.deleteMany()
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
      code: null,
      question: 'How to log in?',
      variants: ['Login help?'],
      answer_ru: 'Ответ',
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
        code: 'ACCOUNT_001',
        status: 'active',
        translations: { en: ' Answer ' },
        domains: ['BINODEX.IO', 'binodex.io'],
        updatedById: ' test-user-2 ',
      },
    })
    expect(update.statusCode).toBe(200)
    expect(update.json()).toMatchObject({
      id: entry.id,
      code: 'ACCOUNT_001',
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
    await create({ ...payload(), category: 'payments' })
    const list = await app.inject({
      method: 'GET',
      url: `${prefix}?category=account&limit=1&offset=1`,
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
      await prismaSupport.zhoraKbEntry.findUnique({
        where: { id: entry.id },
      })
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
      { question: ' ' },
      { variants: [' '] },
      { answer_ru: ' ' },
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
        { method: 'POST' as const, url: `${prefix}/import`, payload: {} },
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

  it('imports JSON with defaults and explicit active status; repeated imports create new entries', async () => {
    const entries = [
      {
        question: ' Question ',
        answer_ru: ' Ответ ',
        category: 'account',
      },
      {
        id: 'TEST_002',
        question: 'Other question',
        answer_ru: 'Другой ответ',
        category: 'payments',
        status: 'active',
        translations: { en: ' Answer ' },
        domains: ['BINODEX.IO'],
      },
    ]
    const response = await upload(
      '\uFEFF' + JSON.stringify(entries),
      'kb.JSON',
      ' test-user-2 '
    )
    expect(response.statusCode).toBe(201)
    expect(response.json()).toEqual({ created: 2 })
    const stored = await prismaSupport.zhoraKbEntry.findMany({
      orderBy: { category: 'asc' },
    })
    expect(stored[0]).toMatchObject({
      code: null,
      question: 'Question',
      variants: [],
      answer_ru: 'Ответ',
      status: 'draft',
      domains: [],
      translations: {},
      updatedById: 'test-user-2',
    })
    expect(stored[1]).toMatchObject({
      code: 'TEST_002',
      status: 'active',
      translations: { en: 'Answer' },
      domains: ['binodex.io'],
      updatedById: 'test-user-2',
    })
    expect((await upload(JSON.stringify(entries))).json()).toEqual({
      created: 2,
    })
    expect(await prismaSupport.zhoraKbEntry.count()).toBe(4)
  })

  it('imports CSV with JSON cells, escaped quotes, commas and multiline answers', async () => {
    const answer = 'Ответ, с "кавычками"\nи переносом строки'
    const csv =
      '\uFEFFid,question,variants,answer_ru,category,translations,domains,status,notes,is_temporary\r\n' +
      [
        [
          'CSV_001',
          'Question',
          ['Variant'],
          answer,
          'account',
          { en: 'Answer' },
          ['binodex.io'],
          'active',
          ['Check the request.'],
          true,
        ]
          .map(csvCell)
          .join(','),
        ['', 'Second', '', 'Второй ответ', 'account', '', '', '', '', '']
          .map(csvCell)
          .join(','),
      ].join('\r\n')
    const response = await upload(csv, 'kb.csv')
    expect(response.statusCode).toBe(201)
    expect(response.json()).toEqual({ created: 2 })
    const stored = await prismaSupport.zhoraKbEntry.findMany()
    expect(stored).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'CSV_001',
          question: 'Question',
          variants: ['Variant'],
          answer_ru: answer,
          translations: { en: 'Answer' },
          domains: ['binodex.io'],
          status: 'active',
          notes: ['Check the request.'],
          is_temporary: true,
        }),
        expect.objectContaining({
          code: null,
          question: 'Second',
          variants: [],
          translations: {},
          domains: [],
          status: 'draft',
        }),
      ])
    )
  })

  it('imports entries and shared links while preserving KB placeholders', async () => {
    const input = document()
    input.entries.push({
      ...input.entries[0]!,
      id: 'TEST_001',
      is_temporary: false,
    })
    const response = await upload(JSON.stringify(input))
    expect(response.statusCode).toBe(201)
    expect(response.json()).toEqual({ created: 2 })
    const list = await app.inject({ method: 'GET', url: prefix, headers })
    expect(
      new Set(list.json().items.map((item: { id: string }) => item.id)).size
    ).toBe(2)
    const entry = list
      .json()
      .items.find((item: { is_temporary: boolean }) => item.is_temporary)
    expect(entry).toMatchObject({
      code: 'TEST_001',
      question: 'How to open the full version?',
      variants: input.entries[0]!.variants,
      answer_ru: input.entries[0]!.answer_ru,
      category: 'account',
      notes: input.entries[0]!.notes,
      dynamic_fields: ['nId'],
      ask_user: ['Device type'],
      status: 'active',
      is_temporary: true,
      domains: [],
      translations: input.entries[0]!.translations,
    })
    expect(entry).not.toHaveProperty('source')
    expect(entry).not.toHaveProperty('version')
    expect(entry).not.toHaveProperty('config')
    const config = await app.inject({
      method: 'GET',
      url: `${prefix}/config`,
      headers,
    })
    expect(config.json()).toMatchObject({
      full_version_url: input.config.full_version_url,
      ios_url: input.config.ios_url,
      android_url: input.config.android_url,
    })
    const changed = await app.inject({
      method: 'PATCH',
      url: `${prefix}/config`,
      headers,
      payload: {
        ios_url: 'https://example.test/new-ios',
        updatedById: 'test-user-2',
      },
    })
    expect(changed.statusCode).toBe(200)
    expect(changed.json().ios_url).toBe('https://example.test/new-ios')
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `${prefix}/${entry.id}`,
          headers,
        })
      ).json().answer_ru
    ).toBe(input.entries[0]!.answer_ru)
    const secondImport = await upload(JSON.stringify(document()))
    expect(secondImport.statusCode).toBe(201)
    const retained = await app.inject({
      method: 'GET',
      url: `${prefix}/config`,
      headers,
    })
    expect(retained.json().ios_url).toBe('https://example.test/new-ios')
    expect(entry.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
    const updated = await app.inject({
      method: 'PATCH',
      url: `${prefix}/${entry.id}`,
      headers,
      payload: {
        notes: ['Updated check.'],
        dynamic_fields: ['request_status'],
        ask_user: [],
        is_temporary: false,
        updatedById: 'test-user-2',
      },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toMatchObject({
      notes: ['Updated check.'],
      dynamic_fields: ['request_status'],
      ask_user: [],
      is_temporary: false,
    })
  })

  it('rejects an invalid record before writing any part of the import', async () => {
    await create()
    const { updatedById: _author, ...valid } = payload()
    const response = await upload(
      JSON.stringify([valid, { ...valid, translations: { pl: 'Answer' } }])
    )
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ code: 'KB_IMPORT_INVALID' })
    expect(response.json().message).toContain('Record 2')
    const csv =
      'question,variants,answer_ru,category\n' +
      [
        ['Valid', ['Variant'], 'Ответ', 'account'].map(csvCell).join(','),
        ['Question', 'not-json', 'Ответ', 'account'].map(csvCell).join(','),
      ].join('\n')
    const invalidCsv = await upload(csv, 'kb.csv')
    expect(invalidCsv.statusCode).toBe(400)
    expect(invalidCsv.json().message).toContain('Record 2')
    expect(await prismaSupport.zhoraKbEntry.count()).toBe(1)
  })

  it('rejects malformed, empty, oversized batches, missing authors and unsupported files', async () => {
    for (const content of [
      '{broken',
      '{}',
      '[]',
      JSON.stringify(Array.from({ length: 1001 }, () => payload())),
    ]) {
      expect((await upload(content)).statusCode).toBe(400)
    }
    for (const content of [
      'question,answer_ru,category\n"unclosed',
      'question,question\nfirst,second',
      'unknown\nvalue',
    ]) {
      expect((await upload(content, 'kb.csv')).statusCode).toBe(400)
    }
    expect((await upload('[]', 'kb.txt')).statusCode).toBe(400)
    expect((await upload('[]', 'kb.json', null)).statusCode).toBe(400)
    expect((await upload('[]', 'kb.json', ' ')).statusCode).toBe(400)
    expect(await prismaSupport.zhoraKbEntry.count()).toBe(0)
  })
})
