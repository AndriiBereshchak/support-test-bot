/**
 * An expected failure with a chosen HTTP status.
 *
 * The Fastify error handler treats this as the ONLY signal that a failure is
 * intentional: an `ApiError` becomes its own status and never reaches Sentry,
 * while anything else that escapes a handler is a bug and gets 500 + a Sentry
 * event. So "the file is not there" must throw `new ApiError(..., 404)`, not a
 * bare `Error` — otherwise every stranger probing an id pages the on-call.
 */
export class ApiError extends Error {
  public readonly status: number
  public readonly code?: string

  constructor(message: string, status = 500, code?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}
