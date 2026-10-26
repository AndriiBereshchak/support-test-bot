import { parse } from 'dotenv'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { developmentEnvironment, testEnvironment } from './load-env.mjs'

const support = path.resolve(__dirname, '../..')
const fixture = () =>
  parse(readFileSync(path.join(support, '.env.test.example')))
const dev = (overrides: Record<string, string> = {}) => ({
  ...fixture(),
  NODE_ENV: 'development',
  SUPPORT_INTERNAL_TOKEN: 'test-internal',
  ...overrides,
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('env file loading', () => {
  it('reads test settings from .env.test rather than inherited credentials', () => {
    vi.stubEnv('DATABASE_SUPPORT', 'postgresql://remote/production')
    vi.stubEnv('SUPPORT_BOT_TOKEN', 'real-token')
    vi.stubEnv('SENTRY_DSN', 'real-dsn')
    const expected = parse(readFileSync(path.join(support, '.env.test')))
    const env = testEnvironment()
    expect(env.DATABASE_SUPPORT).toBe(expected.DATABASE_SUPPORT)
    expect(env.REDIS_PORT).toBe(expected.REDIS_PORT)
    expect(env.SUPPORT_BOT_TOKEN).toBe('')
    expect(env.SENTRY_DSN).toBe('')
    expect(process.env.DATABASE_SUPPORT).toBe('postgresql://remote/production')
  })

  it('does not hardcode local database credentials or ports', () => {
    const database = 'postgresql://custom:custom@127.0.0.1:55433/custom_test'
    const env = testEnvironment({
      ...fixture(),
      DATABASE_SUPPORT: database,
      DATABASE_EXCHANGE: database,
      DATABASE_AFFILIATE: database,
      REDIS_PORT: '16380',
    })
    expect(env.DATABASE_SUPPORT).toBe(database)
    expect(env.REDIS_PORT).toBe('16380')
  })

  it.each([
    'postgresql://remote.example/support_test',
    'postgresql://test:test@127.0.0.1:5432/support',
    'postgresql://test:test@127.0.0.1/support_test?host=remote.example',
  ])('rejects unsafe database target %s', (database) => {
    expect(() =>
      testEnvironment({ ...fixture(), DATABASE_SUPPORT: database })
    ).toThrow('disposable')
  })

  it('rejects real bot keys in automated test configuration', () => {
    expect(() =>
      testEnvironment({ ...fixture(), SUPPORT_BOT_TOKEN: 'real-token' })
    ).toThrow('automated tests')
  })

  it('rejects an unsafe file storage directory', () => {
    expect(() =>
      testEnvironment({ ...fixture(), SUPPORT_FILES_DIR: '/private/tmp' })
    ).toThrow('support/.tmp')
  })

  it('rejects non-test NODE_ENV in the test file', () => {
    expect(() =>
      testEnvironment({ ...fixture(), NODE_ENV: 'production' })
    ).toThrow('NODE_ENV=test')
  })
})

describe('standard dev env settings', () => {
  it('uses offline delivery with an empty SUPPORT_BOT_TOKEN', () => {
    const env = developmentEnvironment(dev())
    expect(env.STANDALONE_REAL_TELEGRAM).toBe('false')
    expect(env.SUPPORT_BOT_TOKEN).toBe('')
    expect(env.APP_PORT).toBe(fixture().APP_PORT)
  })

  it('reads dev settings from support/.env', () => {
    const expected = parse(readFileSync(path.join(support, '.env')))
    const env = developmentEnvironment()
    expect(env.APP_PORT).toBe(expected.APP_PORT)
    expect(env.DATABASE_SUPPORT).toBe(expected.DATABASE_SUPPORT)
    expect(env.SUPPORT_INTERNAL_TOKEN).toBe(expected.SUPPORT_INTERNAL_TOKEN)
  })

  it('accepts a test bot using standard SUPPORT_* names', () => {
    const env = developmentEnvironment(
      dev({
        SUPPORT_BOT_TOKEN: 'test-token',
        SUPPORT_CHAT_ID: '-1001234567',
        SUPPORT_WEBHOOK_SECRET: 'test_secret',
        SUPPORT_WEBHOOK_URL: 'https://example.test/v1/internal/tg-webhook',
      })
    )
    expect(env.STANDALONE_REAL_TELEGRAM).toBe('true')
    expect(env.SUPPORT_BOT_TOKEN).toBe('test-token')
  })

  it('allows local polling only with a test bot and no webhook URL', () => {
    const local = dev({
      SUPPORT_BOT_TOKEN: 'test-token',
      SUPPORT_CHAT_ID: '-1001234567',
      SUPPORT_WEBHOOK_SECRET: '',
      SUPPORT_WEBHOOK_URL: '',
      DEV_TELEGRAM_POLLING: 'true',
    })
    const env = developmentEnvironment(local)
    expect(env.STANDALONE_TELEGRAM_POLLING).toBe('true')
    expect(env.SUPPORT_WEBHOOK_URL).toBe('')
    expect(() =>
      developmentEnvironment({
        ...local,
        SUPPORT_WEBHOOK_URL: 'https://example.test/v1/internal/tg-webhook',
      })
    ).toThrow('empty SUPPORT_WEBHOOK_URL')
    expect(() =>
      developmentEnvironment({ ...local, SUPPORT_BOT_TOKEN: '' })
    ).toThrow('test bot token')
  })

  it('validates group ID and HTTPS for real Telegram', () => {
    expect(() =>
      developmentEnvironment(
        dev({ SUPPORT_BOT_TOKEN: 'test-token', SUPPORT_CHAT_ID: '123' })
      )
    ).toThrow('negative')
    expect(() =>
      developmentEnvironment(
        dev({
          SUPPORT_BOT_TOKEN: 'test-token',
          SUPPORT_CHAT_ID: '-100123',
          SUPPORT_WEBHOOK_SECRET: 'secret',
          SUPPORT_WEBHOOK_URL: 'http://example.test',
        })
      )
    ).toThrow('HTTPS')
  })

  it.each(['0', '80', '65536', 'NaN', '3020.5'])(
    'rejects invalid APP_PORT %s',
    (value) => {
      expect(() => developmentEnvironment(dev({ APP_PORT: value }))).toThrow(
        'APP_PORT'
      )
    }
  )

  it('uses SUPPORT_ROLE to control worker execution', () => {
    expect(
      developmentEnvironment(dev({ SUPPORT_ROLE: 'api' }))
        .STANDALONE_WORKER_ENABLED
    ).toBe('false')
    expect(
      developmentEnvironment(dev({ SUPPORT_ROLE: 'all' }))
        .STANDALONE_WORKER_ENABLED
    ).toBe('true')
  })

  it('requires a dev API token and refuses production mode', () => {
    expect(() =>
      developmentEnvironment(dev({ SUPPORT_INTERNAL_TOKEN: '' }))
    ).toThrow('SUPPORT_INTERNAL_TOKEN')
    vi.stubEnv('NODE_ENV', 'production')
    expect(() => developmentEnvironment(dev())).toThrow('production')
  })
})
