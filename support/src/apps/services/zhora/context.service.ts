import type { Prisma, SupportProduct } from '@prisma-support'
import { prismaSupport } from '@config/database'
import { ZHORA_CONTEXT_MESSAGE_LIMIT } from '@config/env'
import { logger } from '@config/logger'
import { ApiError } from '@core/errors/api-error'
import { listUserDeposits } from '../deposit-list.service'
import { listUserWithdrawals } from '../withdrawal-list.service'
import { getUserCard } from '../user-card.service'
import { searchZhoraKb } from './kb-search.service'

const SEARCH_MESSAGE_LIMIT = 5
const messageSelect = {
  id: true,
  seq: true,
  direction: true,
  text: true,
  createdAt: true,
  agentId: true,
  agent: { select: { displayName: true } },
  // Metadata only: no file reads, OCR or claims about attachment contents.
  attachments: { select: { kind: true, fileName: true } },
} satisfies Prisma.SupportMessageSelect

type ContextMessageRow = Prisma.SupportMessageGetPayload<{
  select: typeof messageSelect
}>

function contextMessage(row: ContextMessageRow) {
  return {
    id: row.id,
    seq: row.seq,
    author:
      row.direction === 'IN' ? ('customer' as const) : ('operator' as const),
    agentId: row.agentId,
    agentName: row.agent?.displayName ?? null,
    text: row.text,
    attachments: row.attachments,
    createdAt: row.createdAt,
  }
}

export interface ZhoraContextInput {
  ticketId: string
  /** Customer scope resolved by a trusted caller, not operator identity.
   * Telegram group/operator authentication remains at the transport boundary. */
  userId: string
  product?: SupportProduct
  /** Omit for the latest customer message. Must belong to this ticket. */
  messageId?: string
  agentId?: string | null
  /** No default until calibrated against the actual model and KB. */
  minScore: number
}

/** Prepare facts only; does not generate a reply or send anything to Telegram.
 * KB search may make one audited, budget-checked embedding request. */
export async function buildZhoraContext(input: ZhoraContextInput) {
  if (
    !Number.isFinite(input.minScore) ||
    input.minScore < -1 ||
    input.minScore > 1
  ) {
    throw new ApiError(
      'Invalid KB search threshold',
      400,
      'ZHORA_CONTEXT_INVALID'
    )
  }
  const ticket = await prismaSupport.supportTicket.findUnique({
    where: { id: input.ticketId },
    select: {
      id: true,
      userId: true,
      userNId: true,
      product: true,
      status: true,
      originDomain: true,
    },
  })
  if (!ticket) throw new ApiError('Ticket not found', 404)
  if (
    ticket.userId !== input.userId ||
    ticket.product !== (input.product ?? 'PLATFORM')
  ) {
    throw new ApiError('Forbidden', 403)
  }
  if (ticket.status !== 'OPEN') {
    throw new ApiError('Ticket is closed', 409, 'TICKET_CLOSED')
  }
  // Unlike the chat's fail-open mute display, an unreadable access check must
  // stop a new AI operation. Do not substitute "not muted" on a DB failure.
  const mute = await prismaSupport.supportMute.findUnique({
    where: {
      product_userId: { product: ticket.product, userId: ticket.userId },
    },
    select: { mutedUntil: true },
  })
  if (mute?.mutedUntil && mute.mutedUntil.getTime() > Date.now()) {
    throw new ApiError(
      'Support access is temporarily restricted',
      403,
      'SUPPORT_MUTED'
    )
  }

  const conversation: Prisma.SupportMessageWhereInput = {
    ticketId: ticket.id,
    deletedAt: null,
    autoKind: null,
    direction: { in: ['IN', 'OUT'] },
  }
  const target = await prismaSupport.supportMessage.findFirst({
    where: {
      ...conversation,
      direction: 'IN',
      ...(input.messageId ? { id: input.messageId } : {}),
    },
    orderBy: { seq: 'desc' },
    select: messageSelect,
  })
  if (!target) throw new ApiError('Customer message not found in ticket', 404)

  const rows = await prismaSupport.supportMessage.findMany({
    where: { ...conversation, seq: { lte: target.seq } },
    orderBy: { seq: 'desc' },
    take: Math.max(ZHORA_CONTEXT_MESSAGE_LIMIT, SEARCH_MESSAGE_LIMIT),
    select: messageSelect,
  })
  const messages = rows.reverse().map(contextMessage)
  const targetMessage = messages[messages.length - 1]
  // A deletion between the target lookup and history read must not turn a
  // different message into the question. Use the latest text if it was edited.
  if (!targetMessage || targetMessage.id !== target.id) {
    throw new ApiError('Customer message not found in ticket', 404)
  }
  const searchQuery = messages
    .slice(-SEARCH_MESSAGE_LIMIT)
    .map((message) => {
      const attachments = message.attachments
        .map(
          (file) => `[Attachment metadata only: ${file.kind}, ${file.fileName}]`
        )
        .join(' ')
      return `${message.author === 'customer' ? 'Customer' : 'Operator'}: ${[
        message.text,
        attachments,
      ]
        .filter(Boolean)
        .join(' ')}`
    })
    .join('\n')

  const [card, deposits, withdrawals, knowledge] = await Promise.allSettled([
    getUserCard(ticket.userId, { requireComplete: true }),
    listUserDeposits(ticket.userId),
    listUserWithdrawals(ticket.userId),
    searchZhoraKb({
      question: searchQuery,
      originDomain: ticket.originDomain,
      ticketId: ticket.id,
      agentId: input.agentId,
      minScore: input.minScore,
    }),
  ])
  const unavailable: string[] = []
  function available<T>(
    result: PromiseSettledResult<T>,
    source: string
  ): T | null {
    if (result.status === 'fulfilled' && result.value !== null)
      return result.value
    unavailable.push(source)
    // No customer text, credentials or provider error body in the log.
    logger.warn(`[zhora] Context source unavailable: ${source}`)
    return null
  }

  return {
    ticket,
    targetMessage,
    history: messages.slice(-ZHORA_CONTEXT_MESSAGE_LIMIT),
    searchQuery,
    userCard: available(card, 'userCard'),
    deposits: available(deposits, 'deposits'),
    withdrawals: available(withdrawals, 'withdrawals'),
    knowledge: available(knowledge, 'knowledge'),
    unavailable,
  }
}

export type ZhoraContext = Awaited<ReturnType<typeof buildZhoraContext>>
