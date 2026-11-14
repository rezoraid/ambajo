export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = new.target.name
  }
}
export class ValidationError extends AppError {
  constructor(message: string) {
    super(400, 'BAD_REQUEST', message)
  }
}
export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(404, 'NOT_FOUND', message)
  }
}
export class UpstreamError extends AppError {
  constructor(
    message: string,
    readonly upstreamStatus?: number
  ) {
    super(502, 'UPSTREAM_ERROR', message)
  }
}
export class UnavailableError extends AppError {
  constructor(message: string) {
    super(503, 'PROVIDER_UNAVAILABLE', message)
  }
}
export class TimeoutError extends AppError {
  constructor(message = 'Upstream timeout') {
    super(504, 'UPSTREAM_TIMEOUT', message)
  }
}

/** Ubah error apa pun (fetch abort, parse, dll) menjadi AppError. */
export function normalizeError(e: unknown): AppError | Error {
  if (e instanceof AppError) return e
  const err = e as { name?: string; message?: string }
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return new TimeoutError()
  return new UpstreamError(err?.message || 'Upstream failure')
}
