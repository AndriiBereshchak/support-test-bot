import { afterAll, describe, expect, test } from 'vitest'

import { PaymentStatus, PaymentType } from '@prisma-exchange'

import { checkDeletable } from '@apps/services/account-delete.service'
import { findPartnerByCode } from '@apps/services/partner-bind.service'
import { listUserWithdrawals } from '@apps/services/withdrawal-list.service'

import { getPrismaAffiliate, prismaExchange } from '@config/database'

import { extractReferralCode } from '@telegram/commands'

import { cleanupTestUser, createTestUser } from './_helpers'

/**
 * The support-bot actions that replaced the operator bot: the withdrawal list,
 * the referral-code resolver and the deletion rules.
 *
 * These are the paths an operator reaches through a ticket topic, and two of
 * them change data — so the rules are pinned here rather than trusted to have
 * survived the move out of the old bot.
 */

const uniqueCode = (tag: string): string =>
  `t-${tag}-${Math.random().toString(36).slice(2, 10)}`

describe('extractReferralCode', () => {
  test('a bare code is passed through untouched', () => {
    expect(extractReferralCode('promo123')).toBe('promo123')
    expect(extractReferralCode('  promo123  ')).toBe('promo123')
  })

  test('a link gives up its code', () => {
    expect(extractReferralCode('https://binodex.com/?aff=abc123')).toBe(
      'abc123'
    )
    expect(
      extractReferralCode('https://binodex.com/signup?utm=x&aff=abc123&z=1')
    ).toBe('abc123')
  })

  test('the partner-recruiting parameter is NOT accepted as a user code', () => {
    // `?r=` recruits PARTNERS. Someone who arrived through it is a partner,
    // not a referred trader, and binding a user by it would attribute them to
    // the wrong side of the programme.
    expect(extractReferralCode('https://binodex.com/?r=recruit1')).toBeNull()
  })

  test('a link with no code we know is refused, not searched for whole', () => {
    expect(extractReferralCode('https://binodex.com/promo')).toBeNull()
    expect(extractReferralCode('https://')).toBeNull()
  })

  test('empty input is refused', () => {
    expect(extractReferralCode('   ')).toBeNull()
  })
})

describe('findPartnerByCode', () => {
  const prismaAffiliate = getPrismaAffiliate()
  const partnerIds: number[] = []
  const codeIds: number[] = []
  const regionIds: number[] = []

  afterAll(async () => {
    if (!prismaAffiliate) return
    if (codeIds.length) {
      await prismaAffiliate.companyCode.deleteMany({
        where: { id: { in: codeIds } },
      })
    }
    if (regionIds.length) {
      await prismaAffiliate.partnerRegionCode.deleteMany({
        where: { id: { in: regionIds } },
      })
    }
    if (partnerIds.length) {
      await prismaAffiliate.partner.deleteMany({
        where: { id: { in: partnerIds } },
      })
    }
    await prismaAffiliate.$disconnect()
  })

  const makePartner = async (
    tag: string,
    over: Record<string, unknown> = {}
  ) => {
    const partner = await prismaAffiliate!.partner.create({
      data: {
        email: `${uniqueCode(tag)}@test.local`,
        password: 'x',
        ...over,
      },
      select: { id: true },
    })
    partnerIds.push(partner.id)
    return partner.id
  }

  test.skipIf(!prismaAffiliate)(
    'finds a partner by a company link code',
    async () => {
      const partnerId = await makePartner('company')
      const code = uniqueCode('cc')
      const row = await prismaAffiliate!.companyCode.create({
        data: { partnerId, name: 'Instagram RU', code },
        select: { id: true },
      })
      codeIds.push(row.id)

      const match = await findPartnerByCode(code)
      expect(match).not.toBeNull()
      expect(match).not.toBe('ambiguous')
      expect(match).not.toBe('unavailable')
      if (typeof match !== 'object' || match === null) return
      expect(match.partner.id).toBe(partnerId)
      expect(match.source).toContain('Instagram RU')
    }
  )

  test.skipIf(!prismaAffiliate)(
    'finds a partner by their own personal link code',
    async () => {
      const code = uniqueCode('own')
      const partnerId = await makePartner('own', { userAffiliateCode: code })

      const match = await findPartnerByCode(code)
      if (typeof match !== 'object' || match === null) {
        throw new Error(`expected a match, got ${String(match)}`)
      }
      expect(match.partner.id).toBe(partnerId)
      expect(match.source).toContain('личная')
    }
  )

  test.skipIf(!prismaAffiliate)(
    'finds a partner by a regional link code',
    async () => {
      const partnerId = await makePartner('region')
      const code = uniqueCode('reg')
      const row = await prismaAffiliate!.partnerRegionCode.create({
        data: {
          partnerId,
          region: 'KZ',
          partnerCode: uniqueCode('rp'),
          userCode: code,
          mobileCode: uniqueCode('rm'),
        },
        select: { id: true },
      })
      regionIds.push(row.id)

      const match = await findPartnerByCode(code)
      if (typeof match !== 'object' || match === null) {
        throw new Error(`expected a match, got ${String(match)}`)
      }
      expect(match.partner.id).toBe(partnerId)
      expect(match.source).toContain('KZ')
    }
  )

  test.skipIf(!prismaAffiliate)(
    'the partner-recruiting code is NOT a user referral code',
    async () => {
      const code = uniqueCode('recruit')
      // affiliateCode is the `?r=` namespace — binding a trader by it would
      // credit the wrong side of the programme.
      await makePartner('recruit', { affiliateCode: code })
      expect(await findPartnerByCode(code)).toBeNull()
    }
  )

  test.skipIf(!prismaAffiliate)(
    'the same code on TWO partners is ambiguous, never a guess',
    async () => {
      // company_codes.code carries no unique constraint — the affiliate service
      // reads it with findFirst. Picking one here would mis-attribute revenue
      // silently, which is the whole reason this case exists.
      const code = uniqueCode('dup')
      for (const tag of ['dupA', 'dupB']) {
        const partnerId = await makePartner(tag)
        const row = await prismaAffiliate!.companyCode.create({
          data: { partnerId, name: `dup ${tag}`, code },
          select: { id: true },
        })
        codeIds.push(row.id)
      }
      expect(await findPartnerByCode(code)).toBe('ambiguous')
    }
  )

  test.skipIf(!prismaAffiliate)(
    'two codes pointing at the SAME partner are not ambiguous',
    async () => {
      const partnerId = await makePartner('same')
      const code = uniqueCode('same')
      for (const name of ['first', 'second']) {
        const row = await prismaAffiliate!.companyCode.create({
          data: { partnerId, name, code },
          select: { id: true },
        })
        codeIds.push(row.id)
      }
      const match = await findPartnerByCode(code)
      if (typeof match !== 'object' || match === null) {
        throw new Error(`expected a match, got ${String(match)}`)
      }
      expect(match.partner.id).toBe(partnerId)
    }
  )

  test.skipIf(!prismaAffiliate)('an unknown code finds nothing', async () => {
    expect(await findPartnerByCode(uniqueCode('nope'))).toBeNull()
  })
})

