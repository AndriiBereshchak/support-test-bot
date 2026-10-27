import type { FastifyPluginAsync } from 'fastify'
import { ApiError } from '@core/errors/api-error'
import {
  getZhoraKbCandidate,
  listZhoraKbCandidates,
} from '@apps/services/zhora/kb-candidate.service'
import { requireZhoraManagementToken } from './zhora-management-auth'

const uuid =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

export const zhoraKbCandidateRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', requireZhoraManagementToken)

  app.get<{ Querystring: { limit?: number; offset?: number } }>(
    '/',
    {
      prefixTrailingSlash: 'both',
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 200 },
            offset: { type: 'integer', minimum: 0 },
          },
        },
      },
    },
    async (request) => listZhoraKbCandidates(request.query)
  )

  app.get<{ Params: { id: string } }>(
    '/:id',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', pattern: uuid } },
        },
      },
    },
    async (request) => {
      const candidate = await getZhoraKbCandidate(request.params.id)
      if (!candidate) throw new ApiError('KB candidate not found', 404)
      return candidate
    }
  )
}
