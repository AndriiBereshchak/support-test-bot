import { timingSafeEqual } from 'node:crypto'

/**
 * Compare two secrets without leaking their contents through timing.
 *
 * Two traps this wraps:
 *   1. `timingSafeEqual` THROWS when the buffers differ in length, so a naive
 *      call turns a wrong-length token into a 500 instead of a 401.
 *   2. Short-circuiting on the length check is itself an oracle for the secret
 *      length, so the mismatch branch still runs one full comparison before
 *      returning false.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')

  if (left.length !== right.length) {
    timingSafeEqual(left, left)
    return false
  }
  return timingSafeEqual(left, right)
}
