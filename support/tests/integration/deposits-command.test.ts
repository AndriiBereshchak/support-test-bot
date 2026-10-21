// The /info and /deposits commands inside a ticket topic.
//
// What matters to check here:
//   • /deposits shows every deposit and attaches the filter buttons
//   • pressing a filter REDRAWS the same message instead of sending a new one
//   • the "₴ карты" filter shows only the hryvnia ones and carries the UPay
//     payment id
//   • /info produces a fresh card
//   • outside a ticket topic both commands answer with a hint instead of
//     staying silent
//
// Requires the infrastructure to be up:
//   yarn test:infra:up && yarn test:wait && yarn test:migrate

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@apps/services/push.service', () => ({
  pushToUser: vi.fn(async () => undefined),
}))
vi.mock('@telegram/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@telegram/api')>()),
  ...(await import('./_telegram-stub')).telegramStub(),
}))

import { randomUUID } from 'node:crypto'

import { prismaExchange, shutdownPrisma } from '@config/database'
import { closeRedis } from '@config/redis'

import { userSendMessage } from '@apps/services/chat.service'

import * as telegram from '@telegram/api'
import { handleUpdate } from '@telegram/updates'

import { cleanupTestUser, createTestUser, openTicketOf } from './_helpers'
import { agentMessageUpdate, callbackUpdate } from './_telegram-stub'

const sent = () => vi.mocked(telegram.sendToTopic)
const edited = () => vi.mocked(telegram.editTopicMessage)

const UPAY_ORDER = 'UP-55443322'
const OPERATOR_ID = 900_777
let messageSeq = 500_000
const nextMessageId = (): number => (messageSeq += 1)

async function seedDeposit(
  userId: string,
  additionalData: Record<string, unknown>,
  amount: number
): Promise<void> {
  await prismaExchange.$executeRawUnsafe(
    `INSERT INTO "payments"
       ("id","user_id","tx_id","type","status","amount","to_usdt","additional_data")
     VALUES ($1,$2,$3,'DEPOSIT','COMPLETED',$4::numeric,$5::numeric,$6::jsonb)`,
    randomUUID(),
    userId,
    randomUUID(),
    amount,
    25,
    JSON.stringify(additionalData)
  )
}

