import {
  ZHORA_ENABLED,
  ZHORA_OPENROUTER_API_KEY,
  ZHORA_MODEL_TRANSLATE,
  ZHORA_MODEL_REPLY,
  ZHORA_MODEL_FIX,
  ZHORA_MODEL_BRIEF,
  ZHORA_MODEL_TAGS,
  ZHORA_MODEL_CLUSTER,
  ZHORA_MODEL_CANDIDATES,
  ZHORA_MODEL_EMBEDDING,
  ZHORA_TIMEOUT_MS,
  ZHORA_MAX_OUTPUT_TOKENS,
} from '@config/env'

export type ZhoraOperation =
  | 'translate'
  | 'reply'
  | 'fix'
  | 'brief'
  | 'tag'
  | 'cluster'
  | 'draft'

export interface OpenRouterInput {
  operation: ZhoraOperation
  systemPrompt: string
  knowledge?: string
  input: string
  /** Explicit cache blocks: set only for a compatible model/provider.
   * Other providers may cache implicitly. This is not a response cache. */
  cachePrompt?: boolean
}

// Fixed with the pgvector column/index; changing dimensions needs reindexing.
export const ZHORA_EMBEDDING_DIMENSIONS = 1024

export interface OpenRouterEmbeddingInput {
  operation: 'embedding'
  input: string
}

export type OpenRouterCallInput = OpenRouterInput | OpenRouterEmbeddingInput

export interface OpenRouterEmbeddingResult extends OpenRouterMetadata {
  embedding: number[]
}

export interface OpenRouterUsage {
  inputTokens: number | null
  outputTokens: number | null
  costUsd: number | null
  cachedTokens: number | null
  cacheWriteTokens: number | null
}

export interface OpenRouterMetadata {
  model: string
  generationId: string | null
  usage: OpenRouterUsage
  durationMs: number
  httpStatus?: number
}

export interface OpenRouterResult extends OpenRouterMetadata {
  text: string
}

type ErrorCode =
  | 'disabled'
  | 'api_key_missing'
  | 'model_missing'
  | 'invalid_input'
  | 'timeout'
  | 'network_error'
  | 'http_error'
  | 'provider_error'
  | 'invalid_response'
  | 'incomplete_response'
  | 'accounting_unavailable'

// Fixed error codes and usage metadata only. Provider messages and network
// errors may contain private data and must not escape into application logs.
export class OpenRouterError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly details?: OpenRouterMetadata
  ) {
    super(`[zhora] OpenRouter: ${code}`)
    this.name = 'OpenRouterError'
  }
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

function readUsage(value: unknown): OpenRouterUsage {
  const usage = object(value)
  const details = object(usage.prompt_tokens_details)
  const tokens = (value: unknown) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      ? value
      : null
  return {
    inputTokens: tokens(usage.prompt_tokens),
    outputTokens: tokens(usage.completion_tokens),
    costUsd:
      typeof usage.cost === 'number' &&
      Number.isFinite(usage.cost) &&
      usage.cost >= 0
        ? usage.cost
        : null,
    cachedTokens: tokens(details.cached_tokens),
    cacheWriteTokens: tokens(details.cache_write_tokens),
  }
}

/** Validate before creating a pending journal record or checking the budget. */
export function getZhoraModel(input: OpenRouterCallInput): string {
  if (!ZHORA_ENABLED) throw new OpenRouterError('disabled')
  if (!ZHORA_OPENROUTER_API_KEY) throw new OpenRouterError('api_key_missing')
  const models: Record<ZhoraOperation, string> = {
    translate: ZHORA_MODEL_TRANSLATE,
    reply: ZHORA_MODEL_REPLY,
    fix: ZHORA_MODEL_FIX,
    brief: ZHORA_MODEL_BRIEF,
    tag: ZHORA_MODEL_TAGS,
    cluster: ZHORA_MODEL_CLUSTER,
    draft: ZHORA_MODEL_CANDIDATES,
  }
  const model =
    input.operation === 'embedding'
      ? ZHORA_MODEL_EMBEDDING
      : models[input.operation]
  if (!model) throw new OpenRouterError('model_missing')
  if (
    !input.input.trim() ||
    (input.operation !== 'embedding' && !input.systemPrompt.trim())
  )
    throw new OpenRouterError('invalid_input')
  return model
}

