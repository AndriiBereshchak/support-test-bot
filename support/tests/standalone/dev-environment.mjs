import { parse } from 'dotenv'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { testEnvironment } from './environment.mjs'

/** @param {Record<string, string>} [overrides] */
export function developmentEnvironment(overrides) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Standalone development server cannot run in production')
  }
  const envPath = fileURLToPath(new URL('./.env.dev', import.meta.url))
  const local =
    overrides ?? (existsSync(envPath) ? parse(readFileSync(envPath)) : {})
  const value = (key, fallback = '') => local[key] ?? fallback
  const realTelegram = value('DEV_TELEGRAM_ENABLED') === 'true'
  const port = Number(value('DEV_PORT', '3020'))
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('DEV_PORT must be an integer between 1024 and 65535')
  }
  const token = value('DEV_INTERNAL_TOKEN', 'standalone-dev-only').trim()
  if (!token) throw new Error('DEV_INTERNAL_TOKEN cannot be empty')
  const chatId = value('DEV_TELEGRAM_CHAT_ID')
  const botToken = value('DEV_TELEGRAM_BOT_TOKEN').trim()
  const secret = value('DEV_TELEGRAM_WEBHOOK_SECRET').trim()
  const webhook = value('DEV_TELEGRAM_WEBHOOK_URL').trim()
  if (realTelegram) {
    if (
      !botToken ||
      !secret ||
      !Number.isSafeInteger(Number(chatId)) ||
      Number(chatId) >= 0
    ) {
      throw new Error(
        'Real Telegram requires a test bot token, a negative chat ID and a webhook secret'
      )
    }
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
      throw new Error(
        'DEV_TELEGRAM_WEBHOOK_SECRET must contain 1–256 letters, digits, underscores or hyphens'
      )
    }
    if (webhook && new URL(webhook).protocol !== 'https:') {
      throw new Error('DEV_TELEGRAM_WEBHOOK_URL must use HTTPS')
    }
  }
  return {
    ...testEnvironment(),
    // Remain NODE_ENV=test so ordinary .env and Sentry do not activate.
    APP_PORT: String(port),
    SUPPORT_INTERNAL_TOKEN: token,
    SUPPORT_BOT_TOKEN: realTelegram ? botToken : '',
    SUPPORT_CHAT_ID: realTelegram ? chatId : '-1002000000001',
    SUPPORT_WEBHOOK_SECRET: realTelegram ? secret : '',
    SUPPORT_WEBHOOK_URL: realTelegram ? webhook : '',
    STANDALONE_REAL_TELEGRAM: String(realTelegram),
    STANDALONE_WORKER_ENABLED: value('DEV_WORKER_ENABLED', 'true'),
    ZHORA_ENABLED: 'false',
    ZHORA_OPENROUTER_API_KEY: '',
  }
}
