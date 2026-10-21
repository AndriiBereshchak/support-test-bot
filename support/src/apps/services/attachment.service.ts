import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import sharp from 'sharp'

import type { SupportAttachment } from '@prisma-support'

import { prismaSupport } from '@config/database'
import {
  MAX_UPLOAD_BYTES,
  SUPPORT_FILES_DIR,
  UPLOAD_RATE_PER_HOUR,
  USER_STORAGE_QUOTA_BYTES,
} from '@config/env'
import { logger } from '@config/logger'

import {
  isInlineMediaKind,
  isInsideRoot,
  resolveInsideRoot,
  sanitizeFileName,
  sniffFile,
  type SniffedFile,
} from '@core/file-guard'
import { readVideoMeta } from '@core/video-meta'

import { downloadFile } from '@telegram/api'

import { isStorageFull, recordStoredBytes } from './retention.service'

/**
 * Attachment storage for both directions of the conversation.
 *
 * Two invariants hold everywhere below.
 *
 * 1. **The on-disk name is always a generated uuid.** The name the user typed
 *    lives in a DB column and is used for display and for the download header,
 *    never to build a path. Combined with the `resolveInsideRoot` containment
 *    check on every read, a hostile name — or a corrupted `storage_path`
 *    column — cannot address anything outside SUPPORT_FILES_DIR.
 * 2. **The bytes are classified before they are trusted.** `sniffFile` decides
 *    what a file is; the declared mime type and the extension are discarded.
 *    Images are additionally re-encoded, so what lands on disk is output from
 *    our own encoder rather than a stranger's file format.
 * 3. **The first path segment is an access class.** Inline media goes to
 *    `media/`, everything else to `docs/`, and exchange mounts `media/` — and
 *    only `media/` — as static files. The layout IS the access control for the
 *    static door, so nothing may write a document into the media subtree.
 *
 * Write ordering is bytes-then-row. A file with no row is invisible garbage
 * that a future sweeper can collect; a row with no file is a broken bubble the
 * user stares at forever.
 */

// Images are shown inline in a chat bubble and are mostly screenshots — 2048px
// keeps small text legible while capping a 48MP phone photo at ~200KB of webp.
const IMAGE_MAX_DIM = 2048
const IMAGE_QUALITY = 82
// Agent avatars render at ~32px in the bubble; anything larger is wasted bytes
// on a file that is fetched on every page load.
const AVATAR_SIZE = 128
const AVATAR_QUALITY = 85
// Hard wall-clock cap on the decode pipeline, so no single upload can pin the
// event loop. A real photo finishes in tens of ms; this only trips on
// pathological input.
const SHARP_TIMEOUT_SECONDS = 15
// Cap decoded pixels so a small-but-bomb file cannot blow up memory.
const DECODE_PIXEL_LIMIT = 100_000_000

// Three sibling subtrees under SUPPORT_FILES_DIR, split by who may read them:
//
//   media/  — images and video. Published by exchange with express.static, so
//             the browser gets cache headers and, decisively, Range support:
//             `<video>` cannot seek through a proxied stream.
//   docs/   — PDFs and documents. NEVER mounted; the only way out is the
//             authenticated /v1/support-chat/files/:id route, which checks that
//             the caller owns the ticket first. These are payment receipts and
//             identity documents.
//   agents/ — operator avatars, mounted separately and unchanged.
//
// Keep `media` in step with the mount path in exchange's app.ts and with
// SUPPORT_FILES_URL_PREFIX in mappers.ts. Renaming it here without renaming it
// there breaks every image link; renaming `docs` to something already mounted
// publishes the documents.
const MEDIA_DIR = 'media'
const DOCS_DIR = 'docs'
const AGENTS_DIR = 'agents'

// `ticketId` and attachment ids become path segments / row lookups. They come
// from our own DB today, but a route handler will eventually pass one straight
// from a request body — validate rather than rely on that staying true.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A file we refuse to store. Distinct from an infrastructure failure on
 * purpose: the HTTP route turns this into a 400 the user can act on, while
 * anything else stays a 500.
 */
export class AttachmentRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AttachmentRejectedError'
  }
}

