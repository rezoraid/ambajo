import type { FastifyBaseLogger } from 'fastify'
import type { ProviderKey, Store } from '../core/types.js'
import type { ScraperService } from './scraper.js'

/**
 * Tugas latar berkala:
 *  1. ambil "latest" tiap provider -> cache hangat + tabel series/genres terisi
 *  2. perkaya beberapa seri tanpa genre (mis. Lumos, yang list-nya tidak memuat genre) lewat halaman detail
 *  3. bersihkan data view lama
 */
export class Warmer {
  private timer?: NodeJS.Timeout
  private stopped = false

  constructor(
    private readonly svc: ScraperService,
    private readonly store: Store,
    private readonly providers: ProviderKey[],
    private readonly log: FastifyBaseLogger,
    private readonly cfg: { intervalMs: number; enrich: number }
  ) {}

  start(firstDelayMs = 5_000) {
    this.schedule(firstDelayMs)
  }

  stop() {
    this.stopped = true
    clearTimeout(this.timer)
  }

  private schedule(ms: number) {
    if (this.stopped) return
    this.timer = setTimeout(() => void this.run().finally(() => this.schedule(this.cfg.intervalMs)), ms)
    this.timer.unref()
  }

  async run() {
    for (const provider of this.providers) {
      await this.svc.latest({ page: 1, limit: 20, provider }).catch(e => this.log.warn({ provider, err: (e as Error).message }, 'warm latest failed'))
    }
    try {
      for (const { provider, ref } of await this.store.needingDetail(this.cfg.enrich)) {
        if (this.stopped) return
        await this.svc.refreshDetail(provider, ref).catch(e => this.log.warn({ provider, ref, err: (e as Error).message }, 'warm detail failed'))
      }
      await this.store.prune()
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, 'warm maintenance failed')
    }
  }
}
