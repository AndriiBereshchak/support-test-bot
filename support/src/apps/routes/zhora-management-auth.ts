import type { FastifyRequest } from 'fastify'
import { INTERNAL_TOKEN } from '@config/env'
import { ApiError } from '@core/errors/api-error'
import { constantTimeEqual } from '@core/utils/constant-time'

/** Internal service authentication; the upstream admin backend owns user roles. */
export async function requireZhoraManagementToken(
  request: FastifyRequest
): Promise<void> {
  const token = request.headers['x-internal-token']
  if (
    !INTERNAL_TOKEN ||
    typeof token !== 'string' ||
    !constantTimeEqual(token, INTERNAL_TOKEN)
  )
    throw new ApiError('Unauthorized', 401)
}
