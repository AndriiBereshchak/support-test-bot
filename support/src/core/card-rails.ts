/**
 * Card deposit rails: types, labels and grouping.
 *
 * Lives in `core` rather than next to `user-card.service` because of the layer
 * rule: `@telegram/api` takes ONLY types from services (a runtime import would
 * close the cycle `chat.service -> @telegram/api -> chat.service`), and the
 * grouping is needed by both renderers of the card — the one in the ticket
 * topic and the one in the user card. Here it has not a single dependency, so
 * anyone at all can import it.
 */

/** Ruble cards, Ukrainian ones (UPay), Kazakh ones (KZT), Indian ones (INR)
 *  and worldwide ones (Onramper). */
export type CardRail = 'ru' | 'ua' | 'kz' | 'in' | 'world'

/** A payment's `additionalData.source` → rail. */
export const RAIL_BY_SOURCE: Record<string, CardRail> = {
  ru_card: 'ru',
  ua_card: 'ua',
  kz_card: 'kz',
  in_card: 'in',
  onramper: 'world',
}

/**
 * Labels and order — one source for both renderers.
 *
 * Rubles, hryvnias, tenge and rupees are split deliberately: this is different
 * money and different providers, and in a merged list the operator had to read
 * the currency off every row to work out whether it was even the right deposit.
 */
export const RAIL_LABELS: Record<CardRail, string> = {
  ru: 'Депозиты ₽ картой',
  ua: 'Депозиты ₴ картой',
  kz: 'Депозиты ₸ картой',
  in: 'Депозиты ₹ картой',
  world: 'Депозиты картой (мир)',
}

// `world` stays last: it is the catch-all rail (`RAIL_BY_SOURCE` falls back to
// it), so a named rail listed after it would read as a footnote to "everything
// else".
export const RAIL_ORDER: CardRail[] = ['ru', 'ua', 'kz', 'in', 'world']

/** The minimum the grouping needs — so it can be called both with a full
 *  deposit card and with a row from the /deposits command's list. */
export interface RailBearing {
  rail: CardRail
}

export interface RailGroup<T extends RailBearing> {
  rail: CardRail
  label: string
  items: T[]
}

/**
 * Lay the deposits out by rail in a fixed order.
 *
 * Empty groups are omitted: a heading with no rows is noise in a message that
 * gets read from a phone.
 */
export function groupByRail<T extends RailBearing>(
  deposits: T[]
): Array<RailGroup<T>> {
  return RAIL_ORDER.map((rail) => ({
    rail,
    label: RAIL_LABELS[rail],
    items: deposits.filter((deposit) => deposit.rail === rail),
  })).filter((group) => group.items.length > 0)
}
