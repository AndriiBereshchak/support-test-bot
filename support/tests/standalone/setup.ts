import { afterAll, vi } from 'vitest'
import { testEnvironment } from './environment.mjs'

Object.assign(process.env, testEnvironment())

// This boundary is outside the export. Fail explicitly instead of ever
// contacting a real exchange service or pretending deletion succeeded.
vi.mock('@core/exchange-grpc', () => ({
  grpcDeleteUser: vi.fn(async () => {
    throw new Error('Exchange gRPC is unavailable in standalone tests')
  }),
}))

afterAll(async () => {
  const { closeRedis } = await import('../../src/config/redis')
  const { closeNats } = await import('../../src/config/nats')
  const { shutdownPrisma } = await import('../../src/config/database')
  await closeNats()
  await closeRedis()
  await shutdownPrisma()
})
