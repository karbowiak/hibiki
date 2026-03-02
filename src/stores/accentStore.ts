import { create } from "zustand"

export interface AccentPreset {
  name: string
  hex: string
}

export const ACCENT_PRESETS: AccentPreset[] = [
  { name: "Magenta",  hex: "#d946ef" },
  { name: "Violet",   hex: "#8b5cf6" },
  { name: "Cobalt",   hex: "#3b82f6" },
  { name: "Cyan",     hex: "#06b6d4" },
  { name: "Emerald",  hex: "#10b981" },
  { name: "Green",    hex: "#1db954" },
  { name: "Amber",    hex: "#f59e0b" },
  { name: "Orange",   hex: "#f97316" },
  { name: "Rose",     hex: "#f43f5e" },
]

const DEFAULT_ACCENT = "#d946ef"
const STORAGE_KEY = "plex-accent-color"

function hexToRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `${r} ${g} ${b}`
}

export function applyAccent(hex: string) {
  document.documentElement.style.setProperty("--accent", hex)
  document.documentElement.style.setProperty("--accent-rgb", hexToRgb(hex))
}

// Apply immediately on module load so the colour is set before first render
applyAccent(localStorage.getItem(STORAGE_KEY) ?? DEFAULT_ACCENT)

interface AccentState {
  accent: string
  setAccent: (hex: string) => void
}

export const useAccentStore = create<AccentState>(() => ({
  accent: localStorage.getItem(STORAGE_KEY) ?? DEFAULT_ACCENT,
  setAccent: (hex: string) => {
    localStorage.setItem(STORAGE_KEY, hex)
    applyAccent(hex)
    useAccentStore.setState({ accent: hex })
  },
}))
