import { ValidationError } from './errors.js'
import { PROVIDER_KEYS, type ProviderKey } from './types.js'

/** Id unified: `<provider>:<ref asli>` (seri) atau `<provider>:<chapterRef>` (chapter). */
export const sid = (provider: ProviderKey, ref: string) => `${provider}:${ref}`
export const cid = sid

export function parseId(id: string): { provider: ProviderKey; ref: string } {
  const i = id.indexOf(':')
  const provider = id.slice(0, i) as ProviderKey
  const ref = id.slice(i + 1)
  if (i < 1 || !PROVIDER_KEYS.includes(provider) || !ref || ref.length > 300 || /[\u0000-\u001f/\\?#]/.test(ref)) {
    throw new ValidationError('Invalid id, expected "<provider>:<id>"')
  }
  return { provider, ref }
}
