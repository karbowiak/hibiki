import { useEffect } from "react"
import { isTauri } from "@tauri-apps/api/core"
import { useLocation } from "wouter"
import { SideBar } from "./components/SideBar"
import { Page } from "./components/Page"
import { ArtworkShell } from "./components/ArtworkShell"
import "./App.css"
import { TailwindIndicator } from "./components/tailwind-indicator"
import { Player } from "./components/Player"
import { CreatePlaylist } from "./components/Pages/CreatePlaylist"
import { QueuePanel } from "./components/QueuePanel"
import LyricsPanel from "./components/LyricsPanel"
import { UpdateDialog } from "./components/UpdateDialog"
import { ContextMenu } from "./components/ContextMenu"
import { DebugPanel } from "./components/DebugPanel"
import { DragOverlay } from "./components/DragOverlay"
import { HotkeyHelpModal } from "./components/HotkeyHelpModal"
import { useDebugPanelStore } from "./stores/debugPanelStore"
import { useVisualizerStore } from "./stores/visualizerStore"
import { createAppMenu } from "./lib/appMenu"
import { recordRecentPlaylist } from "./lib/recentPlaylists"
import { useProviderStore } from "./stores/providerStore"
import { useShallow } from "zustand/react/shallow"
import { useConnectionStore, useLibraryStore, useUIStore } from "./stores"
import { useLastfmStore } from "./metadata/lastfm/authStore"
import { useGeniusStore } from "./metadata/genius/authStore"
import { useListenBrainzStore } from "./metadata/listenbrainz/authStore"
import "./stores/accentStore"    // import so the module runs applyAccent() on load
import "./stores/themeStore"    // import so the module runs applyTheme() on load
import "./stores/fontStore"     // import so the module runs applyFont() on load
import "./stores/cardSizeStore" // import so the module sets --card-size CSS var on load
import "./stores/highlightStore" // import so the module sets --hl-* CSS vars on load
import { IS_WINDOWS } from "./lib/platform"
import { WindowTitleBar } from "./components/WindowTitleBar"
import { useGlobalHotkeys } from "./hooks/useGlobalHotkeys"
import { initializeShutdown } from "./lib/shutdown"
import { ListeningSyncStatus } from "./components/ListeningSyncStatus"
import { ShutdownNotice } from "./components/ShutdownNotice"
import { StorageStatus } from "./components/PersistenceNotice"
import { NotificationSources } from "./components/NotificationSources"
import { OfflineStatus } from "./components/OfflineStatus"
import { useLinkedPlaylistSync } from "./hooks/useLinkedPlaylistSync"
import { NotificationToasts } from "./components/NotificationCenter"
import LiveAnnouncer from "./components/LiveAnnouncer"
import "./i18n" // Initialize i18n on app load

