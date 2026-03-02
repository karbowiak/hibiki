import { create } from "zustand"
import type { Track, Album, Artist } from "../types/plex"

export type ContextMenuType = "track" | "album" | "artist"

interface ContextMenuState {
  open: boolean
  x: number
  y: number
  type: ContextMenuType | null
  data: Track | Album | Artist | null
  show: (x: number, y: number, type: ContextMenuType, data: Track | Album | Artist) => void
  close: () => void
}

export const useContextMenuStore = create<ContextMenuState>((set) => ({
  open: false,
  x: 0,
  y: 0,
  type: null,
  data: null,

  show: (x, y, type, data) => set({ open: true, x, y, type, data }),
  close: () => set({ open: false }),
}))
