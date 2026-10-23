import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
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

export interface ZhoraKbActor {
  id: string
  isAdmin: boolean
}

export interface ZhoraKbRouteOptions {
  // Server-side adapter to the existing admin authentication, still to be
  // agreed with its owners. This is not an HTTP header/body contract.
  resolveActor?: (request: FastifyRequest) => Promise<ZhoraKbActor | null>
}

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

/** Management API; a service token alone never grants administrator rights. */
export const zhoraKbRoutes: FastifyPluginAsync<ZhoraKbRouteOptions> = async (
  app,
  options
) => {
  const authors = new WeakMap<FastifyRequest, string>()
  app.addHook('onRequest', async (request) => {
    const token = request.headers['x-internal-token']
    if (
      !INTERNAL_TOKEN ||
      typeof token !== 'string' ||
      !constantTimeEqual(token, INTERNAL_TOKEN)
    ) {
      throw new ApiError('Unauthorized', 401)
    }
    // TODO: connect the real admin backend adapter once its identity and
    // permissions contract is confirmed. Keep the mounted API closed meanwhile.
    if (!options.resolveActor) {
      throw new ApiError(
        'KB administrator authentication is not configured',
        503,
        'KB_AUTH_NOT_CONFIGURED'
      )
    }
    const actor = await options.resolveActor(request)
    if (!actor || typeof actor.id !== 'string' || !actor.id.trim()) {
      throw new ApiError('Unauthorized', 401)
    }
    if (actor.isAdmin !== true) throw new ApiError('Forbidden', 403)
    authors.set(request, actor.id)
  })

  app.post<{ Body: ZhoraKbInput }>(
    '/',
    {
      prefixTrailingSlash: 'both',
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['questions', 'answerRu', 'tag'],
          properties: fields,
        },
      },
    },
    async (request, reply) => {
      const entry = await createZhoraKbEntry(
        request.body,
        authors.get(request)!
      )
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

  app.patch<{ Params: { id: string }; Body: Partial<ZhoraKbInput> }>(
    '/:id',
    {
      schema: {
        params,
        body: {
          type: 'object',
          minProperties: 1,
          anyOf: Object.keys(fields).map((field) => ({ required: [field] })),
          additionalProperties: false,
          properties: fields,
        },
      },
    },
    async (request) =>
      updateZhoraKbEntry(request.params.id, request.body, authors.get(request)!)
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
