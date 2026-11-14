import { NotFoundError, UpstreamError } from '../core/errors.js'
import { request, retry } from '../core/http.js'
import { cid, sid } from '../core/ids.js'
import type { ChapterContent, ProviderAdapter, SeriesDetail, SeriesStatus, SeriesSummary } from '../core/types.js'
import { compact, isoDate, numOrNull } from '../core/util.js'

const KEY = 'shinigami'
const BASE = 'https://app.shinigami.asia'
const API = 'https://api.shngm.io'
const UA = 'Mozilla/5.0 (Android 14; Mobile; rv:153.0) Gecko/153.0 Firefox/153.0'
const HEADERS = { 'user-agent': UA, origin: BASE, referer: `${BASE}/`, accept: 'application/json' }

type Raw = Record<string, any>

const api = (path: string): Promise<Raw> =>
  retry(async () => {
    const res = await request(API + path, { headers: HEADERS, timeoutMs: 15000 })
    const json: Raw = await res.json()
    if (json.retcode !== undefined && json.retcode !== 0) throw new UpstreamError(json.message || 'API error')
    return json
  })

const names = (list: unknown): string[] =>
  Array.isArray(list) ? list.map(x => x?.name).filter(Boolean) : []
const statusOf = (s: number): SeriesStatus => (({ 1: 'ongoing', 2: 'hiatus' }) as Record<number, SeriesStatus>)[s] || 'completed'

function toSummary(m: Raw): SeriesSummary | null {
  if (!m?.manga_id || !m.title) return null
  const id = sid(KEY, m.manga_id)
  return {
    id,
    provider: KEY,
    title: m.title,
    cover: m.cover_portrait_url || m.cover_image_url || '',
    url: `${BASE}/series/${m.manga_id}/`,
    type: names(m.taxonomy?.Type)[0]?.toLowerCase() ?? null,
    status: statusOf(m.status),
    genres: names(m.taxonomy?.Genre),
    rating: null,
    chapterCount: null,
    latestChapter: m.latest_chapter_number != null ? String(m.latest_chapter_number) : null,
    sources: [{ provider: KEY, id }]
  }
}

async function list(q: string, page: number, size: number): Promise<SeriesSummary[]> {
  const qs = new URLSearchParams({ page: String(page), page_size: String(size) })
  if (q) qs.set('q', q)
  const res = await api(`/v1/manga/list?${qs}`)
  return compact((res.data ?? []).map(toSummary))
}

async function chapterList(id: string) {
  const fetchPage = (n: number) =>
    api(
      `/v1/chapter/${id}/list?${new URLSearchParams({ page: String(n), page_size: '100', sort_by: 'chapter_number', sort_order: 'desc' })}`
    )
  const first = await fetchPage(1)
  const pages = Number(first.meta?.total_page) || 1
  const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, i) => fetchPage(i + 2).catch(() => null)))
  return [first, ...rest]
    .flatMap(r => r?.data ?? [])
    .filter((c: Raw) => c?.chapter_id)
    .map((c: Raw) => ({
      id: cid(KEY, c.chapter_id),
      number: String(c.chapter_number ?? ''),
      title: c.chapter_title || '',
      date: isoDate(c.release_date || c.created_at)
    }))
    .sort((a, b) => parseFloat(b.number) - parseFloat(a.number))
}

export function createShinigami(): ProviderAdapter {
  return {
    key: KEY,
    name: 'Shinigami',
    baseUrl: BASE,

    search: (q, { page, limit }) => list(q, page, limit),
    latest: ({ page, limit }) => list('', page, limit),

    async detail(ref): Promise<SeriesDetail> {
      const [res, chapters] = await Promise.all([api(`/v1/manga/detail/${ref}`), chapterList(ref)])
      const d: Raw | undefined = res.data
      if (!d) throw new NotFoundError('Manga tidak ditemukan')
      const base = toSummary({ ...d, manga_id: d.manga_id ?? ref })
      if (!base) throw new NotFoundError('Manga tidak ditemukan')
      return {
        ...base,
        chapterCount: numOrNull(chapters.length),
        latestChapter: base.latestChapter ?? chapters[0]?.number ?? null,
        synopsis: d.description || '',
        author: names(d.taxonomy?.Author).join(', '),
        artist: names(d.taxonomy?.Artist).join(', '),
        year: numOrNull(d.release_year),
        chapters
      }
    },

    async chapter(ref): Promise<ChapterContent> {
      const d: Raw | undefined = (await api(`/v1/chapter/detail/${ref}`)).data
      if (!d) throw new NotFoundError('Chapter tidak ditemukan')
      const ch: Raw = d.chapter || {}
      const root = ch.base_url || d.base_url || ''
      const join = (...p: unknown[]) =>
        p
          .map(s => String(s || '').replace(/^\/+|\/+$/g, ''))
          .filter(Boolean)
          .join('/')
      return {
        id: cid(KEY, d.chapter_id || ref),
        seriesId: d.manga_id ? sid(KEY, d.manga_id) : null,
        number: String(d.chapter_number ?? ''),
        images: (ch.data ?? []).map((f: string) => (/^https?:\/\//.test(f) ? f : join(root, ch.path, f))),
        prev: d.prev_chapter_id ? cid(KEY, d.prev_chapter_id) : null,
        next: d.next_chapter_id ? cid(KEY, d.next_chapter_id) : null,
        imageHeaders: this.imageHeaders()
      }
    },

    imageHeaders: () => ({ 'user-agent': UA, referer: `${BASE}/`, origin: BASE })
  }
}
