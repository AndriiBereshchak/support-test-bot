import fs from 'node:fs'

import type { MultipartFields } from '@fastify/multipart'
import type { FastifyPluginAsync } from 'fastify'

import { prismaSupport } from '@config/database'
import { INTERNAL_TOKEN, NODE_ENV } from '@config/env'

import type {
  InternalCloseTicketRequest,
  InternalFeedbackRequest,
  InternalMarkReadRequest,
  InternalSendMessageRequest,
  InternalThreadRequest,
  InternalTrustpilotClickRequest,
  InternalTypingRequest,
} from '@core/contracts'
import { ApiError } from '@core/errors/api-error'
import { constantTimeEqual } from '@core/utils/constant-time'

import {
  AttachmentQuotaError,
  AttachmentRejectedError,
  openAttachment,
  stageUpload,
} from '@apps/services/attachment.service'
import {
  closeTicketEverywhere,
  markRead,
  userSendMessage,
  userTyping,
} from '@apps/services/chat.service'
import {
  markTrustpilotClick,
  submitFeedback,
} from '@apps/services/feedback.service'
import { assertCanWrite } from '@apps/services/mute.service'
import { toAttachmentDto } from '@apps/services/mappers'
import { appendMessage } from '@apps/services/message.service'
import {
  ensureOpenTicket,
  findOpenTicket,
  getThread,
} from '@apps/services/ticket.service'

/**
 * The exchange -> support hop. Every route here is called by the exchange proxy
 * over the docker network and by nothing else; the browser never reaches this
 * service directly, which is why there is no CORS, no cookie parsing and no
 * user authentication — exchange has already authenticated the user and passes
 * the resolved `userId` in the body.
 *
 * That makes `x-internal-token` the entire trust boundary: anything able to
 * forge it can read and write any user's support thread.
 */

// Abuse ceiling, not a protocol one — `@telegram/text.splitText` already chops
// a long message into Telegram-sized parts, so this only bounds how much text
// one bubble can persist.
const MAX_TEXT_LENGTH = 8000

const userIdSchema = { type: 'string', minLength: 1, maxLength: 64 } as const

// Attachment ids are `@db.Uuid` columns. A non-uuid string reaching Prisma
// raises P2023 ("Inconsistent column data") — a 500 for what is obviously a bad
// request — so the shape is rejected at the schema instead.
const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

/** Body of POST /messages.
 *
 * Neither extra field is part of `InternalSendMessageRequest` in the wire
 * contract — both are added by the exchange proxy on this hop:
 *  - `userNId`, because the browser doesn't know it, a ticket denormalizes it
 *    for the Telegram topic name, and support must stay able to name topics
 *    when the exchange DB blinks;
 *  - `originDomain`, because only exchange sees the request headers the mirror
 *    is identified by.
 */
type InternalSendMessageBody = InternalSendMessageRequest & {
  userNId: number
  originDomain?: string
}

// Matches `SupportTicket.originDomain` (VarChar 255). The value ultimately
// comes from a request HEADER the exchange proxy read, so it is bounded here
// as well as there — a header is not a validated field.
const MAX_ORIGIN_DOMAIN_LENGTH = 255

interface AttachmentParams {
  id: string
}

interface AttachmentQuery {
  userId: string
}

/** Pull a scalar multipart field, tolerating the array form busboy emits on repeats. */
function fieldValue(fields: MultipartFields, name: string): string | undefined {
  const raw = fields[name]
  const one = Array.isArray(raw) ? raw[0] : raw
  if (!one || one.type !== 'field') return undefined
  return String(one.value)
}

/**
 * Build the `Content-Disposition` header.
 *
 * The stored name is already sanitized at upload time; this second pass exists
 * because one stray quote or newline in a header is a response-splitting bug,
 * and paranoia in a header costs nothing.
 */
