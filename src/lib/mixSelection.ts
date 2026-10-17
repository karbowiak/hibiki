import type { MusicProvider } from "../providers/types"
import type { MusicPlaylist, MusicTrack } from "../types/music"
import { useProviderStore } from "../stores/providerStore"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashString(str: string): number {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0
  }
  return hash >>> 0
}

function mulberry32(seed: number): () => number {
  let s = seed | 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function shuffleTracks(arr: MusicTrack[], title: string): MusicTrack[] {
  const result = [...arr]
  const rng = mulberry32(hashString(title))
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

// ---------------------------------------------------------------------------
// Module-level state: the mix item selected on the homepage.
// Plex hub mixes have rating_key=0 — we cannot route by ID, so Home.tsx
// calls selectMix() before navigating to /mix.
// ---------------------------------------------------------------------------

let selectedMix: {
  item: MusicPlaylist
  provider: MusicProvider | null
} | null = null
const selectionListeners = new Set<() => void>()
export function subscribeSelection(listener: () => void) {
  selectionListeners.add(listener)
  return () => {
    selectionListeners.delete(listener)
  }
}
export function getSelection() {
  return selectedMix
}

useProviderStore.subscribe((state, previous) => {
  if (
    state.provider !== previous.provider &&
    selectedMix?.provider !== state.provider
  ) {
    selectedMix = null
    for (const listener of selectionListeners) listener()
  }
})

export function selectMix(item: MusicPlaylist) {
  selectedMix = { item, provider: useProviderStore.getState().provider }
  for (const listener of selectionListeners) listener()
}
