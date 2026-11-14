import type { FastifyBaseLogger } from 'fastify'
import type { Config } from '../config.js'
import { CircuitBreaker } from '../core/breaker.js'
import type { Cache, CacheState } from '../core/cache.js'
import { NotFoundError, TimeoutError, UnavailableError, UpstreamError, ValidationError, normalizeError } from '../core/errors.js'
import { parseId } from '../core/ids.js'
import type {
  ChapterContent,
  ChapterSummary,
  DataSource,
  DbPage,
  GenreFilters,
  GenreRow,
  ProviderAdapter,
  ProviderKey,
  ProviderStatus,
  SeriesDetail,
  SeriesSummary,
  Store
} from '../core/types.js'
import { normTitle, slugify, withDeadline } from '../core/util.js'

export interface ViewSink {
  hit(provider: ProviderKey, ref: string): void
}

export interface ListMeta {
  page: number
  limit: number
  count: number
  providers: Record<string, ProviderStatus>
  degraded: boolean
  source: DataSource
}
export interface ListResult {
  data: SeriesSummary[]
  meta: ListMeta
}
export interface ItemMeta {
  provider: ProviderKey
  requestedId: string
  fallback: boolean
  source: DataSource
}
export interface PageQuery {
  page: number
  limit: number
  provider?: ProviderKey
}

type ServiceConfig = Pick<Config, 'ttl' | 'aggregateTimeoutMs' | 'primaryTimeoutMs'>
const offsetOf = (q: PageQuery) => (q.page - 1) * q.limit
const dbPage = (q: PageQuery): DbPage => ({ limit: q.limit, offset: offsetOf(q), provider: q.provider })
const sameNumber = (a: string, b: string) => (Number.isFinite(+a) && Number.isFinite(+b) ? +a === +b : a === b)
const stateToSource = (s: CacheState): DataSource => (s === 'hit' ? 'cache' : s === 'stale' ? 'stale' : 'upstream')

function statusOf(e: unknown): ProviderStatus {
  if (e instanceof TimeoutError) return 'timeout'
  if (e instanceof UnavailableError) return 'unavailable'
  return 'error'
}

/** Gabungkan hasil beberapa provider: round-robin, deduplikasi judul sama, kumpulkan `sources`. */
export function mergeSeries(lists: SeriesSummary[][]): SeriesSummary[] {
  const byTitle = new Map<string, SeriesSummary>()
  const out: SeriesSummary[] = []
  const longest = Math.max(0, ...lists.map(l => l.length))
  for (let i = 0; i < longest; i++) {
    for (const list of lists) {
      const item = list[i]
      if (!item) continue
      const key = normTitle(item.title)
      const first = key ? byTitle.get(key) : undefined
      if (!first) {
        const copy = { ...item, genres: [...item.genres], sources: [...item.sources] }
        if (key) byTitle.set(key, copy)
        out.push(copy)
        continue
      }
      first.sources.push(...item.sources.filter(s => !first.sources.some(x => x.id === s.id)))
      first.genres = [...new Set([...first.genres, ...item.genres])]
      first.cover ||= item.cover
      first.rating ??= item.rating
      first.type ??= item.type
      first.status ??= item.status
    }
  }
  return out
}

export class ScraperService {
  private readonly adapters = new Map<ProviderKey, ProviderAdapter>()
  private readonly breakers = new Map<ProviderKey, CircuitBreaker>()
  private readonly stats = new Map<ProviderKey, { lastOkAt: string | null; lastError: string | null; lastMs: number | null }>()

  constructor(
    private readonly o: {
      adapters: ProviderAdapter[] // urutan = prioritas
      cache: Cache
      store: Store
      views: ViewSink
      log: FastifyBaseLogger
      cfg: ServiceConfig
    }
  ) {
    for (const a of o.adapters) {
      this.adapters.set(a.key, a)
      this.breakers.set(a.key, new CircuitBreaker())
      this.stats.set(a.key, { lastOkAt: null, lastError: null, lastMs: null })
    }
  }

  // ------------------------------------------------------------------ infra

  private adapter(key: ProviderKey): ProviderAdapter {
    const a = this.adapters.get(key)
    if (!a) throw new ValidationError(`Provider "${key}" tidak aktif`)
    return a
  }

