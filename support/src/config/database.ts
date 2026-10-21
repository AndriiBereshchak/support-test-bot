import { PrismaClient as PrismaSupportClient } from '@prisma-support'
import { PrismaClient as PrismaExchangeClient } from '@prisma-exchange'
import { PrismaClient as PrismaAffiliateClient } from '@prisma-affiliate'

import { DATABASE_AFFILIATE } from './env'
import { logger } from './logger'

// Own database — the service's source of truth for tickets and messages.
export const prismaSupport = new PrismaSupportClient()

// Cross-service client. READ-ONLY for the ticket-bridge side (the info
// card). The operator-tools bot is the ONE deliberate exception: partner
// binding writes `User.partnerId` with exactly the same statement the admin
// panel uses (admin users.service `setPartner`) — an explicit, whitelisted,
// audited admin action, not chat-flow code. Nothing else in this service may
// write to exchange; that boundary is what keeps this a microservice rather
// than a second head on exchange's schema.
export const prismaExchange = new PrismaExchangeClient()

// Affiliate database — read-only, operator bot only (partner existence
// check + the partner line on a user card). Lazy: constructed on first use
// so a replica without DATABASE_AFFILIATE boots and runs everything else.
let affiliateClient: PrismaAffiliateClient | null = null
export function getPrismaAffiliate(): PrismaAffiliateClient | null {
  if (!DATABASE_AFFILIATE) return null
  affiliateClient ??= new PrismaAffiliateClient({
    datasources: { db: { url: DATABASE_AFFILIATE } },
  })
  return affiliateClient
}

export async function shutdownPrisma(): Promise<void> {
  await Promise.allSettled([
    prismaSupport.$disconnect(),
    prismaExchange.$disconnect(),
    affiliateClient?.$disconnect() ?? Promise.resolve(),
  ])
  logger.debug('[db] prisma clients disconnected')
}
