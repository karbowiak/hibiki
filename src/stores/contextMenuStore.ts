import { create } from "zustand"
import { useProviderStore } from "./providerStore"
import type { MusicProvider } from "../providers/types"
import type { MusicTrack, MusicAlbum, MusicArtist, MusicPlaylist } from "../types/music"

export type MediaContextMenuType = "track" | "album" | "artist" | "playlist"
export type ContextMenuType = MediaContextMenuType | "actions"
export interface ContextAction { label: string; run: () => void | Promise<void> }
export interface ContextActionsData { title: string; owner: object; actions: readonly ContextAction[] }

export type MediaContextMenuData = MusicTrack | MusicAlbum | MusicArtist | MusicPlaylist
type ContextMenuData = MediaContextMenuData | ContextActionsData

interface ContextMenuState {
  ownerProvider: MusicProvider | null
  ownerScope: string | undefined
  generation: number
  open: boolean
  x: number
  y: number
  type: ContextMenuType | null
  data: ContextMenuData | null
  /** When non-null, the context menu was opened from within a playlist view */
  playlistId: string | null
  show: (x: number, y: number, type: MediaContextMenuType, data: MediaContextMenuData, playlistId?: string | null) => void
  showActions: (x: number, y: number, data: ContextActionsData) => void
  close: () => void
}

export const useContextMenuStore = create<ContextMenuState>((set) => ({
  ownerProvider: null,
  ownerScope: undefined,
  generation: 0,
  open: false,
  x: 0,
  y: 0,
  type: null,
  data: null,
  playlistId: null,

  show: (x, y, type, data, playlistId) => set(state => ({ open: true, ownerProvider: useProviderStore.getState().provider, ownerScope: useProviderStore.getState().provider?.cacheScope, generation: state.generation + 1, x, y, type, data, playlistId: playlistId ?? null })),
  showActions: (x, y, data) => set(state => ({ open: true, ownerProvider: useProviderStore.getState().provider, ownerScope: useProviderStore.getState().provider?.cacheScope, generation: state.generation + 1, x, y, type: "actions", data, playlistId: null })),
  close: () => set(state => ({ open: false, ...(state.type === "actions" ? { type: null, data: null } : {}) })),
}))

useProviderStore.subscribe(state => {
  const menu = useContextMenuStore.getState()
  if (menu.open && (menu.ownerProvider !== state.provider || menu.ownerScope !== state.provider?.cacheScope)) menu.close()
})
