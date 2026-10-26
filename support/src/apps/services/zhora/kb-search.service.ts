import { createHash } from 'node:crypto'
import { Prisma, type ZhoraJob, type ZhoraKbEntry } from '@prisma-support'
import { prismaSupport } from '@config/database'
import { ZHORA_ENABLED, ZHORA_MODEL_EMBEDDING } from '@config/env'
import { generateZhoraEmbeddingWithJournal } from './llm.service'
import {
  getZhoraModel,
  OpenRouterError,
  validEmbedding,
  ZHORA_EMBEDDING_DIMENSIONS,
} from './openrouter'

// PostgreSQL produces this fingerprint both when scheduling and when searching.
// It detects content changes, including writes outside the support CRUD API;
// MD5 here is a change marker, not a security or identity check.
const sourceHash = Prisma.sql`md5(question || chr(10) || variants::text || chr(10) || answer_ru)`

/** Queue only the supplied records. CRUD passes its transaction so the edit
 * and its durable indexing job commit or roll back together. No AI is called.
 * Jobs may wait while Zhora is disabled; the worker enforces enabled/budget. */
export async function enqueueKbEmbeddings(
  entryIds: string[],
  db: Prisma.TransactionClient = prismaSupport
): Promise<number> {
  if (!entryIds.length || !ZHORA_MODEL_EMBEDDING) return 0
  const model = ZHORA_MODEL_EMBEDDING
  const namespace = createHash('sha256')
    .update(`${model}:${ZHORA_EMBEDDING_DIMENSIONS}`)
    .digest('hex')
    .slice(0, 16)
  const prefix = `kb-embedding:${namespace}:`
  const ids = Prisma.join(entryIds.map((id) => Prisma.sql`${id}::uuid`))
  return db.$executeRaw`
    WITH candidates AS (
      SELECT id, ${sourceHash} AS hash,
        md5(coalesce(extract(epoch FROM embedding_indexed_at)::text, '')) AS previous_index
      FROM zhora_kb_entries
      WHERE id IN (${ids}) AND status = 'active' AND (
        embedding IS NULL OR embedding_model IS DISTINCT FROM ${model}
        OR embedding_hash IS DISTINCT FROM ${sourceHash}
      )
    )
    INSERT INTO zhora_jobs (id, updated_at, event_key, operation, input)
    SELECT gen_random_uuid(), NOW(), ${prefix} || id::text || ':' || hash || ':' || previous_index,
      'embedding', jsonb_build_object('kbEntryId', id::text, 'sourceHash', hash, 'model', ${model}::text)
    FROM candidates c
    ON CONFLICT (event_key) DO NOTHING
  `
}

/** Startup/model rebuild and infrequent fallback for writes outside CRUD.
 * Keyset pagination reads only one primary-key page, not a full stale-row scan.
 * Direct CRUD changes are queued immediately even if their IDs precede cursor. */
export async function enqueuePendingKbEmbeddings(
  afterId: string | null = null
): Promise<{ nextCursor: string | null; queued: number }> {
  if (!ZHORA_ENABLED || !ZHORA_MODEL_EMBEDDING)
    return { nextCursor: null, queued: 0 }
  const entries = await prismaSupport.zhoraKbEntry.findMany({
    where: afterId ? { id: { gt: afterId } } : {},
    orderBy: { id: 'asc' },
    take: 20,
    select: { id: true },
  })
  const queued = await enqueueKbEmbeddings(entries.map((entry) => entry.id))
  return {
    nextCursor: entries.length === 20 ? entries[entries.length - 1]!.id : null,
    queued,
  }
}

