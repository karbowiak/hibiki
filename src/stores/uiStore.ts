import { create } from "zustand"

interface UIState {
  showCreatePlaylist: boolean
  /** Item IDs to add to the newly created playlist after the create dialog completes. */
  pendingPlaylistItemIds: string[] | null
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
  /** When true, duplicate albums on artist pages are merged into a single entry. */
  deduplicateAlbums: boolean
  /** When true, album art is expanded in the bottom-left corner above the player bar. */
  isArtExpanded: boolean

  setShowCreatePlaylist: (v: boolean) => void
  setPendingPlaylistItemIds: (ids: string[] | null) => void
  setIsRefreshing: (v: boolean) => void
  incrementPageRefreshKey: () => void
  setQueueOpen: (v: boolean) => void
  setQueuePinned: (v: boolean) => void
  setLyricsOpen: (v: boolean) => void
  setLyricsPinned: (v: boolean) => void
  setQueueActiveTab: (tab: "queue" | "lyrics") => void
  setDeduplicateAlbums: (v: boolean) => void
  toggleArtExpanded: () => void
}

export const useUIStore = create<UIState>((set) => ({
  showCreatePlaylist: false,
  pendingPlaylistItemIds: null,
  isRefreshing: false,
  pageRefreshKey: 0,
  isQueueOpen: false,
  isQueuePinned: localStorage.getItem("plex-queue-pinned") === "1",
  isLyricsOpen: false,
  isLyricsPinned: localStorage.getItem("plex-lyrics-pinned") === "1",
  queueActiveTab: "queue",
  deduplicateAlbums: localStorage.getItem("plex-dedup-albums") !== "0",
  isArtExpanded: localStorage.getItem("plex-art-expanded") === "1",

  setShowCreatePlaylist: (v: boolean) => set({ showCreatePlaylist: v }),
  setPendingPlaylistItemIds: (ids: string[] | null) => set({ pendingPlaylistItemIds: ids }),
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
  setDeduplicateAlbums: (v: boolean) => {
    localStorage.setItem("plex-dedup-albums", v ? "1" : "0")
    set({ deduplicateAlbums: v })
  },
  toggleArtExpanded: () => set(s => {
    const next = !s.isArtExpanded
    localStorage.setItem("plex-art-expanded", next ? "1" : "0")
    return { isArtExpanded: next }
  }),
}))
