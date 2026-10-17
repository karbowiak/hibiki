import type { MusicProvider } from "../providers/types"
import type { MusicPlaylist } from "../types/music"
import { useProviderStore } from "../stores/providerStore"

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
