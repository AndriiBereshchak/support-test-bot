export const kbText = { type: 'string', pattern: '\\S' } as const
const status = { type: 'string', enum: ['draft', 'active'] } as const
export const kbFields = {
  questions: { type: 'array', minItems: 1, items: kbText },
  answerRu: kbText,
  translations: {
    type: 'object',
    // RU is the master answerRu field; translations may be incomplete.
    propertyNames: {
      enum: ['en', 'ua', 'de', 'es', 'fr', 'hi', 'tr', 'ar', 'cs', 'it'],
    },
    additionalProperties: kbText,
  },
  tag: kbText,
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
