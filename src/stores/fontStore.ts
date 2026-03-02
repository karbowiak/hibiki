const STORAGE_KEY = "plex-font"

export interface FontPreset {
  name: string
  label: string
  /** CSS font-family stack to set on --font-family */
  stack: string
  /** Google Fonts URL — null if the font is already available locally */
  googleUrl: string | null
}

export const FONT_PRESETS: FontPreset[] = [
  {
    name: "circular",
    label: "Circular",
    stack: "CircularSp, CircularSp-Arab, CircularSp-Hebr, CircularSp-Cyrl, CircularSp-Grek, CircularSp-Deva, sans-serif",
    googleUrl: null,
  },
  {
    name: "inter",
    label: "Inter",
    stack: "'Inter', sans-serif",
    googleUrl: "https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;900&display=swap",
  },
  {
    name: "geist",
    label: "Geist",
    stack: "'Geist', sans-serif",
    googleUrl: "https://fonts.googleapis.com/css2?family=Geist:wght@400;600;700;900&display=swap",
  },
  {
    name: "montserrat",
    label: "Montserrat",
    stack: "'Montserrat', sans-serif",
    googleUrl: "https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700;900&display=swap",
  },
  {
    name: "nunito",
    label: "Nunito",
    stack: "'Nunito', sans-serif",
    googleUrl: "https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;900&display=swap",
  },
]

const DEFAULT_FONT = "circular"

function loadFont(): FontPreset {
  const stored = localStorage.getItem(STORAGE_KEY)
  return FONT_PRESETS.find(p => p.name === stored) ?? FONT_PRESETS[0]!
}

function injectGoogleFont(url: string) {
  if (document.querySelector(`link[href="${url}"]`)) return
  const link = document.createElement("link")
  link.rel = "stylesheet"
  link.href = url
  document.head.appendChild(link)
}

function applyFont(preset: FontPreset) {
  if (preset.googleUrl) injectGoogleFont(preset.googleUrl)
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
  _font = preset
  localStorage.setItem(STORAGE_KEY, name)
  applyFont(preset)
  _listeners.forEach(fn => fn(preset))
}

const _listeners = new Set<(font: FontPreset) => void>()

export function subscribeFont(fn: (font: FontPreset) => void): () => void {
  _listeners.add(fn)
  return () => _listeners.delete(fn)
}

export { DEFAULT_FONT }
