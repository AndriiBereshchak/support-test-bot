import { parse } from 'csv-parse/sync'
import { ApiError } from '@core/errors/api-error'
import { kbImportFields } from './kb.schema'
import type { ZhoraKbInput } from './kb.service'
import type { ZhoraKbConfigInput } from './kb-config.service'

type ZhoraKbFileEntry = Omit<ZhoraKbInput, 'code'> & { id?: string }
export type ZhoraKbImport =
  | ZhoraKbFileEntry[]
  | { entries: ZhoraKbFileEntry[]; config?: ZhoraKbConfigInput }

/** Called only after validating the complete file with kbImportSchema. */
export function normalizeZhoraKbImport(data: ZhoraKbImport): ZhoraKbInput[] {
  const fileEntries = Array.isArray(data) ? data : data.entries
  // Preserve source labels for operators; support still generates DB UUIDs.
  return fileEntries.map(({ id, ...entry }) => ({
    ...entry,
    ...(id !== undefined && { code: id }),
  }))
}

export function parseZhoraKbImport(
  content: string,
  format: '.json' | '.csv'
): unknown {
  if (format === '.json') {
    try {
      return JSON.parse(content.replace(/^\uFEFF/, ''))
    } catch {
      throw new ApiError('Invalid JSON file', 400, 'KB_IMPORT_INVALID')
    }
  }

  let rows: Record<string, string>[]
  try {
    rows = parse(content, {
      bom: true,
      skip_empty_lines: true,
      columns: (headers: string[]) => {
        if (
          new Set(headers).size !== headers.length ||
          headers.some((key) => !Object.hasOwn(kbImportFields, key))
        ) {
          throw new Error('Invalid CSV headers')
        }
        return headers
      },
    })
  } catch {
    throw new ApiError(
      'Invalid CSV file or column names',
      400,
      'KB_IMPORT_INVALID'
    )
  }
  return rows.map((row, index) => {
    const entry: Record<string, unknown> = { ...row }
    for (const key of [
      'variants',
      'translations',
      'domains',
      'notes',
      'dynamic_fields',
      'ask_user',
      'is_temporary',
    ]) {
      if (!row[key]?.trim()) {
        delete entry[key]
        continue
      }
      try {
        entry[key] = JSON.parse(row[key])
      } catch {
        throw new ApiError(
          `Record ${index + 1}: ${key} must contain valid JSON`,
          400,
          'KB_IMPORT_INVALID'
        )
      }
    }
    if (!row.id?.trim()) delete entry.id
    if (!row.status?.trim()) delete entry.status
    return entry
  })
}
