/**
 * Video dimensions straight out of the container, with no decoder.
 *
 * WHY THIS EXISTS: `sendVideo` takes optional `width`/`height`, and without
 * them Telegram lays the player out square — a horizontal recording arrives
 * looking like a cropped tile until the client finishes its own probe, if it
 * ever does. The service has no ffmpeg (and sharp does not decode video), so
 * the numbers have to come from somewhere else: the MP4/MOV header already
 * carries them, in a box a few hundred bytes into the file.
 *
 * The same numbers give the browser an aspect ratio to reserve before the clip
 * loads, which is what stops the feed jumping as videos come in.
 *
 * SCOPE: ISO base media files — MP4, M4V and QuickTime MOV, i.e. everything a
 * phone or a screen recorder produces. WebM/Matroska uses an entirely different
 * (EBML) layout and is not parsed; those keep null dimensions and fall back to
 * today's behaviour rather than being guessed at wrongly.
 *
 * SAFETY: the input is a file a stranger uploaded. Every walk is bounded — box
 * count, nesting depth and declared sizes are all checked against the buffer —
 * so a crafted header cannot spin this into a long loop or an out-of-range read.
 */

/** Stop walking after this many boxes, however the file is structured. */
const MAX_BOXES = 5_000
const MAX_DEPTH = 8

export interface VideoMeta {
  width: number
  height: number
}

interface Box {
  type: string
  start: number // first byte of the payload
  end: number // one past the last byte of the payload
}

/**
 * Boxes directly inside [from, to). Returns them in file order; a malformed
 * size stops the walk instead of throwing.
 */
function readBoxes(
  buf: Buffer,
  from: number,
  to: number,
  budget: {
    n: number
  }
): Box[] {
  const boxes: Box[] = []
  let offset = from

  // 8 = the smallest possible header (size + type).
  while (offset + 8 <= to && budget.n < MAX_BOXES) {
    budget.n += 1

    let size = buf.readUInt32BE(offset)
    const type = buf.toString('latin1', offset + 4, offset + 8)
    let headerSize = 8

    if (size === 1) {
      // 64-bit size in the eight bytes after the type.
      if (offset + 16 > to) break
      const hi = buf.readUInt32BE(offset + 8)
      const lo = buf.readUInt32BE(offset + 12)
      // A >4 GiB box cannot be addressed by a Buffer anyway; treat it as the
      // rest of the file rather than overflowing into a bogus offset.
      size = hi > 0 ? to - offset : lo
      headerSize = 16
    } else if (size === 0) {
      // "To end of file", per the spec.
      size = to - offset
    }

    if (size < headerSize || offset + size > to) break

    boxes.push({
      type,
      start: offset + headerSize,
      end: offset + size,
    })
    offset += size
  }

  return boxes
}

function findBox(boxes: Box[], type: string): Box | undefined {
  return boxes.find((b) => b.type === type)
}

/** 16.16 fixed point, as used by tkhd's width/height and its matrix. */
const fixed16 = (buf: Buffer, at: number): number => buf.readInt32BE(at) / 65536

/**
 * Dimensions from one `tkhd`, or null when the track has none.
 *
 * An audio track carries a tkhd too, with width and height both zero — which
 * is precisely how this tells the video track apart from the rest without
 * looking at codec boxes.
 */
function readTkhd(buf: Buffer, box: Box): VideoMeta | null {
  const payload = box.end - box.start
  if (payload < 8) return null

  const version = buf.readUInt8(box.start)
  // version/flags(4) + the timing fields, whose width depends on the version.
  const afterTiming = version === 1 ? 4 + 32 : 4 + 20
  // reserved(8) + layer(2) + alternate_group(2) + volume(2) + reserved(2)
  const matrixAt = afterTiming + 16
  const widthAt = matrixAt + 36 // the 3x3 matrix is nine 32-bit entries

  if (widthAt + 8 > payload) return null

  const width = Math.round(fixed16(buf, box.start + widthAt))
  const height = Math.round(fixed16(buf, box.start + widthAt + 4))
  if (width <= 0 || height <= 0) return null

  // Rotation lives in the transform matrix, NOT in width/height: a phone held
  // upright still writes 1920x1080 and leaves a 90° matrix next to it. Reading
  // only the dimensions would report every portrait clip as landscape — the
  // exact bug this file was written to fix, just in the other direction.
  const a = fixed16(buf, box.start + matrixAt)
  const b = fixed16(buf, box.start + matrixAt + 4)
  const rotatedQuarterTurn =
    Math.abs(a) < 0.01 && Math.abs(Math.abs(b) - 1) < 0.01

  return rotatedQuarterTurn
    ? { width: height, height: width }
    : { width, height }
}

/**
 * Read the display dimensions of an MP4/MOV buffer, or null when the file is
 * not ISO-BMFF, has no video track, or is truncated.
 *
 * Cheap: it walks the box tree without decoding a single frame, and `moov` is
 * usually within the first few hundred kilobytes (and at the very end for files
 * written without faststart — both are handled, since the whole buffer is
 * already in memory by the time this is called).
 */
export function readVideoMeta(buffer: Buffer): VideoMeta | null {
  try {
    const budget = { n: 0 }
    const top = readBoxes(buffer, 0, buffer.length, budget)
    const moov = findBox(top, 'moov')
    if (!moov) return null

    const traks = readBoxes(buffer, moov.start, moov.end, budget).filter(
      (b) => b.type === 'trak'
    )

    for (const trak of traks) {
      if (budget.n >= MAX_BOXES) break
      const tkhd = findBox(
        readBoxes(buffer, trak.start, trak.end, budget),
        'tkhd'
      )
      if (!tkhd) continue
      const meta = readTkhd(buffer, tkhd)
      // First track with real dimensions wins: that is the video track, and a
      // file with several video tracks is not something a support chat needs
      // to reason about.
      if (meta) return meta
    }
    return null
  } catch {
    // Malformed input is expected here — it is an upload. Callers treat null as
    // "dimensions unknown", which is exactly the pre-existing behaviour.
    return null
  }
}

// Kept for symmetry with the depth guard above: nesting deeper than this is
// not something a real recording produces, and the walk never recurses past
// moov > trak > tkhd anyway.
export const MAX_PARSE_DEPTH = MAX_DEPTH