  private pick(provider?: ProviderKey): ProviderAdapter[] {
    return provider ? [this.adapter(provider)] : [...this.adapters.values()]
  }

  /** Semua panggilan ke upstream lewat sini: circuit breaker + statistik + normalisasi error. */
  private async call<T>(p: ProviderAdapter, fn: () => Promise<T>): Promise<T> {
    const br = this.breakers.get(p.key)!
    if (!br.canRequest()) throw new UnavailableError(`Provider ${p.key} sedang tidak tersedia (circuit open)`)
    const st = this.stats.get(p.key)!
    const t0 = performance.now()
    try {
      const v = await fn()
      br.success()
      st.lastOkAt = new Date().toISOString()
      st.lastMs = Math.round(performance.now() - t0)
      return v
    } catch (e) {
      if (e instanceof NotFoundError) {
        br.success() // upstream sehat, datanya saja tidak ada
        throw e
      }
      br.failure()
      const err = normalizeError(e)
      st.lastError = err.message
      this.o.log.warn({ provider: p.key, err: err.message }, 'upstream call failed')
      throw err
    }
  }

  private background(p: Promise<unknown>, what: string) {
    p.catch(e => this.o.log.warn({ err: (e as Error).message }, `background ${what} failed`))
  }

  providers() {
    return [...this.adapters.values()].map((a, i) => ({
      key: a.key,
      name: a.name,
      baseUrl: a.baseUrl,
      priority: i,
      circuit: this.breakers.get(a.key)!.state,
      ...this.stats.get(a.key)!,
      imageHeaders: a.imageHeaders()
    }))
  }

  // ------------------------------------------------------------------ list (search / latest)

  private listFrom(p: ProviderAdapter, kind: 'search' | 'latest', a: { q?: string; page: number; limit: number; type?: string }) {
    const key =
      kind === 'search'
        ? `s:${p.key}:${a.q!.trim().toLowerCase()}:${a.page}:${a.limit}`
        : `l:${p.key}:${a.type ?? ''}:${a.page}:${a.limit}`
    return this.o.cache.getOrSet(key, this.o.cfg.ttl[kind], async () => {
      const items = await this.call(p, () => (kind === 'search' ? p.search(a.q!, a) : p.latest(a)))
      this.background(this.o.store.saveSummaries(items), 'saveSummaries')
      return items
    })
  }

  private async fanOut(
    q: PageQuery,
    run: (p: ProviderAdapter) => Promise<{ value: SeriesSummary[]; state: CacheState }>,
    local: () => Promise<SeriesSummary[]>
  ): Promise<ListResult> {
    const settled = await Promise.all(
      this.pick(q.provider).map(async p => {
        try {
          const r = await withDeadline(run(p), this.o.cfg.aggregateTimeoutMs)
          return { key: p.key, items: r.value, state: r.state, status: (r.state === 'stale' ? 'stale' : 'ok') as ProviderStatus }
        } catch (e) {
          return { key: p.key, items: [] as SeriesSummary[], state: null, status: statusOf(e) }
        }
      })
    )
    const providers = Object.fromEntries(settled.map(r => [r.key, r.status]))
    const alive = settled.filter(r => r.state)

    if (!alive.length) {
      // Semua provider gagal -> data terakhir yang pernah tersimpan di PostgreSQL.
      const rows = await local().catch(() => [])
      if (!rows.length) throw new UpstreamError('Semua provider gagal dan belum ada data tersimpan')
      return { data: rows, meta: { page: q.page, limit: q.limit, count: rows.length, providers, degraded: true, source: 'db' } }
    }

    const data = mergeSeries(alive.map(r => r.items))
    const source: DataSource = alive.some(r => r.state === 'miss') ? 'upstream' : alive.some(r => r.state === 'stale') ? 'stale' : 'cache'
    return {
      data,
      meta: { page: q.page, limit: q.limit, count: data.length, providers, degraded: alive.length < settled.length, source }
    }
  }

  search(q: string, o: PageQuery): Promise<ListResult> {
    return this.fanOut(o, p => this.listFrom(p, 'search', { q, ...o }), () => this.o.store.searchLocal(q, dbPage(o)))
  }

