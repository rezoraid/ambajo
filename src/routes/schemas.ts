import { PROVIDER_KEYS } from '../core/types.js'

const str = { type: 'string' } as const
const nstr = { type: 'string', nullable: true } as const

const source = {
  type: 'object',
  properties: { provider: str, id: str },
  required: ['provider', 'id']
} as const

export const seriesSummary = {
  type: 'object',
  properties: {
    id: { ...str, description: 'Id unified: "<provider>:<id asli>"' },
    provider: str,
    title: str,
    cover: str,
    url: str,
    type: nstr,
    status: { ...nstr, description: 'ongoing | completed | hiatus' },
    genres: { type: 'array', items: str },
    rating: { type: 'number', nullable: true },
    chapterCount: { type: 'integer', nullable: true },
    latestChapter: nstr,
    sources: { type: 'array', items: source, description: 'Provider lain yang memiliki seri yang sama (sumber pertama = id ini)' }
  },
  required: ['id', 'provider', 'title', 'cover', 'url', 'genres', 'sources']
} as const

export const chapterSummary = {
  type: 'object',
  properties: { id: str, number: str, title: str, date: { type: 'string', format: 'date-time', nullable: true } },
  required: ['id', 'number', 'title']
} as const

export const seriesDetail = {
  type: 'object',
  properties: {
    ...seriesSummary.properties,
    synopsis: str,
    author: str,
    artist: str,
    year: { type: 'integer', nullable: true },
    chapters: { type: 'array', items: chapterSummary, description: 'Terbaru -> terlama' }
  },
  required: seriesSummary.required
} as const

export const chapterContent = {
  type: 'object',
  properties: {
    id: str,
    seriesId: nstr,
    number: str,
    images: { type: 'array', items: str },
    prev: nstr,
    next: nstr,
    imageHeaders: { type: 'object', additionalProperties: str, description: 'Header yang harus dikirim saat mengunduh gambar' }
  },
  required: ['id', 'number', 'images', 'imageHeaders']
} as const

const listMeta = {
  type: 'object',
  properties: {
    page: { type: 'integer' },
    limit: { type: 'integer' },
    count: { type: 'integer' },
    providers: { type: 'object', additionalProperties: str, description: 'ok | stale | error | timeout | unavailable' },
    degraded: { type: 'boolean', description: 'true jika sebagian provider gagal' },
    source: { ...str, description: 'upstream | cache | stale | db' }
  }
} as const

const itemMeta = {
  type: 'object',
  properties: {
    provider: str,
    requestedId: str,
    fallback: { type: 'boolean', description: 'true jika data berasal dari provider pengganti' },
    source: str
  }
} as const

export const envelope = (data: object, meta?: object) => ({
  type: 'object',
  properties: { data, ...(meta ? { meta } : {}) }
})

export const R = {
  list: { 200: envelope({ type: 'array', items: seriesSummary }, listMeta) },
  detail: { 200: envelope(seriesDetail, itemMeta) },
  chapters: { 200: envelope({ type: 'array', items: chapterSummary }, itemMeta) },
  chapter: { 200: envelope(chapterContent, itemMeta) }
}

export const errorSchema = {
  type: 'object',
  properties: { error: { type: 'object', properties: { code: str, message: str } } }
} as const

// ---- query/params ----
const provider = { type: 'string', enum: [...PROVIDER_KEYS], description: 'Batasi ke satu provider (default: semua + fallback otomatis)' } as const
const page = { type: 'integer', minimum: 1, maximum: 500, default: 1 } as const
const limit = { type: 'integer', minimum: 1, maximum: 50, default: 20, description: 'Per provider (lumos/latest memakai ukuran halaman upstream)' } as const

const sort = { type: 'string', enum: ['latest', 'popular', 'rating', 'az'], default: 'latest' } as const
const format = { type: 'string', enum: ['manga', 'manhwa', 'manhua', 'comic', 'novel'], description: 'Format/tipe seri' } as const
const statusQ = { type: 'string', enum: ['ongoing', 'completed', 'hiatus'] } as const

export const Q = {
  genre: { type: 'object', properties: { page, limit, provider, sort, type: format, status: statusQ } },
  paged: { type: 'object', properties: { page, limit, provider } },
  search: {
    type: 'object',
    properties: { q: { type: 'string', minLength: 1, maxLength: 100 }, page, limit, provider },
    required: ['q']
  },
  latest: {
    type: 'object',
    properties: {
      page,
      limit,
      provider,
      type: { type: 'string', enum: ['comic', 'manga', 'novel'], description: 'Hanya berpengaruh pada provider manta' }
    }
  },
  popular: {
    type: 'object',
    properties: { page, limit, provider, days: { type: 'integer', minimum: 1, maximum: 90, default: 7 } }
  }
} as const

export const idParam = (description: string) =>
  ({ type: 'object', properties: { id: { type: 'string', minLength: 3, maxLength: 300, description } }, required: ['id'] }) as const
