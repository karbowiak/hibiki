import { create } from "zustand"
import { persist } from "zustand/middleware"
import { engine } from "../audio/RustAudioEngine"

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface AudioSettingsState {
  cacheMaxBytes: number

  setCacheMaxBytes: (bytes: number) => void
  syncToEngine: () => void
}

export const useAudioSettingsStore = create<AudioSettingsState>()(
  persist(
    (set, get) => ({
      cacheMaxBytes: 5 * 1024 * 1024 * 1024, // 5 GB default

      setCacheMaxBytes: (bytes) => {
        set({ cacheMaxBytes: bytes })
        engine.setCacheMaxBytes(bytes)
      },

      syncToEngine: () => {
        const { cacheMaxBytes } = get()
        // Hardcoded defaults — always on, not user-configurable
        engine.setNormalizationEnabled(true)
        engine.setPreampGain(3) // +3 dB default pre-amp
        engine.setCrossfadeWindow(4000)
        engine.setSameAlbumCrossfade(false) // gapless for albums
        engine.setSmartCrossfade(true) // always use MixRamp when available
        engine.setSmartCrossfadeMax(15000)
        engine.setMixrampDb(-16)
        engine.setCacheMaxBytes(cacheMaxBytes)
      },
    }),
    {
      name: "plex-audio-settings-v1",
      partialize: (state) => ({
        cacheMaxBytes: state.cacheMaxBytes,
      }),
    },
  ),
)
