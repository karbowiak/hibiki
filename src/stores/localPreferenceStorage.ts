import { PreferencePersistence } from "./preferencePersistence"
import { persistenceMiddleware } from "./safePersist"

// Keep existing localStorage keys. Failed reads must protect saved values;
// failed writes stay queued for the same recovery notice as IndexedDB data.
function storage(): Storage {
  if (!globalThis.localStorage) throw new Error("Local preferences unavailable")
  return globalThis.localStorage
}

export const localPreferencePersistence = new PreferencePersistence({
  get: (key) => storage().getItem(key),
  update: (key, transform) => {
    const backend = storage()
    backend.setItem(key, transform(backend.getItem(key)))
  },
  remove: (key) => storage().removeItem(key),
})

export const safeLocalPersist = persistenceMiddleware(
  localPreferencePersistence
)
