import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { developmentEnvironment } from './dev-environment.mjs'

const env = developmentEnvironment()
if (env.STANDALONE_REAL_TELEGRAM === 'true') {
  throw new Error(
    'dev:smoke requires offline Telegram; no real messages will be sent'
  )
}
const base = `http://127.0.0.1:${env.APP_PORT}`
async function request(route, body) {
  const response = await fetch(`${base}${route}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      'content-type': 'application/json',
      'x-internal-token': env.SUPPORT_INTERNAL_TOKEN,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10_000),
  })
  assert.equal(response.status, 200, `${route}: ${response.status}`)
  return response.json()
}

assert.equal((await request('/healthz')).status, 'ok')
assert.equal((await fetch(`${base}/__dev/fixtures`)).status, 401)
const { users } = await request('/__dev/fixtures')
assert.equal(users.length, 3)
const user = users[0]
const marker = randomUUID()
const sent = await request('/v1/internal/messages', {
  userId: user.userId,
  userNId: user.userNId,
  text: `Local smoke: ${marker}`,
  requestId: marker,
  originDomain: 'binodex.io',
})
const { events } = await request('/__dev/events')
const relay = events.findLast(
  (event) =>
    event.operation === 'relayUserMessage' &&
    event.data.ticket.id === sent.ticket.id
)
assert.ok(relay, 'Incoming message should reach the offline Telegram adapter')
const topicId = relay.data.ticket.tgTopicId
await request('/__dev/reply', { topicId, text: `Operator reply: ${marker}` })
const thread = await request('/v1/internal/thread', { userId: user.userId })
assert.ok(
  thread.messages.some(
    (message) =>
      message.direction === 'out' &&
      message.text === `Operator reply: ${marker}`
  )
)
await request('/__dev/reply', { topicId, text: '/info' })
const updated = await request('/__dev/events')
assert.ok(
  updated.events.some(
    (event) =>
      event.operation === 'sendToTopic' &&
      event.data.text?.includes(user.userNId.toString())
  )
)
console.log(
  'Dev smoke passed: health, auth, synthetic users, incoming relay, operator reply, history and /info.'
)
console.log(
  'Synthetic conversation remains in local support_test for inspection.'
)
