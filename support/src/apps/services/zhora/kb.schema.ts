export const kbText = { type: 'string', pattern: '\\S' } as const
const status = { type: 'string', enum: ['draft', 'active'] } as const
const texts = { type: 'array', items: kbText } as const
export const kbFields = {
  code: kbText,
  question: kbText,
  variants: texts,
  answer_ru: kbText,
  translations: {
    type: 'object',
    // RU is the master answer_ru field; translations may be incomplete.
    propertyNames: {
      enum: ['en', 'ua', 'de', 'es', 'fr', 'hi', 'tr', 'ar', 'cs', 'it'],
    },
    additionalProperties: kbText,
  },
  category: kbText,
  notes: texts,
  dynamic_fields: texts,
  ask_user: texts,
  is_temporary: { type: 'boolean' },
  domains: {
    type: 'array',
    items: {
      type: 'string',
      maxLength: 253,
      // Hostnames only: no URL scheme, path, port or wildcard.
      pattern:
        '^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z]{2,63}$',
    },
  },
  status,
} as const

// Imported file IDs become human-readable codes, not database UUIDs.
const { code: _code, ...kbContentFields } = kbFields
export const kbImportFields = { ...kbContentFields, id: kbText } as const
export const kbConfigFields = {
  full_version_url: kbText,
  ios_url: kbText,
  android_url: kbText,
} as const
export const kbConfigSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['full_version_url', 'ios_url', 'android_url'],
  properties: kbConfigFields,
} as const
export const MAX_KB_IMPORT_ENTRIES = 1000
const entries = {
  type: 'array',
  minItems: 1,
  maxItems: MAX_KB_IMPORT_ENTRIES,
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['question', 'answer_ru', 'category'],
    properties: kbImportFields,
  },
} as const
export const kbImportSchema = {
  anyOf: [
    entries,
    {
      type: 'object',
      // File metadata is ignored; only entries are imported.
      additionalProperties: true,
      required: ['entries'],
      properties: {
        entries,
        config: kbConfigSchema,
      },
    },
  ],
} as const
