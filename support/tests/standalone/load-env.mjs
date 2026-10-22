import { parse } from 'dotenv'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const support = fileURLToPath(new URL('../../', import.meta.url))

function read(name) {
  try {
    return parse(readFileSync(path.join(support, name)))
  } catch (error) {
    if (error.code === 'ENOENT')
      throw new Error(
        `Missing support/${name}. Copy support/${name}.example and fill in local settings.`
      )
    throw error
  }
}

function required(env, key) {
  const value = env[key]?.trim()
  if (!value) throw new Error(`${key} must be set in the local env file`)
  return value
}

function port(value, key) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535)
    throw new Error(`${key} must be an integer between 1024 and 65535`)
  return String(parsed)
}

function validateLocalInfrastructure(local) {
  for (const key of [
    'DATABASE_SUPPORT',
    'DATABASE_EXCHANGE',
    'DATABASE_AFFILIATE',
  ]) {
    const url = new URL(required(local, key))
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !/^\/[a-z0-9_]+_test$/.test(url.pathname) ||
      [...url.searchParams.keys()].some((name) => name !== 'schema')
    ) {
      throw new Error(
        `${key} must point to a local disposable database ending in _test`
      )
    }
    if (local[key] !== local.DATABASE_SUPPORT)
      throw new Error(
        'Standalone fixture clients must use the same disposable test database'
      )
  }
  if (
    !['127.0.0.1', 'localhost', '::1'].includes(required(local, 'REDIS_HOST'))
  )
    throw new Error('REDIS_HOST must be local for standalone runs')
  port(required(local, 'REDIS_PORT'), 'REDIS_PORT')
  const nats = new URL(required(local, 'NATS_URL'))
  if (
    nats.protocol !== 'nats:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(nats.hostname)
  )
    throw new Error('NATS_URL must be local for standalone runs')
  const files = path.resolve(support, required(local, 'SUPPORT_FILES_DIR'))
  const relative = path.relative(path.join(support, '.tmp'), files)
  if (relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error(
      'SUPPORT_FILES_DIR must be inside support/.tmp for standalone runs'
    )
  return files
}

/**
 * @param {Record<string, string>} [overrides]
 * @returns {Record<string, string | undefined>}
 */
export function testEnvironment(overrides) {
  const local = { ...read('.env.test'), ...overrides }
  if (local.NODE_ENV !== 'test')
    throw new Error('support/.env.test must set NODE_ENV=test')
  const files = validateLocalInfrastructure(local)
  for (const key of [
    'SUPPORT_BOT_TOKEN',
    'SUPPORT_WEBHOOK_URL',
    'SUPPORT_WEBHOOK_SECRET',
    'SUPPORT_INTERNAL_TOKEN',
    'PAYMETA_API_KEY',
    'PAYMETA_API_BASE',
    'SENTRY_DSN',
    'ZHORA_OPENROUTER_API_KEY',
  ]) {
    if (local[key]?.trim())
      throw new Error(`${key} must be empty for automated tests`)
    local[key] = ''
  }
  if (local.ZHORA_ENABLED !== 'false')
    throw new Error('ZHORA_ENABLED must be false for automated tests')
  return { ...process.env, ...local, SUPPORT_FILES_DIR: files }
}

/**
 * @param {Record<string, string>} [overrides]
 * @returns {Record<string, string | undefined>}
 */
export function developmentEnvironment(overrides) {
  if (process.env.NODE_ENV === 'production')
    throw new Error('Standalone development server cannot run in production')
  const local = overrides ?? read('.env')
  if (!['development', 'test'].includes(local.NODE_ENV))
    throw new Error('Local .env must set NODE_ENV=development or test')
  const files = validateLocalInfrastructure(local)
  const internal = required(local, 'SUPPORT_INTERNAL_TOKEN')
  const botToken = (local.SUPPORT_BOT_TOKEN ?? '').trim()
  const realTelegram = Boolean(botToken)
  if (realTelegram) {
    const chat = Number(required(local, 'SUPPORT_CHAT_ID'))
    if (!Number.isSafeInteger(chat) || chat >= 0)
      throw new Error('SUPPORT_CHAT_ID must be a negative Telegram group ID')
    if (
      !/^[A-Za-z0-9_-]{1,256}$/.test(required(local, 'SUPPORT_WEBHOOK_SECRET'))
    )
      throw new Error(
        'SUPPORT_WEBHOOK_SECRET must contain 1–256 letters, digits, underscores or hyphens'
      )
    if (
      local.SUPPORT_WEBHOOK_URL &&
      new URL(local.SUPPORT_WEBHOOK_URL).protocol !== 'https:'
    )
      throw new Error('SUPPORT_WEBHOOK_URL must use HTTPS')
  }
  if (!['api', 'worker', 'all'].includes(local.SUPPORT_ROLE))
    throw new Error('SUPPORT_ROLE must be api, worker or all')
  return {
    ...process.env,
    ...local,
    SUPPORT_FILES_DIR: files,
    APP_PORT: port(required(local, 'APP_PORT'), 'APP_PORT'),
    SUPPORT_INTERNAL_TOKEN: internal,
    SUPPORT_BOT_TOKEN: botToken,
    SUPPORT_WEBHOOK_SECRET: realTelegram
      ? local.SUPPORT_WEBHOOK_SECRET.trim()
      : '',
    SUPPORT_WEBHOOK_URL: realTelegram
      ? (local.SUPPORT_WEBHOOK_URL ?? '').trim()
      : '',
    STANDALONE_REAL_TELEGRAM: String(realTelegram),
    STANDALONE_WORKER_ENABLED: String(local.SUPPORT_ROLE !== 'api'),
  }
}
