/** Adapter diuji dengan fetch ter-mock; bentuk payload mengikuti field yang dibaca scraper asli. */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createLumos } from '../src/providers/lumos.js'
import { createManta } from '../src/providers/manta.js'
import { createShinigami } from '../src/providers/shinigami.js'
import { mockFetch } from './helpers.js'

const nextData = (pageProps: unknown) => `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps } })}</script></html>`

describe('manta', () => {
  const seriesRaw = { id: 5, type: 60, episodeCount: 3, data: { title: { en: 'Manta Title' }, tags: [{ name: { en: 'Action' } }], creators: [{ name: 'Kim' }] }, image: { '1280x1840_720': { downloadUrl: 'cover.jpg' } } }
  const episodes = [{ id: 9001, ord: 1, openAt: '2024-01-02T00:00:00Z' }, { id: 9002, ord: 2, openAt: 1704164645000 }, { id: 9003, ord: 3 }]

  it('latest & search -> format unified', async () => {
    const m = mockFetch({
      '/front/v1/home/': () => ({ json: { data: { seriesMap: { 5: seriesRaw }, items: [{ seriesId: 5 }, { seriesId: 99 }] } } }),
      '/manta/v1/search/series': () => ({ json: { data: [seriesRaw] } })
    })
    try {
      const a = createManta()
      const [item] = await a.latest({ page: 1, limit: 20, type: 'manga' })
      assert.equal(item.id, 'manta:5')
      assert.equal(item.type, 'manga')
      assert.deepEqual(item.genres, ['Action'])
      assert.equal(item.cover, 'cover.jpg')
      assert.ok(m.calls[0].includes('homeType=manga'))
      assert.equal((await a.search('x', { page: 1, limit: 10 })).length, 1)
      assert.equal((await a.search('x', { page: 2, limit: 10 })).length, 0)
    } finally { m.restore() }
  })

  it('detail & chapter (nomor < 1000 -> id episode, prev/next, urut terbaru dulu)', async () => {
    const m = mockFetch({
      '/en/series/5': () => ({ text: nextData({ initialSeries: { ...seriesRaw, episodes } }) }),
      '/en/episodes/9002': () => ({ text: nextData({ previewCutImages: [{ downloadUrl: 'i1' }, { downloadUrl: 'i2' }, {}] }) })
    })
    try {
      const a = createManta()
      const d = await a.detail('5')
      assert.deepEqual(d.chapters.map(c => c.number), ['3', '2', '1'])
      assert.equal(d.chapters[1].id, 'manta:5:9002')
      assert.equal(d.chapters[1].date, '2024-01-02T03:04:05.000Z')
      assert.equal(d.author, 'Kim')
      const ch = await a.chapter('5:2') // nomor chapter -> dipetakan ke id episode
      assert.equal(ch.id, 'manta:5:9002')
      assert.deepEqual(ch.images, ['i1', 'i2'])
      assert.equal(ch.prev, 'manta:5:9001')
      assert.equal(ch.next, 'manta:5:9003')
      assert.equal(m.calls.filter(u => u.includes('/en/series/5')).length, 1, 'halaman seri di-memo')
    } finally { m.restore() }
  })

  it('404 -> NotFoundError tanpa retry', async () => {
    const m = mockFetch({ '/en/series/404': () => ({ status: 404 }) })
    try {
      await assert.rejects(createManta().detail('404'), { code: 'NOT_FOUND' })
      assert.equal(m.calls.length, 1)
    } finally { m.restore() }
  })
})