function contentDisposition(kind: string, fileName: string): string {
  const ascii = fileName.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'file'
  // Inline media (image, video) and PDFs render in place in the chat bubble.
  // Everything else downloads rather than renders, so a document that lies
  // about its type can never execute on the platform origin.
  //
  // VIDEO is listed even though the DTO points video at the static mount and
  // never here: leaving it out made this route a trap for whoever later adds a
  // fallback through it, since the clip would download instead of playing.
  const mode =
    kind === 'IMAGE' || kind === 'VIDEO' || kind === 'PDF'
      ? 'inline'
      : 'attachment'
  return `${mode}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
}

export const internalRoutes: FastifyPluginAsync = async (app) => {
  // Encapsulated: this hook covers only the routes registered in THIS plugin.
  // The Telegram webhook lives under the same `/v1/internal` prefix but in its
  // own plugin, so it is deliberately not guarded by the internal token — it
  // carries Telegram's own secret header instead.
  app.addHook('onRequest', async (request) => {
    // Local dev and the test suite run without a token. Production cannot:
    // `assertRequiredEnv()` refuses to boot without one, and the comparison
    // below would 401 everything anyway.
    if (!INTERNAL_TOKEN && NODE_ENV !== 'production') return

    const supplied = request.headers['x-internal-token']
    if (
      typeof supplied !== 'string' ||
      !constantTimeEqual(supplied, INTERNAL_TOKEN)
    ) {
      throw new ApiError('Unauthorized', 401, 'INTERNAL_TOKEN_INVALID')
    }
  })

  app.post<{ Body: InternalThreadRequest }>(
    '/thread',
    {
      schema: {
        body: {
          type: 'object',
          required: ['userId'],
          additionalProperties: false,
          properties: {
            userId: userIdSchema,
            beforeId: { type: 'string', pattern: UUID_PATTERN },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
          },
        },
      },
    },
    async (request) => {
      const { userId, beforeId, limit } = request.body
      return getThread(userId, beforeId, limit)
    }
  )

  app.post<{ Body: InternalSendMessageBody }>(
    '/messages',
    {
      schema: {
        body: {
          type: 'object',
          required: ['userId', 'userNId'],
          additionalProperties: false,
          properties: {
            userId: userIdSchema,
            userNId: { type: 'integer', minimum: 0 },
            text: { type: 'string', maxLength: MAX_TEXT_LENGTH },
            attachmentIds: {
              type: 'array',
              maxItems: 10,
              items: { type: 'string', pattern: UUID_PATTERN },
            },
            requestId: { type: 'string', minLength: 1, maxLength: 64 },
            originDomain: {
              type: 'string',
              maxLength: MAX_ORIGIN_DOMAIN_LENGTH,
            },
          },
        },
      },
    },
    async (request) => {
      const { userId, userNId, text, attachmentIds, requestId, originDomain } =
        request.body

      // Whitespace-only text is empty text: it would open a ticket and post an
      // invisible bubble into the Telegram topic. Trimmed only for this check —
      // what gets stored stays byte-for-byte what the user typed.
      const hasText = typeof text === 'string' && text.trim().length > 0
      if (!hasText && !(attachmentIds && attachmentIds.length > 0)) {
        throw new ApiError('Message is empty', 400, 'EMPTY_MESSAGE')
      }

      return userSendMessage({
        userId,
        userNId,
        text: hasText ? text : null,
        ...(attachmentIds ? { attachmentIds } : {}),
        ...(requestId ? { requestId } : {}),
        ...(originDomain ? { originDomain } : {}),
      })
    }
  )

  app.post<{ Body: InternalMarkReadRequest }>(
    '/read',
    {
      schema: {
        body: {
          type: 'object',
          required: ['userId'],
          additionalProperties: false,
          properties: { userId: userIdSchema },
        },
      },
    },
    async (request) => {
      const unread = await markRead(request.body.userId)
      return { unread }
    }
  )

  app.post<{ Body: InternalTypingRequest }>(
    '/typing',
    {
      schema: {
        body: {
          type: 'object',
          required: ['userId'],
          additionalProperties: false,
          properties: { userId: userIdSchema },
        },
      },
    },
    async (request, reply) => {
      await userTyping(request.body.userId)
      // 204 whatever happened inside. The caller fires this on a keystroke and
      // has nothing to do with an answer, and every "nothing to signal" case
      // (no open ticket, no topic yet, throttled) is a normal outcome — a 404
      // here would only teach the FE to show an error while the user types.
      return reply.code(204).send()
    }
  )

  app.post<{ Body: InternalCloseTicketRequest }>(
    '/close',
    {
      schema: {
        body: {
          type: 'object',
          required: ['userId'],
          additionalProperties: false,
          properties: { userId: userIdSchema },
        },
      },
    },
    async (request) => {
      const open = await findOpenTicket(request.body.userId)
      // 404 rather than a silent 200: the user only sees the close button while
      // the UI believes a ticket is open, so "nothing to close" means the two
      // sides disagree and the FE should re-read the thread.
      if (!open) throw new ApiError('No open ticket', 404, 'NO_OPEN_TICKET')

      const ticket = await closeTicketEverywhere(open.id, 'USER')
      return { ticket }
    }
  )

  app.post<{ Body: InternalFeedbackRequest }>(
    '/feedback',
    {
      schema: {
        body: {
          type: 'object',
          required: ['userId', 'ticketId', 'rating'],
          additionalProperties: false,
          properties: {
            userId: userIdSchema,
            ticketId: { type: 'string', minLength: 1, maxLength: 64 },
            // The range is checked here, in the service and by the DB column
            // alike: the rating goes into analytics, and a "7 stars" there
            // costs more than a rejection.
            rating: { type: 'integer', minimum: 1, maximum: 5 },
            comment: {
              type: ['string', 'null'],
              maxLength: 2000,
            },
          },
        },
      },
    },
    async (request) => {
      const ticket = await submitFeedback({
        userId: request.body.userId,
        ticketId: request.body.ticketId,
        rating: request.body.rating,
        comment: request.body.comment ?? null,
      })
      return { ticket }
    }
  )

  app.post<{ Body: InternalTrustpilotClickRequest }>(
    '/feedback/trustpilot',
    {
      schema: {
        body: {
          type: 'object',
          required: ['userId'],
          additionalProperties: false,
          properties: { userId: userIdSchema },
        },
      },
    },
    async (request) => {
      return await markTrustpilotClick(request.body.userId)
    }
  )

  app.post('/attachments', async (request) => {
    const data = await request.file()
    if (!data) throw new ApiError('file is required', 400, 'NO_FILE')

    // Drains the part fully; `@fastify/multipart` raises FST_REQ_FILE_TOO_LARGE
    // (413) here when the upload passes the configured ceiling.
    const buffer = await data.toBuffer()

    // Read the fields AFTER draining the file: busboy fills `data.fields`
    // incrementally, so a field sent after the file part does not exist yet at
    // the moment `request.file()` resolves.
    const userId = fieldValue(data.fields, 'userId')
    const userNIdRaw = fieldValue(data.fields, 'userNId')
    const userNId = Number(userNIdRaw)
    if (!userId || !userNIdRaw || !Number.isFinite(userNId)) {
      throw new ApiError(
        'userId and userNId fields are required',
        400,
        'MISSING_FIELDS'
      )
    }

    // A file is as much a support request as text: without this check a
    // blocked user would silently keep sending screenshots.
    await assertCanWrite(userId)
    // Multipart fields bypass the JSON schema, so this one is bounded by hand.
    // Attaching a file is one of the two ways a ticket gets opened, and the
    // ticket it opens deserves the same origin as one opened by typing.
    const originDomain = fieldValue(data.fields, 'originDomain')?.slice(
      0,
      MAX_ORIGIN_DOMAIN_LENGTH
    )

    const { ticket, created } = await ensureOpenTicket({
      userId,
      userNId,
      ...(originDomain ? { originDomain } : {}),
    })

    // Staging a file is one of the things that can open a ticket, so the
    // opening system bubble has to be written here too. Without it, a user who
    // attaches a file before typing gets a feed where the new ticket is not
    // separated from the previous one: `userSendMessage` only writes that
    // bubble for the ticket IT created, and by then the ticket already exists.
    if (created) {
      await appendMessage({
        ticketId: ticket.id,
        direction: 'SYSTEM',
        systemKind: 'TICKET_OPENED',
      })
    }

    try {
      const attachment = await stageUpload({
        ticketId: ticket.id,
        fileName: data.filename,
        mimeType: data.mimetype,
        buffer,
      })
      return toAttachmentDto(attachment)
    } catch (err) {
      // BEFORE the plain-rejection branch, which this one extends: a limit
      // carries its own status, and the three are deliberately distinct so the
      // browser can tell them apart from the status alone — 429 "wait", 413
      // "you are out of room", 507 "the volume is". The `code` survives the hop
      // too (the proxy's `readJson` reads it), but the status is what the FE
      // branches on, because it is the one thing no intermediary can drop.
      if (err instanceof AttachmentQuotaError) {
        throw new ApiError(err.message, err.status, err.code)
      }
      // A rejected file is the user's problem to fix (wrong type, unreadable
      // image), not an incident — 400 with the reason, no Sentry event.
      if (err instanceof AttachmentRejectedError) {
        throw new ApiError(err.message, 400, 'ATTACHMENT_REJECTED')
      }
      throw err
    }
  })

  app.get<{ Params: AttachmentParams; Querystring: AttachmentQuery }>(
    '/attachments/:id/raw',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', pattern: UUID_PATTERN } },
        },
        querystring: {
          type: 'object',
          required: ['userId'],
          properties: { userId: userIdSchema },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params

      // Ownership is part of the LOOKUP, not a comparison after it: an id that
      // does not exist and an id belonging to somebody else both come back as
      // null, so there is no branch where the two can accidentally diverge.
      // The answer is 404 either way — support attachments are payment receipts
      // and identity documents, so even confirming that an id exists leaks.
      const owned = await prismaSupport.supportAttachment.findFirst({
        where: { id, ticket: { userId: request.query.userId } },
        select: { kind: true },
      })
      if (!owned) throw new ApiError('Not found', 404, 'ATTACHMENT_NOT_FOUND')

      // Resolves the path and re-checks containment; null means the row points
      // at bytes that are gone or outside the storage root.
      const opened = await openAttachment(id)
      if (!opened) throw new ApiError('Not found', 404, 'ATTACHMENT_NOT_FOUND')

      reply.header('Content-Type', opened.mimeType)
      // From the filesystem stat, not the row: a Content-Length that disagrees
      // with the bytes on the wire stalls the transfer.
      reply.header('Content-Length', String(opened.sizeBytes))
      reply.header(
        'Content-Disposition',
        contentDisposition(owned.kind, opened.fileName)
      )
      // The stored mime type ultimately came from an uploader. `nosniff` stops
      // the browser from second-guessing it and executing a mislabelled file.
      reply.header('X-Content-Type-Options', 'nosniff')
      reply.header('Cache-Control', 'private, max-age=300')

      return reply.send(fs.createReadStream(opened.absPath))
    }
  )
}

export default internalRoutes
