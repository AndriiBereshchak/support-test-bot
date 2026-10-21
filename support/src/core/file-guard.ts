import path from 'node:path'

/**
 * Content-based upload guard.
 *
 * Everything that reaches disk goes through `sniffFile` first. The rule the
 * whole module exists to enforce: **the bytes decide, the client never does.**
 * A declared `Content-Type` and a file extension are both attacker-controlled
 * (and, for Telegram, agent-controlled) — a `.pdf` that is really a Mach-O
 * binary must resolve to "Mach-O, rejected", not to "pdf, stored".
 *
 * Deliberately hand-rolled instead of pulling in `file-type`: that package is
 * ESM-only since v17 and this service compiles to CommonJS, so `require()` of
 * it fails at runtime — the failure would surface on the first upload, not at
 * boot. The format list here is small on purpose: it is the closed set of
 * things a support conversation legitimately carries, and anything outside it
 * is a rejection rather than a "best effort" store.
 *
 * No env, no fs, no logging. That keeps it unit-testable with nothing but a
 * Buffer, and lets `@telegram/*` reuse the path helpers without dragging an
 * app service into the dumb-wrapper layer.
 */

/** Mirrors the `SupportAttachmentKind` prisma enum (structurally identical). */
export type SupportFileKind = 'IMAGE' | 'PDF' | 'DOCUMENT' | 'VIDEO'

/**
 * The kinds a browser renders INSIDE the bubble, and the only ones exchange
 * publishes as static files off the shared volume.
 *
 * Lives here rather than next to either consumer because two of them must
 * agree byte for byte: `attachment.service` picks the on-disk subtree from it
 * (`media/` vs `docs/`) and `mappers` picks the URL shape from it. A file
 * stored under `media/` whose DTO points at the authenticated route is merely
 * slow; the reverse — a document written where the static mount can reach it —
 * publishes someone's passport.
 */
export function isInlineMediaKind(kind: SupportFileKind): boolean {
  return kind === 'IMAGE' || kind === 'VIDEO'
}

export interface SniffedFile {
  kind: SupportFileKind
  /** What the bytes actually are. Used for decisions and for reject logging. */
  sourceMimeType: string
  /**
   * What we store and later serve. Same as `sourceMimeType` for everything
   * except raster images, which are always re-encoded to webp — that is what
   * makes an iPhone HEIC renderable in a browser. Video is NOT normalized:
   * there is no ffmpeg in the image, so the container we received is the
   * container we serve.
   */
  storedMimeType: string
  /** Extension of the on-disk file, no leading dot. */
  ext: string
  /** True when sharp must decode + re-encode the bytes before they hit disk. */
  isRasterImage: boolean
}

// Only inspect a prefix when classifying text: a 20 MB log file does not need
// a full scan to be recognised as text, and the scan is O(n).
const TEXT_SAMPLE_BYTES = 64 * 1024

// ISO-BMFF brands that mean "still image". `ftyp` alone is not enough — mp4
// and mov share the box, so the BRAND is the whole discriminator, and this set
// is consulted BEFORE the video brands below. An iPhone photo is `heic`/`mif1`
// ISO-BMFF exactly like the video next to it in the camera roll; get the order
// wrong and every HEIC becomes an unplayable "video".
const HEIF_BRANDS = new Set([
  'heic',
  'heix',
  'heim',
  'heis',
  'hevc',
  'hevx',
  'hevm',
  'hevs',
  'heif',
  'mif1',
  'msf1',
  'avif',
  'avis',
])

/**
 * ISO-BMFF brands that mean "MP4-family video" — what a desktop export, a
 * WhatsApp forward or an Android camera produces.
 *
 * An allow-list, not "everything that is not HEIF": the same box also fronts
 * `M4A ` (audio), `M4P ` (DRM-wrapped audio) and `f4v`, none of which belong in
 * a support bubble. An unrecognised brand keeps the module's default answer,
 * which is a rejection.
 */
const MP4_BRANDS = new Set([
  'isom',
  'iso2',
  'iso4',
  'iso5',
  'iso6',
  'mp41',
  'mp42',
  'mp4v',
  'avc1',
  'dash',
  // .m4v, Apple's MP4 flavour. Four-byte brands are space-padded, hence 'M4V '.
  'M4V ',
  'M4VH',
  'M4VP',
])

// QuickTime .mov — what an iPhone records. Same box, its own brand and its own
// mime type; browsers play the common H.264/AAC case natively.
const QUICKTIME_BRAND = 'qt  '