function DesktopApp() {
  useLinkedPlaylistSync()
  const activeProvider = useProviderStore(s => s.provider)
  const debugPanelOpen = useDebugPanelStore(s => s.open)
  const fullscreenOpen = useVisualizerStore(s => s.fullscreenOpen)
  const { hotkeyHelpOpen, setHotkeyHelpOpen } = useGlobalHotkeys()
  const { isConnected, isOffline, musicSectionId, isLoading, loadAndConnect } = useConnectionStore(
    useShallow(s => ({ isConnected: s.isConnected, isOffline: s.isOffline, musicSectionId: s.musicSectionId, isLoading: s.isLoading, loadAndConnect: s.loadAndConnect }))
  )
  const { fetchPlaylists, fetchRecentlyAdded, fetchLatestReleases, fetchHubs, fetchTags, prefetchAllPlaylists, prefetchMixTracks } = useLibraryStore(
    useShallow(s => ({ fetchPlaylists: s.fetchPlaylists, fetchRecentlyAdded: s.fetchRecentlyAdded, fetchLatestReleases: s.fetchLatestReleases, fetchHubs: s.fetchHubs, fetchTags: s.fetchTags, prefetchAllPlaylists: s.prefetchAllPlaylists, prefetchMixTracks: s.prefetchMixTracks }))
  )
  const { showCreatePlaylist, setShowCreatePlaylist, pendingPlaylistItemIds, setPendingPlaylistItemIds } = useUIStore(
    useShallow(s => ({ showCreatePlaylist: s.showCreatePlaylist, setShowCreatePlaylist: s.setShowCreatePlaylist, pendingPlaylistItemIds: s.pendingPlaylistItemIds, setPendingPlaylistItemIds: s.setPendingPlaylistItemIds }))
  )
  const initLastfm = useLastfmStore(s => s.initialize)
  const initGenius = useGeniusStore(s => s.initialize)
  const initListenBrainz = useListenBrainzStore(s => s.initialize)
  const [location, navigate] = useLocation()

  useEffect(() => {
    let disposed = false
    let cleanup: (() => void) | undefined
    void initializeShutdown().then(unlisten => { if (disposed) unlisten(); else cleanup = unlisten })
    return () => { disposed = true; cleanup?.() }
  }, [])

  useEffect(() => {
    void loadAndConnect()
    void createAppMenu(() => navigate("/settings"))
    void initLastfm()
    void initGenius()
    void initListenBrainz()
  }, [])

  useEffect(() => {
    let active = true
    if ((isConnected || isOffline) && musicSectionId !== null && activeProvider) {
      // Fetch all home-page data in parallel, THEN start background prefetch.
      // Starting prefetch early was competing with fetchHubs/fetchRecentlyAdded
      // for Plex server connections, causing hubs to silently fail.
      void Promise.all([
        fetchPlaylists(),
        fetchRecentlyAdded(50),
        fetchLatestReleases(30),
        // Personalized mixes change on the server. Refresh them on connection
        // instead of trusting a persisted recommendation from a previous run.
        fetchHubs({ force: true }),
        fetchTags(),    // 24h TTL — rarely hits network after first load
      ]).then(() => {
        if (!active || isOffline || useProviderStore.getState().provider !== activeProvider) return
        void prefetchAllPlaylists()
        void prefetchMixTracks()
      })
    }
    return () => { active = false }
  }, [isConnected, isOffline, musicSectionId, activeProvider])

  useEffect(() => {
    if (!isLoading && !isConnected && !isOffline && location !== "/settings") {
      navigate("/settings")
    }
  }, [isLoading, isConnected, isOffline])

  if (process.env.NODE_ENV === "production") {
    document.addEventListener("contextmenu", (event) => event.preventDefault())
  }

  return (
    <div className="select-none">
      <NotificationSources />
      <OfflineStatus />
      <StorageStatus />
      <ListeningSyncStatus />
      {/*
        Outer shell: full-height flex column.
        - Top row: sidebar + page content (flex-1, takes all space above the player)
        - Bottom: Player — always visible, never overlaps content
      */}
      <ArtworkShell>
        {IS_WINDOWS && <WindowTitleBar />}
        {/* Sidebar + main content + optional pinned queue */}
        <div className="relative z-0 flex min-h-0 flex-1 flex-row overflow-hidden">
          <SideBar onCreatePlaylist={() => setShowCreatePlaylist(true)} />
          <main className="min-w-0 flex-1" role="main">
            <Page />
          </main>
          {/* QueuePanel lives here so pinned mode becomes a natural flex column.
              In overlay mode it uses fixed positioning and escapes this layout. */}
          <QueuePanel />
          {/* LyricsPanel: pinned sidebar sits here; overlay mode uses fixed positioning */}
          <LyricsPanel />
        </div>

        {/* Player sits at the bottom as a natural flex item — no overlap */}
        <Player />
      </ArtworkShell>

      <TailwindIndicator />
      <NotificationToasts />

      {showCreatePlaylist && (
        <CreatePlaylist
          onClose={() => { setShowCreatePlaylist(false); setPendingPlaylistItemIds(null) }}
          onCreated={pendingPlaylistItemIds ? (playlist) => {
            const provider = useProviderStore.getState().provider
            if (provider) {
              void provider.addToPlaylist(playlist.id, pendingPlaylistItemIds.map(String))
                .then(() => { if (useProviderStore.getState().provider === provider) useLibraryStore.getState().invalidatePlaylistItems(playlist.id) })
                .catch(() => {})
            }
            recordRecentPlaylist(playlist.id)
            setPendingPlaylistItemIds(null)
          } : undefined}
        />
      )}

      <ShutdownNotice />
      <UpdateDialog />
      <ContextMenu />
      {hotkeyHelpOpen && <HotkeyHelpModal context={fullscreenOpen ? "visualizer" : "player"} onClose={() => setHotkeyHelpOpen(false)} />}
      {debugPanelOpen && <DebugPanel />}
      <LiveAnnouncer />
      <DragOverlay />
    </div>
  )
}

function App() {
  // A regular browser has no desktop backend. Don't initialize native services
  // or offer sign-in controls that would fail with an undefined invoke API.
  if (!isTauri()) {
    return (
      <main className="flex h-screen items-center justify-center bg-app-bg p-8 text-white">
        <div className="max-w-lg rounded-lg border border-white/10 bg-app-card p-8">
          <p className="mb-2 text-sm font-semibold text-accent">Hibiki</p>
          <h1 className="text-2xl font-bold">Open the Hibiki desktop app</h1>
          <p className="mt-3 text-sm leading-relaxed text-white/60">
            Plex sign-in, audio playback, and saved settings are available in the desktop app.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-white/60">
            This development page is running in a browser, so it cannot connect to Plex or play your library.
          </p>
        </div>
      </main>
    )
  }
  return <DesktopApp />
}

export default App
