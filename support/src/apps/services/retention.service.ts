import fs from 'node:fs'
import path from 'node:path'

import { prismaSupport } from '@config/database'
import {
  FILE_RETENTION_DAYS,
  STORAGE_QUOTA_BYTES,
  SUPPORT_FILES_DIR,
} from '@config/env'
import { logger } from '@config/logger'
import { redisClient, supportKey } from '@config/redis'

import { resolveInsideRoot } from '@core/file-guard'

/**
 * Everything that keeps the shared support-files volume bounded.
 *
 * Two jobs, both about the same finite resource:
 *
 * 1. **Retention.** Attachment BYTES live FILE_RETENTION_DAYS and are then
 *    unlinked. The row is never deleted — the conversation has to keep showing
 *    that a file was sent, and its name — and Telegram keeps its own copy of
 *    every relayed file indefinitely, so support loses nothing it can act on.
 *    `purgedAt` is what turns the bubble into a "file removed" placeholder
 *    instead of a broken image (see `toAttachmentDto`).
 *
 * 2. **The disk guard.** `SUM(size_bytes)` over a growing table is not
 *    something an upload can afford to run, so the total lives in a Redis
 *    counter that uploads increment and each retention pass overwrites with
 *    the authoritative SQL total. Redis holds the fast answer; Postgres holds
 *    the truth.
 *
 * The counter drifts only downwards and only briefly: an INCRBY that lands
 * between the SUM and the SET of a pass is lost, and an upload that could not
 * reach Redis never incremented at all. Both are corrected by the next pass,
 * so the guard can be at most one pass late — never permanently blind.
 */

// Total non-purged bytes on the volume, as a decimal string. Under the house
// `binodex:support:` namespace like every other key this service writes.
export const STORAGE_USED_BYTES_KEY = supportKey('storage:used-bytes')

// Bounded batch, same reasoning as the inactivity sweeper: a backlog (the
// feature just shipped, or the worker was down for a day) drains over several
// passes instead of one burst of thousands of unlinks holding a Redis lock.
const PURGE_BATCH = 1000

// Operator avatars are PERMANENT — they are referenced by `SupportAgent`, not
// by an attachment row, and one aged-out avatar breaks every historical
// message that agent ever sent. This sweep is driven by the attachment table,
// where no avatar has a row, so the prefix check below can only ever fire on a
// corrupted `storage_path`; it is here so the exemption is a property of the
// code rather than of a table's current contents. Keep in step with
// `AGENTS_DIR` in attachment.service.ts.
const EXEMPT_PREFIX = 'agents/'

/** Authoritative total, straight from Postgres. */
async function sumStoredBytes(): Promise<number> {
  // Raw rather than `aggregate`: `SUM(int)` is a bigint in Postgres and the
  // total legitimately passes 2^31 (the default cap alone is 100 GB), so the
  // widening is made explicit here instead of trusted to the client's mapping
  // of an Int column.
  const rows = await prismaSupport.$queryRaw<{ total: bigint }[]>`
    SELECT COALESCE(SUM(size_bytes), 0)::bigint AS total
      FROM support_attachments
     WHERE purged_at IS NULL
  `
  return Number(rows[0]?.total ?? 0n)
}

/**
 * Add an accepted upload to the counter. Never throws.
 *
 * By the time this is called the bytes are on disk and the row is committed —
 * a Redis blip must not turn a successful upload into a failed one. The next
 * pass restores the exact total.
 */
export async function recordStoredBytes(sizeBytes: number): Promise<void> {
  try {
    await redisClient.incrby(STORAGE_USED_BYTES_KEY, sizeBytes)
  } catch (err) {
    logger.warn(
      `[retention] storage counter not updated: ${(err as Error).message}`
    )
  }
}

/**
 * Is the volume over SUPPORT_STORAGE_QUOTA? Asked before every upload.
 *
 * Fails OPEN. Redis is not on this service's critical path (the sweeper lock is
 * its only other user), and refusing every attachment on both sides of every
 * conversation because Redis blinked is a worse outage than the few hundred
 * megabytes that can land past the line before the next pass reports it.
 */
export async function isStorageFull(): Promise<boolean> {
  let used: number

  try {
    const raw = await redisClient.get(STORAGE_USED_BYTES_KEY)
    if (raw === null) {
      // Cold counter: fresh Redis, a FLUSHALL, a failover. Seed it from the
      // source of truth right here — waiting for the next pass would leave the
      // guard blind for an hour on exactly the deploy where somebody is
      // watching the disk.
      used = await sumStoredBytes()
      await redisClient.set(STORAGE_USED_BYTES_KEY, String(used))
    } else {
      used = Number(raw)
    }
  } catch (err) {
    logger.warn(
      `[retention] disk guard unavailable, allowing upload: ${(err as Error).message}`
    )
    return false
  }

  return Number.isFinite(used) && used > STORAGE_QUOTA_BYTES
}

