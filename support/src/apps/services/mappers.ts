import type {
  SupportAgent,
  SupportAttachment,
  SupportMessage,
  SupportTicket,
} from '@prisma-support'

import { isInlineMediaKind } from '@core/file-guard'

import type {
  SupportAgentDto,
  SupportAttachmentDto,
  SupportAttachmentKindDto,
  SupportDirection,
  SupportMessageDto,
  SupportTicketDto,
} from '@core/contracts'

// Documents are fetched through the exchange proxy, which checks that the
// caller owns the ticket before streaming bytes. PDFs and documents routinely
// carry payment receipts and identity papers, so unlike /avatars they are NOT
// public-by-obscurity — and that route is also the only one that sets
// Content-Disposition with the ORIGINAL file name, so a download does not land
// in the user's folder called `9f3c…-…-…​.pdf`.
const FILE_URL_PREFIX = '/v1/support-chat/files'

// Everything exchange publishes off the shared support-files volume. The
// subtree after it comes from `storagePath`, so these URLs cannot drift from
// what is on disk. Keep in step with the express.static mounts in
// exchange/src/app.ts.
const SUPPORT_FILES_URL_PREFIX = '/support-files'

// Agent avatars are non-sensitive and are served as plain static files by
// exchange off the shared volume, which is what makes them load on every
// mirror domain with no per-mirror nginx work.
const AGENT_AVATAR_URL_PREFIX = `${SUPPORT_FILES_URL_PREFIX}/agents`

/**
 * Inline media (images, video) points at the STATIC mount; documents keep the
 * authenticated stream.
 *
 * The split is not a micro-optimisation. `<video>` seeking is built on HTTP
 * Range requests, and the proxy route hands back a plain stream with no Range
 * support at all — through it a recording can only ever be played from the
 * start, and Safari refuses to start it. express.static answers Ranges, caches,
 * and never wakes the support service.
 *
 * What it costs, stated plainly: anyone holding the uuid URL can fetch that
 * image or video with no session. It is the same property /documents, /avatars
 * and /announcement-images already have on this platform, the path is two
 * unguessable uuids deep, and receipts and identity documents — the files where
 * this would actually matter — stay on the authenticated route.
 *
 * `purged` (the retention sweep unlinked the bytes) is what tells the UI to
 * render a "removed" placeholder. The url is STILL emitted next to it, for two
 * reasons: it is a required field of the contract, and an empty string in an
 * `src` is not a neutral value — the browser resolves `src=""` to the current
 * document and re-fetches the whole page. A url nobody is supposed to follow
 * is strictly safer than that, and it keeps an older FE build (one that
 * predates the flag) rendering a normal bubble with a broken thumbnail rather
 * than hammering the platform origin once per purged attachment.
 */
export function toAttachmentDto(row: SupportAttachment): SupportAttachmentDto {
  // A sticker is stored as an IMAGE (it is a .webp, and it has to stay inline
  // media so the static mount can serve it); the flag is what tells the client
  // to draw it bare.
  const kind = (
    row.isSticker ? 'sticker' : row.kind.toLowerCase()
  ) as SupportAttachmentKindDto
  const url = isInlineMediaKind(row.kind)
    ? `${SUPPORT_FILES_URL_PREFIX}/${row.storagePath}`
    : `${FILE_URL_PREFIX}/${row.id}`

  return {
    id: row.id,
    kind,
    name: row.fileName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    url,
    // Dimensions survive the purge on purpose: they cost nothing and let the
    // placeholder occupy exactly the space the image did, so a thread that
    // aged out does not reflow as it loads.
    ...(row.width != null ? { width: row.width } : {}),
    ...(row.height != null ? { height: row.height } : {}),
    // Absent rather than `false` for a live file — the flag is the exception,
    // and every byte of it crosses a NATS hop on every push.
    ...(row.purgedAt ? { purged: true } : {}),
  }
}

export function toAgentDto(row: SupportAgent): SupportAgentDto {
  return {
    id: row.id,
    name: row.displayName,
    ...(row.title ? { title: row.title } : {}),
    ...(row.avatarPath
      ? { avatarUrl: `${AGENT_AVATAR_URL_PREFIX}/${row.avatarPath}` }
      : {}),
  }
}

export function toMessageDto(
  row: SupportMessage & {
    attachments?: SupportAttachment[]
    agent?: SupportAgent | null
  }
): SupportMessageDto {
  return {
    id: row.id,
    ticketId: row.ticketId,
    seq: row.seq,
    direction: row.direction.toLowerCase() as SupportDirection,
    text: row.text,
    attachments: (row.attachments ?? []).map(toAttachmentDto),
    agent: row.agent ? toAgentDto(row.agent) : null,
    // One DTO field, two storage sources: the lifecycle enum for the grey
    // pills, and `autoKind` for support's automatic replies. They can never
    // both be set — a pill is a SYSTEM message, an auto reply is an OUT one.
    systemKind: (row.systemKind
      ? row.systemKind.toLowerCase()
      : (row.autoKind ?? null)) as SupportMessageDto['systemKind'],
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt ? row.editedAt.toISOString() : null,
  }
}

export function toTicketDto(row: SupportTicket): SupportTicketDto {
  return {
    id: row.id,
    status: row.status === 'OPEN' ? 'open' : 'closed',
    createdAt: row.createdAt.toISOString(),
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
    rating: row.rating ?? null,
    // No `unread` here on purpose: the badge is a per-USER total across every
    // ticket, and the push envelopes carry it as their own field. Hanging a
    // per-ticket copy off the ticket DTO gave the browser two numbers that
    // disagree the moment a closed ticket still holds unread replies.
  }
}
