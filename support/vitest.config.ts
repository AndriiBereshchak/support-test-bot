import path from 'path'

import { defineConfig } from 'vitest/config'

// Mirrors the exchange setup: real infra (Postgres/Redis/NATS from
// docker-compose.test.yml), one forked worker so shared infra is never hit
// concurrently, and an alias block that must stay in sync with tsconfig
// `paths` — vitest does NOT read tsconfig paths.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/typecheck-gate.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
  resolve: {
    alias: {
      '@apps': path.resolve(__dirname, './src/apps'),
      '@core': path.resolve(__dirname, './src/core'),
      '@config': path.resolve(__dirname, './src/config'),
      '@telegram': path.resolve(__dirname, './src/telegram'),
      '@prisma-support': path.resolve(
        __dirname,
        './prisma/generated/prisma-support'
      ),
      '@prisma-exchange': path.resolve(
        __dirname,
        '../exchange/prisma/generated/prisma-exchange'
      ),
      '@prisma-affiliate': path.resolve(
        __dirname,
        '../affiliate/prisma/generated/prisma-affiliate'
      ),
    },
  },
})
