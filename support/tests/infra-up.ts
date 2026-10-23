// Conditional `docker compose up` for the test stack: a service whose host
// port already answers is skipped, because the local dev stand can hold
// 14222/16379 with its own NATS/Redis containers — composing ours on the same
// ports would fail the bind and abort `yarn test` before vitest ever runs.
//
// Postgres gets a stricter check than a TCP probe. It shares host port 55432
// with the EXCHANGE test stack, whose database is `exchange_test`; a bare probe
// would happily attach to it and the suite would then fail deep inside
// `prisma migrate deploy` with an unhelpful "database does not exist". So we
// additionally verify that the thing answering is our container.

import { execSync } from 'node:child_process'
import net from 'node:net'

const PG_CONTAINER = 'binodex-test-pg-support'
const PG_DB = 'support_test'

const SERVICES = [
  {
    compose: 'postgres-support',
    host: '127.0.0.1',
    port: 55432,
    postgres: true,
  },
  { compose: 'nats', host: '127.0.0.1', port: 14222, postgres: false },
  { compose: 'redis', host: '127.0.0.1', port: 16379, postgres: false },
]

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

/** True when OUR postgres container is the one holding the port. */
function isOurPostgres(): boolean {
  try {
    execSync(`docker exec ${PG_CONTAINER} pg_isready -U test -d ${PG_DB}`, {
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  const toStart: string[] = []

  for (const s of SERVICES) {
    const answering = await probe(s.host, s.port)

    if (answering && s.postgres && !isOurPostgres()) {
      throw new Error(
        `port ${s.port} is held by a different postgres (most likely the exchange test stack).\n` +
          `Stop it first:  docker compose -f ../exchange/docker-compose.test.yml down`
      )
    }

    if (answering && s.postgres) {
      const available = execSync(
        `docker exec ${PG_CONTAINER} psql -U test -d ${PG_DB} -tAc "SELECT count(*) FROM pg_available_extensions WHERE name = 'vector'"`,
        { encoding: 'utf8' }
      ).trim()
      if (available !== '1') {
        throw new Error(
          'The existing support test container has no pgvector. Back up its data before recreating postgres-support with the image in docker-compose.test.yml; this runner never replaces it automatically.'
        )
      }
    }

    if (answering) {
      console.log(
        `✓ ${s.compose} already answering on ${s.host}:${s.port} — skipping`
      )
    } else {
      toStart.push(s.compose)
    }
  }

  if (toStart.length === 0) {
    console.log('All test services already up.')
    return
  }

  execSync(
    `docker compose -f docker-compose.test.yml up -d ${toStart.join(' ')}`,
    { stdio: 'inherit' }
  )
}

void main().catch((err: Error) => {
  console.error(err.message)
  process.exit(1)
})
