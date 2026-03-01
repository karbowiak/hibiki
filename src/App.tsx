import { useEffect } from "react"
import { useLocation } from "wouter"
import { SideBar } from "./components/SideBar"
import { Page } from "./components/Page"
import "./App.css"
import { TailwindIndicator } from "./components/tailwind-indicator"
import { Player } from "./components/Player"
import { CreatePlaylist } from "./components/Pages/CreatePlaylist"
import { QueuePanel } from "./components/QueuePanel"
import { useConnectionStore, useLibraryStore, useUIStore } from "./stores"

function App() {
  const { isConnected, musicSectionId, isLoading, loadAndConnect } = useConnectionStore()
  const { fetchPlaylists, fetchRecentlyAdded, fetchHubs, prefetchAllPlaylists } = useLibraryStore()
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
      ]).then(() => void prefetchAllPlaylists())
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
        {/* Sidebar + main content */}
        <div className="flex min-h-0 flex-1 flex-row overflow-hidden">
          <SideBar onCreatePlaylist={() => setShowCreatePlaylist(true)} />
          <div className="min-w-0 flex-1">
            <Page />
          </div>
        </div>

        {/* Player sits at the bottom as a natural flex item — no overlap */}
        <Player />
      </div>

      <TailwindIndicator />

      <QueuePanel />

      {showCreatePlaylist && (
        <CreatePlaylist onClose={() => setShowCreatePlaylist(false)} />
      )}
    </div>
  )
}

export default App
