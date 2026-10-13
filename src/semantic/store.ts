import { create } from "zustand"
import { booleanPreference } from "../stores/scalarPreference"
import { installAssets, installedAssets } from "./assets"
const enabled = booleanPreference("hibiki-local-semantic-enabled", false)
interface SemanticSettings {
  enabled: boolean
  installed: boolean
  installing: boolean
  progress: number
  error: string | null
  setEnabled(value: boolean): void
  checkInstalled(): Promise<void>
  download(): Promise<void>
}
export const useSemanticSettingsStore = create<SemanticSettings>(
  (set, get) => ({
    enabled: enabled.snapshot(),
    installed: false,
    installing: false,
    progress: 0,
    error: null,
    setEnabled: (value) => enabled.set(value),
    checkInstalled: async () => {
      try {
        set({ installed: !!(await installedAssets()) })
      } catch {
        set({
          installed: false,
          error:
            "The local model could not be read. Retry its download to repair it.",
        })
      }
    },
    download: async () => {
      if (get().installing) return
      set({ installing: true, error: null, progress: 0 })
      try {
        await installAssets((done, total) => set({ progress: done / total }))
        set({ installed: true })
        enabled.set(true)
      } catch {
        set({
          error:
            "The local model could not be downloaded or verified. Your library and saved pages are unchanged.",
        })
      } finally {
        set({ installing: false })
      }
    },
  })
)
enabled.subscribe(() =>
  useSemanticSettingsStore.setState({ enabled: enabled.snapshot() })
)
