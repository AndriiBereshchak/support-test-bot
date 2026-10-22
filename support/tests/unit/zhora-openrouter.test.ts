import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const settings = vi.hoisted(() => ({
  ZHORA_ENABLED: true,
  ZHORA_OPENROUTER_API_KEY: 'fake-test-key',
  ZHORA_MODEL_TRANSLATE: 'test/translate',
  ZHORA_MODEL_REPLY: 'test/reply',
  ZHORA_MODEL_FIX: 'test/fix',
  ZHORA_MODEL_BRIEF: 'test/brief',
  ZHORA_MODEL_TAG: 'test/tag',
  ZHORA_MODEL_CLUSTER: 'test/cluster',
  ZHORA_MODEL_DRAFT: 'test/draft',
  ZHORA_TIMEOUT_MS: 30_000,
  ZHORA_MAX_OUTPUT_TOKENS: 2048,
}))
vi.mock('@config/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@config/env')>()),
  ...settings,
  get ZHORA_ENABLED() {
    return settings.ZHORA_ENABLED
  },
  get ZHORA_OPENROUTER_API_KEY() {
    return settings.ZHORA_OPENROUTER_API_KEY
  },
  get ZHORA_MODEL_REPLY() {
    return settings.ZHORA_MODEL_REPLY
  },
  get ZHORA_TIMEOUT_MS() {
    return settings.ZHORA_TIMEOUT_MS
  },
}))

import {
  generateZhoraText,
  getOpenRouterMonthlyUsage,
  getOpenRouterGenerationCost,
  OpenRouterError,
} from '@apps/services/zhora/openrouter'

const prompt = {
  operation: 'reply' as const,
  systemPrompt: 'Approved support rules',
  input: 'Synthetic question',
}
const completion = (overrides = {}) => ({
  id: 'gen-test',
  model: 'test/actual-model',
  choices: [
    { finish_reason: 'stop', message: { content: 'Synthetic answer' } },
  ],
  usage: {
    prompt_tokens: 100,
    completion_tokens: 20,
    cost: 0.001,
    prompt_tokens_details: { cached_tokens: 50, cache_write_tokens: 0 },
  },
  ...overrides,
})
const request = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()

