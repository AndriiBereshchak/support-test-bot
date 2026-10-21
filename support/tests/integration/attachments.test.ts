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

import { shutdownPrisma } from '@config/database'
import { SUPPORT_FILES_DIR } from '@config/env'

import {
  AttachmentRejectedError,
  openAttachment,
  stageUpload,
} from '@apps/services/attachment.service'
import { userSendMessage } from '@apps/services/chat.service'
import { toAttachmentDto } from '@apps/services/mappers'

import { buildApp } from '../../src/app'
import {
  DOCX_BYTES,
  EXE_BYTES,
  MP4_BYTES,
  PDF_BYTES,
  PNG_BYTES,
  ZIP_BYTES,
} from '../fixtures/bytes'
import {
  cleanupTestUser,
  createTestUser,
  listAttachments,
  openTicketOf,
} from './_helpers'

let app: FastifyInstance

beforeAll(async () => {
  app = buildApp()
  await app.ready()
})

afterAll(async () => {
  await app.close()
  await shutdownPrisma()
})

/** A user with an open ticket, ready to hang attachments off. */
async function userWithTicket() {
  const user = await createTestUser()
  await userSendMessage({
    userId: user.userId,
    userNId: user.userNId,
    text: 'прикладываю документ',
  })
  return { user, ticket: (await openTicketOf(user.userId))! }
}

/**
 * Both halves of the split layout: inline media lives under `media/` (the one
 * subtree exchange publishes statically) and documents under `docs/`.
 */
function dropFiles(ticketId: string): void {
  for (const subtree of ['media', 'docs']) {
    fs.rmSync(path.join(path.resolve(SUPPORT_FILES_DIR), subtree, ticketId), {
      recursive: true,
      force: true,
    })
  }
}

const rawUrl = (id: string, userId: string) =>
  `/v1/internal/attachments/${id}/raw?userId=${encodeURIComponent(userId)}`

describe('attachment ownership', () => {
  it("refuses to serve one user's file to another, indistinguishably from a miss", async () => {
    const a = await userWithTicket()
    const b = await userWithTicket()
    try {
      const attachment = await stageUpload({
        ticketId: a.ticket.id,
        fileName: 'счёт за март.png',
        mimeType: 'image/png',
        buffer: PNG_BYTES,
      })

      // The bytes landed, re-encoded through our own encoder (EXIF and any
      // GPS coordinates gone with it), under a generated name.
      expect(attachment.kind).toBe('IMAGE')
      expect(attachment.mimeType).toBe('image/webp')
      expect(attachment.fileName).toBe('счёт за март.webp')
      expect(attachment.storagePath.startsWith(`media/${a.ticket.id}/`)).toBe(
        true
      )
      expect(attachment.width).toBe(1)
      expect(attachment.height).toBe(1)
      // Staged: no message carries it yet, which is what lets the UI show a
      // thumbnail while the user is still typing.
      expect(attachment.messageId).toBeNull()

      // `openAttachment` is deliberately NOT an authorization boundary — it
      // answers "where are these bytes", and pinning that here is what stops
      // someone from later assuming it checks ownership.
      const opened = await openAttachment(attachment.id)
      expect(opened).not.toBeNull()
      expect(opened!.absPath.startsWith(path.resolve(SUPPORT_FILES_DIR))).toBe(
        true
      )

      // The route is the boundary. Another user's id: 404.
      const foreign = await app.inject({
        method: 'GET',
        url: rawUrl(attachment.id, b.user.userId),
      })
      expect(foreign.statusCode).toBe(404)

      // An id that belongs to nobody answers identically — even confirming
      // that an id exists leaks, these are receipts and identity documents.
      const missing = await app.inject({
        method: 'GET',
        url: rawUrl('00000000-0000-4000-8000-0000000000ff', b.user.userId),
      })
      expect(missing.statusCode).toBe(404)
      expect(missing.json()).toEqual(foreign.json())

      // The owner gets the bytes, with the headers that keep a browser from
      // second-guessing the stored type.
      const owner = await app.inject({
        method: 'GET',
        url: rawUrl(attachment.id, a.user.userId),
      })
      expect(owner.statusCode).toBe(200)
      expect(owner.headers['content-type']).toBe('image/webp')
      expect(owner.headers['x-content-type-options']).toBe('nosniff')
      expect(String(owner.headers['content-disposition'])).toContain('inline')
      expect(String(owner.headers['content-disposition'])).toContain(
        "filename*=UTF-8''"
      )
      expect(owner.rawPayload.length).toBe(
        Number(owner.headers['content-length'])
      )
      expect(owner.rawPayload.length).toBe(opened!.sizeBytes)
    } finally {
      dropFiles(a.ticket.id)
      dropFiles(b.ticket.id)
      await cleanupTestUser(a.user.userId)
      await cleanupTestUser(b.user.userId)
    }
  })

  it("will not bind another ticket's staged file to a message", async () => {
    const a = await userWithTicket()
    const b = await userWithTicket()
    try {
      const stolen = await stageUpload({
        ticketId: a.ticket.id,
        fileName: 'паспорт.png',
        mimeType: 'image/png',
        buffer: PNG_BYTES,
      })

      // User B sends a message naming user A's attachment id.
      await userSendMessage({
        userId: b.user.userId,
        userNId: b.user.userNId,
        text: 'вот файл',
        attachmentIds: [stolen.id],
      })

      // The bind is scoped to the sending ticket, so the row is untouched and
      // B's message carries nothing.
      const [row] = await listAttachments(a.ticket.id)
      expect(row!.id).toBe(stolen.id)
      expect(row!.messageId).toBeNull()
      expect(await listAttachments(b.ticket.id)).toHaveLength(0)
    } finally {
      dropFiles(a.ticket.id)
      dropFiles(b.ticket.id)
      await cleanupTestUser(a.user.userId)
      await cleanupTestUser(b.user.userId)
    }
  })
})

