import { create } from "zustand"
import type { OfflineReadNotice } from "./providerCache"
interface OfflineStatus {
  scope: string | null
  offlineMode: boolean
  savedReads: Record<string, number>
  activate(scope: string | null, offlineMode?: boolean): void
  cached(scope: string, notice: OfflineReadNotice): void
  online(scope: string, key: string): void
}
export function createOfflineStatusStore() {
  return create<OfflineStatus>((set, get) => ({
    scope: null,
    offlineMode: false,
    savedReads: {},
    activate: (scope, offlineMode = false) =>
      set({ scope, offlineMode, savedReads: {} }),
    cached: (scope, notice) => {
      if (scope !== get().scope || !Number.isFinite(notice.cachedAt)) return
      set((state) => {
        const entries = Object.entries(state.savedReads)
          .filter(([key]) => key !== notice.key)
          .slice(-49)
        return {
          savedReads: {
            ...Object.fromEntries(entries),
            [notice.key]: notice.cachedAt,
          },
        }
      })
    },
    online: (scope, key) => {
      if (scope !== get().scope) return
      set((state) => {
        const savedReads = { ...state.savedReads }
        delete savedReads[key]
        return { savedReads }
      })
    },
  }))
}
export const useOfflineStatusStore = createOfflineStatusStore()
