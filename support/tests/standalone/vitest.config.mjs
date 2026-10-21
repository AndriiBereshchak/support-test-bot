import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { testEnvironment } from './environment.mjs'

const directory = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const manifest = require('./package.json')
const unitOnly = process.env.SUPPORT_STANDALONE_SUITE === 'unit'

export default defineConfig({
  root: path.resolve(directory, '../..'),
  cacheDir: path.join(directory, '.vite'),
  resolve: {
    alias: [
      { find: '@apps', replacement: path.resolve(directory, '../../src/apps') },
      { find: '@core', replacement: path.resolve(directory, '../../src/core') },
      {
        find: '@config',
        replacement: path.resolve(directory, '../../src/config'),
      },
      {
        find: '@telegram',
        replacement: path.resolve(directory, '../../src/telegram'),
      },
      {
        find: '@prisma-support',
        replacement: path.join(directory, '.generated/support/index.js'),
      },
      {
        find: '@prisma-exchange',
        replacement: path.join(directory, '.generated/external/index.js'),
      },
      {
        find: '@prisma-affiliate',
        replacement: path.join(directory, '.generated/external/index.js'),
      },
      {
        find: '@binodex/shared',
        replacement: path.join(directory, 'adapters/shared.ts'),
      },
      ...Object.keys({ ...manifest.dependencies, vitest: '' })
        .filter((name) => name !== 'prisma')
        .map((name) => ({
          find: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
          replacement:
            name === 'vitest'
              ? path.join(
                  path.dirname(require.resolve('vitest/package.json')),
                  'dist/index.js'
                )
              : require.resolve(name),
        })),
    ],
  },
  test: {
    environment: 'node',
    env: testEnvironment(),
    setupFiles: [path.join(directory, 'setup.ts')],
    globalSetup: [path.join(directory, 'typecheck.mjs')],
    include: unitOnly
      ? [
          'tests/unit/**/*.test.ts',
          'tests/telegram/**/*.test.ts',
          'tests/standalone/**/*.test.ts',
        ]
      : ['tests/integration/**/*.test.ts', 'tests/app.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
})
