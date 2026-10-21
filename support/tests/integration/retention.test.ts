import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'

vi.mock('@apps/services/push.service', () => ({
  pushToUser: vi.fn(async () => undefined),
}))
vi.mock('@telegram/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@telegram/api')>()),
  ...(await import('./_telegram-stub')).telegramStub(),
}))

import { prismaSupport, shutdownPrisma } from '@config/database'
import {
  STORAGE_QUOTA_BYTES,
  SUPPORT_FILES_DIR,
  UPLOAD_RATE_PER_HOUR,
  USER_STORAGE_QUOTA_BYTES,
} from '@config/env'
import { closeRedis, redisClient } from '@config/redis'

import {
  AttachmentQuotaError,
  AttachmentRejectedError,
  saveAgentAvatar,
  stageUpload,
} from '@apps/services/attachment.service'
import { toAttachmentDto } from '@apps/services/mappers'
import {
  STORAGE_USED_BYTES_KEY,
  runRetentionPass,
} from '@apps/services/retention.service'
import { ensureOpenTicket } from '@apps/services/ticket.service'

import { buildApp } from '../../src/app'
import { PNG_BYTES } from '../fixtures/bytes'
import {
  cleanupTestUser,
  createTestUser,
  listAttachments,
  type TestUser,
} from './_helpers'

let app: FastifyInstance

beforeAll(async () => {
  app = buildApp()
  await app.ready()
})

afterAll(async () => {
  await app.close()
  await closeRedis()
  await shutdownPrisma()
})

/**
 * A user with an empty ticket to hang files off.
 *
 * Deliberately NOT through `userSendMessage`: nothing in this file needs a
 * Telegram topic, and binding one would spend an id from the stub's sequence —
 * a shared test stand where an abandoned row from an old run holds a topic id
 * forever, and the next file to reach it fails on the unique index.
 */
async function userWithTicket() {
  const user = await createTestUser()
  const { ticket } = await ensureOpenTicket({
    userId: user.userId,
    userNId: user.userNId,
  })
  return { user, ticket }
}

/** Both halves of the split layout — see attachments.test.ts. */
function dropFiles(ticketId: string): void {
  for (const subtree of ['media', 'docs']) {
    fs.rmSync(path.join(path.resolve(SUPPORT_FILES_DIR), subtree, ticketId), {
      recursive: true,
      force: true,
    })
  }
}

const absOf = (storagePath: string): string =>
  path.join(path.resolve(SUPPORT_FILES_DIR), storagePath)

/** Age a row. The retention window is measured in days, so nothing waits. */
async function backdate(id: string, days: number): Promise<void> {
  await prismaSupport.supportAttachment.update({
    where: { id },
    data: { createdAt: new Date(Date.now() - days * 86_400_000) },
  })
}

/**
 * Plant an attachment ROW with no bytes behind it.
 *
 * Both quotas are measured from the table, and writing 200 MB of real files to
 * assert a limit would be the slowest test in the suite for no extra coverage.
 */
async function plantRow(
  ticketId: string,
  sizeBytes: number,
  uploadedByAgent = false
) {
  return prismaSupport.supportAttachment.create({
    data: {
      ticketId,
      kind: 'IMAGE',
      storagePath: `media/${ticketId}/${randomUUID()}.webp`,
      fileName: 'planted.webp',
      mimeType: 'image/webp',
      sizeBytes,
      uploadedByAgent,
    },
  })
}

const upload = (ticketId: string, fileName = 'скрин.png') =>
  stageUpload({
    ticketId,
    fileName,
    mimeType: 'image/png',
    buffer: PNG_BYTES,
  })

const BOUNDARY = '----binodexRetentionTest'

/**
 * The multipart body the route actually parses.
 *
 * The file part comes FIRST and the fields after it, which is the order the
 * handler depends on: it drains the file before reading `data.fields`, because
 * busboy fills them incrementally.
 */