/**
 * A file refused because of a LIMIT rather than its contents — the user is over
 * quota, uploading too fast, or the volume itself is full.
 *
 * Carries its own status so the route does not have to re-derive one, and
 * extends `AttachmentRejectedError` deliberately: every existing handler
 * already degrades it to a 400 the user can read, instead of letting a new
 * error class fall through to a 500 and page the on-call over an anti-spam
 * rule doing its job.
 */
export class AttachmentQuotaError extends AttachmentRejectedError {
  public readonly status: number
  public readonly code: string

  constructor(message: string, status: number, code: string) {
    super(message)
    this.name = 'AttachmentQuotaError'
    this.status = status
    this.code = code
  }
}

/** First bytes in hex — enough to identify a rejected format from the log. */
const headHex = (buffer: Buffer): string =>
  buffer.subarray(0, 8).toString('hex')

/**
 * Decode, strip metadata, downscale, re-encode as webp.
 *
 * `.rotate()` with no argument applies the EXIF orientation and then drops all
 * metadata, GPS included. That is a privacy requirement, not an optimisation:
 * users photograph documents with their phones and would otherwise hand
 * support their home coordinates along with the receipt.
 */
async function normalizeImage(
  buffer: Buffer
): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(buffer, {
    // Tolerate the minor warnings phone exports carry, but still abort on
    // truncated / corrupt bytes. With failOn:'none' libvips will chew on
    // garbage indefinitely and the decode never returns.
    failOn: 'error',
    limitInputPixels: DECODE_PIXEL_LIMIT,
    // First frame only. An animated GIF or a screen recording would otherwise
    // re-encode into a multi-megabyte animated webp for no support value.
    animated: false,
  })
    .timeout({ seconds: SHARP_TIMEOUT_SECONDS })
    .rotate()
    // `inside` (not `cover`): a screenshot cropped to a square is useless.
    .resize(IMAGE_MAX_DIM, IMAGE_MAX_DIM, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: IMAGE_QUALITY })
    .toBuffer({ resolveWithObject: true })

  return { data, width: info.width, height: info.height }
}

interface IngestInput {
  ticketId: string
  fileName: string
  mimeType?: string | null
  buffer: Buffer
  tgFileId?: string | null
  uploadedByAgent: boolean
  /**
   * Mark the row as a Telegram sticker.
   *
   * Only Telegram can know: the file is a plain .webp and sniffing it can never
   * answer anything but IMAGE. The stored `kind` STAYS `IMAGE` — that is what
   * keeps it inline media, served off the static mount — and this flag only
   * changes how the client draws it.
   */
  isSticker?: boolean
}

/**
 * Per-user admission control: is this person allowed to store another file?
 *
 * Two limits in ONE query, both scoped through the ticket to the user who owns
 * it — never to a caller-supplied id, so there is no argument a route could get
 * wrong that would measure the wrong person's usage.
 *
 * Agent uploads are excluded from both sums. The limits exist to shape what a
 * USER can push onto the volume; counting the screenshots an operator sent them
 * would let support lock a user out of their own ticket, and would blame the
 * user for it in the error.
 *
 * `incomingBytes` is the file as RECEIVED — an image shrinks in
 * `normalizeImage` afterwards, so the check errs towards refusing slightly
 * early rather than admitting bytes it cannot account for.
 */
async function assertWithinUserQuota(
  ticketId: string,
  incomingBytes: number
): Promise<void> {
  const rows = await prismaSupport.$queryRaw<
    { used_bytes: bigint; recent_uploads: bigint }[]
  >`
    SELECT
      COALESCE(SUM(a.size_bytes) FILTER (
        WHERE a.purged_at IS NULL AND NOT a.uploaded_by_agent
      ), 0)::bigint AS used_bytes,
      COUNT(*) FILTER (
        WHERE a.created_at > now() - interval '1 hour' AND NOT a.uploaded_by_agent
      )::bigint AS recent_uploads
      FROM support_attachments a
      JOIN support_tickets t ON t.id = a.ticket_id
     WHERE t.user_id = (SELECT user_id FROM support_tickets WHERE id = ${ticketId}::uuid)
  `

  const used = Number(rows[0]?.used_bytes ?? 0n)
  const recent = Number(rows[0]?.recent_uploads ?? 0n)

  // Rate first: it is the limit a script trips, and it says "wait", while the
  // quota says "delete something" — reporting the wrong one sends the user off
  // to fix the wrong thing.
  if (recent >= UPLOAD_RATE_PER_HOUR) {
    throw new AttachmentQuotaError(
      `upload rate limit reached: ${recent} uploads in the last hour`,
      429,
      'UPLOAD_RATE_LIMITED'
    )
  }
  if (used + incomingBytes > USER_STORAGE_QUOTA_BYTES) {
    throw new AttachmentQuotaError(
      `attachment quota exceeded: ${used} + ${incomingBytes} > ${USER_STORAGE_QUOTA_BYTES} bytes`,
      413,
      'USER_STORAGE_QUOTA'
    )
  }
}

