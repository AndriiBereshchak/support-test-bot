import dotenv from 'dotenv'

// MUST be the first import in server.ts — ahead of `./instrument` (which reads
// SENTRY_DSN and NODE_ENV straight off process.env, before @config/env exists)
// and ahead of anything that pulls in a generated Prisma client.
//
// Prisma's generated clients load a .env of their OWN at require() time,
// resolved next to the schema they were generated from. `@prisma-exchange`
// therefore injects `backend/exchange/.env` into this process — and dotenv
// never overwrites a key that is already set, so whichever loader runs first
// wins every shared key. Import order used to hand that race to exchange
// (server.ts requires @config/database before @config/env), and the support
// service booted on exchange's APP_PORT against exchange's Redis.
//
// Loading our own file here first makes it authoritative. Real environment
// variables — set before node starts, which is how the container is configured
// — still beat both, so production behaviour is unchanged.
dotenv.config({ quiet: true })
