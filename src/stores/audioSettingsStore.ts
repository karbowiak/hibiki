import { create } from "zustand"
import {
  engine,
  type AudioCacheStats,
  type RustAudioEngine,
} from "../audio/RustAudioEngine"
import { safeLocalPersist } from "./localPreferenceStorage"

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface AudioSettingsState {
  cacheMaxBytes: number

  setCacheMaxBytes: (bytes: number) => Promise<AudioCacheStats>
  syncToEngine: () => Promise<void>
}

export function createAudioSettingsStore(
  audio: Pick<
    RustAudioEngine,
    | "setCacheMaxBytes"
    | "setNormalizationEnabled"
    | "setPreampGain"
    | "setCrossfadeWindow"
    | "setSameAlbumCrossfade"
    | "setSmartCrossfade"
    | "setSmartCrossfadeMax"
    | "setMixrampDb"
  > = engine,
  persist = safeLocalPersist
) {
  let hydrated = false
  const store = create<AudioSettingsState>()(
    persist(
      (set, get) => ({
        cacheMaxBytes: 5 * 1024 * 1024 * 1024, // 5 GB default

        setCacheMaxBytes: async (bytes) => {
          const stats = await audio.setCacheMaxBytes(bytes)
          set({ cacheMaxBytes: stats.max_bytes })
          return stats
        },

        syncToEngine: async () => {
          const { cacheMaxBytes } = get()
          // Hardcoded defaults — always on, not user-configurable
          audio.setNormalizationEnabled(true)
          audio.setPreampGain(3) // +3 dB default pre-amp
          audio.setCrossfadeWindow(4000)
          audio.setSameAlbumCrossfade(false) // gapless for albums
          audio.setSmartCrossfade(true) // always use MixRamp when available
          audio.setSmartCrossfadeMax(15000)
          audio.setMixrampDb(-16)
          if (hydrated) await audio.setCacheMaxBytes(cacheMaxBytes)
        },
      }),
      {
        name: "plex-audio-settings-v1",
        partialize: (state) => ({
          cacheMaxBytes: state.cacheMaxBytes,
        }),
        validate: (saved) =>
          Number.isSafeInteger(saved.cacheMaxBytes) &&
          (saved.cacheMaxBytes as number) >= 0,
        onRehydrateStorage: () => (state, error) => {
          hydrated = !error && !!state
          if (state && !error)
            void audio.setCacheMaxBytes(state.cacheMaxBytes).catch(() => {})
        },
        merge: (saved, current) => {
          const bytes =
            saved && typeof saved === "object"
              ? (saved as Partial<AudioSettingsState>).cacheMaxBytes
              : undefined
          return {
            ...current,
            cacheMaxBytes:
              typeof bytes === "number" &&
              Number.isSafeInteger(bytes) &&
              bytes >= 0
                ? bytes
                : current.cacheMaxBytes,
          }
        },
      }
    )
  )
  return store
}

export const useAudioSettingsStore = createAudioSettingsStore()