  latest(o: PageQuery & { type?: string }): Promise<ListResult> {
    return this.fanOut(o, p => this.listFrom(p, 'latest', o), () => this.o.store.latestLocal(dbPage(o)))
  }

  // ------------------------------------------------------------------ DB-backed lists (popular / genre)

  private async dbList(key: string, q: PageQuery, load: () => Promise<SeriesSummary[]>): Promise<ListResult> {
    const { value, state } = await this.o.cache.getOrSet(key, this.o.cfg.ttl.db, load)
    return {
      data: value,
      meta: { page: q.page, limit: q.limit, count: value.length, providers: {}, degraded: false, source: state === 'hit' ? 'cache' : state === 'stale' ? 'stale' : 'db' }
    }
  }

  /** Populer = paling banyak dibuka lewat API ini (hit detail) dalam `days` hari terakhir. */
  popular(o: PageQuery & { days: number }): Promise<ListResult> {
    return this.dbList(`p:${o.provider ?? ''}:${o.days}:${o.page}:${o.limit}`, o, () => this.o.store.popular({ ...dbPage(o), days: o.days }))
  }

  async genres(): Promise<{ data: GenreRow[]; source: DataSource }> {
    const { value, state } = await this.o.cache.getOrSet('g:all', this.o.cfg.ttl.genres, async () => {
      const rows = await this.o.store.genres()
      const seen = new Set(rows.map(r => r.slug))
      // Genre yang dikenal provider tapi belum pernah muncul di DB (mis. Lumos) ikut ditampilkan.
      for (const a of this.adapters.values()) {
        const names = a.listGenres ? await withDeadline(a.listGenres(), 3000).catch(() => []) : []
        for (const name of names) {
          const slug = slugify(name)
          if (slug && !seen.has(slug)) {
            seen.add(slug)
            rows.push({ slug, name, count: 0 })
          }
        }
      }
      return rows
    })
    return { data: value, source: state === 'hit' ? 'cache' : state === 'stale' ? 'stale' : 'db' }
  }

  /** Provider dengan katalog native (Lumos) ditarik live dulu -> tersimpan ke DB lengkap dengan genre. */
  private browseFrom(p: ProviderAdapter, slug: string, o: PageQuery & GenreFilters) {
    const key = `b:${p.key}:${slug}:${o.sort}:${o.type ?? ''}:${o.status ?? ''}:${o.page}`
    return this.o.cache.getOrSet(key, this.o.cfg.ttl.latest, async () => {
      const items = await this.call(p, () => p.browse!({ genre: slug, page: o.page, sort: o.sort ?? 'latest', type: o.type, status: o.status }))
      await this.o.store.saveSummaries(items).catch(e => this.o.log.warn({ err: (e as Error).message }, 'save browse failed'))
      return items.length
    })
  }

  async byGenre(slug: string, o: PageQuery & GenreFilters): Promise<ListResult> {
    const providers: Record<string, ProviderStatus> = {}
    await Promise.all(
      this.pick(o.provider)
        .filter(p => p.browse)
        .map(async p => {
          try {
            const r = await withDeadline(this.browseFrom(p, slug, o), this.o.cfg.aggregateTimeoutMs)
            providers[p.key] = r.state === 'stale' ? 'stale' : 'ok'
          } catch (e) {
            providers[p.key] = statusOf(e)
          }
        })
    )
    const key = `gs:${slug}:${o.provider ?? ''}:${o.sort ?? 'latest'}:${o.type ?? ''}:${o.status ?? ''}:${o.page}:${o.limit}`
    const res = await this.dbList(key, o, () => this.o.store.byGenre(slug, { ...dbPage(o), sort: o.sort, type: o.type, status: o.status }))
    res.meta.providers = providers
    res.meta.degraded = Object.values(providers).some(s => s !== 'ok' && s !== 'stale')
    return res
  }

  // ------------------------------------------------------------------ detail & chapter (dengan fallback)

  private detailFrom(p: ProviderAdapter, ref: string) {
    return this.o.cache.getOrSet<SeriesDetail>(`d:${p.key}:${ref}`, this.o.cfg.ttl.detail, async () => {
      const d = await this.call(p, () => p.detail(ref))
      this.background(this.o.store.saveDetail(d), 'saveDetail')
      return d
    })
  }

