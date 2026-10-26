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
  kbImportSchema,
  kbConfigFields,
} from '@apps/services/zhora/kb.schema'
import {
  getZhoraKbConfig,
  updateZhoraKbConfig,
  type ZhoraKbConfigInput,
} from '@apps/services/zhora/kb-config.service'
import {
  parseZhoraKbImport,
  normalizeZhoraKbImport,
  type ZhoraKbImport,
} from '@apps/services/zhora/kb-import.service'

type CreateKbBody = ZhoraKbInput & { updatedById: string }
type UpdateKbBody = Partial<ZhoraKbInput> & { updatedById: string }

const status = fields.status
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
  // JSON accepts a flat array or a document. The document may update links.
  // File IDs are discarded; support generates its own UUIDs.
  // CSV uses the import fields; array/object/boolean cells contain JSON.
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
    const data = parseZhoraKbImport(content, format)
    const validate = request.compileValidationSchema(kbImportSchema)
    if (!validate(data)) {
      // anyOf also reports errors for the alternate format. Show only the
      // applicable branch so a document error is not reported as "not array".
      const branch = Array.isArray(data) ? '#/anyOf/0/' : '#/anyOf/1/'
      const error = validate.errors?.find((item) =>
        item.schemaPath.startsWith(branch)
      )
      const parts = error?.instancePath.split('/') ?? []
      const index = parts[1] === 'entries' ? 2 : 1
      const location =
        parts[index] !== undefined && /^\d+$/.test(parts[index]!)
          ? `Record ${Number(parts[index]) + 1}${parts.slice(index + 1).length ? ` (${parts.slice(index + 1).join('/')})` : ''}`
          : `File${error?.instancePath ? ` (${error.instancePath})` : ''}`
      throw new ApiError(
        `${location}: ${error?.message ?? 'invalid entries'}`,
        400,
        'KB_IMPORT_INVALID'
      )
    }
    const entries = normalizeZhoraKbImport(data as ZhoraKbImport)
    const config = Array.isArray(data)
      ? undefined
      : (data as Extract<ZhoraKbImport, { entries: ZhoraKbInput[] }>).config
    return reply
      .code(201)
      .send(await importZhoraKbEntries(entries, author.value.trim(), config))
  })

  app.get('/config', async () => {
    const config = await getZhoraKbConfig()
    if (!config)
      throw new ApiError('KB config not found', 404, 'KB_CONFIG_NOT_FOUND')
    return config
  })

  app.patch<{
    Body: Partial<ZhoraKbConfigInput> & { updatedById: string }
  }>(
    '/config',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['updatedById'],
          anyOf: Object.keys(kbConfigFields).map((field) => ({
            required: [field],
          })),
          properties: { ...kbConfigFields, updatedById: text },
        },
      },
    },
    async (request) => {
      const { updatedById, ...input } = request.body
      return updateZhoraKbConfig(input, updatedById.trim())
    }
  )

  app.post<{ Body: CreateKbBody }>(
    '/',
    {
      prefixTrailingSlash: 'both',
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['question', 'answer_ru', 'category', 'updatedById'],
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
            category: text,
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