/**
 * Unlink one attachment's bytes. Returns whether the row may now be stamped
 * `purgedAt`, i.e. whether the bytes are really gone.
 */
async function unlinkStored(storagePath: string, id: string): Promise<boolean> {
  if (storagePath.startsWith(EXEMPT_PREFIX)) {
    logger.error(
      `[retention] attachment ${id} points into the avatar subtree, refusing to purge: ${storagePath}`
    )
    return false
  }

  const absPath = resolveInsideRoot(SUPPORT_FILES_DIR, storagePath)
  if (!absPath) {
    // Same posture as `openAttachment`: a path that escapes the root is a
    // corrupted column, and deleting whatever it resolves to is the one
    // outcome worse than leaving the bytes in place.
    logger.error(
      `[retention] storage path escapes root, leaving attachment ${id} alone: ${storagePath}`
    )
    return false
  }

  try {
    await fs.promises.unlink(absPath)
  } catch (err) {
    // ENOENT is the goal state, not a failure: the file was removed by hand,
    // or by a pass that died between the unlink and the stamp below.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.error(
        `[retention] could not unlink ${storagePath}: ${(err as Error).message}`
      )
      return false
    }
  }

  await pruneTicketDir(storagePath, absPath)
  return true
}

/**
 * Drop `<subtree>/<ticketId>/` once its last file is gone.
 *
 * Without it the tree keeps one empty directory per ticket forever. That costs
 * no meaningful space, but after a year it is what turns a volume backup, an
 * `ls`, or a container restart that stats the tree into a minutes-long
 * operation.
 */
async function pruneTicketDir(
  storagePath: string,
  absPath: string
): Promise<void> {
  // Exactly `<subtree>/<ticketId>/<file>`. Anything shallower would ask rmdir
  // to remove `media/` or `docs/` themselves — and `media/` is a mount point
  // exchange's express.static holds open.
  if (storagePath.split('/').length !== 3) return

  try {
    await fs.promises.rmdir(path.dirname(absPath))
  } catch {
    // ENOTEMPTY (the ticket still has files) and ENOENT (a sibling pass got
    // there first) are both the normal case. Nothing about failing to remove
    // an empty directory is worth a log line.
  }
}

/** Unlink everything past the retention window. Returns how many rows moved. */
async function purgeExpired(): Promise<number> {
  const cutoff = new Date(Date.now() - FILE_RETENTION_DAYS * 86_400_000)

  // Hits `support_attachments_retention_idx`, which is partial on
  // `purged_at IS NULL` — so this scan shrinks back to nothing as files age
  // out instead of growing with the archive.
  const due = await prismaSupport.supportAttachment.findMany({
    where: { purgedAt: null, createdAt: { lt: cutoff } },
    select: { id: true, storagePath: true },
    orderBy: { createdAt: 'asc' },
    take: PURGE_BATCH,
  })
  if (!due.length) return 0

  const purgedIds: string[] = []
  for (const row of due) {
    if (await unlinkStored(row.storagePath, row.id)) purgedIds.push(row.id)
  }
  if (!purgedIds.length) return 0

  // One stamp for the whole batch. Dying between the unlinks and this update
  // is safe: the next pass selects the same rows and a missing file counts as
  // already purged, so the retry converges instead of erroring forever.
  await prismaSupport.supportAttachment.updateMany({
    where: { id: { in: purgedIds } },
    data: { purgedAt: new Date() },
  })

  return purgedIds.length
}

/**
 * One retention pass: age out expired bytes, then re-anchor the usage counter.
 *
 * Called by the worker loop under a Redis lock — see sweeper.service.ts.
 */
export async function runRetentionPass(): Promise<void> {
  const purged = await purgeExpired()

  // Unconditional, even when nothing was purged: this is the ONLY place the
  // authoritative total is computed, so it is also the only place a counter
  // that drifted (lost INCRBY, purges from an older build) is corrected.
  const total = await sumStoredBytes()
  try {
    await redisClient.set(STORAGE_USED_BYTES_KEY, String(total))
  } catch (err) {
    logger.warn(
      `[retention] storage counter not refreshed: ${(err as Error).message}`
    )
  }

  if (purged) {
    logger.info(
      `[retention] purged ${purged} attachment(s) older than ${FILE_RETENTION_DAYS}d`
    )
  }

  if (total > STORAGE_QUOTA_BYTES) {
    // Repeated every pass on purpose. Uploads are being refused platform-wide
    // and only a human can fix it (raise the cap, grow the volume, shorten
    // retention); one line an hour is the cheapest possible page, and a
    // fire-once log is the one that gets scrolled past.
    logger.error(
      `[retention] storage over quota: ${total} > ${STORAGE_QUOTA_BYTES} bytes — uploads are being refused`
    )
  }
}
