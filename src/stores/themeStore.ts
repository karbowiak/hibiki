type Theme = "dark" | "light" | "system"

const STORAGE_KEY = "plex-theme"
const DEFAULT_THEME: Theme = "dark"

let mediaListener: ((e: MediaQueryListEvent) => void) | null = null
let mediaQuery: MediaQueryList | null = null

function resolveTheme(mode: Theme): "dark" | "light" {
  if (mode !== "system") return mode
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"
}

function applyTheme(mode: Theme) {
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

function loadTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored === "dark" || stored === "light" || stored === "system") return stored
  return DEFAULT_THEME
}

// --- Minimal store (no Zustand needed — pure CSS var side-effects) ---

let _theme: Theme = loadTheme()

// Apply immediately before first render
applyTheme(_theme)

export function getTheme(): Theme {
  return _theme
}

export function setTheme(mode: Theme) {
  _theme = mode
  localStorage.setItem(STORAGE_KEY, mode)
  applyTheme(mode)
  // Notify all subscribers
  _listeners.forEach(fn => fn(mode))
}

const _listeners = new Set<(theme: Theme) => void>()

export function subscribeTheme(fn: (theme: Theme) => void): () => void {
  _listeners.add(fn)
  return () => _listeners.delete(fn)
}