/**
 * The single pipeline both entry points share: validate, normalize, persist.
 *
 * Throws `AttachmentRejectedError` for anything the user could fix (too big,
 * wrong type, undecodable image) and a plain error for infrastructure trouble.
 */
async function ingest(input: IngestInput): Promise<SupportAttachment> {
  const { ticketId, fileName, mimeType = null, buffer } = input

  if (!UUID_RE.test(ticketId)) {
    throw new Error(`[attachment] refusing non-uuid ticket id: ${ticketId}`)
  }
  if (!buffer.length) {
    throw new AttachmentRejectedError('empty file')
  }
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new AttachmentRejectedError(
      `file too large: ${buffer.length} > ${MAX_UPLOAD_BYTES} bytes`
    )
  }

  // Layers ON TOP of the per-file cap, cheapest first and both BEFORE the
  // decode: a file we are not going to keep must not cost a sharp round trip.
  //
  // The disk guard covers EVERY path including the Telegram relay — a full
  // volume is shared with exchange, and one undelivered attachment (the agent
  // is told, and Telegram still holds the file) is cheaper than a host that
  // can no longer write.
  if (await isStorageFull()) {
    throw new AttachmentQuotaError(
      'attachment storage is full',
      507,
      'STORAGE_FULL'
    )
  }
  if (!input.uploadedByAgent) {
    await assertWithinUserQuota(ticketId, buffer.length)
  }

  const sniffed: SniffedFile | null = sniffFile(buffer, mimeType)
  if (!sniffed) {
    logger.warn(
      `[attachment] rejected file on ticket ${ticketId}: declared=${
        mimeType ?? 'none'
      } head=${headHex(buffer)}`
    )
    throw new AttachmentRejectedError('file type not allowed')
  }

  let bytes = buffer
  let width: number | null = null
  let height: number | null = null

  if (sniffed.isRasterImage) {
    try {
      const normalized = await normalizeImage(buffer)
      bytes = normalized.data
      width = normalized.width
      height = normalized.height
    } catch (err) {
      // The magic bytes matched but the decoder disagreed — truncated upload,
      // an unsupported HEIC profile, or a decompression bomb hitting a limit.
      throw new AttachmentRejectedError(
        `image could not be processed: ${(err as Error).message}`
      )
    }
  }

  // Everything that is not a raster image — PDFs, documents AND video — is
  // stored byte-for-byte.
  //
  // Video is never handed to sharp: it is not an image decoder, so it would
  // throw on the first frame, and there is no ffmpeg in the runtime image to
  // transcode with. Its dimensions are READ FROM THE CONTAINER instead of
  // decoded — `sendVideo` lays the player out square without width/height, so
  // a horizontal recording reaches the operator looking cropped, and the
  // browser has nothing to reserve space with either.
  //
  // The cost of storing the container untouched is that its metadata survives —
  // unlike images, where the sharp round-trip is what strips EXIF GPS. Accepted
  // knowingly: transcoding is not available here, and the alternative was
  // refusing video altogether.
  if (sniffed.kind === 'VIDEO') {
    const meta = readVideoMeta(buffer)
    if (meta) {
      width = meta.width
      height = meta.height
    }
  }

  // A sticker claim is only honoured for something the guard already accepted
  // as a raster image, so it can never relabel a document or a video.
  const isSticker = input.isSticker === true && sniffed.isRasterImage

  const subtree = isInlineMediaKind(sniffed.kind) ? MEDIA_DIR : DOCS_DIR
  const storagePath = `${subtree}/${ticketId}/${randomUUID()}.${sniffed.ext}`
  const absPath = resolveInsideRoot(SUPPORT_FILES_DIR, storagePath)
  if (!absPath) {
    throw new Error(`[attachment] path escapes storage root: ${storagePath}`)
  }

  await fs.promises.mkdir(path.dirname(absPath), { recursive: true })
  await fs.promises.writeFile(absPath, bytes)

  let row: SupportAttachment
  try {
    row = await prismaSupport.supportAttachment.create({
      data: {
        ticketId,
        kind: sniffed.kind,
        isSticker,
        storagePath,
        fileName: sanitizeFileName(fileName, sniffed.ext),
        mimeType: sniffed.storedMimeType,
        sizeBytes: bytes.length,
        width,
        height,
        tgFileId: input.tgFileId ?? null,
        uploadedByAgent: input.uploadedByAgent,
      },
    })
  } catch (err) {
    // No row means nothing will ever reference these bytes — drop them rather
    // than leave the volume growing with unreachable files.
    await fs.promises.unlink(absPath).catch(() => undefined)
    throw err
  }

  // The disk guard reads a counter instead of summing a growing table, so
  // every accepted upload has to add itself to it. After the row, never
  // before: bytes counted for a file that failed to persist would drift the
  // guard upwards until the next retention pass. Never throws.
  await recordStoredBytes(bytes.length)

  return row
}