const image = (sourceMimeType: string): SniffedFile => ({
  kind: 'IMAGE',
  sourceMimeType,
  // Every image is normalized to webp, so the stored type never varies.
  storedMimeType: 'image/webp',
  ext: 'webp',
  isRasterImage: true,
})

const asIs = (
  kind: SupportFileKind,
  mimeType: string,
  ext: string
): SniffedFile => ({
  kind,
  sourceMimeType: mimeType,
  storedMimeType: mimeType,
  ext,
  isRasterImage: false,
})

function startsWith(buf: Buffer, bytes: number[]): boolean {
  if (buf.length < bytes.length) return false
  return bytes.every((byte, i) => buf[i] === byte)
}

/** Latin-1 slice, or '' when the buffer is shorter than the window. */
function ascii(buf: Buffer, offset: number, length: number): string {
  if (buf.length < offset + length) return ''
  return buf.toString('latin1', offset, offset + length)
}

/**
 * Containers we refuse outright, ahead of any positive match.
 *
 * Fail-closed ordering matters: an executable whose first bytes happen to also
 * satisfy a looser positive test must never reach the allow path.
 */
function deniedContainer(buf: Buffer): boolean {
  // Executables. PE/MZ, ELF, and every Mach-O flavour incl. the fat headers
  // (0xCAFEBABE doubles as a Java class file — also unwanted).
  if (startsWith(buf, [0x4d, 0x5a])) return true // MZ: exe / dll / msi stub
  if (startsWith(buf, [0x7f, 0x45, 0x4c, 0x46])) return true // ELF
  if (startsWith(buf, [0xfe, 0xed, 0xfa, 0xce])) return true // Mach-O 32 BE
  if (startsWith(buf, [0xfe, 0xed, 0xfa, 0xcf])) return true // Mach-O 64 BE
  if (startsWith(buf, [0xce, 0xfa, 0xed, 0xfe])) return true // Mach-O 32 LE
  if (startsWith(buf, [0xcf, 0xfa, 0xed, 0xfe])) return true // Mach-O 64 LE
  if (startsWith(buf, [0xca, 0xfe, 0xba, 0xbe])) return true // fat / .class
  if (startsWith(buf, [0xca, 0xfe, 0xba, 0xbf])) return true // fat 64
  if (startsWith(buf, [0xbe, 0xba, 0xfe, 0xca])) return true // fat, byte-swapped
  // A shebang makes a plain-text file executable the moment it is chmod'd.
  if (startsWith(buf, [0x23, 0x21])) return true // "#!"

  // Archives. We never unpack anything, so an archive is a delivery vehicle we
  // cannot inspect — the user is asked to send the files themselves instead.
  if (startsWith(buf, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return true // rar
  if (startsWith(buf, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return true // 7z
  if (startsWith(buf, [0x1f, 0x8b])) return true // gzip
  if (startsWith(buf, [0x42, 0x5a, 0x68])) return true // bzip2
  if (startsWith(buf, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return true // xz
  if (ascii(buf, 257, 5) === 'ustar') return true // tar

  // OLE2 compound file. It is legacy .doc/.xls — and also .msi installers and
  // macro-bearing documents, which the format gives us no cheap way to tell
  // apart. Rejected wholesale; users re-save as docx/pdf, which we accept.
  if (startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return true
  }

  return false
}

/**
 * Distinguish an OOXML document from a plain zip.
 *
 * The first local file entry of an OOXML package is always
 * `[Content_Types].xml`; a generic archive's first entry is whatever the user
 * added first. That single check is what turns "zip" into an allow/deny
 * decision without unpacking anything.
 *
 * The part names below are stored uncompressed inside the local headers and
 * the central directory, so a substring search over the raw bytes identifies
 * the flavour without a zip reader.
 */
function sniffOoxml(buf: Buffer): SniffedFile | null {
  if (buf.length < 30) return null
  const nameLength = buf.readUInt16LE(26)
  if (ascii(buf, 30, nameLength) !== '[Content_Types].xml') return null

  // Macro-enabled packages (.docm/.xlsm) carry a VBA project. Same reasoning
  // as OLE2 above: we will not hand support staff a document that can run code.
  if (buf.includes('vbaProject.bin', 0, 'latin1')) return null

  if (buf.includes('word/document.xml', 0, 'latin1')) {
    return asIs(
      'DOCUMENT',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'docx'
    )
  }
  if (buf.includes('xl/workbook.xml', 0, 'latin1')) {
    return asIs(
      'DOCUMENT',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'xlsx'
    )
  }
  if (buf.includes('ppt/presentation.xml', 0, 'latin1')) {
    return asIs(
      'DOCUMENT',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'pptx'
    )
  }
  return null
}

/**
 * Drop a multi-byte sequence cut in half by the sample boundary, so a valid
 * UTF-8 file is not rejected for the accident of being longer than the sample.
 */
function trimIncompleteUtf8(sample: Buffer): Buffer {
  let end = sample.length
  // A 4-byte sequence is the worst case: at most 3 continuation bytes to skip
  // before the lead byte shows up.
  for (let i = 0; i < 4 && end > 0; i += 1) {
    const byte = sample[end - 1] as number
    if (byte < 0x80) return sample.subarray(0, end) // ASCII — nothing pending
    if ((byte & 0xc0) === 0xc0) return sample.subarray(0, end - 1) // lead byte
    end -= 1 // continuation byte — keep walking back
  }
  return sample.subarray(0, end)
}

/**
 * Last-resort classification: valid UTF-8 with no binary noise is text.
 *
 * There is no magic number for text, so this is the only place where the
 * absence of evidence is the evidence. The bar is deliberately strict (no NUL,
 * no stray control bytes, decodes as UTF-8) — everything that fails it stays
 * rejected rather than being stored as an opaque blob.
 *
 * The stored type is ALWAYS `text/plain`: an .svg or .html body sniffs as text
 * here, and pinning the served type is what keeps a browser from executing it.
 * (`text/csv` is the one refinement we take from the client — a subtype inside
 * a family we already proved, not a competing claim about the bytes.)
 */
function sniffText(
  buf: Buffer,
  declaredMimeType?: string | null
): SniffedFile | null {
  if (!buf.length) return null

  // A UTF-8 BOM is metadata, not content; keep it on disk, skip it for checks.
  const body = startsWith(buf, [0xef, 0xbb, 0xbf]) ? buf.subarray(3) : buf
  if (!body.length) return null

  let sample = body.subarray(0, TEXT_SAMPLE_BYTES)
  if (body.length > TEXT_SAMPLE_BYTES) sample = trimIncompleteUtf8(sample)

  for (const byte of sample) {
    // Allow HT/LF/VT/FF/CR (0x09-0x0d); reject NUL, the rest of C0, and DEL.
    // This is also what rules out UTF-16 — its ASCII range is half NUL bytes.
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20) || byte === 0x7f) {
      return null
    }
  }

  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample)
  } catch {
    return null
  }

  const isCsv = (declaredMimeType ?? '').toLowerCase().startsWith('text/csv')
  return isCsv
    ? asIs('DOCUMENT', 'text/csv', 'csv')
    : asIs('DOCUMENT', 'text/plain', 'txt')
}

/**
 * Classify a buffer, or return null when it is not something we accept.
 *
 * `declaredMimeType` is advisory only and is consulted for exactly one thing
 * (csv vs plain, both already proven to be text). Any disagreement between it
 * and the bytes resolves to the bytes.
 */
export function sniffFile(
  buffer: Buffer,
  declaredMimeType?: string | null
): SniffedFile | null {
  if (!buffer.length) return null
  if (deniedContainer(buffer)) return null

  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return image('image/jpeg')
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return image('image/png')
  }
  const gif = ascii(buffer, 0, 6)
  if (gif === 'GIF87a' || gif === 'GIF89a') return image('image/gif')
  if (ascii(buffer, 0, 4) === 'RIFF' && ascii(buffer, 8, 4) === 'WEBP') {
    return image('image/webp')
  }
  // ISO-BMFF. One box, two products: HEIC/AVIF stills and the whole MP4 video
  // family. Stills are matched FIRST — a generic "has an ftyp box, must be
  // video" branch would swallow every iPhone photo.
  if (ascii(buffer, 4, 4) === 'ftyp') {
    const brand = ascii(buffer, 8, 4)
    if (HEIF_BRANDS.has(brand)) {
      return image(brand.startsWith('avi') ? 'image/avif' : 'image/heic')
    }
    if (MP4_BRANDS.has(brand)) return asIs('VIDEO', 'video/mp4', 'mp4')
    if (brand === QUICKTIME_BRAND) {
      return asIs('VIDEO', 'video/quicktime', 'mov')
    }
    // Some other ISO-BMFF flavour: bare audio (`M4A `), DRM containers, f4v.
    // Not something a support conversation carries.
    return null
  }

  // WebM. The EBML header it is built on is Matroska's, and WebM is precisely
  // a Matroska profile — so the DocType string is not split out here: what
  // decides whether a browser plays the file is the codec pair inside it, not
  // those four letters. An audio-only .mka would land as a silent video bubble;
  // acceptable, and cheaper than parsing EBML elements to find out.
  if (startsWith(buffer, [0x1a, 0x45, 0xdf, 0xa3])) {
    return asIs('VIDEO', 'video/webm', 'webm')
  }

  if (ascii(buffer, 0, 5) === '%PDF-') {
    return asIs('PDF', 'application/pdf', 'pdf')
  }

  // Any zip flavour: OOXML gets through, a real archive does not.
  if (
    startsWith(buffer, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(buffer, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWith(buffer, [0x50, 0x4b, 0x07, 0x08])
  ) {
    return sniffOoxml(buffer)
  }

  return sniffText(buffer, declaredMimeType)
}

// ─── Display name ─────────────────────────────────────────────────────────

const MAX_STEM_LENGTH = 80

/**
 * Strip characters that make a rendered file name lie.
 *
 * Written as a codepoint scan rather than a regex class so the ranges stay
 * readable: C0 controls + DEL, the zero-width / LRM-RLM block, the bidi
 * embedding + override block, the bidi isolates, and a stray BOM.
 */
function stripDeceptiveChars(value: string): string {
  let out = ''
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) continue
    if (code >= 0x200b && code <= 0x200f) continue
    if (code >= 0x202a && code <= 0x202e) continue
    if (code >= 0x2066 && code <= 0x2069) continue
    if (code === 0xfeff) continue
    out += char
  }
  return out
}

/** No dotfiles, no trailing dot (Windows silently drops it), no edge spaces. */
const trimEdges = (value: string): string =>
  value.replace(/^[.\s]+|[.\s]+$/g, '')

/**
 * Turn a client-supplied name into something safe to store in a DB column and
 * echo back in a `Content-Disposition`.
 *
 * The result is NEVER used to build a filesystem path (on-disk names are
 * generated uuids) — this is purely about what a human sees and what lands in
 * their Downloads folder. Two things are load-bearing:
 *
 *   - the extension is replaced with the SNIFFED one, so `invoice.pdf.exe`
 *     cannot survive the round trip as something double-clickable. The cost is
 *     that a `.json` comes back as `.txt`; cosmetic, and worth it.
 *   - deceptive characters are stripped, because U+202E is the classic trick
 *     for rendering `photo<RLO>gnp.exe` as `photoexe.png` in a file listing.
 */
export function sanitizeFileName(raw: string, ext: string): string {
  // Some browsers hand over a full Windows path in the multipart filename.
  const base = raw.split(/[\\/]/).pop() ?? ''
  const cleaned = trimEdges(
    stripDeceptiveChars(base.replace(/\.[^.]*$/, '')).replace(/\s+/g, ' ')
  )

  // Truncate by CODE POINT, not by `slice`: cutting a surrogate pair in half
  // leaves a lone surrogate, which has no UTF-8 encoding and is rejected on
  // the way into Postgres. An emoji-heavy name is enough to hit it.
  // 80 code points also stays well inside the column's varchar(255).
  const stem = trimEdges(Array.from(cleaned).slice(0, MAX_STEM_LENGTH).join(''))

  return `${stem || 'file'}.${ext}`
}

// ─── Path containment ─────────────────────────────────────────────────────

/**
 * True when `absolutePath` is `root` itself or lives underneath it.
 *
 * Split out from `resolveInsideRoot` so a caller can re-check AFTER a
 * `realpath` — resolve() is pure string math and happily walks through a
 * symlink that points outside the storage root.
 */
export function isInsideRoot(root: string, absolutePath: string): boolean {
  const resolvedRoot = path.resolve(root)
  return (
    absolutePath === resolvedRoot ||
    absolutePath.startsWith(resolvedRoot + path.sep)
  )
}

/**
 * Join a stored relative path onto the storage root, or null when the result
 * escapes it. Every read of an attachment goes through here: a mangled or
 * hostile `storage_path` column must not be able to serve `/etc/passwd`.
 */
export function resolveInsideRoot(
  root: string,
  relativePath: string
): string | null {
  const resolvedRoot = path.resolve(root)
  const full = path.resolve(resolvedRoot, relativePath)
  return isInsideRoot(resolvedRoot, full) ? full : null
}