function multipartBody(user: TestUser): Buffer {
  const part = (headers: string, body: Buffer): Buffer =>
    Buffer.concat([
      Buffer.from(`--${BOUNDARY}\r\n${headers}\r\n\r\n`),
      body,
      Buffer.from('\r\n'),
    ])

  return Buffer.concat([
    part(
      'Content-Disposition: form-data; name="file"; filename="shot.png"\r\nContent-Type: image/png',
      PNG_BYTES
    ),
    part(
      'Content-Disposition: form-data; name="userId"',
      Buffer.from(user.userId)
    ),
    part(
      'Content-Disposition: form-data; name="userNId"',
      Buffer.from(String(user.userNId))
    ),
    Buffer.from(`--${BOUNDARY}--\r\n`),
  ])
}

const uploadThroughRoute = (user: TestUser) =>
  app.inject({
    method: 'POST',
    url: '/v1/internal/attachments',
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    payload: multipartBody(user),
  })

describe('retention', () => {
  it('unlinks aged bytes, keeps the row, and marks the DTO purged', async () => {
    const { user, ticket } = await userWithTicket()
    try {
      const old = await upload(ticket.id, 'старый.png')
      const fresh = await upload(ticket.id, 'свежий.png')
      expect(fs.existsSync(absOf(old.storagePath))).toBe(true)

      await backdate(old.id, 8)
      await runRetentionPass()

      // The bytes are gone; the ROW is not. That is the whole design: the chat
      // must keep showing that a file was sent, and Telegram still holds a copy
      // for the operator.
      expect(fs.existsSync(absOf(old.storagePath))).toBe(false)
      const purged = await prismaSupport.supportAttachment.findUniqueOrThrow({
        where: { id: old.id },
      })
      expect(purged.purgedAt).not.toBeNull()
      expect(purged.fileName).toBe('старый.webp')
      expect(purged.sizeBytes).toBe(old.sizeBytes)

      const dto = toAttachmentDto(purged)
      expect(dto.purged).toBe(true)
      // Still a url, never an empty string: `src=""` re-fetches the current
      // document, which is worse than a link the FE is told not to follow.
      expect(dto.url).toBe(`/support-files/${purged.storagePath}`)

      // Anything that follows a stale link anyway gets the same 404 as an id
      // that never existed — and no "file missing" warning in the logs.
      const stale = await app.inject({
        method: 'GET',
        url: `/v1/internal/attachments/${old.id}/raw?userId=${encodeURIComponent(user.userId)}`,
      })
      expect(stale.statusCode).toBe(404)

      // Inside the window nothing is touched, and no `purged` key appears on a
      // live file.
      expect(fs.existsSync(absOf(fresh.storagePath))).toBe(true)
      const live = await prismaSupport.supportAttachment.findUniqueOrThrow({
        where: { id: fresh.id },
      })
      expect(live.purgedAt).toBeNull()
      expect(toAttachmentDto(live).purged).toBeUndefined()

      // Idempotent: a second pass finds the row already stamped and a file that
      // is already gone, and does neither again.
      await runRetentionPass()
      const again = await prismaSupport.supportAttachment.findUniqueOrThrow({
        where: { id: old.id },
      })
      expect(again.purgedAt).toEqual(purged.purgedAt)
    } finally {
      dropFiles(ticket.id)
      await cleanupTestUser(user.userId)
    }
  })

  it('prunes the emptied ticket directory but never the mounted subtree', async () => {
    const { user, ticket } = await userWithTicket()
    try {
      const only = await upload(ticket.id)
      const ticketDir = path.dirname(absOf(only.storagePath))
      expect(fs.existsSync(ticketDir)).toBe(true)

      await backdate(only.id, 8)
      await runRetentionPass()

      expect(fs.existsSync(ticketDir)).toBe(false)
      // `media/` is a mount point exchange's express.static holds open — the
      // prune must stop one level below it.
      expect(fs.existsSync(path.dirname(ticketDir))).toBe(true)
    } finally {
      dropFiles(ticket.id)
      await cleanupTestUser(user.userId)
    }
  })

  it('leaves the agent avatar subtree alone', async () => {
    const { user, ticket } = await userWithTicket()
    const avatarPath = `agents/${await saveAgentAvatar(424242, PNG_BYTES)}`
    try {
      // No avatar has an attachment row of its own, so a row POINTING at that
      // subtree is the only way this sweep could ever reach one. Aged well past
      // the window, it still has to survive.
      const planted = await prismaSupport.supportAttachment.create({
        data: {
          ticketId: ticket.id,
          kind: 'IMAGE',
          storagePath: avatarPath,
          fileName: 'avatar.webp',
          mimeType: 'image/webp',
          sizeBytes: 1,
          createdAt: new Date(Date.now() - 30 * 86_400_000),
        },
      })

      await runRetentionPass()

      expect(fs.existsSync(absOf(avatarPath))).toBe(true)
      const row = await prismaSupport.supportAttachment.findUniqueOrThrow({
        where: { id: planted.id },
      })
      expect(row.purgedAt).toBeNull()
    } finally {
      fs.rmSync(absOf(avatarPath), { force: true })
      dropFiles(ticket.id)
      await cleanupTestUser(user.userId)
    }
  })
})

