import { NotFoundError } from '../core/errors.js'
import { request } from '../core/http.js'
import { cid, sid } from '../core/ids.js'
import type {
  BrowseOptions,
  ChapterContent,
  ChapterSummary,
  ProviderAdapter,
  SeriesDetail,
  SeriesStatus,
  SeriesSummary
} from '../core/types.js'
import { compact, memo, numOrNull, slugify, splitOnce } from '../core/util.js'

const KEY = 'lumos'
const BASES = ['https://03.lumosgg.com', 'https://02.lumosgg.com', 'https://lumoskomik.com']
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
const STATUSES = ['ongoing', 'completed', 'hiatus']
const LUMOS_TYPES = ['manga', 'manhwa', 'manhua']

type Raw = Record<string, any>

const decode = (s: string) => s.replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
const text = (s: unknown) => decode(String(s ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
const numberFromSlug = (slug: string) => slug.replace(/^chapter-/, '').replace(/-/g, '.')
const byNumber = (a: { number: string }, b: { number: string }) => (parseFloat(b.number) || 0) - (parseFloat(a.number) || 0)
const statusOf = (s: unknown): SeriesStatus | null => {
  const v = String(s ?? '').trim().toLowerCase()
  return STATUSES.includes(v) ? (v as SeriesStatus) : null
}

export function createLumos(): ProviderAdapter {
  let site = BASES[0]

  /** Coba tiap mirror berurutan; 404 menghentikan rotasi. */
  async function get<T>(path: string, accept: string, read: (r: Response) => Promise<T>): Promise<T> {
    let error: unknown
    for (const base of BASES) {
      try {
        const res = await request(base + path, {
          headers: { 'user-agent': UA, accept, 'accept-language': 'id,en-US;q=0.9,en;q=0.8', referer: `${base}/` },
          timeoutMs: 10000
        })
        const out = await read(res)
        site = base
        return out
      } catch (e) {
        error = e
        if (e instanceof NotFoundError) break
      }
    }
    throw error
  }
  const getJson = (path: string): Promise<any> => get(path, 'application/json, text/plain, */*', r => r.json())
  const getHtml = (path: string) => get(path, 'text/html,application/xhtml+xml,*/*;q=0.8', r => r.text())

  /** Thumbnail Lumos bisa berupa `?src=<base64url>`; dekode ke URL CDN langsung. */
  function image(src?: string | null): string {
    if (!src) return ''
    if (/^https?:\/\//.test(src)) return src
    const m = src.match(/[?&]src=([\w\-=]+)/)
    if (m) {
      try {
        let b64 = m[1].replace(/-/g, '+').replace(/_/g, '/')
        while (b64.length % 4) b64 += '='
        const url = Buffer.from(b64, 'base64').toString('utf8')
        if (url.startsWith('http')) return url
      } catch {}
    }
    return site + (src.startsWith('/') ? '' : '/') + src
  }

  function toSummary(i: Raw): SeriesSummary | null {
    const ref = i.slug || i.id
    const title = i.title || i.name || i.slug
    if (!ref || !title) return null
    const id = sid(KEY, ref)
    const recent = (i.recentChapters ?? []).map((c: Raw) => String(c.number)).filter(Boolean)
    return {
      id,
      provider: KEY,
      title,
      cover: image(i.coverImage || i.cover || i.image),
      url: `${site}/comic/${ref}`,
      type: String(i.type || '').toLowerCase() || null,
      status: statusOf(i.status),
      genres: [],
      rating: numOrNull(i.rating ?? i.avgRating),
      chapterCount: null,
      latestChapter: recent.sort((a: string, b: string) => parseFloat(b) - parseFloat(a))[0] ?? null,
      sources: [{ provider: KEY, id }]
    }
  }

  // ---- genre: slug unified -> slug milik Lumos (diambil dari /browse, di-memo 1 jam) ----
  const lumosGenres = memo(async () => {
    const html = await getHtml('/browse')
    const map = new Map<string, { slug: string; name: string }>()
    for (const m of html.matchAll(/<[^>]+data-bf-genre-name="([^"]+)"[^>]*>([\s\S]*?)<\/(?:label|div)>/gi)) {
      const slug = decode(m[1])
      const name = text(m[2]) || slug
      map.set(slugify(slug) || slugify(name), { slug, name })
    }
    return map
  }, 3_600_000, 1)

  /** Katalog /browse (kartu `htg-card`). */
  async function browse(o: BrowseOptions): Promise<SeriesSummary[]> {
    let genre: { slug: string; name: string } | undefined
    if (o.genre) {
      genre = (await lumosGenres('').catch(() => undefined))?.get(o.genre)
      if (!genre) return [] // genre ini tidak dikenal Lumos
    }
    const params = new URLSearchParams()
    if (o.page > 1) params.set('page', String(o.page))
    params.set('sort', o.sort)
    if (o.status && STATUSES.includes(o.status)) params.set('status', o.status)
    const type = o.type && LUMOS_TYPES.includes(o.type) ? o.type : ''
    if (type) params.set('type', type)
    if (genre) params.set('genre', genre.slug)
    if (o.q) params.set('q', o.q)

    const html = await getHtml(`/browse?${params}`)
    const out: SeriesSummary[] = []
    const card = /<div[^>]*class="[^"]*htg-card[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*htg-card[^"]*"|$)/gi
    for (const m of html.matchAll(card)) {
      const b = m[1]
      const slug = b.match(/href="\/comic\/([a-zA-Z0-9_\-]+)"/i)?.[1]
      if (!slug) continue
      const chapters = b.match(/(\d+)\s*<span[^>]*class="[^"]*min-\[400px\]:hidden/i)?.[1] ?? b.match(/<span[^>]*text-surface-300[^>]*>\s*(\d+)/i)?.[1]
      const id = sid(KEY, slug)
      out.push({
        id,
        provider: KEY,
        title: text(b.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i)?.[1]) || slug,
        cover: image(b.match(/<img[^>]+src="([^"]+)"/i)?.[1]),
        url: `${site}/comic/${slug}`,
        type: type || null,
        status: statusOf(text(b.match(/<span[^>]*class="[^"]*capitalize[^"]*"[^>]*>([\s\S]*?)<\/span>/i)?.[1])),
        genres: genre ? [genre.name] : [],
        rating: numOrNull(b.match(/<svg[\s\S]*?<\/svg>\s*([0-9.]+)\s*<\/span>/i)?.[1]),
        chapterCount: numOrNull(chapters),
        latestChapter: null,
        sources: [{ provider: KEY, id }]
      })
    }
    return out
  }

  async function chapterListApi(slug: string): Promise<{ slug: string; number: string; title: string }[]> {
    const data = await getJson(`/api/chapters/list?comic=${encodeURIComponent(slug)}`)
    return (data?.chapters ?? [])
      .map((c: Raw) => {
        const s = c.slug || `chapter-${String(c.number).replace(/\./g, '-')}`
        return { slug: s, number: c.number != null ? String(c.number) : numberFromSlug(s), title: c.title || '' }
      })
      .sort(byNumber)
  }

  return {
    key: KEY,
    name: 'Lumos',
    baseUrl: BASES[0],
    browse,

    async listGenres() {
      return [...(await lumosGenres('')).values()].map(g => g.name)
    },

    /** page 1 = instant search API (fallback ke katalog); page > 1 = katalog `/browse?q=`. */
    async search(query, { page, limit }) {
      if (page > 1) return (await browse({ page, sort: 'latest', q: query })).slice(0, limit)
      try {
        const data = await getJson(`/api/search?q=${encodeURIComponent(query)}`)
        if (Array.isArray(data?.results)) return compact<SeriesSummary>(data.results.map(toSummary)).slice(0, limit)
      } catch {}
      return (await browse({ page: 1, sort: 'latest', q: query })).slice(0, limit)
    },

    /** Ukuran halaman ditentukan upstream; `limit` tidak berpengaruh. */
    async latest({ page }) {
      const data = await getJson(`/api/home-latest?page=${page}`)
      return compact<SeriesSummary>((data?.data?.items ?? []).map(toSummary))
    },

    async detail(ref): Promise<SeriesDetail> {
      const slug = ref
      const html = await getHtml(`/comic/${encodeURIComponent(slug)}`)
      const pick = (re: RegExp) => text(html.match(re)?.[1])

      const found: { slug: string; number: string; title: string }[] = []
      for (const m of html.matchAll(/<a[^>]+href="(\/read\/([^\/]+)\/([a-zA-Z0-9_\-]+))"[^>]+data-chapter="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
        if (m[2] !== slug || found.some(c => c.slug === m[3])) continue
        found.push({
          slug: m[3],
          number: m[4].trim() || numberFromSlug(m[3]),
          title: text(m[5].match(/<span[^>]*class="[^"]*text-heading[^"]*"[^>]*>([\s\S]*?)<\/span>/i)?.[1])
        })
      }
      found.sort(byNumber)
      const rows = found.length ? found : await chapterListApi(slug).catch(() => [])
      const chapters: ChapterSummary[] = rows.map(c => ({
        id: cid(KEY, `${slug}:${c.slug}`),
        number: c.number,
        title: c.title,
        date: null // Lumos hanya menampilkan waktu relatif ("2 hari lalu")
      }))

      const genres = [...new Set([...html.matchAll(/<a[^>]+href="\/browse\?genre=([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)].map(g => text(g[2])).filter(Boolean))]
      const sr = html.match(/data-sr="([^"]+)"/i)?.[1]
      const synopsis = (sr && Buffer.from(sr, 'base64').toString('utf8').trim()) || text(html.match(/<meta[^>]+name="description"[^>]+content="([^"]*)"/i)?.[1])
      const rating = pick(/class="rating-value"[^>]*>([\s\S]*?)<\/span>/i)
      const id = sid(KEY, slug)
      return {
        id,
        provider: KEY,
        title: pick(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || slug,
        cover: image(html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)?.[1] ?? html.match(/<img[^>]+class="[^"]*aspect-\[2\/3\][^"]*"[^>]+src="([^"]+)"/i)?.[1]),
        url: `${site}/comic/${slug}`,
        type: pick(/Type<\/div>[\s\S]*?<div[^>]*class="[^"]*text-sm[^"]*"[^>]*>([\s\S]*?)<\/div>/i).toLowerCase() || null,
        status: statusOf(pick(/Status<\/div>[\s\S]*?<span[^>]*class="[^"]*capitalize[^"]*"[^>]*>([\s\S]*?)<\/span>/i)),
        genres,
        rating: numOrNull(rating === '—' ? null : rating),
        chapterCount: chapters.length,
        latestChapter: chapters[0]?.number ?? null,
        sources: [{ provider: KEY, id }],
        synopsis,
        author: '',
        artist: '',
        year: numOrNull(pick(/Tahun[\s\S]*?<span[^>]*class="text-sm font-medium text-surface-100"[^>]*>([\s\S]*?)<\/span>/i)),
        chapters
      }
    },

    /** ref chapter = `<comicSlug>:<chapterSlug>` */
    async chapter(ref): Promise<ChapterContent> {
      const [slug, chapterSlug] = splitOnce(ref)
      const html = await getHtml(`/read/${encodeURIComponent(slug)}/${encodeURIComponent(chapterSlug)}`)

      const pages = [...html.matchAll(/<img[^>]+(?:alt="Page\s*(\d+)"[^>]+src="([^"]+)"|src="([^"]+)"[^>]+alt="Page\s*(\d+)")/gi)]
        .map(m => ({ page: parseInt(m[1] || m[4], 10), url: image(m[2] || m[3]) }))
        .sort((a, b) => a.page - b.page)

      let prev: string | null = null
      let next: string | null = null
      for (const m of html.matchAll(/<a[^>]+href="\/read\/([^\/]+)\/([a-zA-Z0-9_\-]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
        if (m[1] !== slug) continue
        const label = text(m[3]).toLowerCase()
        if (label.includes('prev') || label.includes('sebelumnya')) prev = m[2]
        else if (label.includes('next') || label.includes('selanjutnya')) next = m[2]
      }
      // Cadangan: data navigasi yang ditanam di halaman.
      const flat = html.replace(/&quot;|&#34;/g, '"')
      const embedded = (key: string) => flat.match(new RegExp(`"${key}":\\[0,"([^"\\\\]+)"\\]`))?.[1] ?? null
      prev ??= embedded('prevChapterSlug')
      next ??= embedded('nextChapterSlug')
      const link = (s: string | null) => (s ? cid(KEY, `${slug}:${s}`) : null)

      return {
        id: cid(KEY, `${slug}:${chapterSlug}`),
        seriesId: sid(KEY, slug),
        number: html.match(/const chapterNumber\s*=\s*"([^"]+)";/i)?.[1] || numberFromSlug(chapterSlug),
        images: [...new Set(pages.map(p => p.url).filter(Boolean))],
        prev: link(prev),
        next: link(next),
        imageHeaders: this.imageHeaders()
      }
    },

    imageHeaders: () => ({ 'user-agent': UA, referer: `${site}/` })
  }
}
