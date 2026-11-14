import type { FastifyPluginAsync } from 'fastify'
import type { ScraperService } from '../services/scraper.js'
import { R, idParam } from './schemas.js'

const publicCache = (seconds: number) => ({ 'cache-control': `public, max-age=${seconds}` })

export const seriesRoutes: FastifyPluginAsync<{ svc: ScraperService }> = async (app, { svc }) => {
  const seriesId = idParam('Id seri unified, mis. "shinigami:<uuid>", "manta:123", "lumos:<slug>"')

  app.get<{ Params: { id: string } }>(
    '/series/:id',
    {
      schema: {
        tags: ['series'],
        summary: 'Detail seri + daftar chapter',
        description: 'Jika provider asal gagal, otomatis dialihkan ke provider lain yang memiliki judul sama (`meta.fallback = true`).',
        params: seriesId,
        response: R.detail
      }
    },
    async (req, reply) => reply.headers(publicCache(300)).send(await svc.detail(req.params.id))
  )

  app.get<{ Params: { id: string } }>(
    '/series/:id/chapters',
    { schema: { tags: ['series'], summary: 'Daftar chapter (terbaru -> terlama)', params: seriesId, response: R.chapters } },
    async (req, reply) => reply.headers(publicCache(300)).send(await svc.chapters(req.params.id))
  )

  app.get<{ Params: { id: string } }>(
    '/chapters/:id',
    {
      schema: {
        tags: ['chapters'],
        summary: 'Gambar chapter',
        description:
          'Id chapter diambil dari `chapters[].id`. Jika provider gagal, dicarikan chapter bernomor sama di provider lain. ' +
          'Unduh gambar dengan header `imageHeaders`.',
        params: idParam('Id chapter unified, mis. "shinigami:<uuid>", "manta:<seri>:<episode>", "lumos:<slug>:<chapter-slug>"'),
        response: R.chapter
      }
    },
    async (req, reply) => reply.headers(publicCache(300)).send(await svc.chapter(req.params.id))
  )
}
