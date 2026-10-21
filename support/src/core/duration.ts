/**
 * Parsing of a duration the operator types by hand: `1d`, `2w`, `1m`, `1y`,
 * `6h`.
 *
 * Lives in `core` because it is needed by the bot commands, by the mute
 * service and by the tests — and it depends on nothing.
 *
 * ABOUT `m`. In time abbreviations `m` means minutes in some places and months
 * in others, and guessing here is expensive: an operator who typed "30m"
 * hoping for half an hour and got thirty months will only learn about it from
 * the user. Therefore `m` is ALWAYS a month (that is what the customer called
 * it in the row `1d, 1w, 1m, 1y`), and minutes are written with the full word
 * `min`. No ambiguous spelling is left.
 */

export interface ParsedDuration {
  /** Duration in milliseconds. */
  ms: number
  /** How to show it back to the operator: "1 день", "2 недели". */
  label: string
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Month and year are calendar-based, so they are computed from a date rather
 *  than from a constant. */
type Unit = 'min' | 'h' | 'd' | 'w' | 'm' | 'y'

const UNIT_MS: Record<Exclude<Unit, 'm' | 'y'>, number> = {
  min: MINUTE,
  h: HOUR,
  d: DAY,
  w: 7 * DAY,
}

/** Russian forms for the reply to the operator: 1 день / 2 дня / 5 дней. */
const FORMS: Record<Unit, [string, string, string]> = {
  min: ['минуту', 'минуты', 'минут'],
  h: ['час', 'часа', 'часов'],
  d: ['день', 'дня', 'дней'],
  w: ['неделю', 'недели', 'недель'],
  m: ['месяц', 'месяца', 'месяцев'],
  y: ['год', 'года', 'лет'],
}

function plural(value: number, forms: [string, string, string]): string {
  const n = Math.abs(value) % 100
  const n1 = n % 10
  if (n > 10 && n < 20) return forms[2]
  if (n1 > 1 && n1 < 5) return forms[1]
  if (n1 === 1) return forms[0]
  return forms[2]
}

/** We do not mute for longer than this: a "for 99 years" duration is almost
 *  always a typo.
 *  366, not 365: a `1y` that lands on a leap year lasts 366 days and must not
 *  be rejected by its own ceiling. */
export const MAX_DURATION_DAYS = 366

/**
 * Add months BY THE CALENDAR and in UTC.
 *
 * Our own implementation instead of `setMonth`, because the built-in one does
 * two unpleasant things: it counts in the local zone (the switch to daylight
 * saving time shifts the duration by an hour) and it overflows — January 31
 * plus a month gives March 3, i.e. the person silently gets three extra days.
 * Here the day is clamped to the last date of the target month: January 31 +
 * 1m = February 28.
 */
function addMonthsUtc(from: Date, months: number): Date {
  const day = from.getUTCDate()
  const target = new Date(
    Date.UTC(
      from.getUTCFullYear(),
      from.getUTCMonth() + months,
      1,
      from.getUTCHours(),
      from.getUTCMinutes(),
      from.getUTCSeconds(),
      from.getUTCMilliseconds()
    )
  )
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)
  ).getUTCDate()
  target.setUTCDate(Math.min(day, lastDay))
  return target
}

/**
 * `1d` → milliseconds and a label. null if the spelling cannot be parsed.
 *
 * Month and year are counted from the given moment by the calendar, not as
 * "30 days": a "for a month" mute issued on January 31 must end on February
 * 28, not on March 2.
 */
export function parseDuration(
  input: string,
  from: Date = new Date()
): ParsedDuration | null {
  const match = /^(\d{1,4})\s*(min|[hdwmy])$/i.exec(input.trim())
  if (!match) return null

  const value = Number(match[1])
  const unit = match[2]!.toLowerCase() as Unit
  if (!Number.isInteger(value) || value <= 0) return null

  let ms: number
  if (unit === 'm' || unit === 'y') {
    const end = addMonthsUtc(from, unit === 'm' ? value : value * 12)
    ms = end.getTime() - from.getTime()
  } else {
    ms = value * UNIT_MS[unit]
  }

  if (ms <= 0 || ms > MAX_DURATION_DAYS * DAY) return null

  return { ms, label: `${value} ${plural(value, FORMS[unit])}` }
}

/** Format hint — one line for both /help and the error reply. */
export const DURATION_HINT =
  'Формат срока: 30min, 6h, 1d, 2w, 1m, 1y (m — месяц, минуты — min). Максимум 1y.'