/** A user with a ticket and deposits on all three rails. */
async function seedUserWithTicket() {
  const user = await createTestUser()
  await userSendMessage({
    userId: user.userId,
    userNId: user.userNId,
    text: 'Здравствуйте, где мой депозит?',
  })
  const ticket = await openTicketOf(user.userId)
  if (!ticket) throw new Error('тикет не создался')

  await seedDeposit(
    user.userId,
    {
      source: 'ua_card',
      provider: 'upay',
      provider_order_id: UPAY_ORDER,
      provider_display_name: 'monobank QR',
      fiat_currency: 'UAH',
      fiat_amount: 1500,
    },
    1500
  )
  await seedDeposit(
    user.userId,
    {
      source: 'ru_card',
      provider: 'nirvanapay',
      provider_order_id: 'RU-1234',
      fiat_currency: 'RUB',
      fiat_amount: 5000,
    },
    5000
  )
  await seedDeposit(user.userId, { source: 'paymeta' }, 30)
  // Legacy crypto: source tagging only appeared in May, older deposits have
  // no `source` key at all.
  await seedDeposit(user.userId, { amount: 40, nId: user.userNId }, 40)

  return { user, ticket }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterAll(async () => {
  await Promise.allSettled([shutdownPrisma(), closeRedis()])
})

describe('/deposits and /info', () => {
  it('/deposits shows every deposit and attaches the filter buttons', async () => {
    const { user, ticket } = await seedUserWithTicket()
    try {
      await handleUpdate(
        agentMessageUpdate({
          topicId: ticket.tgTopicId!,
          messageId: nextMessageId(),
          fromId: OPERATOR_ID,
          text: '/deposits',
        })
      )

      const call = sent().mock.calls.at(-1)?.[0]
      expect(call).toBeDefined()
      expect(call!.text).toContain('Депозиты — Все')
      // All three rails in the list.
      expect(call!.text).toContain('1500.00 UAH')
      expect(call!.text).toContain('5000.00 RUB')
      // The buttons are there, and the active filter is marked.
      const buttons = JSON.stringify(call!.keyboard)
      expect(buttons).toContain('✓ Все')
      expect(buttons).toContain('₴ карты')
      expect(buttons).toContain('dep:ua')
    } finally {
      await cleanupTestUser(user.userId)
    }
  })

  it('pressing "₴ карты" redraws the same message', async () => {
    const { user, ticket } = await seedUserWithTicket()
    try {
      await handleUpdate(
        agentMessageUpdate({
          topicId: ticket.tgTopicId!,
          messageId: nextMessageId(),
          fromId: OPERATOR_ID,
          text: '/deposits',
        })
      )
      const messageId = 777001

      await handleUpdate(
        callbackUpdate({
          topicId: ticket.tgTopicId!,
          messageId,
          data: 'dep:ua',
        })
      )

      // An edit, not a new message: otherwise the topic gets buried under
      // copies of the list.
      const call = edited().mock.calls.at(-1)?.[0]
      expect(call).toBeDefined()
      expect(call!.messageId).toBe(messageId)
      expect(call!.text).toContain('Депозиты — ₴ карты')
      expect(call!.text).toContain('1500.00 UAH')
      // The ruble one and the crypto must not be in the filtered list.
      expect(call!.text).not.toContain('5000.00 RUB')
      // The UPay payment id goes in <code>, so it copies on tap.
      expect(call!.text).toContain(`<code>${UPAY_ORDER}</code>`)
    } finally {
      await cleanupTestUser(user.userId)
    }
  })

  it('the "Крипта" filter drops every card rail', async () => {
    const { user, ticket } = await seedUserWithTicket()
    try {
      await handleUpdate(
        callbackUpdate({
          topicId: ticket.tgTopicId!,
          messageId: 777002,
          data: 'dep:crypto',
        })
      )

      const call = edited().mock.calls.at(-1)?.[0]
      expect(call!.text).toContain('Депозиты — Крипта')
      expect(call!.text).not.toContain('UAH')
      expect(call!.text).not.toContain('RUB')
      // Both crypto rows: the tagged one and the old one with no `source`
      // key. The second dropped out of the query — `NOT` over a missing key
      // yields SQL NULL — and the operator got "Ничего нет" for a deposit
      // that was visible on the "Все" tab.
      expect(call!.text).toContain('30.00 USD')
      expect(call!.text).toContain('40.00 USD')
    } finally {
      await cleanupTestUser(user.userId)
    }
  })

  it('rupees (`in_card`) get their own filter and their own block on the card', async () => {
    const { user, ticket } = await seedUserWithTicket()
    await seedDeposit(
      user.userId,
      {
        source: 'in_card',
        provider: 'paylee_in',
        provider_order_id: 'PL-IN-1530021',
        fiat_currency: 'INR',
        fiat_amount: 7000,
      },
      7000
    )
    try {
      await handleUpdate(
        callbackUpdate({
          topicId: ticket.tgTopicId!,
          messageId: 777003,
          data: 'dep:in',
        })
      )
      const list = edited().mock.calls.at(-1)?.[0]
      expect(list!.text).toContain('Депозиты — ₹ карты')
      expect(list!.text).toContain('7000.00 INR')
      expect(list!.text).not.toContain('UAH')
      expect(list!.text).not.toContain('RUB')

      await handleUpdate(
        agentMessageUpdate({
          topicId: ticket.tgTopicId!,
          messageId: nextMessageId(),
          fromId: OPERATOR_ID,
          text: '/info',
        })
      )
      const card = sent().mock.calls.at(-1)?.[0]
      expect(card!.text).toContain('💳 Депозиты ₹ картой:')
      expect(card!.text).toContain('<code>PL-IN-1530021</code>')
    } finally {
      await cleanupTestUser(user.userId)
    }
  })

  it('/info prints the REAL ticket id, not a made-up one', async () => {
    const { user, ticket } = await seedUserWithTicket()
    try {
      await handleUpdate(
        agentMessageUpdate({
          topicId: ticket.tgTopicId!,
          messageId: nextMessageId(),
          fromId: OPERATOR_ID,
          text: '/info',
        })
      )

      const call = sent().mock.calls.at(-1)?.[0]
      // The card prints the id in <code> — it copies on tap, and a made-up
      // string would send the operator looking for a ticket that does not
      // exist.
      expect(call!.text).toContain(ticket.id.slice(0, 8))
      expect(call!.text).not.toContain('refresh-')
    } finally {
      await cleanupTestUser(user.userId)
    }
  })

  it('/info sends a card with the deposits broken down by rail', async () => {
    const { user, ticket } = await seedUserWithTicket()
    try {
      await handleUpdate(
        agentMessageUpdate({
          topicId: ticket.tgTopicId!,
          messageId: nextMessageId(),
          fromId: OPERATOR_ID,
          text: '/info',
        })
      )

      const call = sent().mock.calls.at(-1)?.[0]
      expect(call).toBeDefined()
      expect(call!.text).toContain(`<code>${user.userNId}</code>`)
      expect(call!.text).toContain('💳 Депозиты ₽ картой:')
      expect(call!.text).toContain('💳 Депозиты ₴ картой:')
    } finally {
      await cleanupTestUser(user.userId)
    }
  })

  it('outside a ticket topic both commands answer with a hint', async () => {
    const { user, ticket } = await seedUserWithTicket()
    try {
      // The topic exists, but there is no ticket behind it — the same path
      // as General.
      await handleUpdate(
        agentMessageUpdate({
          topicId: ticket.tgTopicId! + 999_999,
          messageId: nextMessageId(),
          fromId: OPERATOR_ID,
          text: '/deposits',
        })
      )

      const plain = vi.mocked(telegram.sendPlainMessage).mock.calls.at(-1)?.[0]
      expect(plain?.text).toBeTruthy()
      // Silence would be the worst outcome: the operator would decide the
      // bot is broken.
      expect(sent().mock.calls.length).toBe(0)
    } finally {
      await cleanupTestUser(user.userId)
    }
  })
})