describe('shinigami', () => {
  const manga = { manga_id: 'abc', title: 'Shini', status: 1, cover_portrait_url: 'p.jpg', latest_chapter_number: 12, taxonomy: { Type: [{ name: 'Manhwa' }], Genre: [{ name: 'Drama' }], Author: [{ name: 'Au' }] } }

  it('search/latest/detail (chapter list multi-halaman)/chapter', async () => {
    const m = mockFetch({
      '/v1/manga/list': () => ({ json: { retcode: 0, data: [manga, { manga_id: '', title: 'x' }] } }),
      '/v1/manga/detail/abc': () => ({ json: { retcode: 0, data: { ...manga, description: 'desc', release_year: 2021 } } }),
      'page=1&page_size=100': () => ({ json: { retcode: 0, meta: { total_page: 2 }, data: [{ chapter_id: 'c1', chapter_number: 1, release_date: '2024-02-01T00:00:00Z' }] } }),
      'page=2&page_size=100': () => ({ json: { retcode: 0, data: [{ chapter_id: 'c2', chapter_number: 2 }] } }),
      '/v1/chapter/detail/c2': () => ({ json: { retcode: 0, data: { chapter_id: 'c2', manga_id: 'abc', chapter_number: 2, prev_chapter_id: 'c1', chapter: { base_url: 'https://cdn/', path: '/p/', data: ['1.jpg', 'https://o/2.jpg'] } } } })
    })
    try {
      const a = createShinigami()
      const [s] = await a.search('shini', { page: 1, limit: 10 })
      assert.equal(s.id, 'shinigami:abc')
      assert.equal(s.type, 'manhwa')
      assert.equal(s.status, 'ongoing')
      assert.equal(s.latestChapter, '12')
      assert.ok(m.calls[0].includes('q=shini') && m.calls[0].includes('page_size=10'))
      assert.equal((await a.latest({ page: 1, limit: 10 })).length, 1)
      const d = await a.detail('abc')
      assert.deepEqual(d.chapters.map(c => c.id), ['shinigami:c2', 'shinigami:c1'])
      assert.equal(d.synopsis, 'desc')
      assert.equal(d.year, 2021)
      assert.equal(d.chapterCount, 2)
      const ch = await a.chapter('c2')
      assert.deepEqual(ch.images, ['https://cdn/p/1.jpg', 'https://o/2.jpg'])
      assert.equal(ch.seriesId, 'shinigami:abc')
      assert.equal(ch.prev, 'shinigami:c1')
      assert.equal(ch.next, null)
    } finally { m.restore() }
  })

  it('retcode != 0 -> error (setelah retry)', async () => {
    const m = mockFetch({ '/v1/manga/list': () => ({ json: { retcode: 5, message: 'bad' } }) })
    try {
      await assert.rejects(createShinigami().latest({ page: 1, limit: 5 }), /bad/)
      assert.equal(m.calls.length, 3)
    } finally { m.restore() }
  })
})

