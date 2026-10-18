import { PreferencePersistence } from "./preferencePersistence"
import { persistenceMiddleware } from "./safePersist"
import { get, update, del, sqliteLocalStorage, refreshLocalPreference } from "../storage/clientStorage"
import { localStore } from "../storage/keyValue"

interface RawPreferenceCodec {
  decode(raw: string): unknown
  encode(value: unknown): string
}
const rawCodecs = new Map<string, RawPreferenceCodec>()

const inWorker = () => !!(globalThis as any).__HIBIKI_BACKGROUND_WORKER__

export const localPreferencePersistence = new PreferencePersistence({
  get: async (key) => {
    const raw = inWorker() ? sqliteLocalStorage.getItem(key) : await get<string>(key, localStore) ?? null
    const codec = rawCodecs.get(key)
    return raw === null || !codec ? raw : JSON.stringify({ state: { value: codec.decode(raw) }, version: 0 })
  },
  update: async (key, transform) => {
    const codec = rawCodecs.get(key)
    const apply = (saved: string | undefined) => {
      const raw = saved ?? null
      const current = raw === null || !codec ? raw : JSON.stringify({ state: { value: codec.decode(raw) }, version: 0 })
      const next = transform(current)
      return codec ? codec.encode(JSON.parse(next).state.value) : next
    }
    if (inWorker()) { sqliteLocalStorage.setItem(key, apply(sqliteLocalStorage.getItem(key) ?? undefined)); return }
    await update<string>(key, apply, localStore)
    refreshLocalPreference(key, await get<string>(key, localStore) ?? null)
  },
  remove: async key => {
    if (inWorker()) { sqliteLocalStorage.removeItem(key); return }
    await del(key, localStore)
    refreshLocalPreference(key, null)
  },
})

export const safeLocalPersist = persistenceMiddleware(
  localPreferencePersistence
)


/** Preserve legacy scalar keys/formats while using the shared recovery queue. */
export function registerRawPreference(key: string, codec: RawPreferenceCodec) {
  rawCodecs.set(key, codec)
}
export function readRawPreference(key: string): unknown {
  const raw = sqliteLocalStorage.getItem(key)
  if (raw === null) return undefined
  return rawCodecs.get(key)!.decode(raw)
}
