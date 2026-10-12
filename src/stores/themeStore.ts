import { createScalarPreference } from "./scalarPreference"

type Theme = "dark" | "light" | "system"

const STORAGE_KEY = "plex-theme"
const DEFAULT_THEME: Theme = "dark"

let mediaListener: ((e: MediaQueryListEvent) => void) | null = null
let mediaQuery: MediaQueryList | null = null

function resolveTheme(mode: Theme): "dark" | "light" {
  if (mode !== "system") return mode
  return window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark"
}

function applyTheme(mode: Theme) {
  if (typeof document === "undefined") return
  const resolved = resolveTheme(mode)
  document.documentElement.setAttribute("data-theme", resolved)

  // Watch for system changes when in "system" mode
  if (mediaListener && mediaQuery) {
    mediaQuery.removeEventListener("change", mediaListener)
    mediaListener = null
    mediaQuery = null
  }
  if (mode === "system") {
    mediaQuery = window.matchMedia("(prefers-color-scheme: light)")
    mediaListener = () => applyTheme("system")
    mediaQuery.addEventListener("change", mediaListener)
  }
}

function normalizeTheme(value: unknown): Theme {
  return value === "light" || value === "system" ? value : DEFAULT_THEME
}
const preference = createScalarPreference<Theme>(
  STORAGE_KEY,
  DEFAULT_THEME,
  (raw) => {
    if (raw !== "dark" && raw !== "light" && raw !== "system")
      throw new Error("Invalid theme preference")
    return raw
  },
  (value) => value
)
function loadTheme(): Theme {
  return preference.snapshot()
}

// --- Minimal store (no Zustand needed — pure CSS var side-effects) ---

let _theme: Theme = loadTheme()

// Apply immediately before first render
applyTheme(_theme)

export function getTheme(): Theme {
  return _theme
}

export function setTheme(mode: Theme) {
  preference.set(normalizeTheme(mode))
}

const _listeners = new Set<(theme: Theme) => void>()

export function subscribeTheme(fn: (theme: Theme) => void): () => void {
  _listeners.add(fn)
  return () => _listeners.delete(fn)
}

preference.subscribe(() => {
  _theme = preference.snapshot()
  applyTheme(_theme)
  _listeners.forEach((listener) => listener(_theme))
})
