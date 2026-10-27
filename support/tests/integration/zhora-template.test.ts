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
  settings.schema = `zhora_template_${randomUUID().replaceAll('-', '')}`
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
  INTERNAL_TOKEN: 'synthetic-template-token',
  ZHORA_ENABLED: true,
}))
vi.mock('@apps/services/zhora/llm.service', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@apps/services/zhora/llm.service')
  >()),
  generateZhoraTextWithJournal: vi.fn(),
}))

import { prismaSupport } from '@config/database'
import { buildApp } from '../../src/app'
import { generateZhoraTextWithJournal } from '@apps/services/zhora/llm.service'
import { runZhoraJobPass } from '@apps/services/zhora/job.service'

const app = buildApp()
const prefix = '/v1/internal/zhora/templates'
const headers = { 'x-internal-token': 'synthetic-template-token' }
const body = () => ({
  code: `WELCOME_${randomUUID().slice(0, 8)}`,
  category: 'account',
  textRu: 'Здравствуйте, {name}. Ваш ID: {nId}.',
  updatedById: 'admin-1',
})
const create = (payload: object = body()) =>
  app.inject({ method: 'POST', url: prefix, headers, payload })
const patch = (id: string, payload: object) =>
  app.inject({ method: 'PATCH', url: `${prefix}/${id}`, headers, payload })

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
  vi.clearAllMocks()
  await prismaSupport.zhoraJob.deleteMany()
  await prismaSupport.zhoraTemplateUsage.deleteMany()
  await prismaSupport.zhoraTemplate.deleteMany()
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

