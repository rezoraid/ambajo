import pg from 'pg'
import type { Pool } from 'pg'
import type { Config } from '../config.js'

export function createPool(cfg: Pick<Config, 'databaseUrl' | 'pgPoolMax'>): Pool {
  const pool = new pg.Pool({
    connectionString: cfg.databaseUrl,
    max: cfg.pgPoolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 3_000,
    statement_timeout: 8_000,
    application_name: 'unified-scraper-api'
  })
  // Tanpa listener ini koneksi idle yang putus akan menjatuhkan proses.
  pool.on('error', err => console.error('[pg] idle client error:', err.message))
  return pool
}
