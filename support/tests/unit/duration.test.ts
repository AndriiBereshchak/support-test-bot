// Parsing the mute duration that the operator types by hand.
//
// A mistake here is silent and expensive: the operator types "30m" hoping for
// half an hour, and the person cannot write to support for thirty months and
// finds that out on their own. That is why the bounds of the format are pinned
// down by a test and not by an agreement.

import { describe, expect, it } from 'vitest'

import { MAX_DURATION_DAYS, parseDuration } from '@core/duration'

const HOUR = 3_600_000
const DAY = 24 * HOUR

describe('parseDuration', () => {
  it('parses the forms from the task', () => {
    expect(parseDuration('1d')?.ms).toBe(DAY)
    expect(parseDuration('2w')?.ms).toBe(14 * DAY)
    expect(parseDuration('6h')?.ms).toBe(6 * HOUR)
  })

  it('m is a MONTH, and minutes are written as min', () => {
    // Exactly the ambiguity the format was pinned down for.
    const from = new Date('2026-03-10T00:00:00Z')
    const month = parseDuration('1m', from)
    expect(month?.ms).toBe(
      new Date('2026-04-10T00:00:00Z').getTime() - from.getTime()
    )
    expect(parseDuration('30min')?.ms).toBe(30 * 60_000)
  })

  it('a month is counted by the calendar, not as "30 days"', () => {
    // A "one month" mute from 31 January must end on 28 February.
    const from = new Date('2026-01-31T12:00:00Z')
    const end = new Date(from.getTime() + parseDuration('1m', from)!.ms)
    expect(end.getUTCMonth()).toBe(1) // February
    expect(end.getUTCDate()).toBe(28)
  })

  it('a year is calendar-based too, and a leap year does not break it', () => {
    const from = new Date('2028-02-29T00:00:00Z')
    const end = new Date(from.getTime() + parseDuration('1y', from)!.ms)
    expect(end.getUTCFullYear()).toBe(2029)
  })

  it('the label agrees with the number', () => {
    expect(parseDuration('1d')?.label).toBe('1 день')
    expect(parseDuration('2d')?.label).toBe('2 дня')
    expect(parseDuration('5d')?.label).toBe('5 дней')
    expect(parseDuration('11d')?.label).toBe('11 дней')
    expect(parseDuration('21d')?.label).toBe('21 день')
    expect(parseDuration('1w')?.label).toBe('1 неделю')
  })

  it('garbage and nonsense do not parse', () => {
    for (const bad of [
      '',
      'd',
      '0d',
      '-1d',
      '1',
      '1x',
      'вчера',
      '1.5d',
      '1 d 2',
    ]) {
      expect(parseDuration(bad)).toBeNull()
    }
  })

  it('whitespace and letter case do not get in the way', () => {
    expect(parseDuration(' 1 D ')?.ms).toBe(DAY)
    expect(parseDuration('2W')?.ms).toBe(14 * DAY)
  })

  it('a duration longer than a year is rejected', () => {
    // "For 99 years" is almost always a typo, not a decision.
    expect(parseDuration('2y')).toBeNull()
    expect(parseDuration('400d')).toBeNull()
    expect(parseDuration(`${MAX_DURATION_DAYS}d`)?.ms).toBe(
      MAX_DURATION_DAYS * DAY
    )
  })
})
