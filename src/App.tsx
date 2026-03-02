import { useEffect } from "react"
import { useLocation } from "wouter"
import { SideBar } from "./components/SideBar"
import { Page } from "./components/Page"
import "./App.css"
import { TailwindIndicator } from "./components/tailwind-indicator"
import { Player } from "./components/Player"
import { CreatePlaylist } from "./components/Pages/CreatePlaylist"
import { QueuePanel } from "./components/QueuePanel"
import LyricsPanel from "./components/LyricsPanel"
import { UpdateDialog } from "./components/UpdateDialog"
import { useConnectionStore, useLibraryStore, useUIStore } from "./stores"
import "./stores/accentStore"  // import so the module runs applyAccent() on load
import "./stores/themeStore"   // import so the module runs applyTheme() on load
import "./stores/fontStore"    // import so the module runs applyFont() on load

function App() {
  const { isConnected, musicSectionId, isLoading, loadAndConnect } = useConnectionStore()
  const { fetchPlaylists, fetchRecentlyAdded, fetchHubs, fetchTags, prefetchAllPlaylists, prefetchMixTracks } = useLibraryStore()
  const { showCreatePlaylist, setShowCreatePlaylist } = useUIStore()
  const [location, navigate] = useLocation()

  useEffect(() => {
    void loadAndConnect()
  }, [])

  useEffect(() => {
    if (isConnected && musicSectionId !== null) {
      const id = musicSectionId
      // Fetch all home-page data in parallel, THEN start background prefetch.
      // Starting prefetch early was competing with fetchHubs/fetchRecentlyAdded
      // for Plex server connections, causing hubs to silently fail.
      void Promise.all([
        fetchPlaylists(id),
        fetchRecentlyAdded(id, 50),
        fetchHubs(id),
        fetchTags(id),    // 24h TTL — rarely hits network after first load
      ]).then(() => {
        void prefetchAllPlaylists()
        void prefetchMixTracks()
      })
    }
  }, [isConnected, musicSectionId])

  useEffect(() => {
    if (!isLoading && !isConnected && location !== "/settings") {
      navigate("/settings")
    }
  }, [isLoading, isConnected])

  if (process.env.NODE_ENV === "production") {
    document.addEventListener("contextmenu", (event) => event.preventDefault())
  }

  return (
    <div className="select-none">
      {/*
        Outer shell: full-height flex column.
        - Top row: sidebar + page content (flex-1, takes all space above the player)
        - Bottom: Player — always visible, never overlaps content
      */}
      <div className="flex h-screen flex-col overflow-hidden text-white">
        {/* Sidebar + main content + optional pinned queue */}
        <div className="flex min-h-0 flex-1 flex-row overflow-hidden">
          <SideBar onCreatePlaylist={() => setShowCreatePlaylist(true)} />
          <div className="min-w-0 flex-1">
            <Page />
          </div>
          {/* QueuePanel lives here so pinned mode becomes a natural flex column.
              In overlay mode it uses fixed positioning and escapes this layout. */}
          <QueuePanel />
          {/* LyricsPanel: pinned sidebar sits here; overlay mode uses fixed positioning */}
          <LyricsPanel />
        </div>

        {/* Player sits at the bottom as a natural flex item — no overlap */}
        <Player />
      </div>

      <TailwindIndicator />

      {showCreatePlaylist && (
        <CreatePlaylist onClose={() => setShowCreatePlaylist(false)} />
      )}

      <UpdateDialog />
    </div>
  )
}

export default App
