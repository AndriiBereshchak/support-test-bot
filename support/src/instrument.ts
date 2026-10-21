/* eslint-disable no-console --
 * This file runs BEFORE anything else (Sentry must instrument the runtime
 * before the app's modules load), so it cannot import `@config/logger` —
 * pulling winston in here would load it outside Sentry's instrumentation.
 * Two boot lines on stdout is the whole cost.
 */
import { scrubSentryBreadcrumb, scrubSentryEvent } from '@binodex/shared'
import * as Sentry from '@sentry/node'

// NOTE: this is the very first import in server.ts (Sentry must init before the
// libraries it instruments are loaded), so it runs BEFORE module-alias and
// path-alias register the '@'-aliases. Do NOT import via '@config/*' here — it
// resolves to MODULE_NOT_FOUND at runtime. Keep this file alias-free and use
// console for its own log lines. (`@binodex/shared` is fine: it is a real
// workspace package resolved out of node_modules, not a tsconfig path.)

const NODE_ENV = process.env.NODE_ENV

// Unlike the other services there is no hardcoded fallback DSN: support has no
// Sentry project of its own yet, and pointing its errors at exchange's project
// would silently pollute that issue stream. Set SENTRY_DSN to turn it on.
const dsn = process.env.SENTRY_DSN ?? ''

const SENTRY_ENABLED =
  Boolean(dsn) && NODE_ENV !== 'development' && NODE_ENV !== 'test'

if (SENTRY_ENABLED) {
  Sentry.init({
    dsn,
    environment: NODE_ENV ?? 'production',
    release: process.env.npm_package_version,
    serverName: 'backend-support',
    // Self-hosted Sentry: keep ONLY error issues. Tracing / profiling / logs
    // flood the ingestion far faster than issues do, and buy nothing here —
    // this service's hot path is a handful of HTTP routes. Error capture
    // (captureException/captureMessage) is unaffected by these rates.
    sampleRate: Number(process.env.SENTRY_ERROR_SAMPLE_RATE ?? 1.0),
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
    profilesSampleRate: 0,
    enableLogs: false,
    maxBreadcrumbs: 30,
    integrations: [
      // DON'T EVEN BUFFER THE BODY. The default ('medium', ~10KB) parks the
      // raw bytes of every incoming request on the isolation scope, so any
      // error raised while handling it inherits them — here that would be a
      // ticket message, i.e. whatever a trader typed into support chat.
      Sentry.httpIntegration({ maxIncomingRequestBodySize: 'none' }),
    ],
    // One shared redactor for every service (@binodex/shared). Allow-lists
    // headers, drops body / query / cookies, masks secrets that ride in a url
    // PATH — which is the case that matters here: the file-download helper
    // addresses `api.telegram.org/file/bot<id>:<secret>/…`, so an unmasked
    // outgoing-request breadcrumb is the whole bot token.
    beforeSend: scrubSentryEvent,
    beforeBreadcrumb: scrubSentryBreadcrumb,
  })
  console.log(
    `[sentry] init server=backend-support env=${NODE_ENV ?? 'production'} dsn=${dsn.replace(/\/\/[^@]+@/, '//***@')}`
  )
} else {
  console.log(`[sentry] disabled (NODE_ENV=${NODE_ENV ?? 'production'})`)
}
