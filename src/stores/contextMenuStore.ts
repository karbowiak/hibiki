import { create } from "zustand"
import { useProviderStore } from "./providerStore"
import type { MusicProvider } from "../providers/types"
import type { MusicTrack, MusicAlbum, MusicArtist, MusicPlaylist } from "../types/music"

export type MediaContextMenuType = "track" | "album" | "artist" | "playlist"
export type ContextMenuType = MediaContextMenuType | "actions"
export type ContextActionIcon = "play" | "shuffle" | "next" | "queue" | "radio" | "heart" | "share" | "artist" | "album"
export interface ContextAction {
  label: string
  icon?: ContextActionIcon
  section?: "playback" | "rating" | "share" | "navigation"
  disabled?: boolean
  run: (current?: () => boolean) => void | Promise<void>
}
export interface ContextActionsData { title: string; owner: object; actions: readonly ContextAction[]; ratingTrack?: MusicTrack }

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
  extraActions: readonly ContextAction[]
  show: (x: number, y: number, type: MediaContextMenuType, data: MediaContextMenuData, playlistId?: string | null, extraActions?: readonly ContextAction[]) => void
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
  extraActions: [],

  show: (x, y, type, data, playlistId, extraActions = []) => set(state => ({ open: true, ownerProvider: useProviderStore.getState().provider, ownerScope: useProviderStore.getState().provider?.cacheScope, generation: state.generation + 1, x, y, type, data, playlistId: playlistId ?? null, extraActions: [...extraActions] })),
  showActions: (x, y, data) => set(state => ({ open: true, ownerProvider: useProviderStore.getState().provider, ownerScope: useProviderStore.getState().provider?.cacheScope, generation: state.generation + 1, x, y, type: "actions", data, playlistId: null, extraActions: [] })),
  close: () => set(state => ({ open: false, extraActions: [], ...(state.type === "actions" ? { type: null, data: null } : {}) })),
}))

useProviderStore.subscribe(state => {
  const menu = useContextMenuStore.getState()
  if (menu.open && (menu.ownerProvider !== state.provider || menu.ownerScope !== state.provider?.cacheScope)) menu.close()
})
