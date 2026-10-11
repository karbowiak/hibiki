import * as keyval from "idb-keyval"
import type { StateStorage } from "zustand/middleware"
import { PreferencePersistence } from "./preferencePersistence"
import { persistenceMiddleware } from "./safePersist"

/** Raw provider caches own their hydration and errors through ScopedPersistence. */
export const idbStorage: StateStorage = {
  getItem: async name => (await keyval.get<string>(name)) ?? null,
  setItem: async (name, value) => { await keyval.set(name, value) },
  removeItem: async name => { await keyval.del(name) },
}

export const preferencePersistence = new PreferencePersistence({
  get: key => keyval.get(key),
  update: (key, transform) => keyval.update(key, transform),
  remove: key => keyval.del(key),
})
export const safePersist = persistenceMiddleware(preferencePersistence)
