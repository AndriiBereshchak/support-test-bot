import { fileURLToPath } from 'node:url'

export const TEST_DATABASE_URL =
  'postgresql://test:test@127.0.0.1:55432/support_test'

export function testEnvironment() {
  return {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_SUPPORT: TEST_DATABASE_URL,
    DATABASE_EXCHANGE: TEST_DATABASE_URL,
    DATABASE_AFFILIATE: TEST_DATABASE_URL,
    REDIS_HOST: '127.0.0.1',
    REDIS_PORT: '16379',
    REDIS_PASSWORD: '',
    NATS_URL: 'nats://127.0.0.1:14222',
    NATS_USER: '',
    NATS_PASSWORD: '',
    SUPPORT_CHAT_ID: '-1002000000001',
    SUPPORT_BOT_TOKEN: '',
    SUPPORT_WEBHOOK_SECRET: '',
    SUPPORT_WEBHOOK_URL: '',
    SUPPORT_INTERNAL_TOKEN: '',
    PAYMETA_API_BASE: '',
    PAYMETA_API_KEY: '',
    GRPC_EXCHANGE_SERVER: '127.0.0.1:1',
    SENTRY_DSN: '',
    METRICS_ENABLED: 'false',
    SUPPORT_FILES_DIR: fileURLToPath(
      new URL('../../.tmp/standalone-files', import.meta.url)
    ),
    SUPPORT_MAX_UPLOAD_SIZE: '20M',
    SUPPORT_STORAGE_QUOTA: '4G',
    SUPPORT_USER_STORAGE_QUOTA: '200M',
    SUPPORT_UPLOAD_RATE_PER_HOUR: '30',
    SUPPORT_FILE_RETENTION_DAYS: '7',
    SUPPORT_IDLE_CLOSE_HOURS: '48',
    SUPPORT_REPLY_REMINDER_MINUTES: '10',
    SUPPORT_ROLE: 'all',
  }
}
