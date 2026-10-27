import type { FastifyPluginAsync } from 'fastify'
import { kbText } from '@apps/services/zhora/kb.schema'
import {
  createZhoraTemplate,
  deleteZhoraTemplate,
  getZhoraTemplate,
  listZhoraTemplates,
  listZhoraTemplateUsages,
  updateZhoraTemplate,
  ZHORA_TEMPLATE_TRANSLATION_LANGUAGES,
  type ZhoraTemplateInput,
  type ZhoraTemplateQuery,
  type ZhoraTemplateUsageQuery,
} from '@apps/services/zhora/template.service'
import { requireZhoraManagementToken } from './zhora-management-auth'

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
const text = { ...kbText, maxLength: 4096 } as const
const fields = {
  code: {
    type: 'string',
    pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$',
  },
  category: { ...kbText, maxLength: 128 },
  textRu: text,
  translations: {
    type: 'object',
    propertyNames: { enum: ZHORA_TEMPLATE_TRANSLATION_LANGUAGES },
    additionalProperties: text,
  },
} as const

type CreateBody = ZhoraTemplateInput & { updatedById: string }
type UpdateBody = Partial<ZhoraTemplateInput> & { updatedById: string }

export const zhoraTemplateRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', requireZhoraManagementToken)

  app.post<{ Body: CreateBody }>(
    '/',
    {
      prefixTrailingSlash: 'both',
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['code', 'category', 'textRu', 'updatedById'],
          properties: { ...fields, updatedById: kbText },
        },
      },
    },
    async (request, reply) => {
      const { updatedById, ...input } = request.body
      return reply
        .code(201)
        .send(await createZhoraTemplate(input, updatedById.trim()))
    }
  )

  app.get<{ Querystring: ZhoraTemplateQuery }>(
    '/',
    {
      prefixTrailingSlash: 'both',
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            category: fields.category,
            limit: { type: 'integer', minimum: 1, maximum: 200 },
            offset: { type: 'integer', minimum: 0 },
          },
        },
      },
    },
    async (request) => listZhoraTemplates(request.query)
  )

  app.get<{ Params: { id: string } }>(
    '/:id',
    { schema: { params } },
    async (request) => getZhoraTemplate(request.params.id)
  )

  app.get<{ Params: { id: string }; Querystring: ZhoraTemplateUsageQuery }>(
    '/:id/usages',
    {
      schema: {
        params,
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
    async (request) => listZhoraTemplateUsages(request.params.id, request.query)
  )

  app.patch<{ Params: { id: string }; Body: UpdateBody }>(
    '/:id',
    {
      schema: {
        params,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['updatedById'],
          anyOf: Object.keys(fields).map((field) => ({ required: [field] })),
          properties: { ...fields, updatedById: kbText },
        },
      },
    },
    async (request) => {
      const { updatedById, ...input } = request.body
      return updateZhoraTemplate(request.params.id, input, updatedById.trim())
    }
  )

  app.delete<{ Params: { id: string } }>(
    '/:id',
    { schema: { params } },
    async (request, reply) => {
      await deleteZhoraTemplate(request.params.id)
      return reply.code(204).send()
    }
  )
}
