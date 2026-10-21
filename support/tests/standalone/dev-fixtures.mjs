import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
export const developmentUsers = [
  {
    userId: '00000000-0000-4000-8000-000000000001',
    userNId: 2100000001,
    name: 'Test Withdrawal',
    lang: 'en',
    balance: '125.00',
    withdrawalStatus: 'PENDING',
  },
  {
    userId: '00000000-0000-4000-8000-000000000002',
    userNId: 2100000002,
    name: 'Test Deposit',
    lang: 'ua',
    balance: '50.00',
    withdrawalStatus: 'COMPLETED',
  },
  {
    userId: '00000000-0000-4000-8000-000000000003',
    userNId: 2100000003,
    name: 'Test No Payments',
    lang: 'de',
    balance: '0.00',
    withdrawalStatus: null,
  },
]

export async function seedDevelopmentData() {
  const { PrismaClient } = require('./.generated/external')
  const client = new PrismaClient()
  try {
    for (const user of developmentUsers) {
      await client.user.upsert({
        where: { id: user.userId },
        update: {},
        create: {
          id: user.userId,
          nId: user.userNId,
          email: `standalone-${user.userNId}@example.test`,
          fullName: user.name,
          lang: user.lang,
          accountType: 'STANDARD',
        },
      })
      await client.account.upsert({
        where: { id: user.userId },
        update: {},
        create: {
          id: user.userId,
          userId: user.userId,
          kind: 'USER',
          isDemo: false,
          available: user.balance,
        },
      })
      if (user.withdrawalStatus) {
        for (const type of ['DEPOSIT', 'WITHDRAWAL']) {
          const id = `${user.userNId}-${type}`
          await client.payment.upsert({
            where: { id },
            update: {},
            create: {
              id,
              userId: user.userId,
              type,
              status: type === 'DEPOSIT' ? 'COMPLETED' : user.withdrawalStatus,
              amount: type === 'DEPOSIT' ? '100' : '25',
              toUSDT: type === 'DEPOSIT' ? '100' : '25',
              additionalData:
                type === 'DEPOSIT'
                  ? {
                      source: 'ua_card',
                      provider_display_name: 'Synthetic provider',
                      fiat_amount: '4000',
                      fiat_currency: 'UAH',
                      provider_order_id: `TEST-${user.userNId}`,
                    }
                  : {
                      paymeta: {
                        bridge: 'synthetic',
                        receive_amount_usd: '24',
                      },
                    },
            },
          })
        }
      }
    }
    return developmentUsers
  } finally {
    await client.$disconnect()
  }
}

// Explicit command only. Deletes only the three known synthetic users and
// their local DB rows; does not delete Telegram topics or attachment files.
export async function resetDevelopmentData() {
  const { PrismaClient: SupportClient } = require('./.generated/support')
  const { PrismaClient: ExternalClient } = require('./.generated/external')
  const support = new SupportClient()
  const external = new ExternalClient()
  const userId = { in: developmentUsers.map((user) => user.userId) }
  try {
    await support.$transaction([
      support.supportTicket.deleteMany({ where: { userId } }),
      support.supportUserThread.deleteMany({ where: { userId } }),
      support.supportMute.deleteMany({ where: { userId } }),
    ])
    await external.$transaction([
      external.payment.deleteMany({ where: { userId } }),
      external.account.deleteMany({ where: { userId } }),
      external.user.deleteMany({ where: { id: userId } }),
    ])
  } finally {
    await Promise.all([support.$disconnect(), external.$disconnect()])
  }
}
