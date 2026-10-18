import { sqliteLocalStorage } from "../storage/clientStorage"
import { create } from "zustand"

/** Default base opacities for each highlight category */
const DEFAULTS = {
  card:  0.06,
  row:   0.05,
  menu:  0.10,
  queue: 0.05,
} as const

export type HighlightCategory = keyof typeof DEFAULTS

const STORAGE_KEY = "plex-highlights"

interface Persisted {
  intensity: number
  card:  number
  row:   number
  menu:  number
  queue: number
}

function load(): Persisted {
  try {
    const raw = sqliteLocalStorage.getItem(STORAGE_KEY)
    if (raw) return { ...defaults(), ...JSON.parse(raw) }
  } catch { /* ignore */ }
  return defaults()
}

function defaults(): Persisted {
  return { intensity: 1, ...DEFAULTS }
}

function save(state: Persisted) {
  sqliteLocalStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

function clampOpacity(v: number): number {
  return Math.min(1, Math.max(0, v))
}

/** Apply all --hl-* CSS custom properties to :root */
function applyCSS(state: Persisted) {
  const el = document.documentElement.style
  const i = state.intensity
  el.setProperty("--hl-card-opacity",  String(clampOpacity(state.card * i)))
  el.setProperty("--hl-row-opacity",   String(clampOpacity(state.row * i)))
  el.setProperty("--hl-menu-opacity",  String(clampOpacity(state.menu * i)))
  el.setProperty("--hl-queue-opacity", String(clampOpacity(state.queue * i)))
}

interface HighlightState extends Persisted {
  setIntensity: (v: number) => void
  setCategory: (cat: HighlightCategory, v: number) => void
  reset: () => void
}

// Apply immediately on module load
const initial = load()
applyCSS(initial)

export const useHighlightStore = create<HighlightState>(() => ({
  ...initial,
  setIntensity: (v: number) => {
    const state = useHighlightStore.getState()
    const next = { intensity: v, card: state.card, row: state.row, menu: state.menu, queue: state.queue }
    save(next)
    applyCSS(next)
    useHighlightStore.setState({ intensity: v })
  },
  setCategory: (cat: HighlightCategory, v: number) => {
    const state = useHighlightStore.getState()
    const next = { intensity: state.intensity, card: state.card, row: state.row, menu: state.menu, queue: state.queue, [cat]: v }
    save(next)
    applyCSS(next)
    useHighlightStore.setState({ [cat]: v })
  },
  reset: () => {
    const d = defaults()
    save(d)
    applyCSS(d)
    useHighlightStore.setState(d)
  },
}))

export { DEFAULTS as HIGHLIGHT_DEFAULTS }
