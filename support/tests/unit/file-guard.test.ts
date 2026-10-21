import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  isInlineMediaKind,
  isInsideRoot,
  resolveInsideRoot,
  sanitizeFileName,
  sniffFile,
} from '@core/file-guard'

import {
  AVIF_BYTES,
  DOCM_BYTES,
  DOCX_BYTES,
  ELF_BYTES,
  EXE_BYTES,
  GZIP_BYTES,
  HEIC_BYTES,
  M4A_BYTES,
  MOV_BYTES,
  MP4_BYTES,
  PDF_BYTES,
  PNG_BYTES,
  SHEBANG_BYTES,
  TEXT_BYTES,
  WEBM_BYTES,
  ZIP_BYTES,
} from '../fixtures/bytes'

// Pure — no database, no filesystem, no env. The whole point of the module is
// that the BYTES decide, so every case below hands it bytes that disagree with
// what the client claimed.

describe('sniffFile — the declared type never wins', () => {
  it('rejects an archive renamed to a png, mime type and all', () => {
    // The exact attack the guard exists for: attacker picks the filename AND
    // the Content-Type, so agreeing with either is agreeing with the attacker.
    expect(sniffFile(ZIP_BYTES, 'image/png')).toBeNull()
    expect(sniffFile(GZIP_BYTES, 'image/png')).toBeNull()
  })

  it('rejects executables however they are labelled', () => {
    expect(sniffFile(EXE_BYTES, 'image/png')).toBeNull()
    expect(sniffFile(EXE_BYTES, 'application/pdf')).toBeNull()
    expect(sniffFile(ELF_BYTES, 'image/jpeg')).toBeNull()
    expect(sniffFile(SHEBANG_BYTES, 'text/plain')).toBeNull()
  })

  it('rejects a macro-bearing office package but takes the plain one', () => {
    expect(sniffFile(DOCM_BYTES)).toBeNull()
    expect(sniffFile(DOCX_BYTES)).toMatchObject({
      kind: 'DOCUMENT',
      ext: 'docx',
      isRasterImage: false,
    })
  })

  it('does not read an mp4 as an image just because it has an ftyp box', () => {
    // The brand is the whole discriminator, and the client insisting on
    // image/heic does not change it.
    expect(sniffFile(MP4_BYTES, 'image/heic')).toMatchObject({
      kind: 'VIDEO',
      storedMimeType: 'video/mp4',
      ext: 'mp4',
      isRasterImage: false,
    })
  })

  it('keeps HEIC and AVIF images even though they are ISO-BMFF like the video', () => {
    // The ordering bug this pins down: one `ftyp` box fronts both formats, so
    // a generic "has ftyp, must be video" branch turns every iPhone photo into
    // an unplayable video bubble.
    expect(sniffFile(HEIC_BYTES, 'video/mp4')).toMatchObject({
      kind: 'IMAGE',
      sourceMimeType: 'image/heic',
      // Re-encoded like every other image, which is what makes it renderable.
      storedMimeType: 'image/webp',
      isRasterImage: true,
    })
    // Same trap, the other still format — and the one whose brand decides the
    // source type on a prefix check, so it cannot ride on the HEIC case.
    expect(sniffFile(AVIF_BYTES, 'video/mp4')).toMatchObject({
      kind: 'IMAGE',
      sourceMimeType: 'image/avif',
      storedMimeType: 'image/webp',
      ext: 'webp',
      isRasterImage: true,
    })
  })

  it('routes only inline media to the published subtree', () => {
    // `isInlineMediaKind` is consulted twice from two different modules — the
    // service picks `media/` vs `docs/` from it and the mapper picks the URL
    // shape from it — so a document answering true here would not merely look
    // wrong, it would publish a passport scan through the static mount.
    expect(isInlineMediaKind('IMAGE')).toBe(true)
    expect(isInlineMediaKind('VIDEO')).toBe(true)
    expect(isInlineMediaKind('PDF')).toBe(false)
    expect(isInlineMediaKind('DOCUMENT')).toBe(false)
  })

  it('takes .mov and .webm, and still refuses ISO-BMFF audio', () => {
    expect(sniffFile(MOV_BYTES)).toMatchObject({
      kind: 'VIDEO',
      storedMimeType: 'video/quicktime',
      ext: 'mov',
      // Never handed to sharp: it is not an image decoder, and there is no
      // ffmpeg in the image to transcode with.
      isRasterImage: false,
    })
    expect(sniffFile(WEBM_BYTES)).toMatchObject({
      kind: 'VIDEO',
      storedMimeType: 'video/webm',
      ext: 'webm',
    })
    // The brand allow-list is fail-closed: an MP4 box carrying only audio is
    // not something a support conversation carries.
    expect(sniffFile(M4A_BYTES, 'video/mp4')).toBeNull()
  })

  it('accepts a real png and normalizes it to webp', () => {
    const sniffed = sniffFile(PNG_BYTES, 'application/octet-stream')
    expect(sniffed).toMatchObject({
      kind: 'IMAGE',
      sourceMimeType: 'image/png',
      // Everything raster is re-encoded, so the STORED type never varies —
      // that is what makes an iPhone HEIC renderable in a browser.
      storedMimeType: 'image/webp',
      ext: 'webp',
      isRasterImage: true,
    })
  })

  it('accepts a real pdf and stores it byte-for-byte', () => {
    expect(sniffFile(PDF_BYTES, 'application/x-evil')).toMatchObject({
      kind: 'PDF',
      storedMimeType: 'application/pdf',
      ext: 'pdf',
      isRasterImage: false,
    })
  })

  it('takes csv-vs-plain from the client, but only inside proven text', () => {
    expect(sniffFile(TEXT_BYTES)).toMatchObject({ ext: 'txt' })
    expect(sniffFile(TEXT_BYTES, 'text/csv')).toMatchObject({ ext: 'csv' })
    // The refinement does not promote non-text bytes.
    expect(sniffFile(ZIP_BYTES, 'text/csv')).toBeNull()
  })

  it('rejects an empty buffer', () => {
    expect(sniffFile(Buffer.alloc(0), 'image/png')).toBeNull()
  })
})