describe('lumos (parser mengikuti scraper terbaru)', () => {
  const b64 = (u: string) => Buffer.from(u).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

  it('latest, search (+fallback), rotasi mirror, thumbnail base64', async () => {
    let first = true
    const m = mockFetch({
      '/api/home-latest': () => (first ? ((first = false), { status: 500 }) : { json: { data: { items: [{ slug: 's1', title: 'Lumos T', coverImage: `/api/image/thumbnail?src=${b64('https://cdn.x/c.webp')}`, type: 'Manhwa', status: 'Ongoing', rating: '4.5', recentChapters: [{ number: 3 }, { number: 10 }] }] } } }),
      '/api/search': () => ({ json: { results: [{ slug: 's1', title: 'Lumos T' }, { title: 'tanpa slug' }] } })
    })
    try {
      const a = createLumos()
      const [i] = await a.latest({ page: 1, limit: 10 })
      assert.ok(m.calls[1].startsWith('https://02.lumosgg.com'), 'mirror berikutnya dipakai')
      assert.equal(i.id, 'lumos:s1')
      assert.equal(i.latestChapter, '10')
      assert.equal(i.type, 'manhwa')
      assert.equal(i.status, 'ongoing')
      assert.equal(i.cover, 'https://cdn.x/c.webp')
      assert.equal((await a.search('lumos', { page: 1, limit: 10 })).length, 1)
    } finally { m.restore() }
  })

  const browseHtml = `<div id="bf"><label data-bf-genre-name="slice of life">Slice of Life</label><label data-bf-genre-name="sci-fi">Sci-Fi</label></div>`
  const cards = `<div class="htg-card x"><a href="/comic/abc"><h3>Judul &amp; A</h3></a><img src="/c/abc.jpg"><svg></svg> 4.7 </span><span class="capitalize">Ongoing</span><span class="text-surface-300"> 25</span></div>
    <div class="htg-card x"><a href="/comic/def"><h3>B</h3></a></div>`

  it('browse: genre/sort/type dipetakan ke query Lumos & kartu diparse', async () => {
    const m = mockFetch({ '/browse?sort=': () => ({ text: cards }), '/browse?page=': () => ({ text: cards }), '/browse': () => ({ text: browseHtml }) })
    try {
      const a = createLumos()
      const items = await a.browse!({ page: 2, sort: 'popular', genre: 'sci-fi', type: 'manhwa', status: 'ongoing' })
      const url = m.calls.at(-1)!
      assert.ok(url.includes('page=2') && url.includes('sort=popular') && url.includes('type=manhwa') && url.includes('status=ongoing') && url.includes('genre=sci-fi'), url)
      assert.equal(items.length, 2)
      assert.deepEqual([items[0].id, items[0].title, items[0].rating, items[0].status, items[0].chapterCount], ['lumos:abc', 'Judul & A', 4.7, 'ongoing', 25])
      assert.deepEqual(items[0].genres, ['Sci-Fi'])
      assert.equal(items[0].type, 'manhwa')
      assert.deepEqual(await a.browse!({ page: 1, sort: 'latest', genre: 'tidak-ada' }), [])
      assert.deepEqual(await a.listGenres!(), ['Slice of Life', 'Sci-Fi'])
      assert.ok((await a.browse!({ page: 1, sort: 'latest', genre: 'slice-of-life' })).length)
      assert.ok(m.calls.at(-1)!.includes('genre=slice+of+life'))
    } finally { m.restore() }
  })

  it('detail & chapter dari HTML', async () => {
    const detailHtml = `<html><h1>Lumos T</h1><div>Status</div><span class="capitalize">Ongoing</span><div>Type</div><div class="text-sm">Manhwa</div>
      <a href="/browse?genre=action">Action</a><a href="/browse?genre=boys'%20love">Boys&#39; Love</a><span class="rating-value">4.2</span>
      <a href="/read/s1/chapter-2" class="x" data-chapter="2"><span class="text-heading">Judul</span></a>
      <a href="/read/s1/chapter-10" class="x" data-chapter="10">x</a><a href="/read/other/chapter-99" data-chapter="99">x</a>
      <div data-sr="${Buffer.from('Sinopsis').toString('base64')}"></div></html>`
    const readHtml = `<script>const chapterNumber = "10";</script>
      <img alt="Page 2" src="/file/comic/s1/10/2.jpg"><img src="/file/comic/s1/10/1.jpg" alt="Page 1">
      <a href="/read/s1/chapter-9">‹ Prev</a><a href="/read/s1/chapter-11">Next ›</a><a href="/read/s1/chapter-3">Chapter 3</a>`
    const m = mockFetch({ '/comic/s1': () => ({ text: detailHtml }), '/read/s1/chapter-10': () => ({ text: readHtml }) })
    try {
      const a = createLumos()
      const d = await a.detail('s1')
      assert.deepEqual(d.chapters.map(c => c.number), ['10', '2'])
      assert.equal(d.chapters[0].id, 'lumos:s1:chapter-10')
      assert.equal(d.chapters[1].title, 'Judul')
      assert.deepEqual(d.genres, ['Action', "Boys' Love"])
      assert.equal(d.synopsis, 'Sinopsis')
      assert.equal(d.rating, 4.2)
      assert.equal(d.status, 'ongoing')
      assert.equal(d.type, 'manhwa')
      const ch = await a.chapter('s1:chapter-10')
      assert.equal(ch.images.length, 2)
      assert.ok(ch.images[0].endsWith('/1.jpg'), 'urut halaman')
      assert.equal(ch.prev, 'lumos:s1:chapter-9')
      assert.equal(ch.next, 'lumos:s1:chapter-11')
      assert.equal(ch.number, '10')
    } finally { m.restore() }
  })
})
