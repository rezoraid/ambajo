import type { FastifyBaseLogger } from 'fastify'
import type { ProviderKey, Store } from '../core/types.js'

/** Buffer hit detail di memori, ditulis ke PostgreSQL berkala dalam 1 query (tidak membebani request). */
export class ViewCounter {
  private readonly buf = new Map<string, { provider: ProviderKey; ref: string; n: number }>()
  private timer?: NodeJS.Timeout

  constructor(
    private readonly store: Pick<Store, 'addViews'>,
    private readonly log: FastifyBaseLogger,
    private readonly intervalMs = 15_000
  ) {}

  hit(provider: ProviderKey, ref: string) {
    const key = `${provider}\0${ref}`
    const e = this.buf.get(key)
    if (e) e.n++
    else this.buf.set(key, { provider, ref, n: 1 })
  }

  start() {
    this.timer = setInterval(() => void this.flush(), this.intervalMs)
    this.timer.unref()
  }

  async flush() {
    if (!this.buf.size) return
    const rows = [...this.buf.values()]
    this.buf.clear()
    try {
      await this.store.addViews(rows)
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, 'flush views failed')
    }
  }

  async stop() {
    clearInterval(this.timer)
    await this.flush()
  }
}
