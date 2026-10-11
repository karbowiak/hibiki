import { PreferencePersistence } from "./preferencePersistence"
import { persistenceMiddleware } from "./safePersist"

interface RawPreferenceCodec {
  decode(raw: string): unknown
  encode(value: unknown): string
}
const rawCodecs = new Map<string, RawPreferenceCodec>()

// Keep existing localStorage keys. Failed reads must protect saved values;
// failed writes stay queued for the same recovery notice as IndexedDB data.
function storage(): Storage {
  if (!globalThis.localStorage) throw new Error("Local preferences unavailable")
  return globalThis.localStorage
}

export const localPreferencePersistence = new PreferencePersistence({
  get: (key) => {
    const raw = storage().getItem(key), codec = rawCodecs.get(key)
    return raw === null || !codec ? raw : JSON.stringify({ state: { value: codec.decode(raw) }, version: 0 })
  },
  update: (key, transform) => {
    const backend = storage()
    const raw = backend.getItem(key), codec = rawCodecs.get(key)
    const current = raw === null || !codec ? raw : JSON.stringify({ state: { value: codec.decode(raw) }, version: 0 })
    const next = transform(current)
    backend.setItem(key, codec ? codec.encode(JSON.parse(next).state.value) : next)
  },
  remove: (key) => storage().removeItem(key),
})

export const safeLocalPersist = persistenceMiddleware(
  localPreferencePersistence
)


/** Preserve legacy scalar keys/formats while using the shared recovery queue. */
export function registerRawPreference(key: string, codec: RawPreferenceCodec) {
  rawCodecs.set(key, codec)
}
export function readRawPreference(key: string): unknown {
  const raw = storage().getItem(key)
  if (raw === null) return undefined
  return rawCodecs.get(key)!.decode(raw)
}
