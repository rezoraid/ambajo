import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CircuitBreaker } from '../src/core/breaker.js'
import { Cache } from '../src/core/cache.js'
import { ValidationError } from '../src/core/errors.js'
import { parseId } from '../src/core/ids.js'
import { isoDate, memo, normTitle, slugify, splitOnce, withDeadline } from '../src/core/util.js'
import { MemoryKV, noopLog } from './helpers.js'

describe('ids & util', () => {
  it('parseId', () => {
    assert.deepEqual(parseId('manta:12:34'), { provider: 'manta', ref: '12:34' })
    for (const bad of ['x:1', 'manta:', ':1', 'manta', 'manta:a/b']) assert.throws(() => parseId(bad), ValidationError)
  })
  it('normTitle & slugify', () => {
    assert.equal(normTitle('Solo-Leveling!'), normTitle('solo leveling'))
    assert.equal(normTitle('Café'), 'cafe')
    assert.equal(slugify('Slice of Life'), 'slice-of-life')
  })
  it('isoDate', () => {
    assert.equal(isoDate('2024-01-02T03:04:05Z'), '2024-01-02T03:04:05.000Z')
    assert.equal(isoDate(1704164645), '2024-01-02T03:04:05.000Z')
    assert.equal(isoDate(1704164645000), '2024-01-02T03:04:05.000Z')
    assert.equal(isoDate('bukan tanggal'), null)
    assert.equal(isoDate(null), null)
  })
  it('splitOnce', () => {
    assert.deepEqual(splitOnce('a:b:c'), ['a', 'b:c'])
    assert.throws(() => splitOnce('abc'), ValidationError)
  })
  it('memo tidak menyimpan kegagalan', async () => {
    let n = 0
    const f = memo(async () => {
      if (++n === 1) throw new Error('x')
      return n
    }, 1000)
    await assert.rejects(f('a'))
    assert.equal(await f('a'), 2)
    assert.equal(await f('a'), 2)
  })
  it('withDeadline', async () => {
    await assert.rejects(withDeadline(new Promise(() => {}), 10), { code: 'UPSTREAM_TIMEOUT' })
    assert.equal(await withDeadline(Promise.resolve(1), 50), 1)
  })
})

describe('CircuitBreaker', () => {
  it('buka setelah threshold, half-open 1 probe setelah cooldown', async () => {
    const b = new CircuitBreaker(2, 20)
    assert.ok(b.canRequest())
    b.failure()
    b.failure()
    assert.equal(b.state, 'open')
    assert.equal(b.canRequest(), false)
    await new Promise(r => setTimeout(r, 25))
    assert.equal(b.state, 'half-open')
    assert.ok(b.canRequest())
    assert.equal(b.canRequest(), false, 'hanya 1 probe')
    b.success()
    assert.equal(b.state, 'closed')
  })
})

describe('Cache (SWR + singleflight)', () => {
  const ttl = { fresh: 30, stale: 5000 }

  it('miss -> hit, loader hanya sekali walau paralel', async () => {
    const c = new Cache(new MemoryKV(), noopLog)
    let n = 0
    const load = async () => (await new Promise(r => setTimeout(r, 10)), ++n)
    const [a, b] = await Promise.all([c.getOrSet('k', ttl, load), c.getOrSet('k', ttl, load)])
    assert.equal(a.value, 1)
    assert.equal(b.value, 1)
    assert.equal(n, 1)
    assert.equal((await c.getOrSet('k', ttl, load)).state, 'hit')
  })

  it('stale dilayani langsung, di-refresh di background; gagal -> tetap stale', async () => {
    const c = new Cache(new MemoryKV(), noopLog)
    await c.getOrSet('k', ttl, async () => 'v1')
    await new Promise(r => setTimeout(r, 40))
    const s = await c.getOrSet('k', ttl, async () => 'v2')
    assert.deepEqual(s, { value: 'v1', state: 'stale' })
    await new Promise(r => setTimeout(r, 10))
    assert.equal((await c.getOrSet('k', ttl, async () => 'x')).value, 'v2')

    await new Promise(r => setTimeout(r, 40))
    const failing = await c.getOrSet('k', ttl, async () => { throw new Error('down') })
    assert.deepEqual(failing, { value: 'v2', state: 'stale' })
  })

  it('miss + loader gagal -> error diteruskan', async () => {
    const c = new Cache(new MemoryKV(), noopLog)
    await assert.rejects(c.getOrSet('z', ttl, async () => { throw new Error('boom') }), /boom/)
  })

  it('Redis rusak -> cache dilewati, tidak melempar', async () => {
    const broken = { get: async () => { throw new Error('down') }, set: async () => { throw new Error('down') } }
    const c = new Cache(broken as any, noopLog)
    assert.deepEqual(await c.getOrSet('k', ttl, async () => 7), { value: 7, state: 'miss' })
  })
})
