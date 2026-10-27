import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupportTicket } from '@prisma-support'

const settings = vi.hoisted(() => ({
  historyLimit: 20,
  embedding: [1, ...Array(1023).fill(0)],
}))
vi.mock('@config/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@config/env')>()),
  get ZHORA_CONTEXT_MESSAGE_LIMIT() {
    return settings.historyLimit
  },
}))
// No paid calls: only the retrieval boundary is replaced. Ticket/history,
// card and payment reads use the real local test database.
vi.mock('@apps/services/zhora/kb-search.service', () => ({
  searchZhoraKbForSuggestion: vi.fn(async () => ({
    matches: [],
    embedding: settings.embedding,
    embeddingModel: 'test/embedding',
    complete: true,
  })),
}))
vi.mock('@apps/services/withdrawal-list.service', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@apps/services/withdrawal-list.service')
    >()
  return { ...actual, listUserWithdrawals: vi.fn(actual.listUserWithdrawals) }
})

import { prismaExchange, prismaSupport } from '@config/database'
import { buildZhoraContext } from '@apps/services/zhora/context.service'
import { searchZhoraKbForSuggestion } from '@apps/services/zhora/kb-search.service'
import { getUserCard } from '@apps/services/user-card.service'
import { listUserWithdrawals } from '@apps/services/withdrawal-list.service'
import { cleanupTestUser, createTestUser, type TestUser } from './_helpers'

let user: TestUser
let ticket: SupportTicket
const search = vi.mocked(searchZhoraKbForSuggestion)
// Prisma delegates are proxies: Vitest cannot always restore their dynamic
// property descriptors, so preserve the two spied methods explicitly.
const originalMuteRead = prismaSupport.supportMute.findUnique
const originalAggregate = prismaExchange.payment.aggregate
const input = () => ({
  ticketId: ticket.id,
  userId: user.userId,
  minScore: 0.5,
})

beforeEach(async () => {
  settings.historyLimit = 20
  search.mockReset().mockResolvedValue({
    matches: [],
    embedding: settings.embedding,
    embeddingModel: 'test/embedding',
    complete: true,
  })
  user = await createTestUser()
  ticket = await prismaSupport.supportTicket.create({
    data: { ...user, originDomain: 'binodex.io' },
  })
  await prismaSupport.supportMessage.createMany({
    data: Array.from({ length: 26 }, (_, index) => ({
      ticketId: ticket.id,
      seq: index + 1,
      direction: index % 2 === 0 ? ('IN' as const) : ('OUT' as const),
      text: `message-${index + 1}`,
      // Equal timestamps deliberately: ordering must use per-ticket seq.
      createdAt: new Date('2026-10-01T00:00:00Z'),
    })),
  })
})
afterEach(async () => {
  vi.restoreAllMocks()
  prismaSupport.supportMute.findUnique = originalMuteRead
  prismaExchange.payment.aggregate = originalAggregate
  vi.mocked(listUserWithdrawals).mockClear()
  await cleanupTestUser(user.userId)
})

