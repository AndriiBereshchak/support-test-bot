import type { FastifyPluginAsync } from 'fastify'
import { INTERNAL_TOKEN } from '@config/env'
import { ApiError } from '@core/errors/api-error'
import { constantTimeEqual } from '@core/utils/constant-time'
import {
  createZhoraKbEntry,
  deleteZhoraKbEntry,
  getZhoraKbEntry,
  listZhoraKbEntries,
  updateZhoraKbEntry,
  type ZhoraKbInput,
  type ZhoraKbQuery,
} from '@apps/services/zhora/kb.service'

type CreateKbBody = ZhoraKbInput & { updatedById: string }
type UpdateKbBody = Partial<ZhoraKbInput> & { updatedById: string }

const text = { type: 'string', pattern: '\\S' } as const
const status = { type: 'string', enum: ['draft', 'active'] } as const
const fields = {
  questions: { type: 'array', minItems: 1, items: text },
  answerRu: text,
  translations: {
    type: 'object',
    // RU is the master answerRu field; translations may be incomplete.
    propertyNames: {
      enum: ['en', 'ua', 'de', 'es', 'fr', 'hi', 'tr', 'ar', 'cs', 'it'],
    },
    additionalProperties: text,
  },
  tag: text,
  domains: {
    type: 'array',
    items: {
      type: 'string',
      maxLength: 253,
      // Hostnames only: no URL scheme, path, port or wildcard.
      pattern:
        '^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z]{2,63}$',
    },
  },
  status,
} as const
const params = {
  type: 'object',
  required: ['id'],
  properties: {
    id: {
      type: 'string',
      pattern:
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
    },
  },
} as const

export const zhoraKbRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (request) => {
    const token = request.headers['x-internal-token']
    if (
      !INTERNAL_TOKEN ||
      typeof token !== 'string' ||
      !constantTimeEqual(token, INTERNAL_TOKEN)
    ) {
      throw new ApiError('Unauthorized', 401)
    }
  })

  app.post<{ Body: CreateKbBody }>(
    '/',
    {
      prefixTrailingSlash: 'both',
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['questions', 'answerRu', 'tag', 'updatedById'],
          properties: { ...fields, updatedById: text },
        },
      },
    },
    async (request, reply) => {
      const { updatedById, ...input } = request.body
      const entry = await createZhoraKbEntry(input, updatedById.trim())
      return reply.code(201).send(entry)
    }
  )

  app.get<{ Querystring: ZhoraKbQuery }>(
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
            status,
            tag: text,
          },
        },
      },
    },
    async (request) => listZhoraKbEntries(request.query)
  )

  app.get<{ Params: { id: string } }>(
    '/:id',
    { schema: { params } },
    async (request) => getZhoraKbEntry(request.params.id)
  )

  app.patch<{ Params: { id: string }; Body: UpdateKbBody }>(
    '/:id',
    {
      schema: {
        params,
        body: {
          type: 'object',
          minProperties: 1,
          required: ['updatedById'],
          anyOf: Object.keys(fields).map((field) => ({ required: [field] })),
          additionalProperties: false,
          properties: { ...fields, updatedById: text },
        },
      },
    },
    async (request) => {
      const { updatedById, ...input } = request.body
      return updateZhoraKbEntry(request.params.id, input, updatedById.trim())
    }
  )

  app.delete<{ Params: { id: string } }>(
    '/:id',
    { schema: { params } },
    async (request, reply) => {
      await deleteZhoraKbEntry(request.params.id)
      return reply.code(204).send()
    }
  )
}
