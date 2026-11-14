/**
 * Uji integrasi PgStore + migration terhadap PostgreSQL asli.
 *   TEST_DATABASE_URL=postgres://user:pass@localhost:5432/scraper_test npm test
 * Nama database WAJIB berakhiran "_test" (schema public akan di-reset).
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { migrate } from '../src/db/migrate.js'
import { createPool } from '../src/db/pool.js'
import { PgStore } from '../src/db/store.js'
import type { SeriesDetail, SeriesSummary } from '../src/core/types.js'

const url = process.env.TEST_DATABASE_URL
const skip = !url || !/_test(\?|$)/.test(url) ? 'set TEST_DATABASE_URL (nama db berakhiran _test)' : false

const summary = (provider: SeriesSummary['provider'], ref: string, title: string, genres: string[], extra: Partial<SeriesSummary> = {}): SeriesSummary => ({
  id: `${provider}:${ref}`, provider, title, cover: 'c.jpg', url: `u/${ref}`, type: 'manhwa', status: 'ongoing',
  genres, rating: null, chapterCount: null, latestChapter: null, sources: [{ provider, id: `${provider}:${ref}` }], ...extra
})
const detail = (s: SeriesSummary, nums: string[]): SeriesDetail => ({
  ...s, synopsis: 'sinopsis', author: 'A', artist: 'B', year: 2020,
  chapters: nums.map(n => ({ id: `${s.provider}:${s.id.split(':')[1]}:ch${n}`, number: n, title: `T${n}`, date: '2024-01-02T03:04:05.000Z' }))
})

describe('PgStore', { skip }, () => {
  const pool = createPool({ databaseUrl: url!, pgPoolMax: 4 })
  const store = new PgStore(pool)

  before(async () => {
    await pool.query('DROP SCHEMA public CASCADE')
    await pool.query('CREATE SCHEMA public')
    assert.deepEqual(await migrate(pool), ['001_init.sql'])
    assert.deepEqual(await migrate(pool), [], 'migration idempoten')
    await store.syncProviders([
      { key: 'shinigami', name: 'Shinigami', baseUrl: 'x' },
      { key: 'manta', name: 'Manta', baseUrl: 'x' },
      { key: 'lumos', name: 'Lumos', baseUrl: 'x' }
    ])
  })
  after(() => pool.end())

  const a = summary('shinigami', 'uuid-1', 'Solo Leveling', ['Action', 'Fantasy'], { latestChapter: '200' })
  const b = summary('manta', '77', 'Solo-Leveling!', ['Action'])
  const c = summary('lumos', 'slug-x', 'Another Title', [])

  it('saveSummaries: upsert batch, dedupe & genre link', async () => {
    await store.saveSummaries([a, b, c, a])
    await store.saveSummaries([{ ...a, cover: '', latestChapter: null }]) // tidak boleh menimpa dengan kosong
    const [hit] = await store.searchLocal('solo leveling', { limit: 10, offset: 0 })
    assert.equal(hit.id, 'shinigami:uuid-1')
    assert.equal(hit.cover, 'c.jpg')
    assert.equal(hit.latestChapter, '200')
    assert.deepEqual(hit.genres, ['Action', 'Fantasy'])
    assert.deepEqual(hit.sources.map(s => s.id), ['shinigami:uuid-1', 'manta:77'])
  })

  it('siblings & findSeries memakai norm_title', async () => {
    const f = await store.findSeries('manta', '77')
    assert.equal(f?.normTitle, 'sololeveling')
    assert.deepEqual(await store.siblings('sololeveling', 'manta'), [{ provider: 'shinigami', ref: 'uuid-1' }])
  })

  it('saveDetail: chapters, ganti genre, idempoten', async () => {
    await store.saveDetail(detail({ ...b, genres: ['Action', 'Drama'] }, ['2', '1', '1.5']))
    await store.saveDetail(detail({ ...b, genres: ['Drama'] }, ['2', '1', '1.5']))
    assert.deepEqual(await store.findChapter('manta', '77:ch1.5'), { seriesRef: '77', number: '1.5' })
    assert.equal(await store.findChapter('manta', 'nope'), null)
    const rows = await store.byGenre('drama', { limit: 10, offset: 0 })
    assert.equal(rows.length, 1)
    const { rows: n } = await pool.query("SELECT count(*)::int AS n FROM chapters")
    assert.equal(n[0].n, 3)
  })

  it('genres & byGenre dedupe lintas provider', async () => {
    const g = await store.genres()
    assert.deepEqual(g.find(x => x.slug === 'action'), { slug: 'action', name: 'Action', count: 1 })
    const action = await store.byGenre('action', { limit: 10, offset: 0 })
    assert.equal(action.length, 1)
    assert.equal(action[0].provider, 'shinigami')
    assert.equal((await store.byGenre('action', { limit: 10, offset: 0, provider: 'manta' })).length, 0)
  })

  it('byGenre: sortir (az/rating/popular) & filter format/status', async () => {
    await store.saveSummaries([
      summary('manta', 'z1', 'Zeta', ['Action'], { type: 'manga', rating: 3, status: 'completed' }),
      summary('manta', 'a1', 'Alpha', ['Action'], { type: 'manhua', rating: 4.5 })
    ])
    const q = { limit: 10, offset: 0 }
    assert.deepEqual((await store.byGenre('action', { ...q, sort: 'az' })).map(x => x.title), ['Alpha', 'Solo Leveling', 'Zeta'])
    assert.deepEqual((await store.byGenre('action', { ...q, sort: 'rating' })).map(x => x.title), ['Alpha', 'Zeta', 'Solo Leveling'])
    assert.deepEqual((await store.byGenre('action', { ...q, type: 'manga' })).map(x => x.title), ['Zeta'])
    assert.deepEqual((await store.byGenre('action', { ...q, status: 'completed', sort: 'popular' })).map(x => x.title), ['Zeta'])
    assert.equal((await store.byGenre('action', { ...q, sort: 'popular' })).length, 3)
  })

  it('latestLocal, needingDetail', async () => {
    const latest = await store.latestLocal({ limit: 10, offset: 0 })
    assert.equal(latest.length, 4)
    assert.deepEqual(await store.needingDetail(5), [{ provider: 'lumos', ref: 'slug-x' }])
  })

  it('popular: skor view, lalu fallback rating/terbaru', async () => {
    await store.addViews([{ provider: 'lumos', ref: 'slug-x', n: 3 }, { provider: 'manta', ref: '77', n: 1 }])
    await store.addViews([{ provider: 'lumos', ref: 'slug-x', n: 2 }, { provider: 'lumos', ref: 'unknown', n: 9 }])
    const pop = await store.popular({ limit: 10, offset: 0, days: 7 })
    assert.deepEqual(pop.map(p => p.title), ['Another Title', 'Solo Leveling'])
    assert.equal((await store.popular({ limit: 1, offset: 1, days: 7 })).length, 1)
    await store.prune()
  })

  it('searchLocal kosong untuk query tanpa huruf/angka', async () => {
    assert.deepEqual(await store.searchLocal('!!!', { limit: 5, offset: 0 }), [])
  })
})