describe('Zhora ticket context', () => {
  it('builds 20 ordered messages ending at the target and searches using only its last 5', async () => {
    const target = await prismaSupport.supportMessage.findUniqueOrThrow({
      where: { ticketId_seq: { ticketId: ticket.id, seq: 23 } },
    })
    await prismaSupport.supportMessage.update({
      where: { ticketId_seq: { ticketId: ticket.id, seq: 10 } },
      data: { deletedAt: new Date() },
    })
    await prismaSupport.supportMessage.update({
      where: { ticketId_seq: { ticketId: ticket.id, seq: 12 } },
      data: { autoKind: 'agent_greeting' },
    })
    await prismaSupport.supportMessage.create({
      data: {
        ticketId: ticket.id,
        seq: 27,
        direction: 'SYSTEM',
        text: 'system notice',
      },
    })
    const oldTicket = await prismaSupport.supportTicket.create({
      data: { ...user, status: 'CLOSED' },
    })
    await prismaSupport.supportMessage.create({
      data: {
        ticketId: oldTicket.id,
        seq: 1,
        direction: 'IN',
        text: 'other ticket',
      },
    })
    await prismaExchange.$executeRaw`
      INSERT INTO payments (id, user_id, tx_id, type, status, amount, to_usdt)
      VALUES (${randomUUID()}, ${user.userId}, ${randomUUID()}, 'DEPOSIT', 'COMPLETED', 10, 10),
        (${randomUUID()}, ${user.userId}, ${randomUUID()}, 'WITHDRAWAL', 'PENDING', 2, 2)
    `
    const result = await buildZhoraContext({
      ...input(),
      messageId: target.id,
      agentId: null,
    })

    expect(result.history.map((message) => message.seq)).toEqual(
      Array.from({ length: 23 }, (_, index) => index + 1)
        .filter((seq) => seq !== 10 && seq !== 12)
        .slice(-20)
    )
    expect(result.targetMessage.id).toBe(target.id)
    expect(result.searchQuery).toBe(
      [
        'Customer: message-19',
        'Operator: message-20',
        'Customer: message-21',
        'Operator: message-22',
        'Customer: message-23',
      ].join('\n')
    )
    expect(search).toHaveBeenCalledWith({
      question: result.searchQuery,
      originDomain: 'binodex.io',
      ticketId: ticket.id,
      agentId: null,
      minScore: 0.5,
    })
    expect(result.userCard?.fullName).toBe('Тестовый Пользователь')
    expect(result.deposits).toMatchObject([
      { amount: '10.00', status: 'COMPLETED' },
    ])
    expect(result.withdrawals).toMatchObject([
      { amount: '2.00', status: 'PENDING' },
    ])
    expect(result.knowledge).toEqual([])
    expect(result.unavailable).toEqual([])
  })

  it('honors the configured history limit without shrinking the search window and keeps attachment metadata', async () => {
    settings.historyLimit = 2
    const target = await prismaSupport.supportMessage.findUniqueOrThrow({
      where: { ticketId_seq: { ticketId: ticket.id, seq: 25 } },
    })
    await prismaSupport.supportMessage.update({
      where: { id: target.id },
      data: { text: null },
    })
    await prismaSupport.supportAttachment.create({
      data: {
        ticketId: ticket.id,
        messageId: target.id,
        kind: 'IMAGE',
        fileName: 'receipt.png',
        mimeType: 'image/png',
        sizeBytes: 100,
        storagePath: 'media/test/receipt.png',
      },
    })
    const result = await buildZhoraContext(input())
    expect(result.targetMessage.id).toBe(target.id)
    expect(result.history.map((message) => message.seq)).toEqual([24, 25])
    expect(result.searchQuery.split('\n')).toHaveLength(5)
    expect(result.searchQuery).toContain(
      'Customer: [Attachment metadata only: IMAGE, receipt.png]'
    )
    expect(result.searchQuery).not.toContain('message-26')
    expect(result.deposits).toEqual([])
    expect(result.withdrawals).toEqual([])
    expect(result.unavailable).toEqual([])
  })

  it.each([
    'missing',
    'scope',
    'product',
    'closed',
    'muted',
    'mute-read',
  ] as const)(
    'stops before KB search when access cannot be established: %s',
    async (reason) => {
      let args = input()
      let expected: { status?: number; code?: string; message?: string }
      switch (reason) {
        case 'missing':
          args.ticketId = randomUUID()
          expected = { status: 404 }
          break
        case 'scope':
          args.userId = randomUUID()
          expected = { status: 403 }
          break
        case 'product':
          await prismaSupport.supportTicket.update({
            where: { id: ticket.id },
            data: { product: 'PARTNER' },
          })
          expected = { status: 403 }
          break
        case 'closed':
          await prismaSupport.supportTicket.update({
            where: { id: ticket.id },
            data: { status: 'CLOSED' },
          })
          expected = { code: 'TICKET_CLOSED' }
          break
        case 'muted':
          await prismaSupport.supportMute.create({
            data: { ...user, mutedUntil: new Date(Date.now() + 60_000) },
          })
          expected = { code: 'SUPPORT_MUTED' }
          break
        case 'mute-read':
          vi.spyOn(
            prismaSupport.supportMute,
            'findUnique'
          ).mockRejectedValueOnce(new Error('test DB failure'))
          expected = { message: 'test DB failure' }
      }
      await expect(buildZhoraContext(args)).rejects.toMatchObject(expected)
      expect(search).not.toHaveBeenCalled()
    }
  )

  it('rejects a target from another ticket, an operator message and a missing threshold before AI', async () => {
    const otherTicket = await prismaSupport.supportTicket.create({
      data: { ...user, status: 'CLOSED' },
    })
    const other = await prismaSupport.supportMessage.create({
      data: {
        ticketId: otherTicket.id,
        seq: 1,
        direction: 'IN',
        text: 'other',
      },
    })
    const operator = await prismaSupport.supportMessage.findUniqueOrThrow({
      where: { ticketId_seq: { ticketId: ticket.id, seq: 2 } },
    })
    for (const messageId of [other.id, operator.id]) {
      await expect(
        buildZhoraContext({ ...input(), messageId })
      ).rejects.toMatchObject({ status: 404 })
    }
    await expect(
      buildZhoraContext({ ...input(), minScore: NaN })
    ).rejects.toMatchObject({ status: 400 })
    expect(search).not.toHaveBeenCalled()
  })

  it('marks unavailable sources without inventing empty results or accepting fallback card zeros', async () => {
    const aggregate = vi
      .spyOn(prismaExchange.payment, 'aggregate')
      .mockRejectedValueOnce(new Error('test payment aggregate failure'))
    vi.mocked(listUserWithdrawals).mockResolvedValueOnce(null)
    search.mockRejectedValueOnce(new Error('test search failure'))

    const result = await buildZhoraContext(input())
    expect(result.userCard).toBeNull()
    expect(result.deposits).toEqual([])
    expect(result.withdrawals).toBeNull()
    expect(result.knowledge).toBeNull()
    expect(result.unavailable).toEqual(['userCard', 'withdrawals', 'knowledge'])
    expect(result.history).toHaveLength(20)

    // Existing Telegram callers retain their fail-soft behavior.
    aggregate.mockRejectedValueOnce(new Error('same failure in display mode'))
    await expect(getUserCard(user.userId)).resolves.toMatchObject({
      depositsTotal: '0.00',
    })
  })
})
