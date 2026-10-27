// Ticket card: card deposits broken down by rail.
//
// The operator reads this message on a phone and decides from it which payment
// is even being discussed. While roubles, hryvnias and world cards sat in one
// list, the currency had to be read off every line — and Ukrainian deposits
// were not there at all, because `ua_card` was not in the list of sources.
//
// The renderer is pure, so the test needs no infrastructure.

import { describe, expect, test } from 'vitest'

import type { CardDeposit, UserCard } from '@apps/services/user-card.service'

import { renderUserCard } from '@telegram/api'

const deposit = (over: Partial<CardDeposit>): CardDeposit => ({
  providerOrderId: '',
  amount: '1000.00',
  currency: 'RUB',
  status: 'COMPLETED',
  createdAt: new Date('2026-08-01T10:00:00Z'),
  method: '',
  rail: 'ru',
  ...over,
})

const card = (
  cardDeposits: CardDeposit[],
  over: Partial<UserCard> = {}
): UserCard => ({
  userId: '11111111-1111-1111-1111-111111111111',
  nId: 4242,
  email: 'user@example.com',
  fullName: 'Тестовый Юзер',
  countryCode: 'UA',
  lang: 'ru',
  registeredAt: new Date('2026-01-01T00:00:00Z'),
  lastLoggedIn: null,
  kycLevel: '',
  accountType: '',
  isBlocked: false,
  balanceReal: '10.00',
  balanceDemo: '0.00',
  depositsTotal: '100.00',
  withdrawalsTotal: '0.00',
  firstDepositAt: null,
  riskPriority: null,
  riskFlags: null,
  partnerId: null,
  supportVipAt: null,
  lastRating: null,
  lastRatingComment: null,
  mutedUntil: null,
  muteReason: null,
  cardDeposits,
  ...over,
})

const render = (
  deposits: CardDeposit[],
  over: Partial<UserCard> = {}
): string => renderUserCard(card(deposits, over), 'ticket-abcdef123456')

describe('ticket card — deposits by rail', () => {
  test('shows the current ticket category when it is known', () => {
    const tagged = renderUserCard(
      card([]),
      'ticket-abcdef123456',
      null,
      'WITHDRAWAL'
    )
    expect(tagged).toContain('Тема: <b>Вывод</b>')
    expect(render([])).not.toContain('Тема:')
  })

  test('roubles and hryvnias go in separate blocks', () => {
    const text = render([
      deposit({ rail: 'ru', currency: 'RUB', amount: '5000.00' }),
      deposit({
        rail: 'ua',
        currency: 'UAH',
        amount: '1500.00',
        providerOrderId: 'UP-99887766',
        method: 'monobank QR',
      }),
    ])

    expect(text).toContain('💳 Депозиты ₽ картой:')
    expect(text).toContain('💳 Депозиты ₴ картой:')
    // And the amounts each sit under their own heading, not intermixed.
    const ruAt = text.indexOf('💳 Депозиты ₽ картой:')
    const uaAt = text.indexOf('💳 Депозиты ₴ картой:')
    expect(text.indexOf('5000.00')).toBeGreaterThan(ruAt)
    expect(text.indexOf('5000.00')).toBeLessThan(uaAt)
    expect(text.indexOf('1500.00')).toBeGreaterThan(uaAt)
  })

  test('the UPay payment id lands in the message and is copied by tap', () => {
    const text = render([
      deposit({ rail: 'ua', currency: 'UAH', providerOrderId: 'UP-99887766' }),
    ])

    // <code> — Telegram copies such a span on a tap, which is the whole reason
    // the id is on the card: the operator carries it over into the UPay panel
    // without retyping it.
    expect(text).toContain('<code>UP-99887766</code>')
  })

  test('an empty rail leaves no heading', () => {
    const text = render([deposit({ rail: 'ua', currency: 'UAH' })])

    expect(text).toContain('💳 Депозиты ₴ картой:')
    expect(text).not.toContain('💳 Депозиты ₽ картой:')
    expect(text).not.toContain('💳 Депозиты картой (мир):')
  })

  test('with no card deposits there is no block at all', () => {
    expect(render([])).not.toContain('💳')
  })

  test('world cards (Onramper) stay a separate group', () => {
    const text = render([
      deposit({ rail: 'world', currency: 'USD', method: 'moonpay' }),
      deposit({ rail: 'ua', currency: 'UAH' }),
    ])

    expect(text).toContain('💳 Депозиты картой (мир):')
    expect(text).toContain('💳 Депозиты ₴ картой:')
    // The order is fixed: hryvnias above world cards.
    expect(text.indexOf('💳 Депозиты ₴ картой:')).toBeLessThan(
      text.indexOf('💳 Депозиты картой (мир):')
    )
  })

  test('rupees get their own block, between tenge and world cards', () => {
    const text = render([
      deposit({ rail: 'world', currency: 'USD', method: 'moonpay' }),
      deposit({ rail: 'in', currency: 'INR', amount: '7777.00' }),
      deposit({ rail: 'kz', currency: 'KZT', amount: '15000.00' }),
    ])

    const kzAt = text.indexOf('💳 Депозиты ₸ картой:')
    const inAt = text.indexOf('💳 Депозиты ₹ картой:')
    const worldAt = text.indexOf('💳 Депозиты картой (мир):')
    expect(kzAt).toBeGreaterThan(-1)
    expect(inAt).toBeGreaterThan(kzAt)
    expect(worldAt).toBeGreaterThan(inAt)
    expect(text.indexOf('7777.00')).toBeGreaterThan(inAt)
    expect(text.indexOf('7777.00')).toBeLessThan(worldAt)
  })
})

describe('ticket card — rating and VIP', () => {
  test('VIP and the rating are visible to the operator', () => {
    const text = render([], {
      supportVipAt: new Date('2026-08-09T12:00:00Z'),
      lastRating: 5,
    })

    // The priority changes HOW the operator runs the conversation, which is
    // why it is on the card and not on a separate screen.
    expect(text).toContain('VIP-приоритет')
    expect(text).toContain('Оценка поддержки')
    expect(text).toContain('5/5')
  })

  test('the comment on a low rating goes next to it', () => {
    const text = render([], {
      lastRating: 2,
      lastRatingComment: 'Долго отвечали',
    })

    expect(text).toContain('2/5')
    expect(text).toContain('Долго отвечали')
  })

  test('with no rating and no VIP there are no lines at all', () => {
    const text = render([])

    expect(text).not.toContain('VIP-приоритет')
    expect(text).not.toContain('Оценка поддержки')
  })

  test('the comment is escaped', () => {
    // Free-form user text: an unclosed tag would break HTML parsing and
    // Telegram would reject the whole card outright.
    const text = render([], { lastRating: 1, lastRatingComment: '<b>злой' })

    expect(text).not.toContain('<b>злой')
    expect(text).toContain('&lt;b&gt;злой')
  })
})
