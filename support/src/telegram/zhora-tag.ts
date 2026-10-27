import type { SupportTicketCategory } from '@prisma-support'
import { prismaSupport } from '@config/database'
import { TICKET_CATEGORIES, ticketCategoryLabel } from '@core/ticket-category'
import { refreshPinnedTicketCard } from '@apps/services/chat.service'
import { sendPlainMessage, ZHORA_TAG_CALLBACK_PREFIX } from './api'
import { prepareZhoraInvocation } from './zhora'

type TagContext = {
  chatId: number
  topicId: number | null
  fromId: number
  isBot?: boolean
}

export async function showTagMenu(ctx: TagContext): Promise<void> {
  const prepared = await prepareZhoraInvocation(ctx)
  if (!prepared) return
  const current = prepared.ticket.category
    ? ticketCategoryLabel(prepared.ticket.category)
    : 'не определена'
  await sendPlainMessage({
    chatId: ctx.chatId,
    topicId: ctx.topicId,
    text: `Тема тикета: ${current}. Выберите новую категорию:`,
    replyMarkup: {
      inline_keyboard: TICKET_CATEGORIES.map(({ code, label }) => [
        {
          text: current === label ? `✓ ${label}` : label,
          callback_data: `${ZHORA_TAG_CALLBACK_PREFIX}${prepared.ticket.id}:${code}`,
        },
      ]),
    },
  })
}

export async function setManualTag(
  ctx: TagContext & { ticketId: string; category: SupportTicketCategory }
): Promise<void> {
  const prepared = await prepareZhoraInvocation({
    ...ctx,
    ticketId: ctx.ticketId,
  })
  if (!prepared) return
  const changed = await prismaSupport.supportTicket.updateMany({
    where: { id: ctx.ticketId, status: 'OPEN' },
    data: {
      category: ctx.category,
      categoryManual: true,
      categoryJobId: null,
      categoryClassifyPending: false,
    },
  })
  if (!changed.count) return
  const ticket = await prismaSupport.supportTicket.findUniqueOrThrow({
    where: { id: ctx.ticketId },
  })
  await refreshPinnedTicketCard(ticket)
  await sendPlainMessage({
    chatId: ctx.chatId,
    topicId: ctx.topicId,
    text: `Тема тикета: ${ticketCategoryLabel(ctx.category)} (выбрана оператором).`,
  })
}
