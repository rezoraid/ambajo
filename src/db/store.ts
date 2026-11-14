import type { Pool, PoolClient } from 'pg'
import type { DbPage, GenreFilters, GenreRow, SortKey, ProviderKey, SeriesDetail, SeriesSummary, SeriesStatus, SourceRef, Store } from '../core/types.js'
import { normTitle, slugify } from '../core/util.js'

type Row = Record<string, any>

const UPSERT_SUMMARIES = `
INSERT INTO series (provider, ref, title, norm_title, cover, url, type, status, rating, chapter_count, latest_chapter)
SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[],
                     $9::float8[], $10::int[], $11::text[])
ORDER BY 1, 2
ON CONFLICT (provider, ref) DO UPDATE SET
  title          = EXCLUDED.title,
  norm_title     = EXCLUDED.norm_title,
  cover          = COALESCE(NULLIF(EXCLUDED.cover, ''), series.cover),
  url            = EXCLUDED.url,
  type           = COALESCE(EXCLUDED.type, series.type),
  status         = COALESCE(EXCLUDED.status, series.status),
  rating         = COALESCE(EXCLUDED.rating, series.rating),
  chapter_count  = COALESCE(EXCLUDED.chapter_count, series.chapter_count),
  latest_chapter = COALESCE(EXCLUDED.latest_chapter, series.latest_chapter),
  last_seen_at   = now(),
  updated_at     = now()
RETURNING id, provider, ref`

const UPSERT_DETAIL = `
INSERT INTO series (provider, ref, title, norm_title, cover, url, type, status, synopsis, author, artist, year,
                    rating, chapter_count, latest_chapter, detail_fetched_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now())
ON CONFLICT (provider, ref) DO UPDATE SET
  title             = EXCLUDED.title,
  norm_title        = EXCLUDED.norm_title,
  cover             = COALESCE(NULLIF(EXCLUDED.cover, ''), series.cover),
  url               = EXCLUDED.url,
  type              = COALESCE(EXCLUDED.type, series.type),
  status            = COALESCE(EXCLUDED.status, series.status),
  synopsis          = COALESCE(NULLIF(EXCLUDED.synopsis, ''), series.synopsis),
  author            = COALESCE(NULLIF(EXCLUDED.author, ''), series.author),
  artist            = COALESCE(NULLIF(EXCLUDED.artist, ''), series.artist),
  year              = COALESCE(EXCLUDED.year, series.year),
  rating            = COALESCE(EXCLUDED.rating, series.rating),
  chapter_count     = COALESCE(EXCLUDED.chapter_count, series.chapter_count),
  latest_chapter    = COALESCE(EXCLUDED.latest_chapter, series.latest_chapter),
  detail_fetched_at = now(),
  last_seen_at      = now(),
  updated_at        = now()
RETURNING id`

const UPSERT_GENRES = `
INSERT INTO genres (slug, name)
SELECT DISTINCT ON (slug) slug, name FROM unnest($1::text[], $2::text[]) AS t(slug, name)
ORDER BY slug
ON CONFLICT (slug) DO NOTHING`

const UPSERT_CHAPTERS = `
INSERT INTO chapters (series_id, ref, number, number_text, title, released_at)
SELECT $1, t.ref, t.number, t.number_text, t.title, t.released_at
FROM unnest($2::text[], $3::float8[], $4::text[], $5::text[], $6::timestamptz[]) AS t(ref, number, number_text, title, released_at)
ORDER BY t.ref
ON CONFLICT (series_id, ref) DO UPDATE SET
  number      = EXCLUDED.number,
  number_text = EXCLUDED.number_text,
  title       = EXCLUDED.title,
  released_at = COALESCE(EXCLUDED.released_at, chapters.released_at)
WHERE (chapters.number_text, chapters.title) IS DISTINCT FROM (EXCLUDED.number_text, EXCLUDED.title)`

const GENRE_ORDER: Record<SortKey, string> = {
  latest: 'x.last_seen_at DESC, x.id',
  popular: 'x.score DESC, x.rating DESC NULLS LAST, x.last_seen_at DESC, x.id',
  rating: 'x.rating DESC NULLS LAST, x.last_seen_at DESC, x.id',
  az: 'lower(x.title), x.id'
}

const genrePairs = (names: string[]) => {
  const map = new Map<string, string>()
  for (const name of names) {
    const slug = slugify(name)
    if (slug && !map.has(slug)) map.set(slug, name)
  }
  return { slugs: [...map.keys()], names: [...map.values()] }
}

