import { sqliteLocalStorage } from "../storage/clientStorage"
import { create } from "zustand"

const STORAGE_KEY = "plex-compact-mode"

function getInitial(): boolean {
  try {
    return sqliteLocalStorage.getItem(STORAGE_KEY) === "true"
  } catch {
    return false
  }
}

function applyCompact(enabled: boolean) {
  const s = document.documentElement.style
  const attr = document.documentElement
  if (enabled) {
    attr.setAttribute("data-compact", "")
    s.setProperty("--spacing-sidebar", "16px")
    s.setProperty("--spacing-player", "16px")
    s.setProperty("--spacing-topbar", "24px")
    s.setProperty("--player-height", "80px")
  } else {
    attr.removeAttribute("data-compact")
    s.setProperty("--spacing-sidebar", "24px")
    s.setProperty("--spacing-player", "24px")
    s.setProperty("--spacing-topbar", "32px")
    s.setProperty("--player-height", "96px")
  }
}

// Apply on load
applyCompact(getInitial())

interface CompactState {
  compact: boolean
  setCompact: (v: boolean) => void
  toggle: () => void
}

export const useCompactStore = create<CompactState>((set, get) => ({
  compact: getInitial(),
  setCompact: (v: boolean) => {
    sqliteLocalStorage.setItem(STORAGE_KEY, String(v))
    applyCompact(v)
    set({ compact: v })
  },
  toggle: () => {
    const next = !get().compact
    sqliteLocalStorage.setItem(STORAGE_KEY, String(next))
    applyCompact(next)
    set({ compact: next })
  },
}))
