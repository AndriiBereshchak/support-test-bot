import http from 'node:http'
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'

import client from 'prom-client'
import type { FastifyInstance } from 'fastify'
import { METRICS_VARY, acceptsGzip } from '@binodex/shared'

import { logger } from './logger'

const gzipAsync = promisify(gzip)

// Dedicated registry so we export exactly what we declare here.
export const metricsRegistry = new client.Registry()

// Default process metrics (heap, event-loop lag, CPU, GC, fds). Standard
// names (process_*, nodejs_*), no prefix needed.
client.collectDefaultMetrics({ register: metricsRegistry })

// ─── Per-route HTTP metrics ─────────────────────────────────────────────
// Labels are BOUNDED on purpose:
//   • method — a handful of verbs
//   • route  — Fastify's matched route PATTERN ("/v1/internal/attachments/:id/raw"),
//              NEVER the raw url, so a per-id or random-path flood collapses
//              into one series instead of exploding the registry
//   • status — finite set of HTTP codes
const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency by method/route/status.',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
})

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'HTTP requests by method/route/status.',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [metricsRegistry],
})

/**
 * Attach the request timer.
 *
 * `request.routeOptions.url` is the registered pattern *including the plugin
 * prefix*, and is undefined for anything that matched no route — those all fold
 * into a single `<unmatched>` series, which is what keeps a 404 flood from
 * creating one time series per probed path.
 */
export function registerHttpMetrics(app: FastifyInstance): void {
  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url ?? '<unmatched>'
    const labels = {
      method: request.method,
      route: route.length > 200 ? route.slice(0, 200) : route,
      status: String(reply.statusCode),
    }
    // Fastify measures from the moment the request was received, in ms.
    httpRequestDuration.observe(labels, reply.elapsedTime / 1000)
    httpRequestsTotal.inc(labels)
  })
}

/**
 * Standalone HTTP server serving ONLY GET /metrics (+ /healthz), on its own
 * port — deliberately NOT the API port. Prometheus scrapes it per replica over
 * the private/WireGuard network.
 */
export function startMetricsServer(port: number): http.Server {
  const srv = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/metrics') {
      metricsRegistry
        .metrics()
        .then(async (body) => {
          const headers: Record<string, string> = {
            'Content-Type': metricsRegistry.contentType,
            Vary: METRICS_VARY,
          }
          if (!acceptsGzip(req.headers['accept-encoding'])) {
            return { headers, payload: body as string | Buffer }
          }
          try {
            const payload = await gzipAsync(body)
            return {
              headers: { ...headers, 'Content-Encoding': 'gzip' },
              payload: payload as string | Buffer,
            }
          } catch {
            // A scrape that arrives uncompressed costs bandwidth; one that
            // fails costs the data point. Fall back to plain.
            return { headers, payload: body as string | Buffer }
          }
        })
        .then(({ headers, payload }) => {
          res.writeHead(200, headers)
          res.end(payload)
        })
        .catch((err: unknown) => {
          res.writeHead(500)
          res.end(String(err))
        })
      return
    }
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200)
      res.end('ok')
      return
    }
    res.writeHead(404)
    res.end()
  })
  srv.listen(port, '0.0.0.0', () => {
    logger.info(`[metrics] Prometheus metrics on :${port}/metrics`)
  })
  srv.on('error', (err) => {
    logger.error(`[metrics] server error: ${String(err)}`)
  })
  return srv
}
