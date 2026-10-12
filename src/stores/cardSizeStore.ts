import { create } from "zustand"
import { createScalarPreference } from "./scalarPreference"

const STORAGE_KEY = "plex-card-size"
const MIN_SIZE = 140
const MAX_SIZE = 280
const DEFAULT_SIZE = 160

interface CardSizeState {
  cardSize: number
  setCardSize: (px: number) => void
}

function applyCardSize(px: number) {
  if (typeof document === "undefined") return
  document.documentElement.style.setProperty("--card-size", `${px}px`)
}

function normalizeSize(value: number): number {
  return Number.isFinite(value)
    ? Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.round(value)))
    : DEFAULT_SIZE
}
const preference = createScalarPreference(
  STORAGE_KEY,
  DEFAULT_SIZE,
  (raw) => {
    if (!raw.trim() || !Number.isFinite(Number(raw)))
      throw new Error("Invalid card size preference")
    return normalizeSize(Number(raw))
  },
  (value) => String(value)
)
const initialSize = preference.snapshot()

// Apply immediately on module load so cards are sized correctly before first render
applyCardSize(initialSize)

export const useCardSizeStore = create<CardSizeState>(() => ({
  cardSize: initialSize,

  setCardSize: (px: number) => {
    preference.set(normalizeSize(px))
  },
}))

export const CARD_SIZE_MIN = MIN_SIZE
export const CARD_SIZE_MAX = MAX_SIZE
export const CARD_SIZE_DEFAULT = DEFAULT_SIZE

preference.subscribe(() => {
  const cardSize = preference.snapshot()
  applyCardSize(cardSize)
  useCardSizeStore.setState({ cardSize })
})
