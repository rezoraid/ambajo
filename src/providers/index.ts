import type { ProviderAdapter, ProviderKey } from '../core/types.js'
import { createLumos } from './lumos.js'
import { createManta } from './manta.js'
import { createShinigami } from './shinigami.js'

const factories: Record<ProviderKey, () => ProviderAdapter> = {
  manta: createManta,
  lumos: createLumos,
  shinigami: createShinigami
}

/** Urutan `keys` = prioritas provider. */
export const createProviders = (keys: ProviderKey[]): ProviderAdapter[] => keys.map(k => factories[k]())
