import { create } from "zustand"

const STORAGE_KEY = "plex-card-size"
const MIN_SIZE = 140
const MAX_SIZE = 280
const DEFAULT_SIZE = 160

interface CardSizeState {
  cardSize: number
  setCardSize: (px: number) => void
}

function applyCardSize(px: number) {
  document.documentElement.style.setProperty("--card-size", `${px}px`)
}

const initialSize = (() => {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (!stored) return DEFAULT_SIZE
  const parsed = parseInt(stored, 10)
  return isNaN(parsed) ? DEFAULT_SIZE : Math.max(MIN_SIZE, Math.min(MAX_SIZE, parsed))
})()

// Apply immediately on module load so cards are sized correctly before first render
applyCardSize(initialSize)

export const useCardSizeStore = create<CardSizeState>(() => ({
  cardSize: initialSize,

  setCardSize: (px: number) => {
    const clamped = Math.max(MIN_SIZE, Math.min(MAX_SIZE, px))
    localStorage.setItem(STORAGE_KEY, String(clamped))
    applyCardSize(clamped)
    useCardSizeStore.setState({ cardSize: clamped })
  },
}))

export const CARD_SIZE_MIN = MIN_SIZE
export const CARD_SIZE_MAX = MAX_SIZE
export const CARD_SIZE_DEFAULT = DEFAULT_SIZE
