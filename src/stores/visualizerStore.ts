import { create } from "zustand"
import { persist } from "zustand/middleware"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CompactVisualizerMode = "waveform" | "spectrum" | "oscilloscope" | "vu"
export type FullscreenVisualizerMode = "spectrum" | "oscilloscope" | "vu" | "milkdrop"

const COMPACT_MODES: CompactVisualizerMode[] = ["waveform", "spectrum", "oscilloscope", "vu"]
const PCM_BUFFER_SIZE = 8192 // ring buffer size in samples

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

  cycleCompactMode: () => void
  setCompactMode: (mode: CompactVisualizerMode) => void
  setFullscreenMode: (mode: FullscreenVisualizerMode) => void
  openFullscreen: () => void
  closeFullscreen: () => void
  pushPcm: (samples: number[]) => void
  getRecentSamples: (n: number) => Float32Array
}

export const useVisualizerStore = create<VisualizerState>()(
  persist(
    (set, get) => ({
      compactMode: "waveform",
      fullscreenMode: "milkdrop",
      fullscreenOpen: false,

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
    }),
    {
      name: "plex-visualizer-v1",
      partialize: (state) => ({
        compactMode: state.compactMode,
        fullscreenMode: state.fullscreenMode,
      }),
    },
  ),
)
