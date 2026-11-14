import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Cache } from '../src/core/cache.js'
import { UpstreamError } from '../src/core/errors.js'
import type { ProviderAdapter, ProviderKey, SeriesDetail, SeriesSummary, Store } from '../src/core/types.js'
import { ScraperService } from '../src/services/scraper.js'
import { MemoryKV, noopLog } from './helpers.js'

const item = (p: ProviderKey, ref: string, title: string): SeriesSummary => ({
  id: `${p}:${ref}`, provider: p, title, cover: '', url: '', type: null, status: null, genres: [], rating: null,
  chapterCount: null, latestChapter: null, sources: [{ provider: p, id: `${p}:${ref}` }]
})
const detailOf = (p: ProviderKey, ref: string, title: string, nums: string[]): SeriesDetail => ({
  ...item(p, ref, title), synopsis: '', author: '', artist: '', year: null,
  chapters: nums.map(n => ({ id: `${p}:${ref}:${n}`, number: n, title: '', date: null }))
})

function adapter(key: ProviderKey, o: { fail?: boolean; titles?: string[] } = {}) {
  const state = { fail: !!o.fail, calls: 0 }
  const guard = async <T>(v: T): Promise<T> => {
    state.calls++
    if (state.fail) throw new UpstreamError(`${key} down`)
    return v
  }
  const titles = o.titles ?? ['Solo Leveling']
  const a: ProviderAdapter = {
    key, name: key, baseUrl: '',
    search: () => guard(titles.map((t, i) => item(key, `${i}`, t))),
    latest: () => guard(titles.map((t, i) => item(key, `${i}`, t))),
    detail: ref => guard(detailOf(key, ref, titles[0], ['2', '1'])),
    chapter: ref => guard({ id: `${key}:${ref}`, seriesId: null, number: '1', images: [`${key}.jpg`], prev: null, next: null, imageHeaders: {} }),
    imageHeaders: () => ({})
  }
  return { a, state }
}

function fakeStore(over: Partial<Store> = {}): Store {
  const noop = async () => undefined
  return {
    syncProviders: noop, saveSummaries: noop, saveDetail: noop, addViews: noop, prune: noop,
    findSeries: async () => null, siblings: async () => [], findChapter: async () => null,
    searchLocal: async () => [], latestLocal: async () => [], popular: async () => [], genres: async () => [], byGenre: async () => [],
    needingDetail: async () => [], ping: async () => true, ...over
  }
}

const cfg = {
  ttl: { search: { fresh: 1000, stale: 5000 }, latest: { fresh: 1000, stale: 5000 }, detail: { fresh: 1000, stale: 5000 }, chapter: { fresh: 1000, stale: 5000 }, db: { fresh: 1000, stale: 5000 }, genres: { fresh: 1000, stale: 5000 } },
  aggregateTimeoutMs: 500, primaryTimeoutMs: 500
}
const make = (adapters: ProviderAdapter[], store = fakeStore()) => {
  const hits: string[] = []
  const svc = new ScraperService({ adapters, cache: new Cache(new MemoryKV(), noopLog), store, views: { hit: (p, r) => void hits.push(`${p}:${r}`) }, log: noopLog, cfg })
  return { svc, hits }
}
const q = { page: 1, limit: 10 }

describe('ScraperService list', () => {
  it('menggabungkan provider & dedupe judul sama (sources terkumpul)', async () => {
    const { svc } = make([adapter('shinigami').a, adapter('manta', { titles: ['Solo-Leveling', 'Other'] }).a])
    const r = await svc.search('solo', q)
    assert.deepEqual(r.data.map(d => d.title), ['Solo Leveling', 'Other'])
    assert.deepEqual(r.data[0].sources.map(s => s.id), ['shinigami:0', 'manta:0'])
    assert.equal(r.meta.degraded, false)
    assert.equal(r.meta.source, 'upstream')
    assert.equal((await svc.search('solo', q)).meta.source, 'cache')
  })

  it('satu provider gagal -> hasil provider lain, degraded', async () => {
    const { svc } = make([adapter('shinigami', { fail: true }).a, adapter('manta').a])
    const r = await svc.latest(q)
    assert.equal(r.data.length, 1)
    assert.equal(r.meta.degraded, true)
    assert.deepEqual(r.meta.providers, { shinigami: 'error', manta: 'ok' })
  })

  it('semua gagal -> data dari DB; DB kosong -> 502', async () => {
    const down = () => [adapter('shinigami', { fail: true }).a, adapter('manta', { fail: true }).a]
    const withDb = make(down(), fakeStore({ searchLocal: async () => [item('manta', '1', 'Dari DB')] }))
    const r = await withDb.svc.search('x', q)
    assert.equal(r.meta.source, 'db')
    assert.equal(r.data[0].title, 'Dari DB')
    await assert.rejects(make(down()).svc.search('x', q), { code: 'UPSTREAM_ERROR' })
  })

  it('circuit breaker terbuka setelah 5 kegagalan -> provider dilewati cepat', async () => {
    const bad = adapter('shinigami', { fail: true })
    const { svc } = make([bad.a, adapter('manta').a])
    for (let i = 1; i <= 6; i++) await svc.search(`q${i}`, q)
    assert.equal(bad.state.calls, 5)
    assert.equal(svc.providers()[0].circuit, 'open')
    assert.equal((await svc.search('q7', q)).meta.providers.shinigami, 'unavailable')
  })

  it('provider= membatasi ke satu provider', async () => {
    const m = adapter('manta')
    const { svc } = make([adapter('shinigami').a, m.a])
    const r = await svc.latest({ ...q, provider: 'manta' })
    assert.deepEqual(Object.keys(r.meta.providers), ['manta'])
  })
})