export interface StageUploadInput {
  ticketId: string
  fileName: string
  mimeType: string
  buffer: Buffer
}

/**
 * Store a file the user picked in the chat window, BEFORE the message that
 * carries it exists.
 *
 * The row lands with `messageId = null` (staged); `appendMessage` binds it when
 * the send actually happens, scoped to the same ticket. That two-step is what
 * lets the UI show an upload progress bar and a thumbnail while the user is
 * still typing.
 */
export async function stageUpload(
  args: StageUploadInput
): Promise<SupportAttachment> {
  return ingest({ ...args, uploadedByAgent: false })
}

export interface SaveTelegramFileInput {
  ticketId: string
  fileId: string
  fileName: string
  mimeType?: string | null
  sizeBytes: number
  uploadedByAgent: boolean
  /** See `IngestInput.isSticker`. */
  isSticker?: boolean
}

/**
 * Pull a file an agent posted in the Telegram topic onto our own storage.
 *
 * Returns null instead of throwing on every rejection path. The relay is
 * mid-flight through a webhook Telegram will retry: a throw here would either
 * lose the agent's accompanying text or replay the whole update. Null lets the
 * caller post the message with a "file skipped" note, which is the outcome
 * support can actually act on.
 */
export async function saveTelegramFile(
  args: SaveTelegramFileInput
): Promise<SupportAttachment | null> {
  const { ticketId, fileId, fileName, mimeType = null, sizeBytes } = args

  // Telegram tells us the size up front, so an oversized file costs no
  // bandwidth at all. (Bot downloads are capped at 20 MB on their side too.)
  if (sizeBytes > MAX_UPLOAD_BYTES) {
    logger.warn(
      `[attachment] telegram file ${fileId} skipped on ticket ${ticketId}: ` +
        `${sizeBytes} > ${MAX_UPLOAD_BYTES} bytes`
    )
    return null
  }

  let downloaded: Awaited<ReturnType<typeof downloadFile>> = null
  try {
    downloaded = await downloadFile(fileId)
  } catch (err) {
    logger.warn(
      `[attachment] telegram download failed for ${fileId}: ${
        (err as Error).message
      }`
    )
    return null
  }
  if (!downloaded?.buffer.length) {
    // `downloadFile` already logged the specific reason (no file_path, over
    // its own cap, HTTP error) — do not re-log the fileId as a second warning.
    return null
  }

  try {
    return await ingest({
      ticketId,
      fileName,
      mimeType,
      buffer: downloaded.buffer,
      tgFileId: fileId,
      uploadedByAgent: args.uploadedByAgent,
      isSticker: args.isSticker === true,
    })
  } catch (err) {
    logger.warn(
      `[attachment] telegram file ${fileId} skipped on ticket ${ticketId}: ${
        (err as Error).message
      }`
    )
    return null
  }
}

export interface OpenedAttachment {
  absPath: string
  mimeType: string
  fileName: string
  sizeBytes: number
}

