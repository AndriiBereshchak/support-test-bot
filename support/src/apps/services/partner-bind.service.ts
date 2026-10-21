import { getPrismaAffiliate, prismaExchange } from '@config/database'

/**
 * Partner binding — a verbatim port of the admin panel's `setPartner`
 * (admin users.service): user must exist, partner must exist in the
 * affiliate database, then one update setting `partnerId`, clearing
 * `partnerCompanyCodeId` (a manual bind overrides any code attribution) and
 * stamping `partnerLinkedManuallyAt`. Any drift between the two code paths
 * would let the bot and the admin panel disagree — if the admin logic ever
 * grows a new check, this file must grow it too.
 *
 * This is the single deliberate exchange-database WRITE in the support
 * service (see the note in config/database.ts).
 */

export interface PartnerInfo {
  id: number
  nick: string | null
  email: string
  /** Blocked partners still bind — the operator just has to SEE it. */
  isBlocked: boolean
}

/** Where a pasted referral code was found. Shown so the operator can sanity
 *  check the match against what the user sent them. */
export interface PartnerCodeMatch {
  partner: PartnerInfo
  code: string
  /** Human label of the code's home, e.g. 'ссылка компании «Instagram RU»'. */
  source: string
}

/**
 * Resolve a referral code to its partner.
 *
 * A support operator usually has the LINK, not the id. The user-facing referral
 * namespace spans five columns, and the affiliate service's own uniqueness
 * check (links.service `isCodeTakenInAffNamespace`) is the authority on which:
 *
 *   company_codes.code, partners.user_affiliate_code, partners.mobile_code,
 *   partner_region_codes.user_code, partner_region_codes.mobile_code
 *
 * DELIBERATELY NOT `partners.affiliate_code` / `partner_region_codes.partner_code`:
 * those are the PARTNER-recruiting links (`?r=`). A person who arrived through
 * one of those is a partner, not somebody's referred trader, and binding a user
 * by that code would attribute them to the wrong side of the programme.
 *
 * `company_codes.code` carries NO unique constraint — the affiliate service
 * reads it with `findFirst`. So a duplicate is possible, and this returns
 * 'ambiguous' instead of picking one: silently binding a user to whichever row
 * came back first is a revenue attribution error nobody would notice.
 */
export type PartnerCodeLookup =
  | PartnerCodeMatch
  | null
  | 'ambiguous'
  | 'unavailable'

const PARTNER_SELECT = {
  id: true,
  nick: true,
  email: true,
  isBlocked: true,
} as const

export async function findPartnerByCode(
  rawCode: string
): Promise<PartnerCodeLookup> {
  const prismaAffiliate = getPrismaAffiliate()
  if (!prismaAffiliate) return 'unavailable'

  const code = rawCode.trim()
  if (!code) return null

  const [companies, partners, regions] = await Promise.all([
    prismaAffiliate.companyCode.findMany({
      where: { code },
      select: { code: true, name: true, partner: { select: PARTNER_SELECT } },
      // Two is enough to know it is ambiguous; no reason to read more.
      take: 2,
    }),
    prismaAffiliate.partner.findMany({
      where: { OR: [{ userAffiliateCode: code }, { mobileCode: code }] },
      select: PARTNER_SELECT,
      take: 2,
    }),
    prismaAffiliate.partnerRegionCode.findMany({
      where: { OR: [{ userCode: code }, { mobileCode: code }] },
      select: { region: true, partner: { select: PARTNER_SELECT } },
      take: 2,
    }),
  ])

  const matches: PartnerCodeMatch[] = [
    ...companies.map((row) => ({
      partner: row.partner,
      code,
      source: `ссылка компании «${row.name}»`,
    })),
    ...partners.map((partner) => ({
      partner,
      code,
      source: 'личная ссылка партнёра',
    })),
    ...regions.map((row) => ({
      partner: row.partner,
      code,
      source: `региональная ссылка (${row.region})`,
    })),
  ]

  if (matches.length === 0) return null
  // Several rows pointing at the SAME partner are not ambiguous — the operator
  // gets the same answer either way.
  const distinct = new Set(matches.map((m) => m.partner.id))
  if (distinct.size > 1) return 'ambiguous'
  return matches[0]!
}

export async function findPartner(
  partnerId: number
): Promise<PartnerInfo | null | 'unavailable'> {
  const prismaAffiliate = getPrismaAffiliate()
  if (!prismaAffiliate) return 'unavailable'
  const partner = await prismaAffiliate.partner.findUnique({
    where: { id: partnerId },
    select: PARTNER_SELECT,
  })
  return partner
}

export type BindResult =
  | { ok: true; partner: PartnerInfo }
  | { ok: false; reason: string }

export async function bindPartner(
  userNId: number,
  partnerId: number
): Promise<BindResult> {
  const user = await prismaExchange.user.findUnique({
    where: { nId: userNId },
    select: { id: true, partnerId: true },
  })
  if (!user) return { ok: false, reason: 'Пользователь не найден' }

  const partner = await findPartner(partnerId)
  if (partner === 'unavailable') {
    return {
      ok: false,
      reason:
        'База партнёрки недоступна на этой реплике (DATABASE_AFFILIATE не задан) - привязка невозможна',
    }
  }
  if (!partner) return { ok: false, reason: `Партнёр #${partnerId} не найден` }

  await prismaExchange.user.update({
    where: { id: user.id },
    data: {
      partnerId,
      partnerCompanyCodeId: null,
      partnerLinkedManuallyAt: new Date(),
    },
  })
  return { ok: true, partner }
}
