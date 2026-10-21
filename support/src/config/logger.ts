import { inspect } from 'util'

import {
  renderLogLine,
  resolveLogColor,
  resolveLogLevel,
} from '@binodex/shared'
import winston from 'winston'

// Same line shape as every other service (`renderLogLine` in `@binodex/shared`)
// so log aggregation stays uniform. What stays here is the wiring that needs
// winston and `process`.
//
// This service was already the closest to right — it gated the level on
// NODE_ENV while the others hardcoded 'debug' — but it shared their local-time
// `DD-MM-YYYY` timestamp, which is neither sortable nor UTC.

const COLORS = resolveLogColor(process.env, Boolean(process.stdout.isTTY))

const JSON_LOGS = process.env.LOG_FORMAT === 'json'

export const logger = winston.createLogger({
  level: resolveLogLevel(process.env),
  format: winston.format.combine(
    // Bare `timestamp()` is ISO-8601 UTC.
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.printf((info) =>
      renderLogLine(info, { colors: COLORS, json: JSON_LOGS, inspect })
    )
  ),
  transports: [new winston.transports.Console()],
})