beforeEach(() => {
  settings.ZHORA_ENABLED = true
  settings.ZHORA_OPENROUTER_API_KEY = 'fake-test-key'
  settings.ZHORA_MODEL_REPLY = 'test/reply'
  settings.ZHORA_TIMEOUT_MS = 30_000
  request.mockReset()
  vi.stubGlobal('fetch', request)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('OpenRouter text client', () => {
  it('uses the configured model and returns text with actual usage', async () => {
    request.mockResolvedValue(new Response(JSON.stringify(completion())))
    const result = await generateZhoraText(prompt)
    expect(result).toMatchObject({
      text: 'Synthetic answer',
      model: 'test/actual-model',
      generationId: 'gen-test',
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        costUsd: 0.001,
        cachedTokens: 50,
        cacheWriteTokens: 0,
      },
    })
    const [url, options] = request.mock.calls[0]!
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(options!.headers).toMatchObject({
      Authorization: 'Bearer fake-test-key',
    })
    const body = JSON.parse(String(options!.body))
    expect(body).toMatchObject({
      model: 'test/reply',
      stream: false,
      max_tokens: 2048,
    })
    expect(body.messages[0].content[0].cache_control).toBeUndefined()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('supports explicit caching for stable system and knowledge blocks', async () => {
    request.mockResolvedValue(new Response(JSON.stringify(completion())))
    await generateZhoraText({
      ...prompt,
      operation: 'translate',
      knowledge: 'Approved KB',
      cachePrompt: true,
    })
    const body = JSON.parse(String(request.mock.calls[0]![1]!.body))
    expect(body.model).toBe('test/translate')
    expect(body.messages[0].content).toEqual([
      {
        type: 'text',
        text: prompt.systemPrompt,
        cache_control: { type: 'ephemeral' },
      },
      {
        type: 'text',
        text: 'Approved KB',
        cache_control: { type: 'ephemeral' },
      },
    ])
    expect(body.messages[1]).toEqual({ role: 'user', content: prompt.input })
  })

  it('does not make requests when disabled, missing credentials or missing a model', async () => {
    settings.ZHORA_ENABLED = false
    await expect(generateZhoraText(prompt)).rejects.toMatchObject({
      code: 'disabled',
    })
    settings.ZHORA_ENABLED = true
    settings.ZHORA_OPENROUTER_API_KEY = ''
    await expect(generateZhoraText(prompt)).rejects.toMatchObject({
      code: 'api_key_missing',
    })
    settings.ZHORA_OPENROUTER_API_KEY = 'fake-test-key'
    settings.ZHORA_MODEL_REPLY = ''
    await expect(generateZhoraText(prompt)).rejects.toMatchObject({
      code: 'model_missing',
    })
    expect(request).not.toHaveBeenCalled()
  })

  it('normalizes an HTTP error without leaking the provider body or retrying', async () => {
    request.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { message: 'private customer text and fake-test-key' },
        }),
        { status: 429 }
      )
    )
    const error = await generateZhoraText(prompt).catch((error) => error)
    expect(error).toBeInstanceOf(OpenRouterError)
    expect(error).toMatchObject({
      code: 'http_error',
      details: { httpStatus: 429, usage: { costUsd: null } },
    })
    expect(error.message).not.toContain('private')
    expect(error.message).not.toContain('fake-test-key')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('does not expose raw network errors or retry them', async () => {
    request.mockRejectedValue(new Error('private network details'))
    await expect(generateZhoraText(prompt)).rejects.toMatchObject({
      code: 'network_error',
      message: '[zhora] OpenRouter: network_error',
    })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('aborts on timeout and does not assume that the call was free', async () => {
    settings.ZHORA_TIMEOUT_MS = 20
    request.mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options!.signal!.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true }
          )
        })
    )
    await expect(generateZhoraText(prompt)).rejects.toMatchObject({
      code: 'timeout',
      details: { usage: { costUsd: null } },
    })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it.each([
    [{ error: { message: 'private provider failure' } }, 'provider_error'],
    [
      {
        choices: [
          { finish_reason: 'length', message: { content: 'Partial answer' } },
        ],
      },
      'incomplete_response',
    ],
  ])(
    'rejects unsuccessful HTTP 200 responses and preserves billed usage',
    async (body, code) => {
      request.mockResolvedValue(new Response(JSON.stringify(completion(body))))
      await expect(generateZhoraText(prompt)).rejects.toMatchObject({
        code,
        details: { usage: { costUsd: 0.001, inputTokens: 100 } },
      })
      expect(request).toHaveBeenCalledTimes(1)
    }
  )

  it('keeps unavailable accounting unknown instead of inventing zeroes', async () => {
    request.mockResolvedValue(
      new Response(JSON.stringify(completion({ usage: { prompt_tokens: 10 } })))
    )
    expect((await generateZhoraText(prompt)).usage).toMatchObject({
      inputTokens: 10,
      outputTokens: null,
      costUsd: null,
    })
  })

  it('rejects a malformed response without exposing its content', async () => {
    request.mockResolvedValue(new Response('private malformed response'))
    await expect(generateZhoraText(prompt)).rejects.toMatchObject({
      code: 'invalid_response',
    })
  })

  it('reads dedicated-key monthly spending without generating text', async () => {
    request.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: { usage_monthly: 12.5, limit: null },
        })
      )
    )
    expect(await getOpenRouterMonthlyUsage()).toEqual({
      month: new Date().toISOString().slice(0, 7),
      costUsd: 12.5,
    })
    expect(request.mock.calls[0]![0]).toBe('https://openrouter.ai/api/v1/key')
    expect(request.mock.calls[0]![1]!.body).toBeUndefined()
  })

  it('accepts a confirmed zero cost for the requested generation', async () => {
    request.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: { id: 'gen-test', total_cost: 0 },
        })
      )
    )
    expect(await getOpenRouterGenerationCost('gen-test')).toBe(0)
    expect(request.mock.calls[0]![0]).toBe(
      'https://openrouter.ai/api/v1/generation?id=gen-test'
    )
  })

  it('rejects missing monthly usage and metadata for another generation', async () => {
    request.mockResolvedValueOnce(new Response(JSON.stringify({ data: {} })))
    await expect(getOpenRouterMonthlyUsage()).rejects.toMatchObject({
      code: 'accounting_unavailable',
    })
    request.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: { id: 'gen-other', total_cost: 0.1 },
        })
      )
    )
    await expect(getOpenRouterGenerationCost('gen-test')).rejects.toMatchObject(
      { code: 'accounting_unavailable' }
    )
  })
})
