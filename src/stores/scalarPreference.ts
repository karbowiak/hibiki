import { localPreferencePersistence, readRawPreference, registerRawPreference } from "./localPreferenceStorage"

export interface ScalarPreference<T> {
  snapshot(): T
  subscribe(listener: () => void): () => void
  set(value: T): void
}

/** Optimistic session edits remain recoverable; unreadable disk values stay untouched. */
export function createScalarPreference<T>(key: string, fallback: T, decode: (raw: string) => T, encode: (value: T) => string): ScalarPreference<T> {
  registerRawPreference(key, { decode, encode: value => encode(value as T) })
  let value = fallback
  try { value = readRawPreference(key) as T ?? fallback } catch { /* Hydration reports the retained read failure. */ }
  const listeners = new Set<() => void>()
  const publish = (next: T) => { value = next; listeners.forEach(listener => listener()) }
  const session = localPreferencePersistence.register(key)
  session.baseline({ value })
  const hydrate = async () => {
    try {
      const saved = await session.read()
      const merged = session.merge(saved?.state ?? { value: fallback })
      publish(merged.value as T)
      session.baseline({ value })
      session.hydrated()
    } catch (error) { session.hydrated(error) }
  }
  session.setRetry(hydrate)
  void hydrate()
  return {
    snapshot: () => value,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: next => {
      publish(next)
      // A same-as-default edit is still explicit intent when disk was unreadable.
      session.baseline({})
      void session.stage({ value: next })
    },
  }
}

export function booleanPreference(key: string, fallback: boolean) {
  return createScalarPreference(key, fallback, raw => {
    if (raw !== "0" && raw !== "1") throw new Error("Invalid boolean preference")
    return raw === "1"
  }, value => value ? "1" : "0")
}
