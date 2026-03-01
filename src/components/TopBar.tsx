import { Link, useLocation } from "wouter"
import { useEffect, useRef, useState } from "react"
import { useSearchStore, useConnectionStore, useUIStore, useLibraryStore } from "../stores"
import { clearImageCache } from "../lib/plex"
import { ActivityIndicator } from "./ActivityIndicator"
import { SearchDropdown } from "./SearchDropdown"

export function TopBar() {
  const [location, navigate] = useLocation()
  const { search, clear, setQuery, query } = useSearchStore()
  const { musicSectionId, isConnected } = useConnectionStore()
  const { isRefreshing, setIsRefreshing, incrementPageRefreshKey } = useUIStore()
  const { refreshAll, invalidateCache } = useLibraryStore()
  const [localQuery, setLocalQuery] = useState(query)
  const [showDropdown, setShowDropdown] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)

  // Debounced search — fires regardless of current route
  useEffect(() => {
    const timer = setTimeout(() => {
      if (musicSectionId !== null && localQuery.trim()) {
        void search(musicSectionId, localQuery)
      } else if (!localQuery.trim()) {
        clear()
      }
    }, 350)
    return () => clearTimeout(timer)
  }, [localQuery, musicSectionId])

  // Keep store in sync immediately for showResults logic
  useEffect(() => {
    setQuery(localQuery)
  }, [localQuery])

  // Close dropdown on route change
  useEffect(() => {
    setShowDropdown(false)
    setActiveIndex(-1)
  }, [location])

  // Global keyboard shortcuts
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "r") {
        e.preventDefault()
        void handleRefresh()
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [musicSectionId, isRefreshing])

  const handleRefresh = async () => {
    if (!musicSectionId || isRefreshing) return
    setIsRefreshing(true)
    try {
      invalidateCache()
      incrementPageRefreshKey()
      await Promise.all([
        clearImageCache(),
        refreshAll(musicSectionId),
      ])
    } finally {
      setIsRefreshing(false)
    }
  }

  const handleInputFocus = () => {
    if (location !== "/search" && localQuery.trim().length > 0) setShowDropdown(true)
    setActiveIndex(-1)
  }

  const handleInputBlur = () => {
    // Delay so dropdown click events fire before the dropdown closes
    setTimeout(() => setShowDropdown(false), 150)
  }

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showDropdown) {
      if (e.key === "Enter") {
        navigate("/search")
      }
      return
    }
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActiveIndex(i => i + 1)
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActiveIndex(i => Math.max(-1, i - 1))
    } else if (e.key === "Escape") {
      e.preventDefault()
      setShowDropdown(false)
      inputRef.current?.blur()
    } else if (e.key === "Enter") {
      if (activeIndex < 0) {
        navigate("/search")
        setShowDropdown(false)
      }
      // If activeIndex >= 0, SearchDropdown handles the Enter press via its own handler
    }
  }

  const handleQueryChange = (value: string) => {
    setLocalQuery(value)
    setShowDropdown(location !== "/search" && value.trim().length > 0)
    setActiveIndex(-1)
  }

  return (
    // pt-8 gives 32px of clearance for the macOS traffic-light buttons
    <div data-tauri-drag-region className="mb-3 flex flex-row items-center px-8 pt-8">
      <div data-tauri-drag-region className="flex grow flex-row items-center gap-4">
        {/* Back button */}
        <Link href="/">
          <button
            aria-label="Go back"
            className="h-fit rounded-full bg-black/70 p-2 hover:bg-black/90 transition-colors"
          >
            <svg role="img" height="16" width="16" className="fill-white" viewBox="0 0 16 16">
              <path d="M11.03.47a.75.75 0 0 1 0 1.06L4.56 8l6.47 6.47a.75.75 0 1 1-1.06 1.06L2.44 8 9.97.47a.75.75 0 0 1 1.06 0z" />
            </svg>
          </button>
        </Link>

        {/* Forward button (always disabled — no history API) */}
        <button
          aria-label="Go forward"
          disabled
          className="h-fit rounded-full bg-black/70 p-2"
        >
          <svg role="img" height="16" width="16" className="fill-white/30" viewBox="0 0 16 16">
            <path d="M4.97.47a.75.75 0 0 0 0 1.06L11.44 8l-6.47 6.47a.75.75 0 1 0 1.06 1.06L13.56 8 6.03.47a.75.75 0 0 0-1.06 0z" />
          </svg>
        </button>

        {/* Search input — always visible, wired to store */}
        <div className="relative text-sm text-black">
          <svg
            height="16" width="16"
            className="absolute left-3 top-1/2 -translate-y-1/2 fill-[#121212] pointer-events-none"
            viewBox="0 0 24 24"
          >
            <path d="M10.533 1.279c-5.18 0-9.407 4.14-9.407 9.279s4.226 9.279 9.407 9.279c2.234 0 4.29-.77 5.907-2.058l4.353 4.353a1 1 0 1 0 1.414-1.414l-4.344-4.344a9.157 9.157 0 0 0 2.077-5.816c0-5.14-4.226-9.28-9.407-9.28zm-7.407 9.279c0-4.006 3.302-7.28 7.407-7.28s7.407 3.274 7.407 7.28-3.302 7.279-7.407 7.279-7.407-3.273-7.407-7.28z" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={localQuery}
            onChange={e => handleQueryChange(e.target.value)}
            onFocus={handleInputFocus}
            onBlur={handleInputBlur}
            onKeyDown={handleInputKeyDown}
            placeholder="What do you want to listen to?"
            className="h-[40px] w-[364px] rounded-full bg-white pl-10 pr-4 text-black focus:outline-none"
          />
          {localQuery && (
            <button
              type="button"
              onMouseDown={e => e.preventDefault()}
              onClick={() => { setLocalQuery(""); clear(); setShowDropdown(false) }}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[#121212]/40 hover:text-[#121212]"
            >
              <svg height="12" width="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M2.47 2.47a.75.75 0 0 1 1.06 0L8 6.94l4.47-4.47a.75.75 0 1 1 1.06 1.06L9.06 8l4.47 4.47a.75.75 0 1 1-1.06 1.06L8 9.06l-4.47 4.47a.75.75 0 0 1-1.06-1.06L6.94 8 2.47 3.53a.75.75 0 0 1 0-1.06z" />
              </svg>
            </button>
          )}
          {showDropdown && (
            <SearchDropdown
              activeIndex={activeIndex}
              onActiveIndexChange={setActiveIndex}
              onClose={() => setShowDropdown(false)}
            />
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        {/* Activity indicator — always visible, animates when busy */}
        <ActivityIndicator />

        {/* Refresh button */}
        <button
          onClick={() => void handleRefresh()}
          disabled={isRefreshing || !isConnected}
          title="Refresh library (⌘R)"
          className="flex h-8 w-8 items-center justify-center rounded-full bg-black/70 hover:bg-[#282828] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <svg
            height="15" width="15" viewBox="0 0 24 24" fill="currentColor"
            className={`text-white/70 ${isRefreshing ? "animate-spin" : ""}`}
          >
            <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
          </svg>
        </button>

        {/* Settings toggle — click again to go back */}
        <button
          onClick={() => location === "/settings" ? window.history.back() : navigate("/settings")}
          className="flex items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 text-sm font-semibold hover:bg-[#282828] transition-colors"
          title={location === "/settings" ? "Close Settings" : "Settings"}
        >
          <span className={`h-2 w-2 rounded-full flex-shrink-0 ${isConnected ? "bg-[#1db954]" : "bg-red-500"}`} />
          <svg height="16" width="16" viewBox="0 0 24 24" fill="currentColor" className="text-white/70">
            <path d="M12 15.5A3.5 3.5 0 0 1 8.5 12 3.5 3.5 0 0 1 12 8.5a3.5 3.5 0 0 1 3.5 3.5 3.5 3.5 0 0 1-3.5 3.5m7.43-2.92c.04-.34.07-.68.07-1.08s-.03-.73-.07-1.08l2.32-1.8c.21-.16.27-.44.14-.67l-2.2-3.81c-.13-.24-.41-.31-.65-.24l-2.74 1.1c-.57-.44-1.18-.81-1.86-1.09l-.42-2.9c-.04-.26-.26-.44-.52-.44H9.5c-.26 0-.48.18-.52.44l-.42 2.9c-.68.28-1.29.65-1.86 1.09l-2.74-1.1c-.24-.07-.52 0-.65.24l-2.2 3.81c-.13.24-.07.52.14.67l2.32 1.8c-.04.35-.07.69-.07 1.08s.03.73.07 1.08L2.25 14.3c-.21.16-.27.44-.14.67l2.2 3.81c.13.24.41.31.65.24l2.74-1.1c.57.44 1.18.81 1.86 1.09l.42 2.9c.04.26.26.44.52.44h4.4c.26 0 .48-.18.52-.44l.42-2.9c.68-.28 1.29-.65 1.86-1.09l2.74 1.1c.24.07.52 0 .65-.24l2.2-3.81c.13-.24.07-.52-.14-.67l-2.32-1.8z" />
          </svg>
          <span className="text-white">Settings</span>
        </button>
      </div>
    </div>
  )
}
