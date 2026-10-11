import { create } from "zustand"
import { createScalarPreference } from "./scalarPreference"

export interface AccentPreset {
  name: string
  hex: string
}

export const ACCENT_PRESETS: AccentPreset[] = [
  { name: "Red",       hex: "#ef4444" },
  { name: "Rose",      hex: "#f43f5e" },
  { name: "Pink",      hex: "#ec4899" },
  { name: "Fuchsia",   hex: "#d946ef" },
  { name: "Purple",    hex: "#a855f7" },
  { name: "Violet",    hex: "#8b5cf6" },
  { name: "Indigo",    hex: "#6366f1" },
  { name: "Blue",      hex: "#3b82f6" },
  { name: "Sky",       hex: "#0ea5e9" },
  { name: "Cyan",      hex: "#06b6d4" },
  { name: "Teal",      hex: "#14b8a6" },
  { name: "Emerald",   hex: "#10b981" },
  { name: "Green",     hex: "#1db954" },
  { name: "Lime",      hex: "#84cc16" },
  { name: "Yellow",    hex: "#eab308" },
  { name: "Amber",     hex: "#f59e0b" },
  { name: "Orange",    hex: "#f97316" },
  { name: "Coral",     hex: "#ff6b6b" },
  { name: "Peach",     hex: "#fb923c" },
  { name: "Sand",      hex: "#d4a574" },
  { name: "Bronze",    hex: "#cd7f32" },
  { name: "Slate",     hex: "#64748b" },
  { name: "Zinc",      hex: "#71717a" },
  { name: "Stone",     hex: "#78716c" },
]

const DEFAULT_ACCENT = "#d946ef"
const STORAGE_KEY = "plex-accent-color"

function validAccent(hex: unknown): hex is string {
  return typeof hex === "string" && /^#[0-9a-f]{6}$/i.test(hex)
}
const preference = createScalarPreference(STORAGE_KEY, DEFAULT_ACCENT, raw => {
  if (!validAccent(raw)) throw new Error("Invalid accent preference")
  return raw
}, value => value)

function hexToRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `${r} ${g} ${b}`
}

export function applyAccent(hex: string) {
  if (!validAccent(hex) || typeof document === "undefined") return
  const rgb = hexToRgb(hex)
  const s = document.documentElement.style
  s.setProperty("--accent", hex)
  s.setProperty("--accent-rgb", rgb)
  s.setProperty("--accent-tint", `rgb(${rgb} / 0.08)`)
  s.setProperty("--accent-tint-subtle", `rgb(${rgb} / 0.04)`)
  s.setProperty("--accent-tint-strong", `rgb(${rgb} / 0.15)`)
  s.setProperty("--accent-tint-hover", `rgb(${rgb} / 0.12)`)
}

// Apply immediately on module load so the colour is set before first render
applyAccent(preference.snapshot())

interface AccentState {
  accent: string
  setAccent: (hex: string) => void
}

export const useAccentStore = create<AccentState>(() => ({
  accent: preference.snapshot(),
  setAccent: (hex: string) => {
    if (!validAccent(hex)) return
    preference.set(hex)
    applyAccent(hex)
    useAccentStore.setState({ accent: hex })
  },
}))

preference.subscribe(() => {
  const accent = preference.snapshot()
  applyAccent(accent)
  useAccentStore.setState({ accent })
})
