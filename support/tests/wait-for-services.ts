// Probes test infrastructure until each service answers, or times out.
// Runs from the `yarn test` orchestration, BEFORE migrations and tests.
//
// Why this exists on top of compose healthchecks: `depends_on:
// condition: service_healthy` only orders containers against each other, never
// against the host process running vitest. We block here until the HOST can
// reach every port.

import net from 'node:net'

const SERVICES = [
  { name: 'postgres-support', host: '127.0.0.1', port: 55432 },
  { name: 'nats', host: '127.0.0.1', port: 14222 },
  { name: 'redis', host: '127.0.0.1', port: 16379 },
]

const TIMEOUT_MS = 60_000
const RETRY_MS = 500

async function probe(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port })
    sock.setTimeout(2000)
    sock.once('connect', () => {
      sock.destroy()
      resolve(true)
    })
    sock.once('timeout', () => {
      sock.destroy()
      resolve(false)
    })
    sock.once('error', () => resolve(false))
  })
}

async function waitFor(
  name: string,
  host: string,
  port: number
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < TIMEOUT_MS) {
    if (await probe(host, port)) {
      console.log(`✓ ${name} ready (${host}:${port})`)
      return
    }
    await new Promise((r) => setTimeout(r, RETRY_MS))
  }
  throw new Error(`${name} (${host}:${port}) not ready after ${TIMEOUT_MS}ms`)
}

async function main(): Promise<void> {
  for (const s of SERVICES) {
    await waitFor(s.name, s.host, s.port)
  }
  console.log('All test services ready.')
}

void main().catch((err: Error) => {
  console.error(err.message)
  process.exit(1)
})
