import { NotFoundError, UpstreamError } from './errors.js'
import { sleep } from './util.js'

export interface RequestOptions {
  headers: Record<string, string>
  timeoutMs: number
}

/** fetch + timeout; 404 -> NotFoundError, non-2xx -> UpstreamError. */
export async function request(url: string, { headers, timeoutMs }: RequestOptions): Promise<Response> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
  if (res.status === 404) {
    await res.body?.cancel()
    throw new NotFoundError('Not found upstream')
  }
  if (!res.ok) {
    await res.body?.cancel()
    throw new UpstreamError(`HTTP ${res.status}`, res.status)
  }
  return res
}

/** Retry ringan (default 2x ulang, jeda 400ms); 404 tidak diulang. */
export async function retry<T>(fn: () => Promise<T>, retries = 2, delayMs = 400): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (e) {
      if (i >= retries || e instanceof NotFoundError) throw e
      await sleep(delayMs)
    }
  }
}
