import { config as loadDotenv } from 'dotenv'
import { resolve } from 'node:path'

// Load .env.test BEFORE any module that reads env at import time (config/env,
// prismaSupport, redisClient) is pulled in. Vitest runs this file via
// `setupFiles` at the top of every test process, so it wins that race.
loadDotenv({ path: resolve(__dirname, '..', '.env.test') })

// Defaults for the two variables the integration suite cannot run without,
// applied only when .env.test leaves them empty.
//
// SUPPORT_CHAT_ID is load-bearing rather than cosmetic: `updates.isSupportChat`
// compares every incoming update against it, and an unset id (0) makes the
// router drop EVERY update — the Telegram-side tests would then pass for the
// wrong reason (nothing happened because nothing was ever routed).
process.env.SUPPORT_CHAT_ID ||= '-1002000000001'

// Attachment bytes land here. Kept inside the workspace (under the gitignored
// `.tmp`) so a failed run leaves its evidence somewhere obvious instead of
// scattered through the system temp dir.
process.env.SUPPORT_FILES_DIR ||= resolve(
  __dirname,
  '..',
  '.tmp',
  'support-files'
)
