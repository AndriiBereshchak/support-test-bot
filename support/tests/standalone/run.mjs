import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { testEnvironment, developmentEnvironment } from './load-env.mjs'

const directory = path.dirname(fileURLToPath(import.meta.url))
const support = path.resolve(directory, '../..')
const generated = path.join(directory, '.generated')
const require = createRequire(import.meta.url)

const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 18)) {
  throw new Error(
    'Standalone tests require Node.js >=22.18.0 (recommended: Node.js 24). ' +
      `Current runtime: ${process.version}`
  )
}

function execute(binary, args, options = {}) {
  return execFileSync(binary, args, {
    cwd: support,
    env: options.env ?? testEnvironment(),
    stdio: 'inherit',
    ...options,
  })
}

function prisma(args, options) {
  const cli = path.join(
    path.dirname(require.resolve('prisma/package.json')),
    'build/index.js'
  )
  return execute(process.execPath, [cli, ...args], options)
}

function generate() {
  mkdirSync(generated, { recursive: true })
  const source = readFileSync(
    path.join(support, 'prisma/schema.prisma'),
    'utf8'
  )
  if (!source.includes('output   = "./generated/prisma-support"')) {
    throw new Error(
      'Support generator changed; review standalone output mapping'
    )
  }
  const schema = source.replace(
    'output   = "./generated/prisma-support"',
    'output   = "./support"'
  )
  const schemaPath = path.join(generated, 'support.prisma')
  writeFileSync(schemaPath, schema)
  prisma(['generate', '--schema', schemaPath])
  prisma([
    'generate',
    '--schema',
    path.join(directory, 'prisma/external.prisma'),
  ])
}

export function runTypecheck() {
  execute(process.execPath, [
    require.resolve('typescript/bin/tsc'),
    '--noEmit',
    '-p',
    path.join(directory, 'tsconfig.json'),
  ])
}

function infra() {
  // Existing script refuses to reuse a different Postgres on the shared port.
  execute(process.execPath, [
    '--experimental-strip-types',
    '--no-warnings',
    'tests/infra-up.ts',
  ])
  execute(process.execPath, [
    '--experimental-strip-types',
    '--no-warnings',
    'tests/wait-for-services.ts',
  ])
}

async function database(env = testEnvironment()) {
  // Do not migrate an arbitrary service that happens to answer on this port.
  const url = new URL(env.DATABASE_SUPPORT)
  execute(
    'docker',
    [
      'exec',
      'binodex-test-pg-support',
      'pg_isready',
      '-U',
      decodeURIComponent(url.username),
      '-d',
      url.pathname.slice(1),
    ],
    { env }
  )
  prisma(
    [
      'migrate',
      'deploy',
      '--schema',
      path.join(support, 'prisma/schema.prisma'),
    ],
    { env }
  )

  const { PrismaClient } = require('./.generated/external')
  const client = new PrismaClient({
    datasources: { db: { url: env.DATABASE_SUPPORT } },
  })
  try {
    const existing = await client.$queryRawUnsafe(
      `SELECT count(*)::int AS count FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN
       ('users', 'accounts', 'payments', 'trades', 'positions', 'predict_orders',
        'partners', 'company_codes', 'partner_region_codes')`
    )
    if (existing[0].count !== 0 && existing[0].count !== 9) {
      throw new Error(
        'Partial external test schema found. Use a fresh disposable support_test database; no tables were dropped.'
      )
    }
    if (existing[0].count === 0) {
      const sql = prisma(
        [
          'migrate',
          'diff',
          '--from-empty',
          '--to-schema-datamodel',
          path.join(directory, 'prisma/external.prisma'),
          '--script',
        ],
        { env, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' }
      )
      const sqlPath = path.join(generated, 'external.sql')
      writeFileSync(sqlPath, sql)
      prisma(
        [
          'db',
          'execute',
          '--schema',
          path.join(directory, 'prisma/external.prisma'),
          '--file',
          sqlPath,
        ],
        { env }
      )
    }
    // Existence alone is not enough: detect old/incompatible fixture tables.
    await client.user.findFirst()
    await client.payment.findFirst()
    await client.account.findFirst()
    await client.partner.findFirst()
  } finally {
    await client.$disconnect()
  }
}

function test(suite) {
  execute(
    process.execPath,
    [
      require.resolve('vitest/vitest.mjs'),
      'run',
      '--config',
      path.join(directory, 'vitest.config.mjs'),
    ],
    { env: { ...testEnvironment(), SUPPORT_STANDALONE_SUITE: suite } }
  )
}

function buildDevelopmentServer() {
  execute(process.execPath, [
    require.resolve('typescript/bin/tsc'),
    '-p',
    path.join(directory, 'tsconfig.dev.json'),
  ])
}

async function main() {
  const action = process.argv[2]
  switch (action) {
    case 'dev-build':
      return buildDevelopmentServer()
    case 'dev-seed': {
      const env = developmentEnvironment()
      await database(env)
      const { seedDevelopmentData } = await import('./dev-fixtures.mjs')
      Object.assign(process.env, env)
      console.log(await seedDevelopmentData())
      return
    }
    case 'dev-reset': {
      const env = developmentEnvironment()
      await database(env)
      Object.assign(process.env, env)
      const { resetDevelopmentData, seedDevelopmentData } = await import(
        './dev-fixtures.mjs'
      )
      await resetDevelopmentData()
      await seedDevelopmentData()
      console.log(
        'Only the three synthetic users were reset in local support_test. Telegram topics and files were not deleted.'
      )
      return
    }
    case 'dev': {
      const env = developmentEnvironment()
      infra()
      await database(env)
      buildDevelopmentServer()
      return execute(
        process.execPath,
        [path.join(directory, 'dev-server.mjs')],
        { env }
      )
    }
    case 'generate':
      return generate()
    case 'typecheck':
      return runTypecheck()
    case 'unit':
      return test('unit')
    case 'infra':
      return infra()
    case 'database':
      return database()
    case 'integration':
      infra()
      await database()
      return test('integration')
    case 'all':
      test('unit')
      infra()
      await database()
      return test('integration')
    default:
      throw new Error(`Unknown test action: ${action}`)
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