describe('Zhora template management API', () => {
  it('creates a template, derives variables, queues only missing translations and reads it back', async () => {
    const payload = {
      ...body(),
      translations: { en: 'Hello, {name}. Your ID: {nId}.' },
    }
    const response = await create(payload)
    expect(response.statusCode).toBe(201)
    const created = response.json()
    expect(created).toMatchObject({
      code: payload.code,
      category: 'account',
      variables: ['nId', 'name'],
      revision: 1,
      updatedById: 'admin-1',
      _count: { usages: 0 },
    })
    expect(created.translations).toHaveLength(10)
    expect(
      created.translations.find(
        (item: { language: string }) => item.language === 'en'
      )
    ).toMatchObject({
      text: payload.translations.en,
      isManual: true,
      needsReview: false,
    })
    expect(
      created.translations.filter(
        (item: { text: string | null }) => item.text === null
      )
    ).toHaveLength(9)
    expect(await prismaSupport.zhoraJob.count()).toBe(9)

    const read = await app.inject({
      method: 'GET',
      url: `${prefix}/${created.id}`,
      headers,
    })
    expect(read.statusCode, read.body).toBe(200)
    expect(read.json()).toEqual(created)
    const list = await app.inject({
      method: 'GET',
      url: `${prefix}?category=account&limit=1`,
      headers,
    })
    expect(list.json()).toMatchObject({ total: 1, limit: 1, offset: 0 })
  })

  it('rejects duplicate codes, unsupported or missing variables and invalid requests', async () => {
    const first = body()
    expect((await create(first)).statusCode).toBe(201)
    expect((await create(first)).statusCode).toBe(409)
    for (const invalid of [
      { textRu: 'Здравствуйте, {unknown}.' },
      { textRu: 'Здравствуйте, {name' },
      { translations: { pl: 'Hello, {name}. Your ID: {nId}.' } },
      { translations: { en: 'Hello.' } },
      { code: 'invalid code' },
      { category: ' ' },
    ])
      expect((await create({ ...body(), ...invalid })).statusCode).toBe(400)
    expect((await create({ ...body(), updatedById: ' ' })).statusCode).toBe(400)
    expect(
      (await patch(randomUUID(), { updatedById: 'admin-1' })).statusCode
    ).toBe(400)
    expect(
      (await app.inject({ method: 'GET', url: `${prefix}/invalid`, headers }))
        .statusCode
    ).toBe(400)
    expect(
      (await app.inject({ method: 'GET', url: `${prefix}?limit=201`, headers }))
        .statusCode
    ).toBe(400)
  })

  it('keeps manual translations for review after a RU edit and ignores old jobs', async () => {
    const created = (
      await create({
        ...body(),
        translations: { en: 'Hello, {name}. Your ID: {nId}.' },
      })
    ).json()
    const update = await patch(created.id, {
      textRu: 'Добрый день, {name}. Ваш ID: {nId}.',
      updatedById: 'admin-2',
    })
    expect(update.statusCode).toBe(200)
    const changed = update.json()
    expect(changed.revision).toBe(2)
    expect(
      changed.translations.find(
        (item: { language: string }) => item.language === 'en'
      )
    ).toMatchObject({
      text: 'Hello, {name}. Your ID: {nId}.',
      isManual: true,
      needsReview: true,
    })
    expect(await prismaSupport.zhoraJob.count()).toBe(18)
    vi.mocked(generateZhoraTextWithJournal).mockResolvedValue({
      text: JSON.stringify({ text: 'Hello, {name}. Your ID: {nId}.' }),
      model: 'test/translate',
      generationId: null,
      durationMs: 1,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
        cachedTokens: null,
        cacheWriteTokens: null,
      },
    })
    for (let index = 0; index < 18; index++) await runZhoraJobPass()
    expect(generateZhoraTextWithJournal).toHaveBeenCalledTimes(9)
    const refreshed = await prismaSupport.zhoraTemplate.findUniqueOrThrow({
      where: { id: created.id },
      include: { translations: true },
    })
    expect(
      refreshed.translations.filter((item) => item.text === null)
    ).toHaveLength(0)
    expect(
      refreshed.translations.find((item) => item.language === 'en')
    ).toMatchObject({ text: 'Hello, {name}. Your ID: {nId}.', isManual: true })

    const reviewed = await patch(created.id, {
      translations: { en: 'Good day, {name}. Your ID: {nId}.' },
      updatedById: 'admin-3',
    })
    expect(reviewed.statusCode).toBe(200)
    expect(
      reviewed
        .json()
        .translations.find(
          (item: { language: string }) => item.language === 'en'
        )
    ).toMatchObject({
      text: 'Good day, {name}. Your ID: {nId}.',
      needsReview: false,
    })
  })

  it('generates and saves a translation, but a later manual edit wins', async () => {
    const created = (await create()).json()
    vi.mocked(generateZhoraTextWithJournal).mockResolvedValue({
      text: JSON.stringify({ text: 'Hello, {name}. Your ID: {nId}.' }),
      model: 'test/translate',
      generationId: null,
      durationMs: 1,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
        cachedTokens: null,
        cacheWriteTokens: null,
      },
    })
    await runZhoraJobPass()
    const firstJob = await prismaSupport.zhoraJob.findFirstOrThrow({
      where: {
        eventKey: { startsWith: `template:translate:${created.id}:1:` },
        status: 'completed',
      },
    })
    expect(firstJob.status).toBe('completed')
    const language = (firstJob.input as { language: string }).language
    expect(
      await prismaSupport.zhoraTemplateTranslation.findUnique({
        where: { templateId_language: { templateId: created.id, language } },
      })
    ).toMatchObject({ text: 'Hello, {name}. Your ID: {nId}.', isManual: false })
    const edited = await patch(created.id, {
      translations: { [language]: 'Dear {name}, your ID is {nId}.' },
      updatedById: 'admin-2',
    })
    expect(edited.statusCode).toBe(200)
    expect(
      edited
        .json()
        .translations.find(
          (item: { language: string }) => item.language === language
        )
    ).toMatchObject({ text: 'Dear {name}, your ID is {nId}.', isManual: true })

    const pending = await prismaSupport.zhoraJob.findFirstOrThrow({
      where: {
        eventKey: { startsWith: `template:translate:${created.id}:1:` },
        status: 'queued',
      },
    })
    const pendingLanguage = (pending.input as { language: string }).language
    expect(
      (
        await patch(created.id, {
          translations: {
            [pendingLanguage]: 'Reviewed by a person: {name}, {nId}.',
          },
          updatedById: 'admin-3',
        })
      ).statusCode
    ).toBe(200)
    for (let index = 0; index < 9; index++) await runZhoraJobPass()
    expect(
      await prismaSupport.zhoraTemplateTranslation.findUnique({
        where: {
          templateId_language: {
            templateId: created.id,
            language: pendingLanguage,
          },
        },
      })
    ).toMatchObject({
      text: 'Reviewed by a person: {name}, {nId}.',
      isManual: true,
    })
    expect(generateZhoraTextWithJournal).toHaveBeenCalledTimes(9)
  })

  it('keeps usage history after deleting a template', async () => {
    const created = (await create()).json()
    const usage = await prismaSupport.zhoraTemplateUsage.create({
      data: {
        templateId: created.id,
        templateCode: created.code,
        operatorTgUserId: 123456789n,
        editedBeforeSend: true,
      },
    })
    const history = await app.inject({
      method: 'GET',
      url: `${prefix}/${created.id}/usages`,
      headers,
    })
    expect(history.statusCode).toBe(200)
    expect(history.json()).toMatchObject({
      total: 1,
      editedTotal: 1,
      items: [
        {
          id: usage.id,
          operatorTgUserId: '123456789',
          editedBeforeSend: true,
        },
      ],
    })
    const deleted = await app.inject({
      method: 'DELETE',
      url: `${prefix}/${created.id}`,
      headers,
    })
    expect(deleted.statusCode).toBe(204)
    expect(
      await prismaSupport.zhoraTemplateUsage.findUnique({
        where: { id: usage.id },
      })
    ).toMatchObject({
      templateId: null,
      templateCode: created.code,
      editedBeforeSend: true,
    })
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `${prefix}/${created.id}`,
          headers,
        })
      ).statusCode
    ).toBe(404)
  })

  it('requires a service token for every template operation', async () => {
    for (const token of [undefined, 'wrong']) {
      const auth = token ? { 'x-internal-token': token } : {}
      for (const route of [
        { method: 'GET' as const, url: prefix },
        { method: 'GET' as const, url: `${prefix}/${randomUUID()}` },
        { method: 'GET' as const, url: `${prefix}/${randomUUID()}/usages` },
        { method: 'POST' as const, url: prefix, payload: body() },
        {
          method: 'PATCH' as const,
          url: `${prefix}/${randomUUID()}`,
          payload: { category: 'account', updatedById: 'admin-1' },
        },
        { method: 'DELETE' as const, url: `${prefix}/${randomUUID()}` },
      ])
        expect((await app.inject({ ...route, headers: auth })).statusCode).toBe(
          401
        )
    }
  })
})
