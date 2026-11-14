import { createHash } from 'node:crypto'
import compress from '@fastify/compress'
import rateLimit from '@fastify/rate-limit'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import Fastify from 'fastify'
import { Redis } from 'ioredis'
import type { Config } from './config.js'
import { Cache } from './core/cache.js'
import { AppError } from './core/errors.js'
import { migrate } from './db/migrate.js'
import { createPool } from './db/pool.js'
import { PgStore } from './db/store.js'
import { createProviders } from './providers/index.js'
import { catalogRoutes } from './routes/catalog.js'
import { seriesRoutes } from './routes/series.js'
import { systemRoutes } from './routes/system.js'
import { ScraperService } from './services/scraper.js'
import { ViewCounter } from './services/views.js'
import { Warmer } from './services/warmer.js'

/** Composition root: merangkai semua dependensi. */
export async function createApp(cfg: Config) {
  const app = Fastify({
    logger: { level: cfg.logLevel },
    trustProxy: cfg.trustProxy,
    maxParamLength: 300
  })
  const log = app.log

  // ---- PostgreSQL ----
  const pool = createPool(cfg)
  if (cfg.autoMigrate) {
    const applied = await migrate(pool)
    if (applied.length) log.info({ applied }, 'migrations applied')
  }
  const store = new PgStore(pool)

  // ---- Redis (opsional saat runtime: jika mati, cache dilewati) ----
  const redis = new Redis(cfg.redisUrl, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 2_000,
    retryStrategy: n => Math.min(n * 200, 3_000)
  })
  let lastRedisLog = 0
  redis.on('error', e => {
    if (Date.now() - lastRedisLog > 10_000) {
      lastRedisLog = Date.now()
      log.warn({ err: e.message }, 'redis error')
    }
  })
  await Promise.race([new Promise(r => redis.once('ready', r)), new Promise(r => setTimeout(r, 3_000))])

  // ---- domain ----
  const adapters = createProviders(cfg.providers)
  await store.syncProviders(adapters.map(a => ({ key: a.key, name: a.name, baseUrl: a.baseUrl })))
  const views = new ViewCounter(store, log)
  const svc = new ScraperService({ adapters, cache: new Cache(redis, log), store, views, log, cfg })
  const warmer = new Warmer(svc, store, cfg.providers, log, cfg.warmer)

  // ---- ETag (dihitung sebelum kompresi) ----
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.method !== 'GET' || reply.statusCode !== 200 || typeof payload !== 'string') return payload
    const etag = `W/"${createHash('sha1').update(payload).digest('base64url').slice(0, 22)}"`
    reply.header('etag', etag)
    if (req.headers['if-none-match'] === etag) {
      reply.code(304)
      return ''
    }
    return payload
  })
  await app.register(compress, { threshold: 1024, encodings: ['gzip', 'deflate'] })

  // ---- rate limit (state di Redis; jika Redis down request tetap lolos) ----
  await app.register(rateLimit, {
    max: cfg.rateLimitMax,
    timeWindow: '1 minute',
    redis,
    nameSpace: 'rl:',
    skipOnError: true,
    allowList: req => req.url.startsWith('/docs') || req.url === '/health'
  })

  // ---- dokumentasi ----
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Unified Scraper API',
        version: '1.0.0',
        description:
          'Satu API untuk provider Shinigami, Manta, dan Lumos dengan format data seragam.\n\n' +
          'Id unified: `<provider>:<id asli>`. Respons sukses: `{ data, meta }`. Error: `{ error: { code, message } }`.'
      },
      tags: [
        { name: 'catalog', description: 'Search, latest, popular, genre' },
        { name: 'series', description: 'Detail seri & daftar chapter' },
        { name: 'chapters', description: 'Gambar chapter' },
        { name: 'system', description: 'Health & status' }
      ]
    }
  })
  await app.register(swaggerUi, { routePrefix: '/docs' })

  // ---- error handling ----
  app.setErrorHandler((err: any, req, reply) => {
    let status = 500
    let code = 'INTERNAL_ERROR'
    let message = 'Internal server error'
    if (err instanceof AppError) {
      ;({ status, code, message } = err)
    } else if (err?.validation) {
      status = 400
      code = 'BAD_REQUEST'
      message = err.message
    } else if (err?.statusCode && err.statusCode < 500) {
      status = err.statusCode
      code = status === 429 ? 'RATE_LIMITED' : 'BAD_REQUEST'
      message = err.message
    } else {
      req.log.error({ err }, 'unhandled error')
    }
    void reply.code(status).send({ error: { code, message } })
  })
  app.setNotFoundHandler((_req, reply) => {
    void reply.code(404).send({ error: { code: 'ROUTE_NOT_FOUND', message: 'Route not found' } })
  })

  // ---- routes ----
  await app.register(systemRoutes, { store, redis })
  await app.register(
    async v1 => {
      await v1.register(catalogRoutes, { svc })
      await v1.register(seriesRoutes, { svc })
    },
    { prefix: '/v1' }
  )

  // ---- lifecycle ----
  app.addHook('onReady', async () => {
    views.start()
    if (cfg.warmer.enabled) warmer.start()
  })
  app.addHook('onClose', async () => {
    warmer.stop()
    await views.stop()
    await pool.end().catch(() => {})
    redis.disconnect()
  })

  return app
}
