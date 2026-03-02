import { create } from "zustand"
import { persist } from "zustand/middleware"
import {
  audioSetNormalizationEnabled,
  audioSetCrossfadeWindow,
  audioSetSameAlbumCrossfade,
  audioSetPreampGain,
  audioSetOutputDevice,
} from "../lib/plex"

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface AudioSettingsState {
  normalizationEnabled: boolean
  crossfadeWindowMs: number
  sameAlbumCrossfade: boolean
  preampDb: number
  albumGainMode: boolean
  preferredDevice: string | null

  setNormalizationEnabled: (enabled: boolean) => void
  setCrossfadeWindowMs: (ms: number) => void
  setSameAlbumCrossfade: (enabled: boolean) => void
  setPreampDb: (db: number) => void
  setAlbumGainMode: (enabled: boolean) => void
  setPreferredDevice: (name: string | null) => void
  syncToEngine: () => void
}

export const useAudioSettingsStore = create<AudioSettingsState>()(
  persist(
    (set, get) => ({
      normalizationEnabled: true,
      crossfadeWindowMs: 8000,
      sameAlbumCrossfade: false,
      preampDb: 0,
      albumGainMode: false,
      preferredDevice: null,

      setNormalizationEnabled: (enabled) => {
        set({ normalizationEnabled: enabled })
        void audioSetNormalizationEnabled(enabled)
      },

      setCrossfadeWindowMs: (ms) => {
        set({ crossfadeWindowMs: ms })
        void audioSetCrossfadeWindow(ms)
      },

      setSameAlbumCrossfade: (enabled) => {
        set({ sameAlbumCrossfade: enabled })
        void audioSetSameAlbumCrossfade(enabled)
      },

      setPreampDb: (db) => {
        set({ preampDb: db })
        void audioSetPreampGain(db)
      },

      setAlbumGainMode: (enabled) => {
        set({ albumGainMode: enabled })
        // No direct engine call needed — gain value is resolved at play time
      },

      setPreferredDevice: (name) => {
        set({ preferredDevice: name })
        void audioSetOutputDevice(name)
      },

      syncToEngine: () => {
        const { normalizationEnabled, crossfadeWindowMs, sameAlbumCrossfade, preampDb, preferredDevice } = get()
        void audioSetNormalizationEnabled(normalizationEnabled)
        void audioSetCrossfadeWindow(crossfadeWindowMs)
        void audioSetSameAlbumCrossfade(sameAlbumCrossfade)
        void audioSetPreampGain(preampDb)
        void audioSetOutputDevice(preferredDevice)
      },
    }),
    {
      name: "plex-audio-settings-v1",
      partialize: (state) => ({
        normalizationEnabled: state.normalizationEnabled,
        crossfadeWindowMs: state.crossfadeWindowMs,
        sameAlbumCrossfade: state.sameAlbumCrossfade,
        preampDb: state.preampDb,
        albumGainMode: state.albumGainMode,
        preferredDevice: state.preferredDevice,
      }),
    },
  ),
)
