import { describe, expect, it } from 'vitest'

import {
  escapeHtml,
  formatTopicName,
  parseTopicName,
  shortTicketId,
  splitText,
} from '@telegram/text'

const TICKET_ID = '3f2a91c4-7b0e-4d51-9c2a-1d6f8e0b4a77'

describe('escapeHtml', () => {
  it('neutralizes the three characters Telegram parses as markup', () => {
    expect(escapeHtml('<b>a & b</b>')).toBe('&lt;b&gt;a &amp; b&lt;/b&gt;')
  })

  it('leaves quotes alone — escaping them would show up as text', () => {
    expect(escapeHtml(`"Ivan" O'Neil`)).toBe(`"Ivan" O'Neil`)
  })
})

describe('splitText', () => {
  it('returns short text as a single chunk', () => {
    expect(splitText('привет')).toEqual(['привет'])
  })

  it('drops text that carries no information', () => {
    expect(splitText('')).toEqual([])
    expect(splitText('   \n  \n ')).toEqual([])
  })

  it('splits on line boundaries and keeps every chunk within the limit', () => {
    const text = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
    const chunks = splitText(text, 30)

    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(30)
    expect(chunks.join('\n')).toBe(text)
  })

  it('never breaks a word when a single line is too long', () => {
    const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot']
    const chunks = splitText(words.join(' '), 12)

    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(12)
      for (const word of chunk.split(' ')) expect(words).toContain(word)
    }
    expect(chunks.join(' ')).toBe(words.join(' '))
  })

  it('hard-cuts only a single token longer than a whole message', () => {
    const blob = 'x'.repeat(25)
    const chunks = splitText(blob, 10)
    expect(chunks).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)])
  })

  it('preserves the user text verbatim across the split', () => {
    // Markup characters, blank lines and non-latin text all survive untouched:
    // the relay sends what the user typed, escaping is the reader's problem.
    const text =
      'первая строка\n\nвторая строка с <тегами> & амперсандом\nтретья строка тут'
    const chunks = splitText(text, 40)

    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(40)
    expect(chunks.join('\n')).toBe(text)
  })
})

describe('formatTopicName / parseTopicName', () => {
  it('round-trips its own format', () => {
    const name = formatTopicName(4821, TICKET_ID)
    expect(name).toBe('4821 · 3f2a91c4')
    expect(parseTopicName(name)).toEqual({
      userNId: 4821,
      ticketShortId: '3f2a91c4',
    })
  })

  // Ticket state lives in the topic ICON, never in the title — so the title a
  // topic is created with is the title it keeps, and the binding never depends
  // on a name Telegram or an operator may have restyled.
  it('carries no status marker', () => {
    expect(formatTopicName(4821, TICKET_ID)).not.toMatch(/[🟢🔴]/u)
  })

  it('accepts the separators an admin might type by hand', () => {
    const expected = { userNId: 123, ticketShortId: '456abc' }
    expect(parseTopicName('123 456abc')).toEqual(expected)
    expect(parseTopicName('123-456abc')).toEqual(expected)
    expect(parseTopicName('123 · 456abc')).toEqual(expected)
    expect(parseTopicName('#123 456abc')).toEqual(expected)
    expect(parseTopicName('🎫 123 | 456abc')).toEqual(expected)
    expect(parseTopicName('  123  :  456ABC  ')).toEqual(expected)
  })

  it('refuses names it cannot read unambiguously', () => {
    // No separator: "nId 123, ticket 456" and "nId 123456" are both readings,
    // and binding the wrong ticket puts one user's reply in another's feed.
    expect(parseTopicName('123456')).toBeNull()
    expect(parseTopicName('Общий')).toBeNull()
    expect(parseTopicName('')).toBeNull()
    expect(parseTopicName('abc · def')).toBeNull()
    expect(parseTopicName('0 · 3f2a91c4')).toBeNull()
  })
})

describe('shortTicketId', () => {
  it('takes the first eight hex characters, dashes ignored', () => {
    expect(shortTicketId(TICKET_ID)).toBe('3f2a91c4')
    expect(shortTicketId('3F2A91C4')).toBe('3f2a91c4')
  })
})