describe('per-user limits', () => {
  it('refuses an upload that would cross the byte quota, with a status the FE can read', async () => {
    const { user, ticket } = await userWithTicket()
    try {
      await plantRow(ticket.id, USER_STORAGE_QUOTA_BYTES)

      const err = await upload(ticket.id).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(AttachmentQuotaError)
      // Extends the plain rejection on purpose: an older handler that only
      // knows that class still answers 400 instead of falling through to 500.
      expect(err).toBeInstanceOf(AttachmentRejectedError)
      expect((err as AttachmentQuotaError).status).toBe(413)
      expect((err as AttachmentQuotaError).code).toBe('USER_STORAGE_QUOTA')

      // And through the route it is that status — not the generic 500 that
      // would page the on-call over an anti-spam rule doing its job.
      const response = await uploadThroughRoute(user)
      expect(response.statusCode).toBe(413)
      expect(response.json().code).toBe('USER_STORAGE_QUOTA')

      // Nothing was written on either attempt.
      expect(await listAttachments(ticket.id)).toHaveLength(1)
    } finally {
      dropFiles(ticket.id)
      await cleanupTestUser(user.userId)
    }
  })

  it('admits the upload that lands exactly ON the cap, and refuses the next byte', async () => {
    const { user, ticket } = await userWithTicket()
    try {
      // The check is `used + incoming > quota`, measured on the file as
      // RECEIVED — an image shrinks in `normalizeImage` afterwards, so the
      // boundary has to be probed with the raw length, not the stored one.
      const planted = await plantRow(
        ticket.id,
        USER_STORAGE_QUOTA_BYTES - PNG_BYTES.length
      )

      // Exactly at the quota is still inside it. A limit that refuses its own
      // boundary would lock a user out one file early, and the error would tell
      // them to delete something they do not have.
      const stored = await upload(ticket.id, 'ровно-в-лимит.png')
      expect(stored.id).toBeTruthy()

      // One byte past it, and the same call is refused with the typed error.
      await prismaSupport.supportAttachment.update({
        where: { id: planted.id },
        data: { sizeBytes: planted.sizeBytes + 1 },
      })
      const err = await upload(ticket.id, 'на-байт-больше.png').catch(
        (e: unknown) => e
      )
      expect(err).toBeInstanceOf(AttachmentQuotaError)
      expect((err as AttachmentQuotaError).code).toBe('USER_STORAGE_QUOTA')

      // The refusal wrote nothing: the planted row plus the one upload that
      // was admitted, and no third.
      expect(await listAttachments(ticket.id)).toHaveLength(2)
    } finally {
      dropFiles(ticket.id)
      await cleanupTestUser(user.userId)
    }
  })

  it('does not charge the user for files an agent sent them', async () => {
    const { user, ticket } = await userWithTicket()
    try {
      await plantRow(ticket.id, USER_STORAGE_QUOTA_BYTES, true)

      // Support answering with ten screenshots must not lock the user out of
      // their own ticket.
      const stored = await upload(ticket.id)
      expect(stored.id).toBeTruthy()
    } finally {
      dropFiles(ticket.id)
      await cleanupTestUser(user.userId)
    }
  })

  it('lets the last upload inside the hourly rate through', async () => {
    const { user, ticket } = await userWithTicket()
    try {
      await prismaSupport.supportAttachment.createMany({
        data: Array.from({ length: UPLOAD_RATE_PER_HOUR - 1 }, () => ({
          ticketId: ticket.id,
          kind: 'IMAGE' as const,
          storagePath: `media/${ticket.id}/${randomUUID()}.webp`,
          fileName: 'planted.webp',
          mimeType: 'image/webp',
          sizeBytes: 1,
        })),
      })

      // The rate says "wait", so the Nth upload of the hour has to be the one
      // that still works — otherwise the cap is really N-1 and the message the
      // user gets is off by one file.
      const stored = await upload(ticket.id, 'последний-за-час.png')
      expect(stored.id).toBeTruthy()
    } finally {
      dropFiles(ticket.id)
      await cleanupTestUser(user.userId)
    }
  })

  it('refuses uploads past the hourly rate, before any bytes are decoded', async () => {
    const { user, ticket } = await userWithTicket()
    try {
      await prismaSupport.supportAttachment.createMany({
        data: Array.from({ length: UPLOAD_RATE_PER_HOUR }, () => ({
          ticketId: ticket.id,
          kind: 'IMAGE' as const,
          storagePath: `media/${ticket.id}/${randomUUID()}.webp`,
          fileName: 'planted.webp',
          mimeType: 'image/webp',
          sizeBytes: 1,
        })),
      })

      const err = await upload(ticket.id).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(AttachmentQuotaError)
      expect((err as AttachmentQuotaError).status).toBe(429)
      expect((err as AttachmentQuotaError).code).toBe('UPLOAD_RATE_LIMITED')

      const response = await uploadThroughRoute(user)
      expect(response.statusCode).toBe(429)
    } finally {
      dropFiles(ticket.id)
      await cleanupTestUser(user.userId)
    }
  })
})

