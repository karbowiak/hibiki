import { del, get, set } from "idb-keyval"
import { createJSONStorage } from "zustand/middleware"
import type { StateStorage } from "zustand/middleware"

/** IndexedDB-backed storage adapter for Zustand persist.
 *  IndexedDB has no practical size limit (disk-based) vs localStorage's ~5 MB cap. */
export const idbStorage: StateStorage = {
  getItem: (name) => get<string>(name).then((v) => v ?? null),
  setItem: (name, value) => set(name, value),
  removeItem: (name) => del(name),
}

export const idbJSONStorage = createJSONStorage(() => idbStorage)
