import { extname } from 'node:path'
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
  importZhoraKbEntries,
} from '@apps/services/zhora/kb.service'

import {
  kbFields as fields,
  kbText as text,
} from '@apps/services/zhora/kb.schema'
import {
  parseZhoraKbImport,
  MAX_KB_IMPORT_ENTRIES,
} from '@apps/services/zhora/kb-import.service'

type CreateKbBody = ZhoraKbInput & { updatedById: string }
type UpdateKbBody = Partial<ZhoraKbInput> & { updatedById: string }

const status = fields.status
const importSchema = {
  type: 'array',
  minItems: 1,
  maxItems: MAX_KB_IMPORT_ENTRIES,
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['questions', 'answerRu', 'tag'],
    properties: fields,
  },
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

  // multipart/form-data: one UTF-8 .json/.csv file and updatedById field.
  // JSON is an array of entries. CSV uses matching headers; questions,
  // translations and domains cells contain JSON values.
  app.post('/import', async (request, reply) => {
    const file = await request.file()
    if (!file) throw new ApiError('file is required', 400, 'NO_FILE')
    const buffer = await file.toBuffer()
    // Like attachments, read fields after draining the file so that the author
    // may appear either before or after it in the multipart body.
    const author = file.fields.updatedById
    if (
      !author ||
      Array.isArray(author) ||
      author.type !== 'field' ||
      typeof author.value !== 'string' ||
      !author.value.trim()
    ) {
      throw new ApiError('updatedById is required', 400, 'KB_IMPORT_INVALID')
    }
    const format = extname(file.filename).toLowerCase()
    if (format !== '.json' && format !== '.csv') {
      throw new ApiError(
        'Expected a .json or .csv file',
        400,
        'KB_IMPORT_INVALID'
      )
    }
    let content: string
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    } catch {
      throw new ApiError('File must use UTF-8', 400, 'KB_IMPORT_INVALID')
    }
    const entries = parseZhoraKbImport(content, format)
    const validate = request.compileValidationSchema(importSchema)
    if (!validate(entries)) {
      const error = validate.errors?.[0]
      const parts = error?.instancePath.split('/') ?? []
      const location =
        parts[1] !== undefined
          ? `Record ${Number(parts[1]) + 1}${parts.slice(2).length ? ` (${parts.slice(2).join('/')})` : ''}`
          : 'File'
      throw new ApiError(
        `${location}: ${error?.message ?? 'invalid entries'}`,
        400,
        'KB_IMPORT_INVALID'
      )
    }
    return reply
      .code(201)
      .send(
        await importZhoraKbEntries(
          entries as ZhoraKbInput[],
          author.value.trim()
        )
      )
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
