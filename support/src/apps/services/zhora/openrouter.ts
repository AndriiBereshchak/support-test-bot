import {
  ZHORA_ENABLED,
  ZHORA_OPENROUTER_API_KEY,
  ZHORA_MODEL_TRANSLATE,
  ZHORA_MODEL_REPLY,
  ZHORA_MODEL_FIX,
  ZHORA_MODEL_BRIEF,
  ZHORA_MODEL_TAG,
  ZHORA_MODEL_CLUSTER,
  ZHORA_MODEL_DRAFT,
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

/** Text generation transport only. Journal, budget admission and Telegram
 * delivery are owned by later service blocks. No automatic paid retries. */
export async function generateZhoraText(
  input: OpenRouterInput
): Promise<OpenRouterResult> {
  if (!ZHORA_ENABLED) throw new OpenRouterError('disabled')
  if (!ZHORA_OPENROUTER_API_KEY) throw new OpenRouterError('api_key_missing')
  const models: Record<ZhoraOperation, string> = {
    translate: ZHORA_MODEL_TRANSLATE,
    reply: ZHORA_MODEL_REPLY,
    fix: ZHORA_MODEL_FIX,
    brief: ZHORA_MODEL_BRIEF,
    tag: ZHORA_MODEL_TAG,
    cluster: ZHORA_MODEL_CLUSTER,
    draft: ZHORA_MODEL_DRAFT,
  }
  const model = models[input.operation]
  if (!model) throw new OpenRouterError('model_missing')
  if (!input.systemPrompt.trim() || !input.input.trim())
    throw new OpenRouterError('invalid_input')

  const content = [
    input.systemPrompt,
    ...(input.knowledge ? [input.knowledge] : []),
  ].map((text) => ({
    type: 'text',
    text,
    ...(input.cachePrompt ? { cache_control: { type: 'ephemeral' } } : {}),
  }))
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
    response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ZHORA_OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      redirect: 'error',
      signal,
      body: JSON.stringify({
        model,
        stream: false,
        max_tokens: ZHORA_MAX_OUTPUT_TOKENS,
        messages: [
          { role: 'system', content },
          { role: 'user', content: input.input },
        ],
      }),
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
