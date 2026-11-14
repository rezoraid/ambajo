# Unified Scraper API

Satu REST API (Node.js + TypeScript + Fastify) untuk tiga provider: **Shinigami**, **Manta**, **Lumos**.
Format data seragam, fallback otomatis antar provider, cache Redis (stale-while-revalidate), PostgreSQL sebagai data utama.

## Jalankan
```bash
docker compose up --build          # API di :3000, dokumentasi di /docs
# atau lokal:
cp .env.example .env && npm install && npm run build && npm start
```
Migration otomatis saat start (`AUTO_MIGRATE=true`) atau manual `npm run migrate`.

**Verifikasi scraper ke situs asli (wajib dijalankan sekali di jaringan Anda):**
```bash
npm run smoke            # semua provider
npm run smoke manta      # satu provider
```
Alur: latest → search → detail → chapter, lengkap dengan waktu & jumlah data; exit code 1 jika ada yang gagal.

Tes: `npm test` (unit). Tes integrasi DB: `TEST_DATABASE_URL=postgres://.../scraper_test npm test`.

## Endpoint (`/v1`, dokumentasi interaktif di `/docs`)
| Endpoint | Fungsi |
|---|---|
| `GET /search?q=&page=&limit=&provider=` | cari di semua provider |
| `GET /latest?page=&limit=&provider=&type=` | update terbaru (`type` = comic/manga/novel, hanya Manta) |
| `GET /popular?days=7&page=&limit=` | populer (lihat catatan) |
| `GET /genres` | daftar genre (DB + genre native Lumos) |
| `GET /genres/:slug/series?sort=&type=&status=` | seri per genre; `sort` = latest/popular/rating/az, `type` (format) = manga/manhwa/manhua/comic/novel, `status` = ongoing/completed/hiatus |
| `GET /series/:id` | detail + daftar chapter |
| `GET /series/:id/chapters` | daftar chapter |
| `GET /chapters/:id` | gambar chapter + `imageHeaders` |
| `GET /providers` | status provider, circuit breaker, header gambar |
| `GET /health` | cek PostgreSQL & Redis |

**Id unified** = `<provider>:<id asli>`: `shinigami:<uuid>`, `manta:123`, `lumos:<slug>`.
Id chapter: `shinigami:<chapterId>`, `manta:<seri>:<episode>`, `lumos:<slug>:<chapter-slug>` — ambil dari `chapters[].id`.
Sukses: `{ data, meta }`. Error: `{ error: { code, message } }`.
Unduh gambar dengan header dari `imageHeaders` (referer wajib untuk provider tertentu).

## Fallback
- **List (search/latest)**: semua provider dipanggil paralel dengan batas waktu; yang gagal dilewati (`meta.degraded`, `meta.providers`). Jika semuanya gagal → cache stale → data terakhir di PostgreSQL.
- **Detail/chapter**: jika provider asal gagal, dicari seri yang sama (judul ternormalisasi) di provider lain — dari DB, atau lewat search provider lain; chapter dicocokkan lewat nomor. `meta.fallback=true`, `meta.provider` = sumber sebenarnya.
- Circuit breaker per provider (5 gagal → buka 30 dtk) agar provider mati tidak memperlambat respons.

## Cache & kecepatan
Redis, stale-while-revalidate + singleflight (request bersamaan = 1 fetch upstream). TTL fresh/stale di `src/config.ts`
(detail 15 mnt/24 jam, latest 2 mnt/1 jam, search 5 mnt/1 jam, chapter 10 mnt/1 jam). Redis mati → cache dilewati, API tetap jalan.
Respons di-gzip, ber-`ETag` (304) dan `Cache-Control`. Penulisan ke PostgreSQL dilakukan di background (batch `unnest`).
Warmer berkala mengisi cache/DB dan memperkaya seri tanpa genre.

## Database (PostgreSQL)
`providers`, `series` (unik `(provider, ref)`, `norm_title`, index trigram untuk pencarian lokal), `genres` + `series_genres`,
`chapters` (unik `(series_id, ref)`), `series_views`. Pool koneksi `PG_POOL_MAX`, `statement_timeout` 8 dtk.
Migration: `migrations/*.sql` (transaksional, advisory lock).

## Lumos (parser terbaru)
Adapter Lumos mengikuti scraper terbaru: tanpa cheerio (regex ringan), thumbnail `?src=<base64>` didekode ke URL CDN,
katalog `/browse` (genre/sort/type/status) dipakai untuk `genres/:slug/series` — hasilnya langsung disimpan ke PostgreSQL beserta genrenya,
sehingga genre Lumos ikut lengkap. Sortir & filter akhir dikerjakan SQL agar konsisten lintas provider.

## Catatan jujur
- Scraper asli tidak punya fungsi *popular* dan *genre*, dan saya tidak mengarang endpoint upstream. Maka:
  **popular** = seri paling banyak dibuka lewat API ini (hit detail) dalam N hari; **genre** = dibangun dari genre seri yang pernah dilihat
  (list Shinigami/Manta memuat genre; Lumos diisi saat genre dibuka lewat `/browse` live, atau dari halaman detail oleh warmer). Keduanya makin lengkap seiring pemakaian.
- `limit` berlaku per provider; Lumos `latest` memakai ukuran halaman upstream.
- `date` chapter dinormalkan ke ISO-8601; Lumos tidak menyediakan tanggal.
