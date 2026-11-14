export const PROVIDER_KEYS = ['manta', 'lumos', 'shinigami'] as const
export type ProviderKey = (typeof PROVIDER_KEYS)[number]
export type SeriesStatus = 'ongoing' | 'completed' | 'hiatus'
export type ProviderStatus = 'ok' | 'stale' | 'error' | 'timeout' | 'unavailable'
export type DataSource = 'upstream' | 'cache' | 'stale' | 'db'

export interface SourceRef {
  provider: ProviderKey
  id: string
}

export interface SeriesSummary {
  id: string
  provider: ProviderKey
  title: string
  cover: string
  url: string
  type: string | null
  status: SeriesStatus | null
  genres: string[]
  rating: number | null
  chapterCount: number | null
  latestChapter: string | null
  sources: SourceRef[]
}

export interface ChapterSummary {
  id: string
  number: string
  title: string
  date: string | null
}

export interface SeriesDetail extends SeriesSummary {
  synopsis: string
  author: string
  artist: string
  year: number | null
  chapters: ChapterSummary[]
}

export interface ChapterContent {
  id: string
  seriesId: string | null
  number: string
  images: string[]
  prev: string | null
  next: string | null
  imageHeaders: Record<string, string>
}

export type SortKey = 'latest' | 'popular' | 'rating' | 'az'

/** Filter katalog (genre / format / status) + sortir. `genre` = slug unified. */
export interface BrowseOptions {
  page: number
  sort: SortKey
  genre?: string
  type?: string
  status?: string
  q?: string
}

export interface ListOptions {
  page: number
  limit: number
  type?: string
}

/** Kontrak yang wajib dipenuhi tiap provider. `ref` = id asli milik provider. */
export interface ProviderAdapter {
  readonly key: ProviderKey
  readonly name: string
  readonly baseUrl: string
  search(query: string, o: ListOptions): Promise<SeriesSummary[]>
  latest(o: ListOptions): Promise<SeriesSummary[]>
  detail(ref: string): Promise<SeriesDetail>
  chapter(ref: string): Promise<ChapterContent>
  /** Opsional: katalog native dengan filter genre/format/status + sortir (saat ini Lumos). */
  browse?(o: BrowseOptions): Promise<SeriesSummary[]>
  /** Opsional: nama genre milik provider (diambil langsung dari situs). */
  listGenres?(): Promise<string[]>
  imageHeaders(): Record<string, string>
}

export interface GenreRow {
  slug: string
  name: string
  count: number
}

export interface DbPage {
  limit: number
  offset: number
  provider?: ProviderKey
}

export interface GenreFilters {
  sort?: SortKey
  type?: string
  status?: string
}

/** Akses persistensi (PostgreSQL). Diinjeksi ke service agar mudah diuji. */
export interface Store {
  syncProviders(list: { key: string; name: string; baseUrl: string }[]): Promise<void>
  saveSummaries(items: SeriesSummary[]): Promise<void>
  saveDetail(d: SeriesDetail): Promise<void>
  findSeries(provider: ProviderKey, ref: string): Promise<{ title: string; normTitle: string } | null>
  siblings(normTitle: string, exclude: ProviderKey): Promise<{ provider: ProviderKey; ref: string }[]>
  findChapter(provider: ProviderKey, ref: string): Promise<{ seriesRef: string; number: string } | null>
  searchLocal(q: string, p: DbPage): Promise<SeriesSummary[]>
  latestLocal(p: DbPage): Promise<SeriesSummary[]>
  popular(p: DbPage & { days: number }): Promise<SeriesSummary[]>
  genres(): Promise<GenreRow[]>
  byGenre(slug: string, p: DbPage & GenreFilters): Promise<SeriesSummary[]>
  addViews(rows: { provider: ProviderKey; ref: string; n: number }[]): Promise<void>
  needingDetail(limit: number): Promise<{ provider: ProviderKey; ref: string }[]>
  prune(): Promise<void>
  ping(): Promise<boolean>
}