  private chapterFrom(p: ProviderAdapter, ref: string) {
    return this.o.cache.getOrSet<ChapterContent>(`c:${p.key}:${ref}`, this.o.cfg.ttl.chapter, () => this.call(p, () => p.chapter(ref)))
  }

  /** Dipakai warmer: isi cache + DB tanpa menghitung view dan tanpa fallback. */
  async refreshDetail(provider: ProviderKey, ref: string): Promise<void> {
    await this.detailFrom(this.adapter(provider), ref)
  }

  /** Seri yang sama di provider lain: dari DB (norm_title), jika kosong cari lewat search provider lain. */
  private async siblingsOf(provider: ProviderKey, ref: string): Promise<{ provider: ProviderKey; ref: string }[]> {
    const found = await this.o.store.findSeries(provider, ref).catch(() => null)
    if (!found) return []
    const out: { provider: ProviderKey; ref: string }[] = await this.o.store.siblings(found.normTitle, provider).catch(() => [])
    if (!out.length) {
      await Promise.all(
        [...this.adapters.values()]
          .filter(p => p.key !== provider && this.breakers.get(p.key)!.available)
          .map(async p => {
            try {
              const r = await withDeadline(this.listFrom(p, 'search', { q: found.title, page: 1, limit: 5 }), this.o.cfg.aggregateTimeoutMs)
              const hit = r.value.find(s => normTitle(s.title) === found.normTitle)
              if (hit) out.push({ provider: p.key, ref: parseId(hit.id).ref })
            } catch {}
          })
      )
    }
    const order = [...this.adapters.keys()]
    return out.filter(s => this.adapters.has(s.provider)).sort((a, b) => order.indexOf(a.provider) - order.indexOf(b.provider))
  }

  async detail(id: string): Promise<{ data: SeriesDetail; meta: ItemMeta }> {
    const { provider, ref } = parseId(id)
    const primary = this.adapter(provider)
    let failure: unknown
    try {
      const r = await withDeadline(this.detailFrom(primary, ref), this.o.cfg.primaryTimeoutMs)
      this.o.views.hit(provider, ref)
      return { data: r.value, meta: { provider, requestedId: id, fallback: false, source: stateToSource(r.state) } }
    } catch (e) {
      failure = e
    }
    for (const sib of await this.siblingsOf(provider, ref)) {
      try {
        const a = this.adapter(sib.provider)
        const r = await withDeadline(this.detailFrom(a, sib.ref), this.o.cfg.primaryTimeoutMs)
        this.o.views.hit(sib.provider, sib.ref)
        return { data: r.value, meta: { provider: sib.provider, requestedId: id, fallback: true, source: stateToSource(r.state) } }
      } catch {}
    }
    throw failure
  }

  async chapters(id: string): Promise<{ data: ChapterSummary[]; meta: ItemMeta }> {
    const { data, meta } = await this.detail(id)
    return { data: data.chapters, meta }
  }

  async chapter(id: string): Promise<{ data: ChapterContent; meta: ItemMeta }> {
    const { provider, ref } = parseId(id)
    const primary = this.adapter(provider)
    let failure: unknown
    try {
      const r = await withDeadline(this.chapterFrom(primary, ref), this.o.cfg.primaryTimeoutMs)
      return { data: r.value, meta: { provider, requestedId: id, fallback: false, source: stateToSource(r.state) } }
    } catch (e) {
      failure = e
    }
    // Fallback: cari chapter bernomor sama pada seri yang sama di provider lain.
    const known = await this.o.store.findChapter(provider, ref).catch(() => null)
    if (known) {
      for (const sib of await this.siblingsOf(provider, known.seriesRef)) {
        try {
          const a = this.adapter(sib.provider)
          const series = await withDeadline(this.detailFrom(a, sib.ref), this.o.cfg.primaryTimeoutMs)
          const match = series.value.chapters.find(c => sameNumber(c.number, known.number))
          if (!match) continue
          const r = await withDeadline(this.chapterFrom(a, parseId(match.id).ref), this.o.cfg.primaryTimeoutMs)
          return { data: r.value, meta: { provider: sib.provider, requestedId: id, fallback: true, source: stateToSource(r.state) } }
        } catch {}
      }
    }
    throw failure
  }
}

