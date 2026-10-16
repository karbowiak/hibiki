import { AmbientArtworkControls } from "./AmbientArtworkControls"
import { useArtworkAppearanceStore } from "../stores/artworkAppearanceStore"
import "../styles/discovery.css"
import { getRecentSearches } from "../lib/recentSearches"
import { useProviderStore } from "../stores/providerStore"
import { useLocation } from "wouter"
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { useShallow } from "zustand/react/shallow"
import {
  useSearchStore,
  useConnectionStore,
  useUIStore,
  useLibraryStore,
} from "../stores"
import { metadataBackends } from "../metadata"
import { clearImageCache } from "../lib/imageCache"
import { ThemeToggle } from "./ThemeToggle"
import { MusicLibraryPicker } from "./MusicLibraryPicker"
import { ActivityIndicator } from "./ActivityIndicator"
import {
  SearchDropdown,
  buildSearchItems,
  buildSearchLandingItems,
} from "./SearchDropdown"
import { IS_MACOS } from "../lib/platform"
import { NotificationCenter } from "./NotificationCenter"
import { useOfflineStatusStore } from "../offline/statusStore"

export function TopBar() {
  const toolbar = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = toolbar.current
    if (!element) return
    const shell = element.closest<HTMLElement>(".app-artwork-shell") ?? document.documentElement
    const update = () => {
      const height = element.getBoundingClientRect().height
      if (!height) return
      const computed = getComputedStyle(element)
      shell.style.setProperty("--app-toolbar-height", `${height}px`)
      shell.style.setProperty("--app-toolbar-padding-start", computed.paddingTop)
      shell.style.setProperty("--app-toolbar-padding-end", computed.paddingBottom)
    }
    update()
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null
    observer?.observe(element)
    window.addEventListener("resize", update)
    return () => { observer?.disconnect(); window.removeEventListener("resize", update) }
  }, [])
  const backgroundArtworkEnabled = useArtworkAppearanceStore(state => state.backgroundArtworkEnabled)
  const provider = useProviderStore((s) => s.provider)
  const offlineMode = useOfflineStatusStore(s => s.offlineMode)
  const savedReads = useOfflineStatusStore(s => s.savedReads)
  const savedCount = Object.keys(savedReads).length
  const [location, navigate] = useLocation()
  const { search, clear, setQuery, query } = useSearchStore(
    useShallow((s) => ({
      search: s.search,
      clear: s.clear,
      setQuery: s.setQuery,
      query: s.query,
    }))
  )
  const { musicSectionId, isConnected } = useConnectionStore(
    useShallow((s) => ({
      musicSectionId: s.musicSectionId,
      isConnected: s.isConnected,
    }))
  )
  const wsConnected = useLibraryStore((s) => s.wsConnected)
  const { isRefreshing, setIsRefreshing, incrementPageRefreshKey } = useUIStore(
    useShallow((s) => ({
      isRefreshing: s.isRefreshing,
      setIsRefreshing: s.setIsRefreshing,
      incrementPageRefreshKey: s.incrementPageRefreshKey,
    }))
  )
  const { refreshAll, invalidateCache } = useLibraryStore(
    useShallow((s) => ({
      refreshAll: s.refreshAll,
      invalidateCache: s.invalidateCache,
    }))
  )
  const [localQuery, setLocalQuery] = useState(query)
  const [showDropdown, setShowDropdown] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const searchId = useId()
  const results = useSearchStore((s) => s.results)
  const isSearching = useSearchStore((s) => s.isSearching)
  const hubs = useLibraryStore((s) => s.hubs)
  const landingItems = buildSearchLandingItems(
    hubs ?? [],
    showDropdown && !localQuery.trim() ? getRecentSearches() : [],
    !!provider?.capabilities.stations
  )
  const rowCount = !localQuery.trim()
    ? landingItems.length + 1
    : results.length
      ? buildSearchItems(results).length + 1
      : 0
  const inputRef = useRef<HTMLInputElement>(null)
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  function cancelPendingBlur() {
    if (blurTimer.current !== null) clearTimeout(blurTimer.current)
    blurTimer.current = null
  }
  useEffect(() => () => cancelPendingBlur(), [])

  // Debounced search — fires regardless of current route
  useEffect(() => {
    const timer = setTimeout(() => {
      if (localQuery.trim()) {
        const state = useSearchStore.getState()
        if (state.query === localQuery && !state.isSearching) return
        void search(localQuery)
      } else if (!localQuery.trim()) {
        clear()
      }
    }, 350)
    return () => clearTimeout(timer)
  }, [localQuery, musicSectionId, provider])

  // Recent searches and provider changes update the canonical query externally.
  useEffect(() => {
    setLocalQuery(query)
  }, [query])

  // Keep store in sync immediately for showResults logic
  useEffect(() => {
    setQuery(localQuery)
  }, [localQuery])

  // Retire keyboard selection when its suggestion/account context changes.
  useEffect(() => {
    setShowDropdown(false)
    setActiveIndex(-1)
  }, [provider])
  useEffect(() => {
    if (!localQuery.trim()) setActiveIndex(-1)
  }, [hubs])

  // Close dropdown on route change
  useEffect(() => {
    setShowDropdown(false)
    setActiveIndex(-1)
  }, [location])

  // Listen for global hotkey events from useGlobalHotkeys
  useEffect(() => {
    function onSearchFocus() {
      cancelPendingBlur()
      inputRef.current?.focus()
      inputRef.current?.select()
      if (location !== "/search") setShowDropdown(true)
      setActiveIndex(-1)
    }
    function onRefresh() {
      void handleRefresh()
    }
    window.addEventListener("plexify:search-focus", onSearchFocus)
    window.addEventListener("plexify:refresh", onRefresh)
    return () => {
      window.removeEventListener("plexify:search-focus", onSearchFocus)
      window.removeEventListener("plexify:refresh", onRefresh)
    }
  }, [musicSectionId, isRefreshing, location])

  const handleRefresh = async () => {
    if (!musicSectionId || isRefreshing) return
    setIsRefreshing(true)
    try {
      invalidateCache()
      incrementPageRefreshKey()
      // Clear external metadata caches so they re-fetch fresh
      metadataBackends.forEach((b) => b.clearCache?.())
      await Promise.all([clearImageCache(), refreshAll()])
    } finally {
      setIsRefreshing(false)
    }
  }

  const handleInputFocus = () => {
    cancelPendingBlur()
    if (location !== "/search") setShowDropdown(true)
    setActiveIndex(-1)
  }

  const handleInputBlur = () => {
    // Delay so dropdown click events fire before the dropdown closes
    cancelPendingBlur()
    blurTimer.current = setTimeout(() => {
      blurTimer.current = null
      if (document.activeElement !== inputRef.current) setShowDropdown(false)
    }, 150)
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
      setActiveIndex((i) => (rowCount ? (i + 1) % rowCount : -1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActiveIndex((i) => Math.max(-1, i - 1))
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
    setShowDropdown(location !== "/search")
    setActiveIndex(-1)
  }

  return (
    // macOS keeps its 32px traffic-light clearance within the tinted toolbar.
    <div
      ref={toolbar}
      data-tauri-drag-region
      data-shell-transparency={backgroundArtworkEnabled ? "enabled" : undefined}
      data-shell-platform={IS_MACOS ? "mac" : undefined}
      data-app-toolbar
      className="app-topbar shell-artwork-surface shell-artwork-toolbar flex flex-row flex-wrap items-center"
      style={{ paddingInline: "var(--spacing-topbar)" }}
    >
      <div
        data-tauri-drag-region
        className="topbar-navigation flex min-w-0 flex-[1_1_18rem] flex-row items-center gap-2"
      >
        {/* Back button */}
        <button
          onClick={() => window.history.back()}
          aria-label="Go back"
          className="topbar-control topbar-icon-control shell-control-secondary rounded-full bg-app-surface transition-colors hover:bg-app-surface-hover"
        >
          <svg
            role="img"
            height="16"
            width="16"
            className="fill-[var(--text-primary)]"
            viewBox="0 0 16 16"
          >
            <path d="M11.03.47a.75.75 0 0 1 0 1.06L4.56 8l6.47 6.47a.75.75 0 1 1-1.06 1.06L2.44 8 9.97.47a.75.75 0 0 1 1.06 0z" />
          </svg>
        </button>

        {/* Forward button */}
        <button
          onClick={() => window.history.forward()}
          aria-label="Go forward"
          className="topbar-control topbar-icon-control shell-control-secondary rounded-full bg-app-surface transition-colors hover:bg-app-surface-hover"
        >
          <svg
            role="img"
            height="16"
            width="16"
            className="fill-[var(--text-primary)]"
            viewBox="0 0 16 16"
          >
            <path d="M4.97.47a.75.75 0 0 0 0 1.06L11.44 8l-6.47 6.47a.75.75 0 1 0 1.06 1.06L13.56 8 6.03.47a.75.75 0 0 0-1.06 0z" />
          </svg>
        </button>

        {/* Search input — always visible, wired to store */}
        <div className="relative w-[364px] min-w-0 max-w-full shrink text-sm text-[var(--text-primary)]">
          <svg
            height="16"
            width="16"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 fill-[var(--text-secondary)]"
            viewBox="0 0 24 24"
          >
            <path d="M10.533 1.279c-5.18 0-9.407 4.14-9.407 9.279s4.226 9.279 9.407 9.279c2.234 0 4.29-.77 5.907-2.058l4.353 4.353a1 1 0 1 0 1.414-1.414l-4.344-4.344a9.157 9.157 0 0 0 2.077-5.816c0-5.14-4.226-9.28-9.407-9.28zm-7.407 9.279c0-4.006 3.302-7.28 7.407-7.28s7.407 3.274 7.407 7.28-3.302 7.279-7.407 7.279-7.407-3.273-7.407-7.28z" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            aria-label="Search your music library"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={showDropdown}
            aria-controls={showDropdown ? searchId : undefined}
            aria-activedescendant={
              showDropdown && activeIndex >= 0 && activeIndex < rowCount
                ? `${searchId}-option-${activeIndex}`
                : undefined
            }
            aria-busy={isSearching}
            data-library-search="true"
            value={localQuery}
            onChange={(e) => handleQueryChange(e.target.value)}
            onFocus={handleInputFocus}
            onBlur={handleInputBlur}
            onKeyDown={handleInputKeyDown}
            placeholder="What do you want to listen to?"
            className="topbar-search discovery-search-input w-full min-w-0 rounded-full pl-10 pr-9 focus:outline-none"
          />
          {localQuery && (
            <button
              type="button"
              aria-label="Clear search"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setLocalQuery("")
                clear()
                setActiveIndex(-1)
                inputRef.current?.focus()
                setShowDropdown(false)
              }}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              <svg
                height="12"
                width="12"
                viewBox="0 0 16 16"
                fill="currentColor"
              >
                <path d="M2.47 2.47a.75.75 0 0 1 1.06 0L8 6.94l4.47-4.47a.75.75 0 1 1 1.06 1.06L9.06 8l4.47 4.47a.75.75 0 1 1-1.06 1.06L8 9.06l-4.47 4.47a.75.75 0 0 1-1.06-1.06L6.94 8 2.47 3.53a.75.75 0 0 1 0-1.06z" />
              </svg>
            </button>
          )}
          {showDropdown && (
            <SearchDropdown
              landingItems={landingItems}
              id={searchId}
              activeIndex={activeIndex}
              onActiveIndexChange={setActiveIndex}
              onClose={() => setShowDropdown(false)}
            />
          )}
        </div>
      </div>

      <div className="topbar-actions ml-auto flex shrink-0 items-center gap-2">
        <MusicLibraryPicker />
        {(offlineMode || savedCount > 0) && <button type="button" className="topbar-control shell-control-secondary rounded-full px-3 text-xs" onClick={() => navigate("/settings")} title="Previously saved pages; open connection settings">
          {offlineMode ? "Saved library" : "Saved copy"}
        </button>}
        <AmbientArtworkControls />
        {/* Activity indicator — always visible, animates when busy */}
        <ActivityIndicator />

        {/* Refresh button */}
        <button
          onClick={() => void handleRefresh()}
          disabled={isRefreshing || !isConnected}
          title="Refresh library (⌘R)"
          className="topbar-control topbar-icon-control shell-control-secondary flex items-center justify-center rounded-full bg-app-surface transition-colors hover:bg-app-surface-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          <svg
            height="15"
            width="15"
            viewBox="0 0 24 24"
            fill="currentColor"
            className={`text-[color:var(--text-secondary)] ${isRefreshing ? "animate-spin" : ""}`}
          >
            <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
          </svg>
        </button>

        <NotificationCenter />
        <ThemeToggle />
        {/* Settings toggle — click again to go back */}
        <button
          onClick={() =>
            location.startsWith("/settings")
              ? window.history.back()
              : navigate("/settings")
          }
          aria-pressed={location.startsWith("/settings")}
          aria-label={location.startsWith("/settings") ? "Close Settings" : "Settings"}
          className={`topbar-control topbar-settings shell-control-secondary flex items-center gap-2 rounded-full px-3 text-sm font-semibold transition-colors ${
            location.startsWith("/settings")
              ? "border border-accent/30 bg-accent/15 hover:bg-accent/25"
              : "bg-app-surface hover:bg-app-surface-hover"
          }`}
          title={
            location.startsWith("/settings") ? "Close Settings" : "Settings"
          }
        >
          <span
            className={`h-2 w-2 flex-shrink-0 rounded-full ${
              !isConnected
                ? "bg-red-500"
                : wsConnected
                  ? "bg-green-500"
                  : "bg-amber-500"
            }`}
          />
          <svg
            height="16"
            width="16"
            viewBox="0 0 24 24"
            fill="currentColor"
            className={
              location.startsWith("/settings")
                ? "text-accent"
                : "text-[color:var(--text-secondary)]"
            }
          >
            <path d="M12 15.5A3.5 3.5 0 0 1 8.5 12 3.5 3.5 0 0 1 12 8.5a3.5 3.5 0 0 1 3.5 3.5 3.5 3.5 0 0 1-3.5 3.5m7.43-2.92c.04-.34.07-.68.07-1.08s-.03-.73-.07-1.08l2.32-1.8c.21-.16.27-.44.14-.67l-2.2-3.81c-.13-.24-.41-.31-.65-.24l-2.74 1.1c-.57-.44-1.18-.81-1.86-1.09l-.42-2.9c-.04-.26-.26-.44-.52-.44H9.5c-.26 0-.48.18-.52.44l-.42 2.9c-.68.28-1.29.65-1.86 1.09l-2.74-1.1c-.24-.07-.52 0-.65.24l-2.2 3.81c-.13.24-.07.52.14.67l2.32 1.8c-.04.35-.07.69-.07 1.08s.03.73.07 1.08L2.25 14.3c-.21.16-.27.44-.14.67l2.2 3.81c.13.24.41.31.65.24l2.74-1.1c.57.44 1.18.81 1.86 1.09l.42 2.9c.04.26.26.44.52.44h4.4c.26 0 .48-.18.52-.44l.42-2.9c.68-.28 1.29-.65 1.86-1.09l2.74 1.1c.24.07.52 0 .65-.24l2.2-3.81c.13-.24.07-.52-.14-.67l-2.32-1.8z" />
          </svg>
          <span
            className={`topbar-settings-label ${
              location.startsWith("/settings")
                ? "text-accent"
                : "text-[color:var(--text-primary)]"
            }`}
          >
            Settings
          </span>
        </button>
      </div>
    </div>
  )
}
