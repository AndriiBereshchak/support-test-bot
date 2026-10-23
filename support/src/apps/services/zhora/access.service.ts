import type { SupportTicket } from '@prisma-support'
import { prismaSupport } from '@config/database'
import { ApiError } from '@core/errors/api-error'

/** Call with a freshly loaded ticket before starting an AI operation.
 * Unlike the ordinary chat's fail-open mute display, an unreadable access
 * check stops new AI work. Transport authentication stays at the boundary. */
export async function assertZhoraTicketAvailable(
  ticket: Pick<SupportTicket, 'status' | 'product' | 'userId'>
): Promise<void> {
  if (ticket.status !== 'OPEN') {
    throw new ApiError('Ticket is closed', 409, 'TICKET_CLOSED')
  }
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
}