describe('what the upload pipeline stores', () => {
  it('takes a pdf byte-for-byte and refuses a disguised executable', async () => {
    const a = await userWithTicket()
    try {
      const pdf = await stageUpload({
        ticketId: a.ticket.id,
        fileName: 'выписка.pdf',
        mimeType: 'application/pdf',
        buffer: PDF_BYTES,
      })
      expect(pdf.kind).toBe('PDF')
      expect(pdf.sizeBytes).toBe(PDF_BYTES.length)

      // The declared mime type says image; the bytes say Windows executable.
      // The bytes win, and the caller gets a 400-shaped error rather than a
      // stored file.
      await expect(
        stageUpload({
          ticketId: a.ticket.id,
          fileName: 'скриншот.png',
          mimeType: 'image/png',
          buffer: EXE_BYTES,
        })
      ).rejects.toBeInstanceOf(AttachmentRejectedError)

      await expect(
        stageUpload({
          ticketId: a.ticket.id,
          fileName: 'документы.png',
          mimeType: 'image/png',
          buffer: ZIP_BYTES,
        })
      ).rejects.toBeInstanceOf(AttachmentRejectedError)

      // Only the pdf made it to disk — a rejection writes nothing.
      expect(await listAttachments(a.ticket.id)).toHaveLength(1)
    } finally {
      dropFiles(a.ticket.id)
      await cleanupTestUser(a.user.userId)
    }
  })

  it('stores a video untouched, and no video is ever decoded', async () => {
    const a = await userWithTicket()
    try {
      const video = await stageUpload({
        ticketId: a.ticket.id,
        fileName: 'экран.mov',
        mimeType: 'application/octet-stream',
        buffer: MP4_BYTES,
      })

      expect(video.kind).toBe('VIDEO')
      // The declared name says .mov, the bytes say mp4. The bytes win, and the
      // extension is rewritten to match them.
      expect(video.mimeType).toBe('video/mp4')
      expect(video.fileName).toBe('экран.mp4')
      // Byte-for-byte: nothing here transcodes, so a re-encode would only mean
      // sharp had been handed a video and thrown.
      expect(video.sizeBytes).toBe(MP4_BYTES.length)
      // No dimensions — there is no ffmpeg in the image to read them with, and
      // the browser learns them from the file itself.
      expect(video.width).toBeNull()
      expect(video.height).toBeNull()
    } finally {
      dropFiles(a.ticket.id)
      await cleanupTestUser(a.user.userId)
    }
  })
})

