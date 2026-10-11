import { create } from "zustand"
import { useProviderStore } from "./providerStore"
import type { MusicProvider } from "../providers/types"
import type { MusicTrack, MusicAlbum, MusicArtist, MusicPlaylist } from "../types/music"

export type ContextMenuType = "track" | "album" | "artist" | "playlist"

type ContextMenuData = MusicTrack | MusicAlbum | MusicArtist | MusicPlaylist

interface ContextMenuState {
  ownerProvider: MusicProvider | null
  generation: number
  open: boolean
  x: number
  y: number
  type: ContextMenuType | null
  data: ContextMenuData | null
  /** When non-null, the context menu was opened from within a playlist view */
  playlistId: string | null
  show: (x: number, y: number, type: ContextMenuType, data: ContextMenuData, playlistId?: string | null) => void
  close: () => void
}

export const useContextMenuStore = create<ContextMenuState>((set) => ({
  ownerProvider: null,
  generation: 0,
  open: false,
  x: 0,
  y: 0,
  type: null,
  data: null,
  playlistId: null,

  show: (x, y, type, data, playlistId) => set(state => ({ open: true, ownerProvider: useProviderStore.getState().provider, generation: state.generation + 1, x, y, type, data, playlistId: playlistId ?? null })),
  close: () => set({ open: false }),
}))

useProviderStore.subscribe(state => {
  const menu = useContextMenuStore.getState()
  if (menu.open && menu.ownerProvider !== state.provider) menu.close()
})
