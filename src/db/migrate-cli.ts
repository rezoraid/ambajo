import { config } from '../config.js'
import { migrate } from './migrate.js'
import { createPool } from './pool.js'

const pool = createPool(config)
try {
  const applied = await migrate(pool)
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database sudah up-to-date')
} catch (e) {
  console.error((e as Error).message)
  process.exitCode = 1
} finally {
  await pool.end()
}