/**
 * Resolve a DTO url the way exchange's `express.static` mount does, or null
 * when the url is not under that mount at all.
 *
 * Modelled here rather than asserted as a string so the check is the one that
 * actually 404s in production: express strips the MOUNT PREFIX and resolves
 * what is left against `<SUPPORT_FILES_DIR>/media`. A url and a storage path
 * that each look right on their own but disagree by one segment — the classic
 * `media/` counted twice — produces a perfectly plausible URL pointing at a
 * file that does not exist.
 *
 * Keep both constants in step with the mount in exchange/src/app.ts.
 */
const EXCHANGE_MEDIA_MOUNT = '/support-files/media'
const EXCHANGE_MEDIA_ROOT = path.join(path.resolve(SUPPORT_FILES_DIR), 'media')

function servedByExchange(url: string): string | null {
  if (!url.startsWith(`${EXCHANGE_MEDIA_MOUNT}/`)) return null
  return path.join(EXCHANGE_MEDIA_ROOT, url.slice(EXCHANGE_MEDIA_MOUNT.length))
}

describe('inline media is published, documents are not', () => {
  it('splits the storage subtree and the URL by kind', async () => {
    const a = await userWithTicket()
    try {
      const image = await stageUpload({
        ticketId: a.ticket.id,
        fileName: 'скриншот.png',
        mimeType: 'image/png',
        buffer: PNG_BYTES,
      })
      const video = await stageUpload({
        ticketId: a.ticket.id,
        fileName: 'запись.mp4',
        mimeType: 'video/mp4',
        buffer: MP4_BYTES,
      })
      const pdf = await stageUpload({
        ticketId: a.ticket.id,
        fileName: 'паспорт.pdf',
        mimeType: 'application/pdf',
        buffer: PDF_BYTES,
      })
      const doc = await stageUpload({
        ticketId: a.ticket.id,
        fileName: 'договор.docx',
        mimeType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        buffer: DOCX_BYTES,
      })

      // THE invariant: exchange mounts `media/` and nothing else, so where a
      // file is written is what decides whether the world can read it. A
      // document under `media/` would be a published passport scan.
      for (const media of [image, video]) {
        expect(media.storagePath.startsWith(`media/${a.ticket.id}/`)).toBe(true)
        expect(toAttachmentDto(media).url).toBe(
          `/support-files/${media.storagePath}`
        )
      }

      for (const secret of [pdf, doc]) {
        expect(secret.storagePath.startsWith(`docs/${a.ticket.id}/`)).toBe(true)
        // Documents keep the authenticated route — which is also the only one
        // that names the download after the original file rather than a uuid.
        expect(toAttachmentDto(secret).url).toBe(
          `/v1/support-chat/files/${secret.id}`
        )
        expect(toAttachmentDto(secret).url).not.toContain('/support-files/')
        // And nothing wrote them where the static mount could reach them.
        expect(
          fs.existsSync(
            path.join(
              EXCHANGE_MEDIA_ROOT,
              a.ticket.id,
              path.basename(secret.storagePath)
            )
          )
        ).toBe(false)
      }
      expect(doc.kind).toBe('DOCUMENT')

      // The url is not just well-shaped — it addresses a file that is really
      // there, at the path exchange resolves it to. This is the check that
      // catches a mount prefix and a storage path drifting apart.
      for (const media of [image, video]) {
        const served = servedByExchange(toAttachmentDto(media).url)
        expect(served).not.toBeNull()
        expect(fs.existsSync(served!)).toBe(true)
        expect(fs.statSync(served!).size).toBe(media.sizeBytes)
      }

      // Video is stored byte-for-byte: the file on disk IS what was uploaded,
      // which is the whole reason it never goes near sharp.
      expect(
        fs.readFileSync(servedByExchange(toAttachmentDto(video).url)!)
      ).toEqual(MP4_BYTES)

      // The authenticated route still resolves media too: the split changes
      // which URL the DTO advertises, not what the owner may fetch.
      expect(await openAttachment(image.id)).not.toBeNull()
    } finally {
      dropFiles(a.ticket.id)
      await cleanupTestUser(a.user.userId)
    }
  })
})
