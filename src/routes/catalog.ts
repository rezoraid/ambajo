import type { FastifyPluginAsync } from 'fastify'
import type { ProviderKey, SortKey } from '../core/types.js'
import type { ScraperService } from '../services/scraper.js'
import { Q, R, envelope } from './schemas.js'

interface Paged {
  page: number
  limit: number
  provider?: ProviderKey
}

const publicCache = (seconds: number) => ({ 'cache-control': `public, max-age=${seconds}` })

export const catalogRoutes: FastifyPluginAsync<{ svc: ScraperService }> = async (app, { svc }) => {
  app.get(
    '/providers',
    {
      schema: {
        tags: ['system'],
        summary: 'Provider aktif, status circuit breaker, dan header gambar',
        response: {
          200: {
            type: 'object',
            properties: {
              data: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    key: { type: 'string' },
                    name: { type: 'string' },
                    baseUrl: { type: 'string' },
                    priority: { type: 'integer' },
                    circuit: { type: 'string', description: 'closed | open | half-open' },
                    lastOkAt: { type: 'string', nullable: true },
                    lastError: { type: 'string', nullable: true },
                    lastMs: { type: 'integer', nullable: true },
                    imageHeaders: { type: 'object', additionalProperties: { type: 'string' } }
                  }
                }
              }
            }
          }
        }
      }
    },
    async () => ({ data: svc.providers() })
  )


  app.get<{ Querystring: Paged & { q: string } }>(
    '/search',
    {
      schema: { tags: ['catalog'], summary: 'Cari seri di semua provider', querystring: Q.search, response: R.list },
      config: { rateLimit: { max: 40, timeWindow: '1 minute' } }
    },
    async (req, reply) => reply.headers(publicCache(60)).send(await svc.search(req.query.q.trim(), req.query))
  )

  app.get<{ Querystring: Paged & { type?: string } }>(
    '/latest',
    { schema: { tags: ['catalog'], summary: 'Update terbaru', querystring: Q.latest, response: R.list } },
    async (req, reply) => reply.headers(publicCache(60)).send(await svc.latest(req.query))
  )

  app.get<{ Querystring: Paged & { days: number } }>(
    '/popular',
    {
      schema: {
        tags: ['catalog'],
        summary: 'Seri populer',
        description: 'Diurutkan dari jumlah hit detail lewat API ini dalam `days` hari terakhir; seri tanpa hit diurutkan rating lalu terbaru.',
        querystring: Q.popular,
        response: R.list
      }
    },
    async (req, reply) => reply.headers(publicCache(60)).send(await svc.popular(req.query))
  )

  const genreList = envelope(
    {
      type: 'array',
      items: {
        type: 'object',
        properties: { slug: { type: 'string' }, name: { type: 'string' }, count: { type: 'integer' } }
      }
    },
    { type: 'object', properties: { source: { type: 'string' } } }
  )

  app.get(
    '/genres',
    {
      schema: {
        tags: ['catalog'],
        summary: 'Daftar genre',
        description: 'Dibangun dari genre seri yang pernah dilihat API (list/detail provider).',
        response: { 200: genreList }
      }
    },
    async (_req, reply) => {
      const { data, source } = await svc.genres()
      return reply.headers(publicCache(300)).send({ data, meta: { source } })
    }
  )

  app.get<{ Params: { slug: string }; Querystring: Paged & { sort: SortKey; type?: string; status?: string } }>(
    '/genres/:slug/series',
    {
      schema: {
        tags: ['catalog'],
        summary: 'Seri berdasarkan genre (+ sortir & filter format/status)',
        description: 'Lumos ditarik live dari katalognya (genre/sort/type/status native); provider lain dari data tersimpan. Sortir & filter akhir dilakukan di PostgreSQL.',
        params: { type: 'object', properties: { slug: { type: 'string', minLength: 1, maxLength: 80 } }, required: ['slug'] },
        querystring: Q.genre,
        response: R.list
      }
    },
    async (req, reply) => reply.headers(publicCache(60)).send(await svc.byGenre(req.params.slug.toLowerCase(), req.query))
  )
}
