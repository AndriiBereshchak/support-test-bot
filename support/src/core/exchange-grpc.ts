import * as grpc from '@grpc/grpc-js'
import { loadPackageDefinition } from '@grpc/grpc-js'
import { loadSync } from '@grpc/proto-loader'

import { GRPC_EXCHANGE_SERVER } from '@config/env'
import { logger } from '@config/logger'

/**
 * Thin client for the exchange gRPC server, mirroring how the admin service
 * calls it (admin/src/apps/services/grpc/grpc.service.ts). Account deletion
 * MUST go through this rpc rather than a direct prisma write: exchange's
 * `UserService.delete` owns the semantics — soft delete + refresh-session
 * revocation + websocket teardown — and duplicating that here would fork the
 * logic the spec explicitly says to reuse.
 *
 * Lazy: the channel dials on first use, so a replica without the env (tests,
 * local dev) boots fine and only the delete action fails with a clear error.
 */

const DEADLINE_MS = 10_000

let client: any = null

function getClient(): any {
  if (client) return client
  const proto = loadSync(`${process.cwd()}/protos/exchange.proto`, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  })
  const pkg = loadPackageDefinition(proto) as any
  client = new pkg.Exchange(
    GRPC_EXCHANGE_SERVER,
    grpc.credentials.createInsecure()
  )
  return client
}

/**
 * Soft-delete a user through exchange. Resolves with whatever exchange
 * returns (the admin client JSON-parses `result`; we do the same and
 * tolerate an empty payload).
 */
export async function grpcDeleteUser(uid: string): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    getClient().deleteUser(
      { uid },
      { deadline: Date.now() + DEADLINE_MS },
      (err: grpc.ServiceError | null, response: any) => {
        if (err) {
          logger.error(`[exchange-grpc] DeleteUser failed: ${err.message}`)
          reject(err)
          return
        }
        try {
          resolve(response?.result ? JSON.parse(response.result) : null)
        } catch {
          resolve(null)
        }
      }
    )
  })
}
