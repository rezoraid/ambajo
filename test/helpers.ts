import type { FastifyBaseLogger } from 'fastify'
import type { KV } from '../src/core/cache.js'

export const noopLog = new Proxy({}, { get: () => () => {} }) as unknown as FastifyBaseLogger

export class MemoryKV implements KV {
  readonly data = new Map<string, string>()
  async get(k: string) {
    return this.data.get(k) ?? null
  }
  async set(k: string, v: string) {
    this.data.set(k, v)
    return 'OK'
  }
}

/** Ganti global fetch dengan router berbasis substring URL. */
export function mockFetch(routes: Record<string, () => { status?: number; json?: unknown; text?: string }>) {
  const calls: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: any) => {
    const url = String(input)
    calls.push(url)
    const key = Object.keys(routes).find(k => url.includes(k))
    if (!key) return new Response('no route: ' + url, { status: 599 })
    const r = routes[key]()
    return new Response(r.json !== undefined ? JSON.stringify(r.json) : (r.text ?? ''), { status: r.status ?? 200 })
  }) as typeof fetch
  return { calls, restore: () => void (globalThis.fetch = original) }
}