/**
 * Resolve an attachment to something a route can stream.
 *
 * Deliberately NOT an authorization boundary — it answers "where are these
 * bytes", not "may you have them". The caller MUST check that the requesting
 * user owns `row.ticketId` first; support attachments routinely carry payment
 * receipts and identity documents, so an id alone is not an access grant.
 */
export async function openAttachment(
  id: string
): Promise<OpenedAttachment | null> {
  if (!UUID_RE.test(id)) return null

  const row = await prismaSupport.supportAttachment.findUnique({
    where: { id },
  })
  if (!row) return null
  // Aged out by the retention sweep. Answering here rather than letting the
  // stat below fail keeps the caller's 404 identical while dropping a
  // "file missing" warning that is neither missing nor a problem — every
  // stale link to a purged file would otherwise log one.
  if (row.purgedAt) return null

  const absPath = resolveInsideRoot(SUPPORT_FILES_DIR, row.storagePath)
  if (!absPath) {
    logger.error(
      `[attachment] storage path escapes root, refusing to serve ${id}: ${row.storagePath}`
    )
    return null
  }

  try {
    // resolve() is string math; realpath is what catches a symlink planted in
    // the storage directory pointing at something we would never serve.
    const realPath = await fs.promises.realpath(absPath)
    if (!isInsideRoot(SUPPORT_FILES_DIR, realPath)) {
      logger.error(`[attachment] symlink escapes root, refusing to serve ${id}`)
      return null
    }

    const stat = await fs.promises.stat(realPath)
    if (!stat.isFile()) return null

    return {
      absPath: realPath,
      mimeType: row.mimeType,
      fileName: row.fileName,
      // From the filesystem, not the row: Content-Length has to match the
      // bytes actually on disk or the transfer stalls.
      sizeBytes: stat.size,
    }
  } catch (err) {
    logger.warn(
      `[attachment] file missing for ${id} (${row.storagePath}): ${
        (err as Error).message
      }`
    )
    return null
  }
}

/**
 * Store an operator's avatar and return the file name to put in
 * `SupportAgent.avatarPath`.
 *
 * These are the one class of file exchange serves as plain static assets (that
 * is what makes them load on every mirror domain with no per-mirror nginx
 * work), so they are re-encoded through our own encoder and squared down to a
 * thumbnail — nothing sensitive can survive the round trip, EXIF included.
 *
 * They are also the one subtree the retention sweep never touches: an avatar
 * aged out at 7 days would break every historical message that agent ever
 * sent. See `EXEMPT_PREFIX` in retention.service.ts.
 *
 * Writing the DB row is the caller's job: the bot command that sets an avatar
 * also has to clear the previous one.
 */
export async function saveAgentAvatar(
  tgUserId: number,
  buffer: Buffer
): Promise<string> {
  if (!buffer.length) throw new AttachmentRejectedError('empty avatar')
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new AttachmentRejectedError('avatar too large')
  }

  const sniffed = sniffFile(buffer)
  if (!sniffed?.isRasterImage) {
    logger.warn(
      `[attachment] rejected avatar from tg user ${tgUserId}: head=${headHex(
        buffer
      )}`
    )
    throw new AttachmentRejectedError('avatar must be an image')
  }

  let processed: Buffer
  try {
    processed = await sharp(buffer, {
      failOn: 'error',
      limitInputPixels: DECODE_PIXEL_LIMIT,
      animated: false,
    })
      .timeout({ seconds: SHARP_TIMEOUT_SECONDS })
      .rotate()
      .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover', position: 'centre' })
      .webp({ quality: AVATAR_QUALITY })
      .toBuffer()
  } catch (err) {
    throw new AttachmentRejectedError(
      `avatar could not be processed: ${(err as Error).message}`
    )
  }

  const fileName = `${randomUUID()}.webp`
  const absPath = resolveInsideRoot(
    SUPPORT_FILES_DIR,
    `${AGENTS_DIR}/${fileName}`
  )
  if (!absPath) {
    throw new Error('[attachment] avatar path escapes storage root')
  }

  await fs.promises.mkdir(path.dirname(absPath), { recursive: true })
  await fs.promises.writeFile(absPath, processed)

  logger.debug(`[attachment] stored avatar ${fileName} for tg user ${tgUserId}`)
  return fileName
}