async function readAccounting(path: string): Promise<Record<string, unknown>> {
  if (!ZHORA_OPENROUTER_API_KEY) throw new OpenRouterError('api_key_missing')
  try {
    const response = await fetch(`https://openrouter.ai/api/v1/${path}`, {
      headers: { Authorization: `Bearer ${ZHORA_OPENROUTER_API_KEY}` },
      redirect: 'error',
      signal: AbortSignal.timeout(ZHORA_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error()
    const body = object(await response.json())
    if (body.error) throw new Error()
    return object(body.data)
  } catch {
    throw new OpenRouterError('accounting_unavailable')
  }
}

const validCost = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

export async function getOpenRouterMonthlyUsage(): Promise<{
  month: string
  costUsd: number
}> {
  const month = new Date().toISOString().slice(0, 7)
  const data = await readAccounting('key')
  // Do not attribute the new month's statistics to a request made in the old one.
  if (
    new Date().toISOString().slice(0, 7) !== month ||
    !validCost(data.usage_monthly)
  )
    throw new OpenRouterError('accounting_unavailable')
  return { month, costUsd: data.usage_monthly }
}

export async function getOpenRouterGenerationCost(id: string): Promise<number> {
  const data = await readAccounting(`generation?id=${encodeURIComponent(id)}`)
  if (data.id !== id || !validCost(data.total_cost))
    throw new OpenRouterError('accounting_unavailable')
  return data.total_cost
}

/** Transport only. The application calls through llm.service for budget
 * checks and journaling. No automatic paid retries. */
export async function generateZhoraText(
  input: OpenRouterInput
): Promise<OpenRouterResult> {
  const model = getZhoraModel(input)

  const content = [
    input.systemPrompt,
    ...(input.knowledge ? [input.knowledge] : []),
  ].map((text) => ({
    type: 'text',
    text,
    ...(input.cachePrompt ? { cache_control: { type: 'ephemeral' } } : {}),
  }))
  const { body, details } = await requestGeneration('chat/completions', model, {
    stream: false,
    max_tokens: ZHORA_MAX_OUTPUT_TOKENS,
    messages: [
      { role: 'system', content },
      { role: 'user', content: input.input },
    ],
  })
  const choice = object(
    Array.isArray(body.choices) ? body.choices[0] : undefined
  )
  if (body.error || choice.error)
    throw new OpenRouterError('provider_error', details)
  if (typeof choice.finish_reason !== 'string')
    throw new OpenRouterError('invalid_response', details)
  // Preserve paid usage on truncation/refusal; never offer partial text as a
  // finished operator draft. HTTP 200 alone does not indicate success.
  if (choice.finish_reason !== 'stop')
    throw new OpenRouterError('incomplete_response', details)
  const message = object(choice.message)
  if (typeof message.content !== 'string' || !message.content.trim())
    throw new OpenRouterError('invalid_response', details)
  return { ...details, text: message.content }
}

// Shared transport preserves the same timeout, error metadata and no-retry rule.
async function requestGeneration(
  path: 'chat/completions' | 'embeddings',
  model: string,
  payload: Record<string, unknown>
): Promise<{ body: Record<string, unknown>; details: OpenRouterMetadata }> {
  const started = Date.now()
  const signal = AbortSignal.timeout(ZHORA_TIMEOUT_MS)
  let response: Response | undefined
  const metadata = (
    body: Record<string, unknown> = {}
  ): OpenRouterMetadata => ({
    model: typeof body.model === 'string' && body.model ? body.model : model,
    generationId: typeof body.id === 'string' ? body.id : null,
    usage: readUsage(body.usage),
    durationMs: Date.now() - started,
    httpStatus: response?.status,
  })

  try {
    response = await fetch(`https://openrouter.ai/api/v1/${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ZHORA_OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      redirect: 'error',
      signal,
      body: JSON.stringify({ ...payload, model }),
    })
  } catch {
    throw new OpenRouterError(
      signal.aborted ? 'timeout' : 'network_error',
      metadata()
    )
  }

  let body: Record<string, unknown>
  try {
    body = object(await response.json())
  } catch {
    throw new OpenRouterError(
      signal.aborted
        ? 'timeout'
        : response.ok
          ? 'invalid_response'
          : 'http_error',
      metadata()
    )
  }
  const details = metadata(body)
  if (!response.ok) throw new OpenRouterError('http_error', details)
  if (body.error) throw new OpenRouterError('provider_error', details)
  return { body, details }
}

export function validEmbedding(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === ZHORA_EMBEDDING_DIMENSIONS &&
    value.every(
      (item) =>
        typeof item === 'number' &&
        Number.isFinite(item) &&
        Math.abs(item) <= 3.4e38
    ) &&
    value.some((item) => item !== 0)
  )
}

export async function generateZhoraEmbedding(
  input: OpenRouterEmbeddingInput
): Promise<OpenRouterEmbeddingResult> {
  const model = getZhoraModel(input)
  const { body, details } = await requestGeneration('embeddings', model, {
    input: input.input,
    dimensions: ZHORA_EMBEDDING_DIMENSIONS,
    encoding_format: 'float',
  })
  const items = Array.isArray(body.data) ? body.data : []
  const item = object(items[0])
  if (
    items.length !== 1 ||
    item.index !== 0 ||
    !validEmbedding(item.embedding)
  ) {
    throw new OpenRouterError('invalid_response', details)
  }
  // Embeddings do not generate output tokens, even when the API omits the count.
  details.usage.outputTokens = 0
  return { ...details, embedding: item.embedding }
}