describe('listUserWithdrawals', () => {
  const userIds: string[] = []

  afterAll(async () => {
    for (const id of userIds) await cleanupTestUser(id)
    await prismaExchange.$disconnect()
  })

  test('shows the bridge, and leaves it empty when the payout is unrouted', async () => {
    const user = await createTestUser()
    userIds.push(user.userId)

    await prismaExchange.payment.create({
      data: {
        userId: user.userId,
        type: PaymentType.WITHDRAWAL,
        status: PaymentStatus.COMPLETED,
        amount: 100,
        toUSDT: 100,
        withdrawAddress: '0xabc',
        withdrawNetwork: 'bsc',
        destinationTxHash: '0xhash',
        additionalData: {
          paymeta: { bridge: 'relay', receive_amount_usd: '98.40' },
        },
      },
    })
    await prismaExchange.payment.create({
      data: {
        userId: user.userId,
        type: PaymentType.WITHDRAWAL,
        status: PaymentStatus.PENDING,
        amount: 50,
        toUSDT: 50,
        withdrawAddress: '0xdef',
      },
    })

    const rows = await listUserWithdrawals(user.userId)
    expect(rows).not.toBeNull()
    expect(rows).toHaveLength(2)

    const routed = rows!.find((row) => row.address === '0xabc')!
    expect(routed.bridge).toBe('relay')
    expect(routed.receiveUsd).toBe('98.40')
    expect(routed.network).toBe('bsc')
    expect(routed.txHash).toBe('0xhash')

    // A pending payout has not been handed to a bridge yet. Empty is the
    // truthful answer; the command renders it as "—" rather than guessing.
    const unrouted = rows!.find((row) => row.address === '0xdef')!
    expect(unrouted.bridge).toBe('')
    expect(unrouted.receiveUsd).toBe('')
  })

  test('a user with no withdrawals gets an empty list, not null', async () => {
    const user = await createTestUser()
    userIds.push(user.userId)
    // null means "could not read" and must stay distinguishable — an operator
    // carries "no withdrawals" to the client as a fact.
    expect(await listUserWithdrawals(user.userId)).toEqual([])
  })

  test('deposits are not withdrawals', async () => {
    const user = await createTestUser()
    userIds.push(user.userId)
    await prismaExchange.payment.create({
      data: {
        userId: user.userId,
        type: PaymentType.DEPOSIT,
        status: PaymentStatus.COMPLETED,
        amount: 10,
        toUSDT: 10,
      },
    })
    expect(await listUserWithdrawals(user.userId)).toEqual([])
  })
})

describe('checkDeletable', () => {
  const userIds: string[] = []

  afterAll(async () => {
    for (const id of userIds) await cleanupTestUser(id)
    await prismaExchange.$disconnect()
  })

  test('a clean account is deletable', async () => {
    const user = await createTestUser()
    userIds.push(user.userId)
    const check = await checkDeletable(user.userNId)
    expect(check.allowed).toBe(true)
  })

  test('a completed real deposit blocks deletion', async () => {
    const user = await createTestUser()
    userIds.push(user.userId)
    await prismaExchange.payment.create({
      data: {
        userId: user.userId,
        type: PaymentType.DEPOSIT,
        status: PaymentStatus.COMPLETED,
        amount: 10,
        toUSDT: 10,
        isFake: false,
      },
    })
    const check = await checkDeletable(user.userNId)
    expect(check.allowed).toBe(false)
    if (check.allowed) return
    expect(check.reason).toContain('депозит')
  })

  test('a fake (admin-credited) deposit does NOT block deletion', async () => {
    const user = await createTestUser()
    userIds.push(user.userId)
    await prismaExchange.payment.create({
      data: {
        userId: user.userId,
        type: PaymentType.DEPOSIT,
        status: PaymentStatus.COMPLETED,
        amount: 10,
        toUSDT: 10,
        isFake: true,
      },
    })
    expect((await checkDeletable(user.userNId)).allowed).toBe(true)
  })

  test('an unknown user is refused rather than crashing', async () => {
    const check = await checkDeletable(2_000_000_000)
    expect(check.allowed).toBe(false)
  })
})
