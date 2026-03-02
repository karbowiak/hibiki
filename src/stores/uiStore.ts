import { create } from "zustand"

interface UIState {
  showCreatePlaylist: boolean
  isRefreshing: boolean
  /** Incremented by the Refresh button — pages add this to their useEffect deps to re-run fetches. */
  pageRefreshKey: number
  isQueueOpen: boolean
  /** When true the queue renders as a fixed sidebar column rather than a slide-over overlay. Persisted to localStorage. */
  isQueuePinned: boolean

  /** Whether the lyrics panel is currently visible (overlay or sidebar). */
  isLyricsOpen: boolean
  /** When true the lyrics panel renders as a fixed sidebar (only when queue is not pinned). Persisted to localStorage. */
  isLyricsPinned: boolean
  /** Active tab in the pinned queue panel. Only relevant when isQueuePinned is true. */
  queueActiveTab: "queue" | "lyrics"

  setShowCreatePlaylist: (v: boolean) => void
  setIsRefreshing: (v: boolean) => void
  incrementPageRefreshKey: () => void
  setQueueOpen: (v: boolean) => void
  setQueuePinned: (v: boolean) => void
  setLyricsOpen: (v: boolean) => void
  setLyricsPinned: (v: boolean) => void
  setQueueActiveTab: (tab: "queue" | "lyrics") => void
}

export const useUIStore = create<UIState>((set) => ({
  showCreatePlaylist: false,
  isRefreshing: false,
  pageRefreshKey: 0,
  isQueueOpen: false,
  isQueuePinned: localStorage.getItem("plex-queue-pinned") === "1",
  isLyricsOpen: false,
  isLyricsPinned: localStorage.getItem("plex-lyrics-pinned") === "1",
  queueActiveTab: "queue",

  setShowCreatePlaylist: (v: boolean) => set({ showCreatePlaylist: v }),
  setIsRefreshing: (v: boolean) => set({ isRefreshing: v }),
  incrementPageRefreshKey: () => set(s => ({ pageRefreshKey: s.pageRefreshKey + 1 })),
  setQueueOpen: (v: boolean) => set({ isQueueOpen: v }),
  setQueuePinned: (v: boolean) => {
    localStorage.setItem("plex-queue-pinned", v ? "1" : "0")
    set({ isQueuePinned: v, ...(v ? { isQueueOpen: true } : { isQueueOpen: false }) })
  },
  setLyricsOpen: (v: boolean) => set({ isLyricsOpen: v }),
  setLyricsPinned: (v: boolean) => {
    localStorage.setItem("plex-lyrics-pinned", v ? "1" : "0")
    set({ isLyricsPinned: v, ...(v ? { isLyricsOpen: true } : {}) })
  },
  setQueueActiveTab: (tab: "queue" | "lyrics") => set({ queueActiveTab: tab }),
}))
