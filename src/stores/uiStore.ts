import { create } from "zustand"
import { booleanPreference, createScalarPreference } from "./scalarPreference"

const queuePinned = booleanPreference("plex-queue-pinned", false)
const queueTab = createScalarPreference<"queue" | "lyrics">("plex-queue-tab", "queue", raw => {
  if (raw !== "queue" && raw !== "lyrics") throw Error("Invalid player panel tab")
  return raw
}, value => value)
let queueVisibilityTouched = false
const lyricsPinned = booleanPreference("plex-lyrics-pinned", false)
const dedupAlbums = booleanPreference("plex-dedup-albums", true)
const artExpanded = booleanPreference("plex-art-expanded", false)
const likedMusicVideos = booleanPreference("hibiki-liked-music-videos", false)

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
  /** Combine physical album copies across browsing, album pages and playback. */
  deduplicateAlbums: boolean
  /** When true, album art is expanded in the bottom-left corner above the player bar. */
  isArtExpanded: boolean
  likedMusicVideos: boolean
  setLikedMusicVideos: (value: boolean) => void

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
  isQueueOpen: queuePinned.snapshot(),
  isQueuePinned: queuePinned.snapshot(),
  isLyricsOpen: false,
  isLyricsPinned: lyricsPinned.snapshot(),
  queueActiveTab: queueTab.snapshot(),
  deduplicateAlbums: dedupAlbums.snapshot(),
  isArtExpanded: artExpanded.snapshot(),
  likedMusicVideos: likedMusicVideos.snapshot(),
  setLikedMusicVideos: value => { likedMusicVideos.set(value); set({ likedMusicVideos: value }) },

  setShowCreatePlaylist: (v: boolean) => set({ showCreatePlaylist: v }),
  setPendingPlaylistItemIds: (ids: string[] | null) => set({ pendingPlaylistItemIds: ids }),
  setIsRefreshing: (v: boolean) => set({ isRefreshing: v }),
  incrementPageRefreshKey: () => set(s => ({ pageRefreshKey: s.pageRefreshKey + 1 })),
  setQueueOpen: (v: boolean) => { queueVisibilityTouched = true; set({ isQueueOpen: v }) },
  setQueuePinned: (v: boolean) => {
    queueVisibilityTouched = true
    queuePinned.set(v)
    set({ isQueuePinned: v, ...(v ? { isQueueOpen: true } : { isQueueOpen: false }) })
  },
  setLyricsOpen: (v: boolean) => set({ isLyricsOpen: v }),
  setLyricsPinned: (v: boolean) => {
    lyricsPinned.set(v)
    set({ isLyricsPinned: v, ...(v ? { isLyricsOpen: true } : {}) })
  },
  setQueueActiveTab: (tab: "queue" | "lyrics") => { queueTab.set(tab); set({ queueActiveTab: tab }) },
  setDeduplicateAlbums: (v: boolean) => {
    dedupAlbums.set(v)
    set({ deduplicateAlbums: v })
  },
  toggleArtExpanded: () => set(s => {
    const next = !s.isArtExpanded
    artExpanded.set(next)
    return { isArtExpanded: next }
  }),
}))

queuePinned.subscribe(() => useUIStore.setState({ isQueuePinned: queuePinned.snapshot(), ...(!queueVisibilityTouched ? { isQueueOpen: queuePinned.snapshot() } : {}) }))
queueTab.subscribe(() => useUIStore.setState({ queueActiveTab: queueTab.snapshot() }))
lyricsPinned.subscribe(() => useUIStore.setState({ isLyricsPinned: lyricsPinned.snapshot() }))
dedupAlbums.subscribe(() => useUIStore.setState({ deduplicateAlbums: dedupAlbums.snapshot() }))
artExpanded.subscribe(() => useUIStore.setState({ isArtExpanded: artExpanded.snapshot() }))
likedMusicVideos.subscribe(() => useUIStore.setState({ likedMusicVideos: likedMusicVideos.snapshot() }))
