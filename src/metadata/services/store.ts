import { create } from "zustand"
import { isTauri } from "@tauri-apps/api/core"
import {
  metadataServiceConfigure,
  metadataServiceStatus,
  type MetadataServiceStatus,
  type ConfiguredMetadataService,
} from "./api"
interface State {
  status: MetadataServiceStatus | null
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
export function createConfiguredMetadataServiceStore(
  service: ConfiguredMetadataService,
  api = {
    status: () => metadataServiceStatus(service),
    configure: (args: Parameters<typeof metadataServiceConfigure>[1]) =>
      metadataServiceConfigure(service, args),
  },
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
                error: "Could not read Metadata service settings. Try again.",
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
      // Retire public snapshots before a save whose atomic outcome may be unknown.
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
              "Metadata service settings could not be confirmed. Check the URL and key, then reload Settings before trying again.",
          })
        return false
      }
    },
  }))
}
export const useFanartServiceStore =
  createConfiguredMetadataServiceStore("fanart")
export const useHeyaServiceStore = createConfiguredMetadataServiceStore("heya")
