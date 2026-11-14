import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Pool } from 'pg'

const DEFAULT_DIR = fileURLToPath(new URL('../../migrations', import.meta.url))
const LOCK_ID = 727274

/** Jalankan file *.sql berurutan, tiap file dalam 1 transaksi; aman dijalankan paralel (advisory lock). */
export async function migrate(pool: Pool, dir = DEFAULT_DIR): Promise<string[]> {
  const client = await pool.connect()
  const applied: string[] = []
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID])
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
    )
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map(r => r.name as string))
    const files = (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()
    for (const file of files) {
      if (done.has(file)) continue
      const sql = await readFile(join(dir, file), 'utf8')
      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
        await client.query('COMMIT')
        applied.push(file)
      } catch (e) {
        await client.query('ROLLBACK')
        throw new Error(`Migration ${file} gagal: ${(e as Error).message}`)
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {})
    client.release()
  }
  return applied
}
