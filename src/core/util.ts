import { TimeoutError, ValidationError } from './errors.js'

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** Judul dinormalisasi untuk mencocokkan seri yang sama antar provider. */
export const normTitle = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')

export const slugify = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')

export function isoDate(v: unknown): string | null {
  if (v == null || v === '') return null
  let d: Date
  if (typeof v === 'number') d = new Date(v < 1e11 ? v * 1000 : v)
  else if (/^\d{10,13}$/.test(String(v))) return isoDate(Number(v))
  else d = new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

export function numOrNull(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export const compact = <T>(list: (T | null | undefined)[]): T[] => list.filter((x): x is T => x != null)

export function splitOnce(s: string, sep = ':'): [string, string] {
  const i = s.indexOf(sep)
  if (i < 1 || i === s.length - 1) throw new ValidationError('Invalid chapter id')
  return [s.slice(0, i), s.slice(i + 1)]
}

export function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout
  const t = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new TimeoutError()), ms)
  })
  return Promise.race([p, t]).finally(() => clearTimeout(timer))
}

/** Cache promise per-argumen dengan TTL pendek; kegagalan tidak di-cache. */
export function memo<T>(fn: (arg: string) => Promise<T>, ttlMs: number, max = 50) {
  const store = new Map<string, { at: number; p: Promise<T> }>()
  return (arg: string): Promise<T> => {
    const hit = store.get(arg)
    if (hit && Date.now() - hit.at < ttlMs) return hit.p
    const p = fn(arg)
    store.set(arg, { at: Date.now(), p })
    p.catch(() => {
      if (store.get(arg)?.p === p) store.delete(arg)
    })
    if (store.size > max) store.delete(store.keys().next().value as string)
    return p
  }
}