describe('the disk guard', () => {
  it('refuses every upload once the volume is over quota', async () => {
    const { user, ticket } = await userWithTicket()
    try {
      await redisClient.set(
        STORAGE_USED_BYTES_KEY,
        String(STORAGE_QUOTA_BYTES + 1)
      )

      const err = await upload(ticket.id).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(AttachmentQuotaError)
      expect((err as AttachmentQuotaError).status).toBe(507)
      expect((err as AttachmentQuotaError).code).toBe('STORAGE_FULL')
      expect(await listAttachments(ticket.id)).toHaveLength(0)
    } finally {
      await redisClient.del(STORAGE_USED_BYTES_KEY)
      dropFiles(ticket.id)
      await cleanupTestUser(user.userId)
    }
  })

  it('seeds the counter cold, adds each upload, and re-anchors it on a pass', async () => {
    const { user, ticket } = await userWithTicket()
    try {
      // Cold Redis (a flush, a failover): the first upload has to seed the
      // counter from Postgres itself, or the guard stays blind until the next
      // pass an hour later.
      await redisClient.del(STORAGE_USED_BYTES_KEY)

      const first = await upload(ticket.id, 'первый.png')
      const seeded = Number(await redisClient.get(STORAGE_USED_BYTES_KEY))
      expect(seeded).toBeGreaterThanOrEqual(first.sizeBytes)

      const second = await upload(ticket.id, 'второй.png')
      expect(Number(await redisClient.get(STORAGE_USED_BYTES_KEY))).toBe(
        seeded + second.sizeBytes
      )

      // The pass is the only place the authoritative total is computed, so it
      // is also what corrects a counter that drifted.
      await redisClient.set(STORAGE_USED_BYTES_KEY, '999999999')
      await runRetentionPass()
      const truth = await prismaSupport.supportAttachment.aggregate({
        where: { purgedAt: null },
        _sum: { sizeBytes: true },
      })
      expect(Number(await redisClient.get(STORAGE_USED_BYTES_KEY))).toBe(
        truth._sum.sizeBytes ?? 0
      )
    } finally {
      dropFiles(ticket.id)
      await cleanupTestUser(user.userId)
    }
  })
})