describe('sanitizeFileName', () => {
  it('forces the sniffed extension so a double extension cannot survive', () => {
    expect(sanitizeFileName('invoice.pdf.exe', 'pdf')).toBe('invoice.pdf.pdf')
  })

  it('strips the bidi override that fakes an extension in a file listing', () => {
    expect(sanitizeFileName('photo\u202Egnp.exe', 'webp')).toBe('photognp.webp')
  })

  it('keeps only the base name of a full windows path', () => {
    expect(sanitizeFileName('C:\\Users\\ivan\\чек.png', 'webp')).toBe(
      'чек.webp'
    )
  })

  it('never returns a nameless file', () => {
    expect(sanitizeFileName('   ', 'pdf')).toBe('file.pdf')
    expect(sanitizeFileName('.....', 'pdf')).toBe('file.pdf')
  })
})

describe('path containment', () => {
  const root = path.resolve('/srv/support-files')

  it('resolves a stored relative path under the root', () => {
    expect(resolveInsideRoot(root, 'ticket/abc.webp')).toBe(
      path.join(root, 'ticket', 'abc.webp')
    )
  })

  it('refuses anything that climbs out', () => {
    expect(resolveInsideRoot(root, '../../etc/passwd')).toBeNull()
    expect(resolveInsideRoot(root, '/etc/passwd')).toBeNull()
  })

  it('does not treat a sibling directory as inside the root', () => {
    // The classic prefix bug: `/srv/support-files-public` starts with the root
    // string but is a different directory.
    expect(isInsideRoot(root, `${root}-public/leak.pdf`)).toBe(false)
    expect(isInsideRoot(root, path.join(root, 'ok.pdf'))).toBe(true)
  })
})
