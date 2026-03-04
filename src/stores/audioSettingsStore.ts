import { create } from "zustand"
import { persist } from "zustand/middleware"
import {
  audioSetNormalizationEnabled,
  audioSetCrossfadeWindow,
  audioSetCrossfadeStyle,
  audioSetSameAlbumCrossfade,
  audioSetSmartCrossfade,
  audioSetPreampGain,
  audioSetOutputDevice,
} from "../lib/audio"
import { fireAndForget } from "../lib/async"

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface AudioSettingsState {
  normalizationEnabled: boolean
  crossfadeWindowMs: number
  crossfadeStyle: number
  sameAlbumCrossfade: boolean
  smartCrossfade: boolean
  preampDb: number
  albumGainMode: boolean
  preferredDevice: string | null

  setNormalizationEnabled: (enabled: boolean) => void
  setCrossfadeWindowMs: (ms: number) => void
  setCrossfadeStyle: (style: number) => void
  setSameAlbumCrossfade: (enabled: boolean) => void
  setSmartCrossfade: (enabled: boolean) => void
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
      crossfadeStyle: 0,
      sameAlbumCrossfade: false,
      smartCrossfade: true,
      preampDb: 0,
      albumGainMode: false,
      preferredDevice: null,

      setNormalizationEnabled: (enabled) => {
        set({ normalizationEnabled: enabled })
        fireAndForget(audioSetNormalizationEnabled(enabled))
      },

      setCrossfadeWindowMs: (ms) => {
        set({ crossfadeWindowMs: ms })
        fireAndForget(audioSetCrossfadeWindow(ms))
      },

      setCrossfadeStyle: (style) => {
        set({ crossfadeStyle: style })
        fireAndForget(audioSetCrossfadeStyle(style))
      },

      setSameAlbumCrossfade: (enabled) => {
        set({ sameAlbumCrossfade: enabled })
        fireAndForget(audioSetSameAlbumCrossfade(enabled))
      },

      setSmartCrossfade: (enabled) => {
        set({ smartCrossfade: enabled })
        fireAndForget(audioSetSmartCrossfade(enabled))
      },

      setPreampDb: (db) => {
        set({ preampDb: db })
        fireAndForget(audioSetPreampGain(db))
      },

      setAlbumGainMode: (enabled) => {
        set({ albumGainMode: enabled })
        // No direct engine call needed — gain value is resolved at play time
      },

      setPreferredDevice: (name) => {
        set({ preferredDevice: name })
        fireAndForget(audioSetOutputDevice(name))
      },

      syncToEngine: () => {
        const { normalizationEnabled, crossfadeWindowMs, crossfadeStyle, sameAlbumCrossfade, smartCrossfade, preampDb, preferredDevice } = get()
        fireAndForget(audioSetNormalizationEnabled(normalizationEnabled))
        fireAndForget(audioSetCrossfadeWindow(crossfadeWindowMs))
        fireAndForget(audioSetCrossfadeStyle(crossfadeStyle))
        fireAndForget(audioSetSameAlbumCrossfade(sameAlbumCrossfade))
        fireAndForget(audioSetSmartCrossfade(smartCrossfade))
        fireAndForget(audioSetPreampGain(preampDb))
        // Only switch device if user has a specific preference — the engine already
        // starts with the system default, so rebuilding the stream for null is
        // unnecessary and can fail on Windows (WASAPI not fully ready at boot).
        if (preferredDevice !== null) {
          fireAndForget(audioSetOutputDevice(preferredDevice))
        }
      },
    }),
    {
      name: "plex-audio-settings-v1",
      partialize: (state) => ({
        normalizationEnabled: state.normalizationEnabled,
        crossfadeWindowMs: state.crossfadeWindowMs,
        crossfadeStyle: state.crossfadeStyle,
        sameAlbumCrossfade: state.sameAlbumCrossfade,
        smartCrossfade: state.smartCrossfade,
        preampDb: state.preampDb,
        albumGainMode: state.albumGainMode,
        preferredDevice: state.preferredDevice,
      }),
    },
  ),
)
