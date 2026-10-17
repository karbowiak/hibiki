import { create } from "zustand"
import { isTauri } from "@tauri-apps/api/core"

export interface ServiceConfiguration {
  baseUrl: string
  apiKey?: string
  enabled: boolean
  clear?: boolean
}
export interface ServiceSettingsApi<Status> {
  status(): Promise<Status>
  configure(
    args: ServiceConfiguration & {
      revision: string
      apiKey: string | null
      clear: boolean
    }
  ): Promise<Status>
}
interface State<Status> {
  status: Status | null
  loading: boolean
  error: string | null
  load(): Promise<void>
  configure(args: ServiceConfiguration): Promise<boolean>
}

/** Native credentials stay native; status reads cannot supersede an admitted save. */
export function createServiceSettingsStore<Status extends { revision: string }>(
  name: string,
  api: ServiceSettingsApi<Status>,
  desktop = isTauri
) {
  let generation = 0,
    loading: Promise<void> | null = null
  return create<State<Status>>((set, get) => ({
    status: null,
    loading: false,
    error: null,
    load() {
      if (!desktop()) return Promise.resolve()
      if (loading) return loading
      if (get().loading) return Promise.resolve()
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
                error: `Could not read ${name} settings. Try again.`,
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
      // A lost receipt does not prove the atomic native save failed.
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
            error: `${name} settings could not be confirmed. Check the URL and key, then reload Settings before trying again.`,
          })
        return false
      }
    },
  }))
}
