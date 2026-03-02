import { useEffect, useRef, useState } from "react"
import { useShallow } from "zustand/react/shallow"
import { useLibraryStore } from "../stores"

interface Activity {
  id: string
  label: string
}

export function ActivityIndicator() {
  const { prefetchStatus, isLoading, isFetchingMore } = useLibraryStore(useShallow(s => ({
    prefetchStatus: s.prefetchStatus,
    isLoading: s.isLoading,
    isFetchingMore: s.isFetchingMore,
  })))
  const [isOpen, setIsOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  const activities: Activity[] = []

  if (prefetchStatus) {
    activities.push({
      id: "prefetch",
      label: `Caching playlists – ${prefetchStatus.done} of ${prefetchStatus.total}`,
    })
  }
  if (isLoading) {
    activities.push({ id: "playlist-load", label: "Loading playlist…" })
  }
  if (isFetchingMore) {
    activities.push({ id: "load-more", label: "Loading more tracks…" })
  }

  const isActive = activities.length > 0

  // Close panel when clicking outside.
  useEffect(() => {
    if (!isOpen) return
    function onPointerDown(e: PointerEvent) {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false)
      }
    }
    document.addEventListener("pointerdown", onPointerDown)
    return () => document.removeEventListener("pointerdown", onPointerDown)
  }, [isOpen])

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={() => setIsOpen(o => !o)}
        title={isActive ? `${activities.length} active operation${activities.length > 1 ? "s" : ""}` : "No active operations"}
        className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
          isOpen ? "bg-white/15" : "bg-app-surface hover:bg-app-surface-hover"
        }`}
      >
        {/* Vinyl-disc icon — spins when active */}
        <svg
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="currentColor"
          className={`transition-colors ${
            isActive
              ? "text-white animate-spin"
              : "text-white/40"
          }`}
          style={isActive ? { animationDuration: "2s" } : undefined}
        >
          {/* Outer ring */}
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm0 2a8 8 0 1 1 0 16A8 8 0 0 1 12 4zm0 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm0 1.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z"
          />
        </svg>
      </button>

      {/* Activity panel */}
      {isOpen && (
        <div
          ref={panelRef}
          className="absolute right-0 top-10 z-50 w-72 rounded-lg bg-app-surface shadow-2xl border border-white/10 overflow-hidden"
        >
          <div className="px-4 py-3 border-b border-white/10">
            <span className="text-xs font-semibold uppercase tracking-wider text-white/50">
              Activity
            </span>
          </div>

          {activities.length === 0 ? (
            <div className="px-4 py-4 text-sm text-white/40">
              No active operations.
            </div>
          ) : (
            <ul className="divide-y divide-white/5">
              {activities.map(a => (
                <li key={a.id} className="flex items-center gap-3 px-4 py-3">
                  <svg
                    className="h-3.5 w-3.5 flex-shrink-0 text-accent animate-spin"
                    viewBox="0 0 24 24"
                    fill="none"
                    style={{ animationDuration: "1s" }}
                  >
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                  <span className="text-sm text-white/80">{a.label}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
