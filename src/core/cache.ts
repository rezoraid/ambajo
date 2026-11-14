import type { FastifyBaseLogger } from 'fastify'

/** Subset ioredis yang dipakai. */
export interface KV {
  get(key: string): Promise<string | null>
  set(key: string, value: string, mode: 'PX', ms: number): Promise<unknown>
}

export type CacheState = 'hit' | 'stale' | 'miss'
export interface Ttl {
  fresh: number
  stale: number
}
interface Envelope<T> {
  v: T
  f: number
}

/**
 * Cache Redis dengan stale-while-revalidate + singleflight.
 *  - fresh  : langsung dipakai
 *  - stale  : dipakai langsung, di-refresh di background
 *  - gagal  : jika loader error dan masih ada data stale, data stale dipakai
 * Redis mati -> cache dilewati (layanan tetap jalan).
 */
export class Cache {
  private readonly inflight = new Map<string, Promise<unknown>>()

  constructor(
    private readonly kv: KV | null,
    private readonly log: FastifyBaseLogger
  ) {}

  async getOrSet<T>(key: string, ttl: Ttl, load: () => Promise<T>): Promise<{ value: T; state: CacheState }> {
    const env = await this.read<T>(key)
    if (env && Date.now() < env.f) return { value: env.v, state: 'hit' }
    if (env) {
      void this.refresh(key, ttl, load).catch(() => {})
      return { value: env.v, state: 'stale' }
    }
    return { value: await this.refresh(key, ttl, load), state: 'miss' }
  }

  private refresh<T>(key: string, ttl: Ttl, load: () => Promise<T>): Promise<T> {
    const running = this.inflight.get(key) as Promise<T> | undefined
    if (running) return running
    const p = (async () => {
      const v = await load()
      await this.write(key, v, ttl)
      return v
    })().finally(() => this.inflight.delete(key))
    this.inflight.set(key, p)
    return p
  }

  private async read<T>(key: string): Promise<Envelope<T> | null> {
    if (!this.kv) return null
    try {
      const raw = await this.kv.get(key)
      return raw ? (JSON.parse(raw) as Envelope<T>) : null
    } catch (e) {
      this.log.warn({ err: (e as Error).message, key }, 'cache read failed')
      return null
    }
  }

  private async write<T>(key: string, v: T, ttl: Ttl): Promise<void> {
    if (!this.kv) return
    try {
      await this.kv.set(key, JSON.stringify({ v, f: Date.now() + ttl.fresh } satisfies Envelope<T>), 'PX', ttl.fresh + ttl.stale)
    } catch (e) {
      this.log.warn({ err: (e as Error).message, key }, 'cache write failed')
    }
  }
}
