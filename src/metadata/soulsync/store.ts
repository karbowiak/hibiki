import { create } from "zustand"
import { isTauri } from "@tauri-apps/api/core"
import { soulSyncConfigure, soulSyncStatus, type SoulSyncStatus } from "./api"
interface State {
  status: SoulSyncStatus | null
  loading: boolean
  error: string | null
  load(): Promise<void>
  configure(args: {
    baseUrl: string
    apiKey?: string
    enabled: boolean
    clear?: boolean
  }): Promise<boolean>
}
/** Native status only; URL+revision are safe, API keys are never stored here. */
export function createSoulSyncStore(
  api = { status: soulSyncStatus, configure: soulSyncConfigure },
  desktop = isTauri
) {
  let generation = 0,
    loading: Promise<void> | null = null
  return create<State>((set, get) => ({
    status: null,
    loading: false,
    error: null,
    load() {
      if (!desktop()) return Promise.resolve()
      if (loading) return loading
      const version = ++generation
      set({ loading: true, error: null })
      const request = api
        .status()
        .then(
          (status) => {
            if (version === generation)
              set({ status, loading: false, error: null })
          },
          () => {
            if (version === generation)
              set({
                loading: false,
                error: "Could not read SoulSync settings. Try again.",
              })
          }
        )
        .finally(() => {
          if (loading === request) loading = null
        })
      loading = request
      return request
    },
    async configure(args) {
      const status = get().status
      if (!status || !desktop() || get().loading) return false
      const version = ++generation
      // The atomic native save may succeed even if its receipt is lost.
      // Retire lookup ownership before dispatch; reload after an unknown result.
      set({ status: null, loading: true, error: null })
      try {
        const next = await api.configure({
          revision: status.revision,
          baseUrl: args.baseUrl,
          apiKey: args.apiKey || null,
          enabled: args.enabled,
          clear: args.clear ?? false,
        })
        if (version !== generation) return false
        set({ status: next, loading: false, error: null })
        return true
      } catch {
        if (version === generation)
          set({
            loading: false,
            error:
              "SoulSync settings could not be confirmed. Check the URL and key, then reload Settings before trying again.",
          })
        return false
      }
    },
  }))
}
export const useSoulSyncStore = createSoulSyncStore()