const dedupe = <T>(items: T[], key: (t: T) => string) => [...new Map(items.map(i => [key(i), i])).values()]

export class PgStore implements Store {
  constructor(private readonly pool: Pool) {}

  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect()
    try {
      await c.query('BEGIN')
      const out = await fn(c)
      await c.query('COMMIT')
      return out
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      c.release()
    }
  }

  async ping() {
    try {
      await this.pool.query('SELECT 1')
      return true
    } catch {
      return false
    }
  }

  async syncProviders(list: { key: string; name: string; baseUrl: string }[]) {
    await this.pool.query(
      `INSERT INTO providers (key, name, base_url, priority)
       SELECT t.key, t.name, t.base_url, (t.ord - 1)::smallint
       FROM unnest($1::text[], $2::text[], $3::text[]) WITH ORDINALITY AS t(key, name, base_url, ord)
       ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, base_url = EXCLUDED.base_url, priority = EXCLUDED.priority`,
      [list.map(p => p.key), list.map(p => p.name), list.map(p => p.baseUrl)]
    )
  }

  async saveSummaries(items: SeriesSummary[]) {
    const rows = dedupe(items, i => i.id)
    if (!rows.length) return
    const ref = (s: SeriesSummary) => s.id.slice(s.provider.length + 1)
    await this.tx(async c => {
      const { rows: saved } = await c.query<Row>(UPSERT_SUMMARIES, [
        rows.map(s => s.provider),
        rows.map(ref),
        rows.map(s => s.title),
        rows.map(s => normTitle(s.title)),
        rows.map(s => s.cover),
        rows.map(s => s.url),
        rows.map(s => s.type),
        rows.map(s => s.status),
        rows.map(s => s.rating),
        rows.map(s => s.chapterCount),
        rows.map(s => s.latestChapter)
      ])
      const dbId = new Map(saved.map(r => [`${r.provider}:${r.ref}`, r.id as string]))
      const links: { sid: string; slug: string }[] = []
      const all = new Map<string, string>()
      for (const s of rows) {
        const { slugs, names } = genrePairs(s.genres)
        slugs.forEach((slug, i) => {
          all.set(slug, names[i])
          const id = dbId.get(s.id)
          if (id) links.push({ sid: id, slug })
        })
      }
      if (!links.length) return
      await c.query(UPSERT_GENRES, [[...all.keys()], [...all.values()]])
      await c.query(
        `INSERT INTO series_genres (series_id, genre_id)
         SELECT t.sid, g.id FROM unnest($1::bigint[], $2::text[]) AS t(sid, slug) JOIN genres g ON g.slug = t.slug
         ON CONFLICT DO NOTHING`,
        [links.map(l => l.sid), links.map(l => l.slug)]
      )
    })
  }

  async saveDetail(d: SeriesDetail) {
    const ref = d.id.slice(d.provider.length + 1)
    await this.tx(async c => {
      const { rows } = await c.query<Row>(UPSERT_DETAIL, [
        d.provider, ref, d.title, normTitle(d.title), d.cover, d.url, d.type, d.status,
        d.synopsis, d.author, d.artist, d.year, d.rating, d.chapters.length || d.chapterCount, d.latestChapter
      ])
      const id = rows[0].id as string

      const { slugs, names } = genrePairs(d.genres)
      if (slugs.length) {
        await c.query(UPSERT_GENRES, [slugs, names])
        await c.query(
          `DELETE FROM series_genres sg USING genres g
           WHERE sg.series_id = $1 AND g.id = sg.genre_id AND g.slug <> ALL($2::text[])`,
          [id, slugs]
        )
        await c.query(
          `INSERT INTO series_genres (series_id, genre_id) SELECT $1, g.id FROM genres g WHERE g.slug = ANY($2::text[])
           ON CONFLICT DO NOTHING`,
          [id, slugs]
        )
      }

      const chapters = dedupe(d.chapters, ch => ch.id)
      if (chapters.length) {
        const n = (s: string) => (Number.isFinite(parseFloat(s)) ? parseFloat(s) : null)
        await c.query(UPSERT_CHAPTERS, [
          id,
          chapters.map(ch => ch.id.slice(d.provider.length + 1)),
          chapters.map(ch => n(ch.number)),
          chapters.map(ch => ch.number),
          chapters.map(ch => ch.title),
          chapters.map(ch => ch.date)
        ])
      }
    })
  }

  async findSeries(provider: ProviderKey, ref: string) {
    const { rows } = await this.pool.query<Row>('SELECT title, norm_title FROM series WHERE provider = $1 AND ref = $2', [provider, ref])
    return rows[0] ? { title: rows[0].title as string, normTitle: rows[0].norm_title as string } : null
  }

  async siblings(normTitleValue: string, exclude: ProviderKey) {
    const { rows } = await this.pool.query<Row>(
      `SELECT s.provider, s.ref FROM series s JOIN providers p ON p.key = s.provider
       WHERE s.norm_title = $1 AND s.provider <> $2 ORDER BY p.priority`,
      [normTitleValue, exclude]
    )
    return rows.map(r => ({ provider: r.provider as ProviderKey, ref: r.ref as string }))
  }

  async findChapter(provider: ProviderKey, ref: string) {
    const { rows } = await this.pool.query<Row>(
      `SELECT s.ref AS series_ref, c.number_text FROM chapters c JOIN series s ON s.id = c.series_id
       WHERE s.provider = $1 AND c.ref = $2 LIMIT 1`,
      [provider, ref]
    )
    return rows[0] ? { seriesRef: rows[0].series_ref as string, number: rows[0].number_text as string } : null
  }

  // ---- listing dari DB (dedupe lintas provider berdasarkan norm_title) ----

  /**
   * Satu baris per norm_title (provider berprioritas tertinggi menang).
   * Genre & sumber alternatif diambil terpisah hanya untuk baris yang lolos LIMIT.
   */
  private async list(
    q: { select?: string; join?: string; where?: string; params: unknown[]; order: string },
    { limit, offset }: DbPage
  ): Promise<SeriesSummary[]> {
    const n = q.params.length
    const { rows } = await this.pool.query<Row>(
      `SELECT x.* FROM (
         SELECT DISTINCT ON (s.norm_title) s.*${q.select ?? ''}
         FROM series s JOIN providers pr ON pr.key = s.provider ${q.join ?? ''}
         ${q.where ?? ''}
         ORDER BY s.norm_title, pr.priority, s.last_seen_at DESC
       ) x ORDER BY ${q.order} LIMIT $${n + 1} OFFSET $${n + 2}`,
      [...q.params, limit, offset]
    )
    return this.hydrate(rows)
  }

  private async hydrate(rows: Row[]): Promise<SeriesSummary[]> {
    if (!rows.length) return []
    const [genres, sources] = await Promise.all([
      this.pool.query<Row>(
        `SELECT sg.series_id, array_agg(g.name ORDER BY g.name) AS names
         FROM series_genres sg JOIN genres g ON g.id = sg.genre_id WHERE sg.series_id = ANY($1::bigint[]) GROUP BY sg.series_id`,
        [rows.map(r => r.id)]
      ),
      this.pool.query<Row>(
        `SELECT s.norm_title, s.provider, s.ref FROM series s JOIN providers p ON p.key = s.provider
         WHERE s.norm_title = ANY($1::text[]) ORDER BY p.priority`,
        [rows.map(r => r.norm_title)]
      )
    ])
    const genreMap = new Map(genres.rows.map(r => [String(r.series_id), r.names as string[]]))
    const sourceMap = new Map<string, SourceRef[]>()
    for (const s of sources.rows) {
      const list = sourceMap.get(s.norm_title) ?? []
      list.push({ provider: s.provider, id: `${s.provider}:${s.ref}` })
      sourceMap.set(s.norm_title, list)
    }
    return rows.map(r => {
      const id = `${r.provider}:${r.ref}`
      const others = (sourceMap.get(r.norm_title) ?? []).filter(s => s.id !== id)
      return {
        id,
        provider: r.provider as ProviderKey,
        title: r.title,
        cover: r.cover,
        url: r.url,
        type: r.type,
        status: r.status as SeriesStatus | null,
        genres: genreMap.get(String(r.id)) ?? [],
        rating: r.rating,
        chapterCount: r.chapter_count,
        latestChapter: r.latest_chapter,
        sources: [{ provider: r.provider, id }, ...others]
      }
    })
  }

  async searchLocal(q: string, p: DbPage) {
    const nq = normTitle(q)
    if (!nq) return []
    const filter = p.provider ? ' AND s.provider = $2' : ''
    return this.list(
      {
        where: `WHERE s.norm_title LIKE '%' || $1 || '%'${filter}`,
        params: p.provider ? [nq, p.provider] : [nq],
        order: 'similarity(x.norm_title, $1) DESC, x.last_seen_at DESC, x.id'
      },
      p
    )
  }

  latestLocal(p: DbPage) {
    return this.list(
      { where: p.provider ? 'WHERE s.provider = $1' : '', params: p.provider ? [p.provider] : [], order: 'x.last_seen_at DESC, x.id' },
      p
    )
  }

  /** Skor = total hit detail dalam `days` hari terakhir (semua provider untuk judul yang sama); seri tanpa hit diurutkan rating lalu terbaru. */
  popular(p: DbPage & { days: number }) {
    return this.list(
      {
        select: ', SUM(COALESCE(v.views, 0)) OVER (PARTITION BY s.norm_title) AS score',
        join: `LEFT JOIN (SELECT series_id, SUM(views) AS views FROM series_views
                          WHERE day > CURRENT_DATE - $1::int GROUP BY series_id) v ON v.series_id = s.id`,
        where: 'WHERE ($2::text IS NULL OR s.provider = $2::text)',
        params: [p.days, p.provider ?? null],
        order: 'x.score DESC, x.rating DESC NULLS LAST, x.last_seen_at DESC, x.id'
      },
      p
    )
  }

  async genres(): Promise<GenreRow[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT g.slug, g.name, COUNT(DISTINCT s.norm_title)::int AS n
       FROM genres g JOIN series_genres sg ON sg.genre_id = g.id JOIN series s ON s.id = sg.series_id
       GROUP BY g.id ORDER BY n DESC, g.name`
    )
    return rows.map(r => ({ slug: r.slug, name: r.name, count: r.n }))
  }

  /** Sortir & filter format/status dilakukan di SQL (whitelist, bukan input mentah). */
  byGenre(slug: string, p: DbPage & GenreFilters) {
    const params: unknown[] = [slug]
    const where = ['g.slug = $1']
    const add = (cond: string, v: unknown) => {
      params.push(v)
      where.push(cond.replace('?', `$${params.length}`))
    }
    if (p.provider) add('s.provider = ?', p.provider)
    if (p.type) add('s.type = ?', p.type)
    if (p.status) add('s.status = ?', p.status)
    const sort: SortKey = p.sort ?? 'latest'
    const popular = sort === 'popular'
    return this.list(
      {
        select: popular ? ', SUM(COALESCE(v.views, 0)) OVER (PARTITION BY s.norm_title) AS score' : '',
        join:
          'JOIN series_genres sg ON sg.series_id = s.id JOIN genres g ON g.id = sg.genre_id' +
          (popular
            ? ' LEFT JOIN (SELECT series_id, SUM(views) AS views FROM series_views WHERE day > CURRENT_DATE - 30 GROUP BY series_id) v ON v.series_id = s.id'
            : ''),
        where: `WHERE ${where.join(' AND ')}`,
        params,
        order: GENRE_ORDER[sort]
      },
      p
    )
  }

  async addViews(rows: { provider: ProviderKey; ref: string; n: number }[]) {
    if (!rows.length) return
    await this.pool.query(
      `INSERT INTO series_views (series_id, day, views)
       SELECT s.id, CURRENT_DATE, v.n
       FROM unnest($1::text[], $2::text[], $3::int[]) AS v(provider, ref, n)
       JOIN series s ON s.provider = v.provider AND s.ref = v.ref
       ORDER BY s.id
       ON CONFLICT (series_id, day) DO UPDATE SET views = series_views.views + EXCLUDED.views`,
      [rows.map(r => r.provider), rows.map(r => r.ref), rows.map(r => r.n)]
    )
  }

  async needingDetail(limit: number) {
    const { rows } = await this.pool.query<Row>(
      `SELECT s.provider, s.ref FROM series s
       WHERE s.detail_fetched_at IS NULL AND NOT EXISTS (SELECT 1 FROM series_genres sg WHERE sg.series_id = s.id)
       ORDER BY s.last_seen_at DESC LIMIT $1`,
      [limit]
    )
    return rows.map(r => ({ provider: r.provider as ProviderKey, ref: r.ref as string }))
  }

  async prune() {
    await this.pool.query(`DELETE FROM series_views WHERE day < CURRENT_DATE - 90`)
  }
}
