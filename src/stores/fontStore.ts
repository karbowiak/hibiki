import { createScalarPreference } from "./scalarPreference"

const STORAGE_KEY = "plex-font"

export interface FontPreset {
  name: string
  label: string
  /** CSS font-family stack to set on --font-family */
  stack: string
  /** Category for grouping in the UI */
  category: "default" | "sans-serif" | "monospace"
}

export const FONT_PRESETS: FontPreset[] = [
  // Default
  {
    name: "circular",
    label: "Circular",
    stack: "CircularSp, CircularSp-Arab, CircularSp-Hebr, CircularSp-Cyrl, CircularSp-Grek, CircularSp-Deva, sans-serif",
    category: "default",
  },
  {
    name: "system",
    label: "System",
    stack: "system-ui, -apple-system, sans-serif",
    category: "default",
  },
  // Sans-serif (alphabetical)
  { name: "archivo",             label: "Archivo",             stack: "'Archivo Variable', sans-serif",             category: "sans-serif" },
  { name: "bricolage-grotesque", label: "Bricolage Grotesque", stack: "'Bricolage Grotesque Variable', sans-serif", category: "sans-serif" },
  { name: "cabin",               label: "Cabin",               stack: "'Cabin Variable', sans-serif",               category: "sans-serif" },
  { name: "dm-sans",             label: "DM Sans",             stack: "'DM Sans Variable', sans-serif",             category: "sans-serif" },
  { name: "figtree",             label: "Figtree",             stack: "'Figtree Variable', sans-serif",             category: "sans-serif" },
  { name: "geist",               label: "Geist",               stack: "'Geist Variable', sans-serif",               category: "sans-serif" },
  { name: "instrument-sans",     label: "Instrument Sans",     stack: "'Instrument Sans Variable', sans-serif",     category: "sans-serif" },
  { name: "inter",               label: "Inter",               stack: "'Inter Variable', sans-serif",               category: "sans-serif" },
  { name: "josefin-sans",        label: "Josefin Sans",        stack: "'Josefin Sans Variable', sans-serif",        category: "sans-serif" },
  { name: "lexend",              label: "Lexend",              stack: "'Lexend Variable', sans-serif",              category: "sans-serif" },
  { name: "manrope",             label: "Manrope",             stack: "'Manrope Variable', sans-serif",             category: "sans-serif" },
  { name: "montserrat",          label: "Montserrat",          stack: "'Montserrat Variable', sans-serif",          category: "sans-serif" },
  { name: "nunito",              label: "Nunito",              stack: "'Nunito Variable', sans-serif",              category: "sans-serif" },
  { name: "onest",               label: "Onest",               stack: "'Onest Variable', sans-serif",               category: "sans-serif" },
  { name: "open-sans",           label: "Open Sans",           stack: "'Open Sans Variable', sans-serif",           category: "sans-serif" },
  { name: "outfit",              label: "Outfit",              stack: "'Outfit Variable', sans-serif",              category: "sans-serif" },
  { name: "overpass",            label: "Overpass",            stack: "'Overpass Variable', sans-serif",            category: "sans-serif" },
  { name: "plus-jakarta-sans",   label: "Plus Jakarta Sans",   stack: "'Plus Jakarta Sans Variable', sans-serif",   category: "sans-serif" },
  { name: "public-sans",         label: "Public Sans",         stack: "'Public Sans Variable', sans-serif",         category: "sans-serif" },
  { name: "quicksand",           label: "Quicksand",           stack: "'Quicksand Variable', sans-serif",           category: "sans-serif" },
  { name: "raleway",             label: "Raleway",             stack: "'Raleway Variable', sans-serif",             category: "sans-serif" },
  { name: "roboto",              label: "Roboto",              stack: "'Roboto Variable', sans-serif",              category: "sans-serif" },
  { name: "rubik",               label: "Rubik",               stack: "'Rubik Variable', sans-serif",               category: "sans-serif" },
  { name: "sora",                label: "Sora",                stack: "'Sora Variable', sans-serif",                category: "sans-serif" },
  { name: "source-sans-3",       label: "Source Sans",         stack: "'Source Sans 3 Variable', sans-serif",       category: "sans-serif" },
  { name: "space-grotesk",       label: "Space Grotesk",       stack: "'Space Grotesk Variable', sans-serif",       category: "sans-serif" },
  { name: "urbanist",            label: "Urbanist",            stack: "'Urbanist Variable', sans-serif",            category: "sans-serif" },
  { name: "work-sans",           label: "Work Sans",           stack: "'Work Sans Variable', sans-serif",           category: "sans-serif" },
  // Monospace
  { name: "jetbrains-mono",      label: "JetBrains Mono",      stack: "'JetBrains Mono Variable', monospace",       category: "monospace" },
  { name: "fira-code",           label: "Fira Code",           stack: "'Fira Code Variable', monospace",            category: "monospace" },
]

const DEFAULT_FONT = "circular"

const preference = createScalarPreference(STORAGE_KEY, DEFAULT_FONT, raw => {
  if (!FONT_PRESETS.some(preset => preset.name === raw)) throw new Error("Invalid font preference")
  return raw
}, value => value)

function loadFont(): FontPreset {
  return FONT_PRESETS.find(preset => preset.name === preference.snapshot()) ?? FONT_PRESETS[0]!
}

function applyFont(preset: FontPreset) {
  if (typeof document === "undefined") return
  document.documentElement.style.setProperty("--font-family", preset.stack)
}

// --- Minimal store (no Zustand needed — pure CSS var side-effects) ---

let _font: FontPreset = loadFont()

// Apply immediately before first render
applyFont(_font)

export function getFont(): FontPreset {
  return _font
}

export function setFont(name: string) {
  const preset = FONT_PRESETS.find(p => p.name === name) ?? FONT_PRESETS[0]!
  preference.set(preset.name)
}

const _listeners = new Set<(font: FontPreset) => void>()

export function subscribeFont(fn: (font: FontPreset) => void): () => void {
  _listeners.add(fn)
  return () => _listeners.delete(fn)
}

export { DEFAULT_FONT }

preference.subscribe(() => {
  _font = loadFont()
  applyFont(_font)
  _listeners.forEach(listener => listener(_font))
})