/** Runs inside the existing leased worker; recheck content before AND after AI. */
export async function indexZhoraKbJob(
  job: ZhoraJob
): Promise<{ indexed: boolean }> {
  const input = job.input
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    typeof input.kbEntryId !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(input.kbEntryId) ||
    typeof input.sourceHash !== 'string' ||
    !/^[0-9a-f]{32}$/.test(input.sourceHash) ||
    typeof input.model !== 'string'
  )
    throw new OpenRouterError('invalid_input')
  if (input.model !== ZHORA_MODEL_EMBEDDING) return { indexed: false }
  const rows = await prismaSupport.$queryRaw<
    Array<{ question: string; variants: string[]; answer_ru: string }>
  >`
    SELECT question, variants, answer_ru FROM zhora_kb_entries
    WHERE id = ${input.kbEntryId}::uuid AND status = 'active'
      AND ${sourceHash} = ${input.sourceHash}
      AND (embedding IS NULL OR embedding_hash IS DISTINCT FROM ${sourceHash}
        OR embedding_model IS DISTINCT FROM ${input.model})
  `
  const entry = rows[0]
  if (!entry) return { indexed: false }
  const text = `Questions:\n${[entry.question, ...entry.variants].join('\n')}\n\nAnswer (RU):\n${entry.answer_ru}`
  const result = await generateZhoraEmbeddingWithJournal(text, {
    jobId: job.id,
  })
  const saved = await prismaSupport.$executeRaw`
    UPDATE zhora_kb_entries SET embedding = ${JSON.stringify(result.embedding)}::public.vector,
      embedding_model = ${input.model}, embedding_hash = ${input.sourceHash}, embedding_indexed_at = NOW()
    WHERE id = ${input.kbEntryId}::uuid AND status = 'active'
      AND ${sourceHash} = ${input.sourceHash}
  `
  // Do not change updatedAt/updatedById: indexing is not an editorial change.
  return { indexed: saved === 1 }
}

export interface KbSearchOptions {
  originDomain?: string | null
  /** Required until calibrated; similarity is not a probability of correctness. */
  minScore: number
  limit?: number
}

export type ZhoraKbMatch = Pick<
  ZhoraKbEntry,
  | 'id'
  | 'code'
  | 'question'
  | 'variants'
  | 'answer_ru'
  | 'translations'
  | 'category'
  | 'domains'
  | 'notes'
  | 'dynamic_fields'
  | 'ask_user'
  | 'is_temporary'
> & { score: number }

function eligibleEntries(originDomain?: string | null): Prisma.Sql {
  const domain = originDomain?.trim().toLowerCase() || null
  return Prisma.sql`status = 'active' AND embedding IS NOT NULL
    AND embedding_model = ${ZHORA_MODEL_EMBEDDING}
    AND embedding_hash = ${sourceHash}
    AND (cardinality(domains) = 0 OR domains @> ARRAY[${domain}]::text[])`
}

function validateSearch(options: KbSearchOptions): number {
  const limit = options.limit ?? 5
  if (
    !Number.isFinite(options.minScore) ||
    options.minScore < -1 ||
    options.minScore > 1 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 5
  ) {
    throw new OpenRouterError('invalid_input')
  }
  return limit
}

/** SQL-only retrieval, also usable with deterministic vectors in tests. */
export async function findZhoraKbMatches(
  embedding: number[],
  options: KbSearchOptions
): Promise<ZhoraKbMatch[]> {
  const limit = validateSearch(options)
  if (!validEmbedding(embedding)) throw new OpenRouterError('invalid_input')
  const vector = JSON.stringify(embedding)
  return prismaSupport.$transaction(async (tx) => {
    // Filtered ANN scans may otherwise stop before finding enough eligible rows.
    await tx.$executeRaw`SET LOCAL hnsw.iterative_scan = 'strict_order'`
    return tx.$queryRaw<ZhoraKbMatch[]>`
      SELECT id, code, question, variants, answer_ru, translations, category, domains,
        notes, dynamic_fields, ask_user, is_temporary,
        1 - (embedding OPERATOR(public.<=>) ${vector}::public.vector) AS score
      FROM zhora_kb_entries
      WHERE ${eligibleEntries(options.originDomain)}
        AND (embedding OPERATOR(public.<=>) ${vector}::public.vector) <= ${1 - options.minScore}
      ORDER BY embedding OPERATOR(public.<=>) ${vector}::public.vector
      LIMIT ${limit}
    `
  })
}

/** Internal service for the later ticket-context block; no new public API. */
export async function searchZhoraKb(
  args: KbSearchOptions & {
    question: string
    ticketId?: string | null
    agentId?: string | null
  }
): Promise<ZhoraKbMatch[]> {
  validateSearch(args)
  getZhoraModel({ operation: 'embedding', input: args.question })
  const ready = await prismaSupport.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM zhora_kb_entries WHERE ${eligibleEntries(args.originDomain)} LIMIT 1
  `
  if (!ready.length) return []
  // Qwen recommends a retrieval instruction on queries, not on documents.
  const result = await generateZhoraEmbeddingWithJournal(
    `Instruct: Retrieve support knowledge that answers the user question\nQuery: ${args.question}`,
    { ticketId: args.ticketId, agentId: args.agentId }
  )
  return findZhoraKbMatches(result.embedding, args)
}
