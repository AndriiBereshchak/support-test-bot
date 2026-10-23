import { parse } from 'csv-parse/sync'
import { ApiError } from '@core/errors/api-error'
import { kbFields } from './kb.schema'

// A bounded initial import, not a streaming/synchronization system.
export const MAX_KB_IMPORT_ENTRIES = 1000

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
          headers.some((key) => !Object.hasOwn(kbFields, key))
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
    for (const key of ['questions', 'translations', 'domains']) {
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
    if (!row.status?.trim()) delete entry.status
    return entry
  })
}
