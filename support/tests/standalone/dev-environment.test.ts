import { afterEach, describe, expect, it, vi } from 'vitest'
import { developmentEnvironment } from './dev-environment.mjs'
import { TEST_DATABASE_URL } from './environment.mjs'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('standalone development configuration', () => {
  it('uses local fixtures and offline Telegram by default', () => {
    const env = developmentEnvironment({})
    expect(env.DATABASE_SUPPORT).toBe(TEST_DATABASE_URL)
    expect(env.SUPPORT_BOT_TOKEN).toBe('')
    expect(env.STANDALONE_REAL_TELEGRAM).toBe('false')
    expect(env.SUPPORT_INTERNAL_TOKEN).toBe('standalone-dev-only')
    expect(env.APP_PORT).toBe('3020')
  })

  it('does not inherit real database settings or bot credentials', () => {
    vi.stubEnv('DATABASE_SUPPORT', 'postgresql://remote/production')
    vi.stubEnv('SUPPORT_BOT_TOKEN', 'real-token')
    const env = developmentEnvironment({
      DATABASE_SUPPORT: 'postgresql://remote/override',
      SUPPORT_BOT_TOKEN: 'also-ignored',
    })
    expect(env.DATABASE_SUPPORT).toBe(TEST_DATABASE_URL)
    expect(env.SUPPORT_BOT_TOKEN).toBe('')
  })

  it('requires explicit Telegram configuration and preserves the local DB', () => {
    const env = developmentEnvironment({
      DEV_TELEGRAM_ENABLED: 'true',
      DEV_TELEGRAM_BOT_TOKEN: 'test-bot-token',
      DEV_TELEGRAM_CHAT_ID: '-1001234567',
      DEV_TELEGRAM_WEBHOOK_SECRET: 'test_secret',
      DEV_TELEGRAM_WEBHOOK_URL: 'https://example.test/v1/internal/tg-webhook',
    })
    expect(env.SUPPORT_BOT_TOKEN).toBe('test-bot-token')
    expect(env.SUPPORT_CHAT_ID).toBe('-1001234567')
    expect(env.DATABASE_SUPPORT).toBe(TEST_DATABASE_URL)
  })

  it('refuses incomplete real Telegram configuration', () => {
    expect(() =>
      developmentEnvironment({ DEV_TELEGRAM_ENABLED: 'true' })
    ).toThrow()
    expect(() =>
      developmentEnvironment({
        DEV_TELEGRAM_ENABLED: 'true',
        DEV_TELEGRAM_BOT_TOKEN: 'test',
        DEV_TELEGRAM_CHAT_ID: '-100123',
        DEV_TELEGRAM_WEBHOOK_SECRET: 'test',
        DEV_TELEGRAM_WEBHOOK_URL: 'http://example.test',
      })
    ).toThrow('HTTPS')
  })

  it.each(['0', '80', '65536', 'NaN', '3020.5'])(
    'rejects invalid port %s',
    (port) => {
      expect(() => developmentEnvironment({ DEV_PORT: port })).toThrow(
        'DEV_PORT'
      )
    }
  )

  it('refuses an empty internal token', () => {
    expect(() => developmentEnvironment({ DEV_INTERNAL_TOKEN: ' ' })).toThrow(
      'DEV_INTERNAL_TOKEN'
    )
  })

  it('cannot run with NODE_ENV=production', () => {
    vi.stubEnv('NODE_ENV', 'production')
    expect(() => developmentEnvironment({})).toThrow('production')
  })
})
