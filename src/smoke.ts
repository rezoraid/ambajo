/**
 * Uji langsung ke situs asli, tanpa DB/Redis:  npm run smoke  [provider...]
 * Alur per provider: latest -> search -> detail -> chapter. Exit code 1 jika ada yang gagal.
 */
import { PROVIDER_KEYS, type ProviderKey } from './core/types.js'
import { parseId } from './core/ids.js'
import { createProviders } from './providers/index.js'

const wanted = process.argv.slice(2).filter((k): k is ProviderKey => (PROVIDER_KEYS as readonly string[]).includes(k))
let failed = 0

for (const p of createProviders(wanted.length ? wanted : [...PROVIDER_KEYS])) {
  const step = async <T>(name: string, fn: () => Promise<T>, info: (v: T) => string): Promise<T | undefined> => {
    const t0 = Date.now()
    try {
      const v = await fn()
      console.log(`  ✓ ${name.padEnd(8)} ${String(Date.now() - t0).padStart(5)}ms  ${info(v)}`)
      return v
    } catch (e) {
      failed++
      console.log(`  ✗ ${name.padEnd(8)} ${(e as Error).message}`)
    }
  }
  console.log(`\n[${p.key}]`)
  const latest = await step('latest', () => p.latest({ page: 1, limit: 10 }), v => `${v.length} item`)
  const first = latest?.[0]
  const q = first?.title.split(/\s+/).slice(0, 2).join(' ') ?? 'a'
  await step('search', () => p.search(q, { page: 1, limit: 10 }), v => `"${q}" -> ${v.length} item`)
  if (p.browse) await step('browse', () => p.browse!({ page: 1, sort: 'popular', genre: 'action' }), v => `genre=action sort=popular -> ${v.length} item`)
  if (!first) continue
  const detail = await step('detail', () => p.detail(parseId(first.id).ref), v => `${v.title} | ${v.chapters.length} chapter | genre: ${v.genres.join(', ') || '-'}`)
  const ch = detail?.chapters[0]
  if (!ch) continue
  await step('chapter', () => p.chapter(parseId(ch.id).ref), v => `ch ${v.number} | ${v.images.length} gambar | prev=${!!v.prev} next=${!!v.next}`)
}

console.log(failed ? `\n${failed} langkah gagal` : '\nSemua langkah berhasil')
process.exitCode = failed ? 1 : 0
