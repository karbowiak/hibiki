import { useEffect } from "react"
import { useLocation } from "wouter"
import { useSearchStore, useConnectionStore, buildPlexImageUrl } from "../stores"
import { usePlayerStore } from "../stores/playerStore"
import type { PlexMedia } from "../types/plex"

interface Props {
  activeIndex: number
  onActiveIndexChange: (index: number) => void
  onClose: () => void
}

type DropdownItem =
  | { kind: "artist"; item: PlexMedia & { type: "artist" }; href: string }
  | { kind: "album"; item: PlexMedia & { type: "album" }; href: string }
  | { kind: "track"; item: PlexMedia & { type: "track" } }

function buildItems(results: PlexMedia[]): DropdownItem[] {
  const artists: DropdownItem[] = []
  const albums: DropdownItem[] = []
  const tracks: DropdownItem[] = []

  for (const item of results) {
    if (item.type === "artist" && artists.length < 3) {
      artists.push({ kind: "artist", item: item as PlexMedia & { type: "artist" }, href: `/artist/${item.rating_key}` })
    } else if (item.type === "album" && albums.length < 3) {
      albums.push({ kind: "album", item: item as PlexMedia & { type: "album" }, href: `/album/${item.rating_key}` })
    } else if (item.type === "track" && tracks.length < 3) {
      tracks.push({ kind: "track", item: item as PlexMedia & { type: "track" } })
    }
  }

  return [...artists, ...albums, ...tracks]
}

export function SearchDropdown({ activeIndex, onActiveIndexChange, onClose }: Props) {
  const [, navigate] = useLocation()
  const { results, query } = useSearchStore()
  const { baseUrl, token } = useConnectionStore()
  const playTrack = usePlayerStore(s => s.playTrack)

  const items = buildItems(results)
  const totalRows = items.length + 1 // +1 for "See all results"

  // Keep activeIndex clamped to valid range
  useEffect(() => {
    if (activeIndex >= totalRows) {
      onActiveIndexChange(0)
    }
  }, [activeIndex, totalRows])

  const activateItem = (index: number) => {
    if (index < 0 || index >= items.length) {
      // "See all results" row
      navigate("/search")
      onClose()
      return
    }
    const row = items[index]
    if (row.kind === "track") {
      void playTrack(row.item as never)
      onClose()
    } else {
      navigate(row.href)
      onClose()
    }
  }

  // Allow the parent's Enter key handler to activate the currently highlighted item
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Enter" && activeIndex >= 0) {
        e.preventDefault()
        activateItem(activeIndex)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [activeIndex, items])

  if (results.length === 0) return null

  return (
    <div className="absolute top-full left-0 z-50 mt-1 w-[420px] rounded-xl bg-app-surface shadow-2xl overflow-hidden">
      {items.map((row, idx) => {
        const isActive = idx === activeIndex
        if (row.kind === "artist") {
          const thumb = row.item.thumb
            ? buildPlexImageUrl(baseUrl, token, row.item.thumb)
            : null
          return (
            <div
              key={row.item.rating_key}
              className={`flex items-center gap-3 px-3 py-2 cursor-pointer ${isActive ? "bg-white/10" : "hover:bg-white/5"}`}
              onMouseEnter={() => onActiveIndexChange(idx)}
              onMouseDown={e => e.preventDefault()}
              onClick={() => activateItem(idx)}
            >
              {thumb ? (
                <img src={thumb} alt="" className="h-9 w-9 rounded-full object-cover flex-shrink-0" />
              ) : (
                <div className="h-9 w-9 rounded-full bg-white/10 flex-shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-white">{row.item.title}</div>
              </div>
              <span className="text-xs text-white/40 flex-shrink-0">Artist</span>
            </div>
          )
        }

        if (row.kind === "album") {
          const thumb = row.item.thumb
            ? buildPlexImageUrl(baseUrl, token, row.item.thumb)
            : null
          return (
            <div
              key={row.item.rating_key}
              className={`flex items-center gap-3 px-3 py-2 cursor-pointer ${isActive ? "bg-white/10" : "hover:bg-white/5"}`}
              onMouseEnter={() => onActiveIndexChange(idx)}
              onMouseDown={e => e.preventDefault()}
              onClick={() => activateItem(idx)}
            >
              {thumb ? (
                <img src={thumb} alt="" className="h-9 w-9 rounded object-cover flex-shrink-0" />
              ) : (
                <div className="h-9 w-9 rounded bg-white/10 flex-shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-white">{row.item.title}</div>
                <div className="truncate text-xs text-white/50">{row.item.parent_title}</div>
              </div>
              <span className="text-xs text-white/40 flex-shrink-0">Album</span>
            </div>
          )
        }

        // track
        const trackThumb = row.item.thumb || row.item.parent_thumb
        const thumb = trackThumb
          ? buildPlexImageUrl(baseUrl, token, trackThumb)
          : null
        return (
          <div
            key={row.item.rating_key}
            className={`flex items-center gap-3 px-3 py-2 cursor-pointer ${isActive ? "bg-white/10" : "hover:bg-white/5"}`}
            onMouseEnter={() => onActiveIndexChange(idx)}
            onMouseDown={e => e.preventDefault()}
            onClick={() => activateItem(idx)}
          >
            {thumb ? (
              <img src={thumb} alt="" className="h-9 w-9 rounded object-cover flex-shrink-0" />
            ) : (
              <div className="h-9 w-9 rounded bg-white/10 flex-shrink-0" />
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-white">{row.item.title}</div>
              <div className="truncate text-xs text-white/50">
                {row.item.grandparent_title} · {row.item.parent_title}
              </div>
            </div>
            <span className="text-xs text-white/40 flex-shrink-0">Track</span>
          </div>
        )
      })}

      {/* See all results row */}
      <div
        className={`flex items-center gap-2 px-3 py-2.5 cursor-pointer border-t border-white/10 ${activeIndex === items.length ? "bg-white/10" : "hover:bg-white/5"}`}
        onMouseEnter={() => onActiveIndexChange(items.length)}
        onMouseDown={e => e.preventDefault()}
        onClick={() => { navigate("/search"); onClose() }}
      >
        <svg height="14" width="14" viewBox="0 0 24 24" fill="currentColor" className="text-white/50 flex-shrink-0">
          <path d="M10.533 1.279c-5.18 0-9.407 4.14-9.407 9.279s4.226 9.279 9.407 9.279c2.234 0 4.29-.77 5.907-2.058l4.353 4.353a1 1 0 1 0 1.414-1.414l-4.344-4.344a9.157 9.157 0 0 0 2.077-5.816c0-5.14-4.226-9.28-9.407-9.28zm-7.407 9.279c0-4.006 3.302-7.28 7.407-7.28s7.407 3.274 7.407 7.28-3.302 7.279-7.407 7.279-7.407-3.273-7.407-7.28z" />
        </svg>
        <span className="text-sm text-white/70">
          See all results for <span className="font-semibold text-white">"{query}"</span>
        </span>
      </div>
    </div>
  )
}
