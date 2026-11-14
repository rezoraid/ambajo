import { PROVIDER_KEYS, type ProviderKey } from './core/types.js'

const env = process.env
const int = (k: string, d: number) => {
  const raw = env[k]
  const n = raw === undefined || raw === '' ? NaN : Number(raw)
  return Number.isFinite(n) ? n : d
}
const min = (n: number) => n * 60_000
const hour = (n: number) => n * 3_600_000

const providers = (env.PROVIDERS ?? 'shinigami,manta,lumos')
  .split(',')
  .map(s => s.trim())
  .filter((s): s is ProviderKey => (PROVIDER_KEYS as readonly string[]).includes(s))

export const config = {
  port: int('PORT', 3000),
  host: env.HOST ?? '0.0.0.0',
  logLevel: env.LOG_LEVEL ?? 'info',
  trustProxy: env.TRUST_PROXY === 'true',
  databaseUrl: env.DATABASE_URL ?? 'postgres://scraper:scraper@localhost:5432/scraper',
  pgPoolMax: int('PG_POOL_MAX', 10),
  autoMigrate: env.AUTO_MIGRATE !== 'false',
  redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
  providers: providers.length ? providers : [...PROVIDER_KEYS],
  rateLimitMax: int('RATE_LIMIT_MAX', 120),
  aggregateTimeoutMs: int('AGGREGATE_TIMEOUT_MS', 8000),
  primaryTimeoutMs: int('PRIMARY_TIMEOUT_MS', 12000),
  warmer: {
    enabled: env.WARMER !== 'false',
    intervalMs: int('WARM_INTERVAL_SEC', 600) * 1000,
    enrich: int('WARM_ENRICH', 5)
  },
  /** fresh = dilayani langsung, stale = dilayani + refresh background / saat upstream gagal */
  ttl: {
    search: { fresh: min(5), stale: hour(1) },
    latest: { fresh: min(2), stale: hour(1) },
    detail: { fresh: min(15), stale: hour(24) },
    chapter: { fresh: min(10), stale: hour(1) },
    db: { fresh: min(1), stale: min(10) },
    genres: { fresh: min(10), stale: hour(1) }
  }
}
export type Config = typeof config
