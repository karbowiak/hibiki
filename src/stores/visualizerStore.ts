import { create } from "zustand"
import { safeLocalPersist } from "./localPreferenceStorage"
import { getAllNames } from "../lib/milkdropPresets"
import { engine } from "../audio/RustAudioEngine"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CompactVisualizerMode =
  "waveform" | "spectrum" | "oscilloscope" | "vu"
export type FullscreenVisualizerMode =
  "spectrum" | "oscilloscope" | "vu" | "starfield" | "milkdrop"
export type AutoCycleMode = "sequential" | "random"

const COMPACT_MODES: CompactVisualizerMode[] = [
  "waveform",
  "spectrum",
  "oscilloscope",
  "vu",
]
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
  starfieldBaseSpeed: number // 1–10: cruise speed when no audio

  // Visualization colors (low/mid/high frequency ranges)
  vizColorLow: string // bass — default green
  vizColorMid: string // mids — default yellow
  vizColorHigh: string // treble — default red

  // DPR render scale (0.25–1.0)
  renderScale: number

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
  setVizColorLow: (hex: string) => void
  setVizColorMid: (hex: string) => void
  setVizColorHigh: (hex: string) => void
  setRenderScale: (val: number) => void
  getFrequencyData: () => Float32Array | null
  getSampleRate: () => number
}

export function createVisualizerStore(persist = safeLocalPersist) {
  // Keep explicit pre-hydration intent, including values equal to startup defaults.
  let hydrated = false
  const pending: Partial<VisualizerState> = {}
  const remember = (patch: Partial<VisualizerState>) => {
    if (!hydrated) Object.assign(pending, patch)
    return patch
  }
  const store = create<VisualizerState>()(
    persist(
      (set, get) => ({
        compactMode: "waveform",
        fullscreenMode: "milkdrop",
        fullscreenOpen: false,

        // Starfield defaults
        starfieldReactivity: 50,
        starfieldBaseSpeed: 3,

        // Viz color defaults
        vizColorLow: "#22c55e",
        vizColorMid: "#eab308",
        vizColorHigh: "#ef4444",

        // DPR render scale
        renderScale: 1.0,

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
          set(
            remember({
              compactMode: COMPACT_MODES[(idx + 1) % COMPACT_MODES.length],
            })
          )
        },

        setCompactMode: (mode) => set(remember({ compactMode: mode })),

        setFullscreenMode: (mode) => set(remember({ fullscreenMode: mode })),

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
          const updated = [name, ...history.filter((n) => n !== name)].slice(
            0,
            HISTORY_CAP
          )
          set({
            ...remember({ currentPresetName: name }),
            presetHistory: updated,
          })
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
        setAutoCycleEnabled: (enabled) =>
          set(remember({ autoCycleEnabled: enabled })),
        setAutoCycleIntervalSec: (sec) =>
          set(remember({ autoCycleIntervalSec: sec })),
        setAutoCycleMode: (mode) => set(remember({ autoCycleMode: mode })),
        setStarfieldReactivity: (val) =>
          set(
            remember({ starfieldReactivity: Math.max(0, Math.min(100, val)) })
          ),
        setStarfieldBaseSpeed: (val) =>
          set(remember({ starfieldBaseSpeed: Math.max(1, Math.min(10, val)) })),
        setVizColorLow: (hex) => set(remember({ vizColorLow: hex })),
        setVizColorMid: (hex) => set(remember({ vizColorMid: hex })),
        setVizColorHigh: (hex) => set(remember({ vizColorHigh: hex })),
        setRenderScale: (val) =>
          set(remember({ renderScale: Math.max(0.25, Math.min(1.0, val)) })),
        getFrequencyData: () => engine.getFrequencyData(),
        getSampleRate: () => engine.getSampleRate(),
      }),
      {
        name: "plex-visualizer-v1",
        onRehydrateStorage: () => {
          hydrated = false
          return (state, error) => {
            if (!state || error) return
            store.setState({
              ...pending,
              presetHistory: state.presetHistory.slice(0, HISTORY_CAP),
            })
            for (const key of Object.keys(pending))
              delete pending[key as keyof VisualizerState]
            hydrated = true
          }
        },
        keyedArrays: { favoritePresets: "$value", presetHistory: "$value" },
        validate: (saved) =>
          (saved.compactMode === undefined ||
            COMPACT_MODES.includes(
              saved.compactMode as CompactVisualizerMode
            )) &&
          (saved.fullscreenMode === undefined ||
            [
              "spectrum",
              "oscilloscope",
              "vu",
              "starfield",
              "milkdrop",
            ].includes(saved.fullscreenMode as string)) &&
          (saved.currentPresetName === undefined ||
            saved.currentPresetName === null ||
            typeof saved.currentPresetName === "string") &&
          ["favoritePresets", "presetHistory"].every(
            (key) =>
              saved[key] === undefined ||
              (Array.isArray(saved[key]) &&
                (saved[key] as unknown[]).every(
                  (value) => typeof value === "string" && value.length > 0
                ) &&
                new Set(saved[key] as unknown[]).size ===
                  (saved[key] as unknown[]).length)
          ) &&
          (saved.autoCycleMode === undefined ||
            saved.autoCycleMode === "random" ||
            saved.autoCycleMode === "sequential") &&
          (saved.autoCycleIntervalSec === undefined ||
            (typeof saved.autoCycleIntervalSec === "number" &&
              Number.isFinite(saved.autoCycleIntervalSec) &&
              saved.autoCycleIntervalSec > 0)) &&
          [
            ["starfieldReactivity", 0, 100],
            ["starfieldBaseSpeed", 1, 10],
            ["renderScale", 0.25, 1],
          ].every(
            ([key, min, max]) =>
              saved[key as string] === undefined ||
              (typeof saved[key as string] === "number" &&
                (saved[key as string] as number) >= (min as number) &&
                (saved[key as string] as number) <= (max as number))
          ) &&
          ["vizColorLow", "vizColorMid", "vizColorHigh"].every(
            (key) =>
              saved[key] === undefined ||
              (typeof saved[key] === "string" &&
                /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(
                  saved[key] as string
                ))
          ),
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
          vizColorLow: state.vizColorLow,
          vizColorMid: state.vizColorMid,
          vizColorHigh: state.vizColorHigh,
          renderScale: state.renderScale,
        }),
      }
    )
  )

  return store
}

export const useVisualizerStore = createVisualizerStore()
