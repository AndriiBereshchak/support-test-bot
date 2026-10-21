// TEST ONLY: no compatibility claim with the missing @binodex/shared package.
// Do not print application payloads or send telemetry from this harness.
export const resolveLogColor = (..._args: unknown[]): boolean => false
export const resolveLogLevel = (..._args: unknown[]): string => 'error'
export const renderLogLine = (..._args: unknown[]): string =>
  '[standalone test: application log payload omitted]'
export const scrubSentryEvent = (..._args: unknown[]): null => null
export const scrubSentryBreadcrumb = (..._args: unknown[]): null => null
export const METRICS_VARY = 'Accept-Encoding'
export function acceptsGzip(value: string | string[] | undefined): boolean {
  return String(value ?? '')
    .split(',')
    .some((part) => /^\s*gzip\s*(?:;\s*q=1(?:\.0*)?)?\s*$/i.test(part))
}
