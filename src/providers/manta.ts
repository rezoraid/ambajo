import { NotFoundError, UpstreamError } from '../core/errors.js'
import { request, retry } from '../core/http.js'
import { cid, sid } from '../core/ids.js'
import type { ChapterContent, ChapterSummary, ProviderAdapter, SeriesDetail, SeriesSummary } from '../core/types.js'
import { compact, isoDate, memo, numOrNull, splitOnce } from '../core/util.js'

const KEY = 'manta'
const BASE = 'https://manta.net'
const HOME_VERSION = '202606'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
const SECTIONS: Record<string, string> = { comic: 'comics', manga: 'manga', novel: 'novels' }
const HEADERS = { 'user-agent': UA, referer: `${BASE}/en`, 'accept-language': 'en-US,en;q=0.9' }

type Raw = Record<string, any>

const fetchBody = <T>(path: string, read: (r: Response) => Promise<T>) =>
  retry(async () => read(await request(BASE + path, { headers: HEADERS, timeoutMs: 15000 })))

const getJson = (path: string): Promise<Raw> => fetchBody(path, r => r.json())

async function pageProps(path: string): Promise<Raw> {
  const html = await fetchBody(path, r => r.text())
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s)
  if (!m) throw new UpstreamError(`Data tidak ditemukan: ${path}`)
  return JSON.parse(m[1]).props?.pageProps ?? {}
}

const loc = (v: any): string => (v && typeof v === 'object' ? (v.en ?? Object.values(v)[0] ?? '') : (v ?? ''))
const tagNames = (list: any[] | undefined): string[] =>
  (list ?? []).map(t => (typeof t === 'string' ? t : loc(t.name))).filter(Boolean)

function cover(image: Raw = {}): string {
  for (const k of ['1280x1840_720', '1280x1840_480', '1440x1440_720', '1440x1440_480', 'thumbnail1']) {
    if (image[k]?.downloadUrl) return image[k].downloadUrl
  }
  return ''
}

function typeOf(n: unknown, tags: Raw[] = []): string {
  const v = Number(n ?? 0)
  if (v === 40) return 'novel'
  if (v === 50 || v === 60) return 'manga'
  return tags.some(t => t?.id === 292) ? 'novel' : 'comic'
}

function toSummary(raw: Raw): SeriesSummary | null {
  const d: Raw = raw.data ?? {}
  const ref = String(raw.id ?? raw.seriesId ?? '')
  const title = String(loc(d.title) || raw.title || '').trim()
  if (!ref || !title) return null
  const id = sid(KEY, ref)
  const ord = raw.latestEpisode?.ord
  return {
    id,
    provider: KEY,
    title,
    cover: cover(raw.image) || raw.coverImage?.downloadUrl || '',
    url: `${BASE}/en/series/${ref}`,
    type: typeOf(raw.type ?? raw.seriesType, d.tags),
    status: null,
    genres: tagNames(d.tags),
    rating: null,
    chapterCount: numOrNull(raw.episodeCount ?? ord),
    latestChapter: ord != null ? String(ord) : null,
    sources: [{ provider: KEY, id }]
  }
}

interface Episode {
  id: string
  number: string
  title: string
  date: string | null
}

const episodesOf = (s: Raw): Episode[] =>
  (s.episodes ?? [])
    .map((ep: Raw) => ({
      id: String(ep.id),
      number: String(ep.ord ?? ep.id),
      title: ep.data?.title ?? `Episode ${ep.ord}`,
      date: isoDate(ep.openAt)
    }))
    .sort((a: Episode, b: Episode) => parseFloat(b.number) - parseFloat(a.number))

/** Halaman seri dipakai detail() dan chapter(); di-memo singkat agar tidak fetch ganda. */
const seriesPage = memo((id: string) => pageProps(`/en/series/${encodeURIComponent(id)}`), 30_000)

export function createManta(): ProviderAdapter {
  return {
    key: KEY,
    name: 'Manta',
    baseUrl: BASE,

    async search(query, { page, limit }) {
      const res = await getJson(`/manta/v1/search/series?lang=en&q=${encodeURIComponent(query)}`)
      const items = compact<SeriesSummary>((Array.isArray(res.data) ? res.data : []).map(toSummary))
      return items.slice((page - 1) * limit, page * limit)
    },

    async latest({ page, limit, type = 'comic' }) {
      const res = await getJson(`/front/v1/home/${HOME_VERSION}?lang=en&homeType=${SECTIONS[type] || 'comics'}`)
      const map: Raw = res.data?.seriesMap ?? {}
      const items = compact<SeriesSummary>((res.data?.items ?? []).map((it: Raw) => toSummary({ ...(map[it.seriesId] ?? {}), ...it })))
      return items.slice((page - 1) * limit, page * limit)
    },

    async detail(ref): Promise<SeriesDetail> {
      const p = await seriesPage(ref)
      const s = p.initialSeries
      if (!s) throw new NotFoundError(`Series "${ref}" tidak ditemukan`)
      const d: Raw = s.data ?? {}
      const chapters: ChapterSummary[] = episodesOf(s).map(e => ({ ...e, id: cid(KEY, `${ref}:${e.id}`) }))
      const id = sid(KEY, ref)
      return {
        id,
        provider: KEY,
        title: String(loc(d.title) || p.headData?.title || ref).trim(),
        cover: cover(s.image) || p.headData?.image || '',
        url: `${BASE}/en/series/${ref}`,
        type: typeOf(s.type, d.tags),
        status: null,
        genres: tagNames(d.tags),
        rating: null,
        chapterCount: chapters.length,
        latestChapter: chapters[0]?.number ?? null,
        sources: [{ provider: KEY, id }],
        synopsis: d.description?.long ?? d.description?.short ?? p.headData?.description ?? '',
        author: (d.creators ?? []).map((c: Raw) => c.name).filter(Boolean).join(', '),
        artist: '',
        year: null,
        chapters
      }
    },

    /** ref chapter = `<seriesId>:<episodeId>` (episodeId < 1000 dianggap nomor chapter, seperti scraper asli). */
    async chapter(ref): Promise<ChapterContent> {
      const [seriesId, episodeId] = splitOnce(ref)
      let id = episodeId
      const chaptersP = seriesPage(seriesId).then(
        p => (p.initialSeries ? episodesOf(p.initialSeries) : []),
        () => [] as Episode[]
      )
      if (Number(id) < 1000) id = (await chaptersP).find(c => c.number === id)?.id ?? id
      const [p, chapters] = await Promise.all([pageProps(`/en/episodes/${encodeURIComponent(id)}`), chaptersP])
      const i = chapters.findIndex(c => c.id === id)
      const link = (e?: Episode) => (e ? cid(KEY, `${seriesId}:${e.id}`) : null)
      return {
        id: cid(KEY, `${seriesId}:${id}`),
        seriesId: sid(KEY, seriesId),
        number: i !== -1 ? chapters[i].number : id,
        images: (p.previewCutImages ?? []).map((x: Raw) => x.downloadUrl).filter(Boolean),
        prev: i !== -1 && i < chapters.length - 1 ? link(chapters[i + 1]) : null,
        next: i > 0 ? link(chapters[i - 1]) : null,
        imageHeaders: this.imageHeaders()
      }
    },

    imageHeaders: () => ({ 'user-agent': UA, referer: `${BASE}/en` })
  }
}
