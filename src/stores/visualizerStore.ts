import { create } from "zustand"
import { persist } from "zustand/middleware"
import { getAllNames } from "../lib/milkdropPresets"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CompactVisualizerMode = "waveform" | "spectrum" | "oscilloscope" | "vu"
export type FullscreenVisualizerMode = "spectrum" | "oscilloscope" | "vu" | "starfield" | "milkdrop"
export type AutoCycleMode = "sequential" | "random"

const COMPACT_MODES: CompactVisualizerMode[] = ["waveform", "spectrum", "oscilloscope", "vu"]
const PCM_BUFFER_SIZE = 8192 // ring buffer size in samples
const HISTORY_CAP = 50

// ---------------------------------------------------------------------------
// PCM ring buffer — module-level mutable Float32Array, NOT in Zustand state.
// Written by pushPcm at ~22fps; read by RAF loops in visualizer components.
// Keeping it outside Zustand avoids triggering re-renders on every audio frame.
// ---------------------------------------------------------------------------

const _pcmBuf = new Float32Array(PCM_BUFFER_SIZE)
let _pcmWrite = 0

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface VisualizerState {
  compactMode: CompactVisualizerMode
  fullscreenMode: FullscreenVisualizerMode
  fullscreenOpen: boolean

  // Starfield settings
  starfieldReactivity: number // 0–100: 0 = chill cruise, 100 = full audio warp
  starfieldBaseSpeed: number  // 1–10: cruise speed when no audio

  // Milkdrop preset state
  currentPresetName: string | null
  favoritePresets: string[]
  presetHistory: string[]
  autoCycleEnabled: boolean
  autoCycleIntervalSec: number
  autoCycleMode: AutoCycleMode
  presetBrowserOpen: boolean

  cycleCompactMode: () => void
  setCompactMode: (mode: CompactVisualizerMode) => void
  setFullscreenMode: (mode: FullscreenVisualizerMode) => void
  openFullscreen: () => void
  closeFullscreen: () => void
  pushPcm: (samples: number[]) => void
  getRecentSamples: (n: number) => Float32Array

  // Preset actions
  setCurrentPreset: (name: string) => void
  toggleFavorite: (name: string) => void
  isFavorite: (name: string) => boolean
  getRandomPresetName: (exclude?: string) => string | null
  getNextPresetName: (dir: 1 | -1) => string | null
  setPresetBrowserOpen: (open: boolean) => void
  setAutoCycleEnabled: (enabled: boolean) => void
  setAutoCycleIntervalSec: (sec: number) => void
  setAutoCycleMode: (mode: AutoCycleMode) => void
  setStarfieldReactivity: (val: number) => void
  setStarfieldBaseSpeed: (val: number) => void
}

export const useVisualizerStore = create<VisualizerState>()(
  persist(
    (set, get) => ({
      compactMode: "waveform",
      fullscreenMode: "milkdrop",
      fullscreenOpen: false,

      // Starfield defaults
      starfieldReactivity: 50,
      starfieldBaseSpeed: 3,

      // Preset defaults
      currentPresetName: null,
      favoritePresets: [],
      presetHistory: [],
      autoCycleEnabled: true,
      autoCycleIntervalSec: 30,
      autoCycleMode: "random",
      presetBrowserOpen: false,

      cycleCompactMode: () => {
        const cur = get().compactMode
        const idx = COMPACT_MODES.indexOf(cur)
        set({ compactMode: COMPACT_MODES[(idx + 1) % COMPACT_MODES.length] })
      },

      setCompactMode: (mode) => set({ compactMode: mode }),

      setFullscreenMode: (mode) => set({ fullscreenMode: mode }),

      openFullscreen: () => set({ fullscreenOpen: true }),

      closeFullscreen: () => set({ fullscreenOpen: false }),

      // Writes directly into the module-level ring buffer — no Zustand re-render.
      pushPcm: (samples) => {
        for (const s of samples) {
          _pcmBuf[_pcmWrite] = s
          _pcmWrite = (_pcmWrite + 1) % PCM_BUFFER_SIZE
        }
      },

      // Reads the last n samples from the ring buffer without touching Zustand state.
      getRecentSamples: (n) => {
        const count = Math.min(n, PCM_BUFFER_SIZE)
        const out = new Float32Array(count)
        const start = (_pcmWrite - count + PCM_BUFFER_SIZE) % PCM_BUFFER_SIZE
        for (let i = 0; i < count; i++) {
          out[i] = _pcmBuf[(start + i) % PCM_BUFFER_SIZE]
        }
        return out
      },

      // Preset actions
      setCurrentPreset: (name) => {
        const history = get().presetHistory
        const updated = [name, ...history.filter((n) => n !== name)].slice(0, HISTORY_CAP)
        set({ currentPresetName: name, presetHistory: updated })
      },

      toggleFavorite: (name) => {
        const favs = get().favoritePresets
        if (favs.includes(name)) {
          set({ favoritePresets: favs.filter((n) => n !== name) })
        } else {
          set({ favoritePresets: [...favs, name] })
        }
      },

      isFavorite: (name) => get().favoritePresets.includes(name),

      getRandomPresetName: (exclude) => {
        const names = getAllNames()
        if (names.length === 0) return null
        if (names.length === 1) return names[0]
        let pick: string
        do {
          pick = names[Math.floor(Math.random() * names.length)]
        } while (pick === exclude && names.length > 1)
        return pick
      },

      getNextPresetName: (dir) => {
        const names = getAllNames()
        if (names.length === 0) return null
        const current = get().currentPresetName
        const idx = current ? names.indexOf(current) : -1
        if (idx === -1) return names[0]
        return names[(idx + dir + names.length) % names.length]
      },

      setPresetBrowserOpen: (open) => set({ presetBrowserOpen: open }),
      setAutoCycleEnabled: (enabled) => set({ autoCycleEnabled: enabled }),
      setAutoCycleIntervalSec: (sec) => set({ autoCycleIntervalSec: sec }),
      setAutoCycleMode: (mode) => set({ autoCycleMode: mode }),
      setStarfieldReactivity: (val) => set({ starfieldReactivity: Math.max(0, Math.min(100, val)) }),
      setStarfieldBaseSpeed: (val) => set({ starfieldBaseSpeed: Math.max(1, Math.min(10, val)) }),
    }),
    {
      name: "plex-visualizer-v1",
      partialize: (state) => ({
        compactMode: state.compactMode,
        fullscreenMode: state.fullscreenMode,
        currentPresetName: state.currentPresetName,
        favoritePresets: state.favoritePresets,
        presetHistory: state.presetHistory,
        autoCycleEnabled: state.autoCycleEnabled,
        autoCycleIntervalSec: state.autoCycleIntervalSec,
        autoCycleMode: state.autoCycleMode,
        starfieldReactivity: state.starfieldReactivity,
        starfieldBaseSpeed: state.starfieldBaseSpeed,
      }),
    },
  ),
)
