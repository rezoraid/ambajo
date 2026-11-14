import type { FastifyPluginAsync } from 'fastify'
import type { Redis } from 'ioredis'
import type { Store } from '../core/types.js'

export const systemRoutes: FastifyPluginAsync<{ store: Store; redis: Redis | null }> = async (app, { store, redis }) => {
  app.get(
    '/health',
    {
      schema: { tags: ['system'], summary: 'Health check (PostgreSQL & Redis)' },
      config: { rateLimit: false }
    },
    async () => {
      const [db, cache] = await Promise.all([
        store.ping(),
        redis ? redis.ping().then(() => true, () => false) : Promise.resolve(false)
      ])
      return { status: db && cache ? 'ok' : 'degraded', db, cache }
    }
  )
}
