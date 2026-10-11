import { create } from "zustand"
import { persist } from "zustand/middleware"
import { engine, type AudioCacheStats } from "../audio/RustAudioEngine"

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface AudioSettingsState {
  cacheMaxBytes: number

  setCacheMaxBytes: (bytes: number) => Promise<AudioCacheStats>
  syncToEngine: () => Promise<void>
}

export const useAudioSettingsStore = create<AudioSettingsState>()(
  persist(
    (set, get) => ({
      cacheMaxBytes: 5 * 1024 * 1024 * 1024, // 5 GB default

      setCacheMaxBytes: async (bytes) => {
        const stats = await engine.setCacheMaxBytes(bytes)
        set({ cacheMaxBytes: stats.max_bytes })
        return stats
      },

      syncToEngine: async () => {
        const { cacheMaxBytes } = get()
        // Hardcoded defaults — always on, not user-configurable
        engine.setNormalizationEnabled(true)
        engine.setPreampGain(3) // +3 dB default pre-amp
        engine.setCrossfadeWindow(4000)
        engine.setSameAlbumCrossfade(false) // gapless for albums
        engine.setSmartCrossfade(true) // always use MixRamp when available
        engine.setSmartCrossfadeMax(15000)
        engine.setMixrampDb(-16)
        await engine.setCacheMaxBytes(cacheMaxBytes)
      },
    }),
    {
      name: "plex-audio-settings-v1",
      partialize: (state) => ({
        cacheMaxBytes: state.cacheMaxBytes,
      }),
      merge: (saved, current) => {
        const bytes = saved && typeof saved === "object" ? (saved as Partial<AudioSettingsState>).cacheMaxBytes : undefined
        return { ...current, cacheMaxBytes: typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : current.cacheMaxBytes }
      },
    },
  ),
)
