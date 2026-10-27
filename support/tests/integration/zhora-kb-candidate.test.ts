import { execFileSync } from 'node:child_process'
import { randomInt, randomUUID } from 'node:crypto'
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
  settings.schema = `zhora_candidate_${randomUUID().replaceAll('-', '')}`
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
  ZHORA_ENABLED: true,
  ZHORA_OPENROUTER_API_KEY: 'synthetic-candidate-key',
  ZHORA_MODEL_CANDIDATES: 'test/draft',
  INTERNAL_TOKEN: 'synthetic-candidate-token',
}))

import { prismaSupport } from '@config/database'
import { appendMessage } from '@apps/services/message.service'
import {
  runZhoraCandidateDraftPass,
  runZhoraCandidateGroupingPass,
} from '@apps/services/zhora/kb-candidate.service'
import { buildApp } from '../../src/app'

const app = buildApp()
const headers = { 'x-internal-token': 'synthetic-candidate-token' }
const url = '/v1/internal/zhora/kb-candidates'
let domain: string
const vector = (x: number, y: number) => [x, y, ...Array(1022).fill(0)]

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

beforeEach(() => {
  domain = `${randomUUID()}.test`
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

async function suggestion(
  question: string,
  embedding: number[] | null = vector(1, 0),
  options: { ticketId?: string; originDomain?: string; kind?: string } = {}
) {
  const ticket = options.ticketId
    ? await prismaSupport.supportTicket.findUniqueOrThrow({
        where: { id: options.ticketId },
      })
    : await prismaSupport.supportTicket.create({
        data: {
          userId: randomUUID(),
          userNId: randomInt(100_000, 900_000),
          originDomain: options.originDomain ?? domain,
        },
      })
  const target = await appendMessage({
    ticketId: ticket.id,
    direction: 'IN',
    text: question,
  })
  const job = await prismaSupport.zhoraJob.create({
    data: {
      eventKey: randomUUID(),
      operation: options.kind === 'suggestion-fix' ? 'fix' : 'reply',
      input: { kind: options.kind ?? 'suggestion' },
      status: 'completed',
      ticketId: ticket.id,
      result: {
        answer: 'Please wait.',
        answerRu: 'Подождите, пожалуйста.',
        sourceKbIds: [],
        sources: [],
        needsReview: true,
        ...(embedding
          ? {
              candidateEmbedding: embedding,
              candidateEmbeddingModel: 'test/embedding',
            }
          : {}),
      },
    },
  })
  const saved = await prismaSupport.zhoraSuggestion.create({
    data: {
      jobId: job.id,
      targetMessageId: target.message.id,
      language: 'en',
    },
  })
  return { ticket, target: target.message, suggestion: saved }
}

describe('Zhora KB candidates', () => {
  it('groups distinct invoked questions, counts one target once, and hides groups below three', async () => {
    const first = await suggestion('Where is my transfer?')
    await suggestion('When will my transfer arrive?', vector(1, 0))
    await runZhoraCandidateGroupingPass()
    expect(
      (await app.inject({ method: 'GET', url, headers })).json().items
    ).toEqual([])

    await suggestion('I need an update on my transfer.', vector(0.96, 0.28))
    await runZhoraCandidateGroupingPass()
    const listed = await app.inject({ method: 'GET', url, headers })
    expect(listed.statusCode).toBe(200)
    expect(listed.json().items).toHaveLength(1)
    expect(listed.json().items[0]).toMatchObject({
      repeatCount: 3,
      draftAnswerRu: null,
    })
    const candidateId = listed.json().items[0].id

    // A second /zhora result for the same customer message cannot add a fourth.
    const secondJob = await prismaSupport.zhoraJob.create({
      data: {
        eventKey: randomUUID(),
        operation: 'reply',
        input: { kind: 'suggestion' },
        status: 'completed',
        result: {
          sourceKbIds: [],
          candidateEmbedding: vector(1, 0),
          candidateEmbeddingModel: 'test/embedding',
        },
      },
    })
    await prismaSupport.zhoraSuggestion.create({
      data: {
        jobId: secondJob.id,
        targetMessageId: first.target.id,
        language: 'en',
      },
    })
    await runZhoraCandidateGroupingPass()
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `${url}/${candidateId}`,
          headers,
        })
      ).json().repeatCount
    ).toBe(3)
    await runZhoraCandidateDraftPass()
    expect(
      (
        await prismaSupport.zhoraKbCandidate.findUniqueOrThrow({
          where: { id: candidateId },
        })
      ).draftJobId
    ).toBeNull()
  })

  it('separates distant questions and domains and ignores unavailable KB results', async () => {
    await suggestion('Transfer question', vector(1, 0))
    await suggestion('Account question', vector(0, 1))
    await suggestion('Another domain transfer', vector(1, 0), {
      originDomain: 'other.example',
    })
    await suggestion('Search unavailable', null)
    await suggestion('A /fix request is not a KB question', vector(1, 0), {
      kind: 'suggestion-fix',
    })
    await runZhoraCandidateGroupingPass()
    expect(
      await prismaSupport.zhoraKbCandidate.count({
        where: { originDomain: domain },
      })
    ).toBe(2)
    expect(
      await prismaSupport.zhoraKbCandidate.count({
        where: { originDomain: 'other.example' },
      })
    ).toBe(1)
    expect(
      await prismaSupport.zhoraKbCandidateOccurrence.count({
        where: { message: { ticket: { originDomain: domain } } },
      })
    ).toBe(2)
  })

  it('drafts only from a delivered operator reply and exposes protected source IDs', async () => {
    const first = await suggestion('How do I resolve this transfer?')
    await suggestion('How can I resolve the transfer?')
    await suggestion('Please help resolve my transfer.')
    await runZhoraCandidateGroupingPass()
    const zhoraReply = await appendMessage({
      ticketId: first.ticket.id,
      direction: 'OUT',
      text: 'Generated reply from Zhora.',
    })
    await prismaSupport.zhoraSuggestion.update({
      where: { id: first.suggestion.id },
      data: { sentMessageId: zhoraReply.message.id },
    })
    const answer = await appendMessage({
      ticketId: first.ticket.id,
      direction: 'OUT',
      text: 'Please give us the transfer ID so we can check it.',
    })
    await runZhoraCandidateDraftPass()
    const candidate = await prismaSupport.zhoraKbCandidate.findFirstOrThrow({
      where: { originDomain: domain },
      include: { draftJob: true },
    })
    expect(candidate.draftJob).toMatchObject({
      operation: 'draft',
      status: 'queued',
    })
    expect(candidate.draftJob?.input).toMatchObject({
      input: expect.stringContaining('Please give us the transfer ID'),
    })
    await prismaSupport.zhoraJob.update({
      where: { id: candidate.draftJobId! },
      data: {
        status: 'completed',
        result: {
          text: JSON.stringify({
            answerRu: 'Укажите ID перевода для проверки.',
            note: 'Extra model field must not discard a usable draft.',
          }),
        },
      },
    })
    await runZhoraCandidateDraftPass()
    const authorized = await app.inject({ method: 'GET', url, headers })
    const item = authorized
      .json()
      .items.find(
        (entry: { originDomain: string }) => entry.originDomain === domain
      )
    expect(item).toMatchObject({
      draftAnswerRu: 'Укажите ID перевода для проверки.',
      draftSourceMessageIds: [answer.message.id],
    })
    const denied = await app.inject({ method: 'GET', url })
    expect(denied.statusCode).toBe(401)
  })
})
