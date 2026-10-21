import { afterEach, describe, expect, it, vi } from 'vitest'

import { TEST_DATABASE_URL, testEnvironment } from './environment.mjs'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('standalone test isolation', () => {
  it('overrides inherited database, credentials and network targets', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('DATABASE_SUPPORT', 'postgresql://private.example/production')
    vi.stubEnv('DATABASE_EXCHANGE', 'postgresql://private.example/exchange')
    vi.stubEnv('DATABASE_AFFILIATE', 'postgresql://private.example/affiliate')
    vi.stubEnv('SUPPORT_BOT_TOKEN', 'real-token')
    vi.stubEnv('SUPPORT_WEBHOOK_URL', 'https://private.example/webhook')
    vi.stubEnv('SENTRY_DSN', 'https://secret@private.example/1')
    vi.stubEnv('PAYMETA_API_KEY', 'real-key')
    vi.stubEnv('REDIS_HOST', 'private.example')
    vi.stubEnv('NATS_URL', 'nats://private.example')
    vi.stubEnv('GRPC_EXCHANGE_SERVER', 'private.example:50051')

    const env = testEnvironment()
    expect(env.NODE_ENV).toBe('test')
    expect(env.DATABASE_SUPPORT).toBe(TEST_DATABASE_URL)
    expect(env.DATABASE_EXCHANGE).toBe(TEST_DATABASE_URL)
    expect(env.DATABASE_AFFILIATE).toBe(TEST_DATABASE_URL)
    expect(env.SUPPORT_BOT_TOKEN).toBe('')
    expect(env.SUPPORT_WEBHOOK_URL).toBe('')
    expect(env.SENTRY_DSN).toBe('')
    expect(env.PAYMETA_API_KEY).toBe('')
    expect(env.REDIS_HOST).toBe('127.0.0.1')
    expect(env.NATS_URL).toBe('nats://127.0.0.1:14222')
    expect(env.GRPC_EXCHANGE_SERVER).toBe('127.0.0.1:1')
  })

  it('does not mutate the caller environment', () => {
    vi.stubEnv('DATABASE_SUPPORT', 'unchanged')
    testEnvironment()
    expect(process.env.DATABASE_SUPPORT).toBe('unchanged')
  })
})