describe('ScraperService detail/chapter fallback', () => {
  it('detail: provider asal gagal -> sibling dari DB', async () => {
    const store = fakeStore({
      findSeries: async () => ({ title: 'Solo Leveling', normTitle: 'sololeveling' }),
      siblings: async () => [{ provider: 'manta', ref: '77' }]
    })
    const { svc, hits } = make([adapter('shinigami', { fail: true }).a, adapter('manta').a], store)
    const r = await svc.detail('shinigami:abc')
    assert.equal(r.meta.fallback, true)
    assert.equal(r.meta.provider, 'manta')
    assert.equal(r.meta.requestedId, 'shinigami:abc')
    assert.equal(r.data.id, 'manta:77')
    assert.deepEqual(hits, ['manta:77'])
  })

  it('detail: tanpa sibling di DB -> cari via search provider lain', async () => {
    const store = fakeStore({ findSeries: async () => ({ title: 'Solo Leveling', normTitle: 'sololeveling' }) })
    const { svc } = make([adapter('shinigami', { fail: true }).a, adapter('manta', { titles: ['solo leveling'] }).a], store)
    const r = await svc.detail('shinigami:abc')
    assert.equal(r.meta.fallback, true)
    assert.equal(r.data.id, 'manta:0')
  })

  it('detail: gagal & tidak ada pengganti -> error asli; id tidak valid -> 400', async () => {
    const { svc } = make([adapter('shinigami', { fail: true }).a, adapter('manta').a])
    await assert.rejects(svc.detail('shinigami:abc'), { code: 'UPSTREAM_ERROR' })
    await assert.rejects(svc.detail('nonsense'), { code: 'BAD_REQUEST' })
    await assert.rejects(svc.detail('lumos:abc'), { code: 'BAD_REQUEST' }) // provider tidak aktif
  })

  it('detail: data stale dipakai saat upstream gagal', async () => {
    const a = adapter('manta')
    const short = { ...cfg, ttl: { ...cfg.ttl, detail: { fresh: 5, stale: 5000 } } }
    const svc = new ScraperService({ adapters: [a.a], cache: new Cache(new MemoryKV(), noopLog), store: fakeStore(), views: { hit() {} }, log: noopLog, cfg: short })
    await svc.detail('manta:1')
    await new Promise(r => setTimeout(r, 15))
    a.state.fail = true
    const r = await svc.detail('manta:1')
    assert.equal(r.meta.source, 'stale')
    assert.equal(r.data.id, 'manta:1')
  })

  it('chapter: fallback mencocokkan nomor chapter di provider lain', async () => {
    const store = fakeStore({
      findChapter: async () => ({ seriesRef: 'abc', number: '2' }),
      findSeries: async () => ({ title: 'Solo Leveling', normTitle: 'sololeveling' }),
      siblings: async () => [{ provider: 'manta', ref: '77' }]
    })
    const { svc } = make([adapter('shinigami', { fail: true }).a, adapter('manta').a], store)
    const r = await svc.chapter('shinigami:c2')
    assert.equal(r.meta.fallback, true)
    assert.equal(r.data.id, 'manta:77:2')
    assert.deepEqual(r.data.images, ['manta.jpg'])
  })

  it('chapter: tanpa jejak di DB -> error asli', async () => {
    const { svc } = make([adapter('shinigami', { fail: true }).a, adapter('manta').a])
    await assert.rejects(svc.chapter('shinigami:c2'), { code: 'UPSTREAM_ERROR' })
  })
})
