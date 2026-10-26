import path from 'node:path'
import { randomInt } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { developmentEnvironment } from './load-env.mjs'
import { developmentUsers, seedDevelopmentData } from './dev-fixtures.mjs'

const directory = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const env = developmentEnvironment()
Object.assign(process.env, env)

const compiled = path.join(directory, '.generated/dev')
const source = path.join(compiled, 'src')
const alias = require('module-alias')
alias.addAliases({
  '@apps': path.join(source, 'apps'),
  '@core': path.join(source, 'core'),
  '@config': path.join(source, 'config'),
  '@telegram': path.join(source, 'telegram'),
  '@prisma-support': path.join(directory, '.generated/support'),
  '@prisma-exchange': path.join(directory, '.generated/external'),
  '@prisma-affiliate': path.join(directory, '.generated/external'),
  '@binodex/shared': path.join(compiled, 'tests/standalone/adapters/shared.js'),
  '@core/exchange-grpc': path.join(
    compiled,
    'tests/standalone/dev/exchange-grpc.js'
  ),
})
const realTelegram = env.STANDALONE_REAL_TELEGRAM === 'true'
if (!realTelegram) {
  alias.addAlias(
    '@telegram/api',
    path.join(compiled, 'tests/standalone/dev/telegram.js')
  )
}

const { assertRequiredEnv } = require('@config/env')
assertRequiredEnv()
const { buildApp } = require(path.join(source, 'app.js'))
const { prismaSupport, shutdownPrisma } = require('@config/database')
const { closeRedis } = require('@config/redis')
const { closeNats, getNatsConnection } = require('@config/nats')
const { startInactivitySweeper } = require('@apps/services/sweeper.service')
const { startZhoraWorker } = require('@apps/services/zhora/job.service')
const telegram = require('@telegram/api')
const { handleUpdate } = require('@telegram/updates')
const { upsertAgent } = require('@apps/services/agent.service')
const { startLocalTelegramPolling } = require(
  path.join(compiled, 'tests/standalone/dev/telegram-polling.js')
)

const app = buildApp()
let stopWorker
let stopZhoraWorker
let stopTelegramPolling
let stopping = false
let nextMessage = randomInt(1_100_000_000, 2_000_000_000)

// Dev-only endpoints are registered solely by this entry point. The fixed
// internal token protects them if a tunnel exposes the local HTTP listener.
app.register(
  async (dev) => {
    dev.addHook('onRequest', async (request, reply) => {
      if (request.headers['x-internal-token'] !== env.SUPPORT_INTERNAL_TOKEN) {
        return reply.code(401).send({ message: 'Dev internal token required' })
      }
    })
    dev.get('/fixtures', async () => ({
      users: developmentUsers,
      realTelegram,
    }))
    dev.get('/events', async () => ({
      mode: realTelegram ? 'real-telegram' : 'offline',
      events: realTelegram ? [] : telegram.getDevEvents(),
    }))
    dev.post(
      '/reply',
      {
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['topicId', 'text'],
            properties: {
              topicId: { type: 'integer', minimum: 2 },
              text: { type: 'string', minLength: 1, maxLength: 8000 },
            },
          },
        },
      },
      async (request, reply) => {
        if (realTelegram)
          return reply
            .code(409)
            .send({ message: 'Reply in the test Telegram group instead' })
        const { topicId, text } = request.body
        const ticket = await prismaSupport.supportTicket.findFirst({
          where: {
            tgChatId: BigInt(env.SUPPORT_CHAT_ID),
            tgTopicId: topicId,
            status: 'OPEN',
            userId: { in: developmentUsers.map((user) => user.userId) },
          },
        })
        if (!ticket)
          return reply
            .code(404)
            .send({ message: 'No open fixture ticket for this topic' })
        const fromId = 900777
        await upsertAgent(fromId, { displayName: 'Local test operator' })
        const messageId = ++nextMessage
        await handleUpdate({
          update_id: messageId,
          message: {
            message_id: messageId,
            message_thread_id: topicId,
            is_topic_message: true,
            date: Math.floor(Date.now() / 1000),
            chat: {
              id: Number(env.SUPPORT_CHAT_ID),
              type: 'supergroup',
              title: 'Standalone test group',
            },
            from: { id: fromId, is_bot: false, first_name: 'Local operator' },
            text,
          },
        })
        return { processed: true, messageId }
      }
    )
  },
  { prefix: '/__dev' }
)

async function close(code = 0) {
  if (stopping) return
  stopping = true
  const deadline = setTimeout(() => process.exit(1), 8000)
  deadline.unref()
  stopWorker?.()
  const telegramStopped = stopTelegramPolling?.()
  const zhoraStopped = stopZhoraWorker?.()
  try {
    await app.close()
    await Promise.all([telegramStopped, zhoraStopped])
    await closeNats()
    await closeRedis()
    await shutdownPrisma()
  } finally {
    process.exitCode = code
    clearTimeout(deadline)
  }
}

process.once('SIGINT', () => void close())
process.once('SIGTERM', () => void close())

try {
  await prismaSupport.$connect()
  const otherChat = await prismaSupport.supportUserThread.findFirst({
    where: {
      userId: { in: developmentUsers.map((user) => user.userId) },
      tgChatId: { not: BigInt(env.SUPPORT_CHAT_ID) },
    },
  })
  if (otherChat) {
    throw new Error(
      'Fixture topics belong to a different Telegram chat. Reset the disposable fixture tickets before switching Telegram mode.'
    )
  }
  await seedDevelopmentData()
  await getNatsConnection()
  // Loopback only. Use a tunnel explicitly for a dedicated test Telegram bot.
  await app.listen({ host: '127.0.0.1', port: Number(env.APP_PORT) })
  if (realTelegram) {
    if (env.STANDALONE_TELEGRAM_POLLING === 'true') {
      const bot = await telegram.ensureBotInitialized()
      stopTelegramPolling = await startLocalTelegramPolling(bot, handleUpdate)
    } else {
      await telegram.registerWebhook()
    }
  }
  if (env.STANDALONE_WORKER_ENABLED === 'true') {
    stopWorker = startInactivitySweeper()
    stopZhoraWorker = startZhoraWorker()
  }
  console.log(`Standalone support: http://127.0.0.1:${env.APP_PORT}`)
  console.log(
    `Telegram: ${!realTelegram ? 'offline; inspect /__dev/events' : env.STANDALONE_TELEGRAM_POLLING === 'true' ? 'dedicated test bot via local polling' : 'dedicated test bot via webhook'}`
  )
  console.log(
    'Synthetic users: GET /__dev/fixtures (x-internal-token required).'
  )
  console.log(
    'Local database: support_test. Zhora commands require ZHORA_ENABLED=true.'
  )
} catch (error) {
  console.error(`Standalone server failed: ${error.message}`)
  await close(1)
}
