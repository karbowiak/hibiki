import { ArtworkImage } from "./shared/ArtworkImage"
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { useLocation } from "wouter"
import { useShallow } from "zustand/react/shallow"
import { useSearchStore } from "../stores"
import { usePlayerStore } from "../stores/playerStore"
import type {
  MusicItem,
  MusicTrack,
  MusicAlbum,
  MusicArtist,
} from "../types/music"

interface Props {
  id?: string
  activeIndex: number
  onActiveIndexChange: (index: number) => void
  onClose: () => void
}

type DropdownItem =
  | { kind: "artist"; item: MusicArtist & { type: "artist" }; href: string }
  | { kind: "album"; item: MusicAlbum & { type: "album" }; href: string }
  | { kind: "track"; item: MusicTrack & { type: "track" } }

export function buildSearchItems(results: MusicItem[]): DropdownItem[] {
  const artists: DropdownItem[] = []
  const albums: DropdownItem[] = []
  const tracks: DropdownItem[] = []

  for (const item of results) {
    if (item.type === "artist" && artists.length < 3) {
      artists.push({
        kind: "artist",
        item: item as MusicArtist & { type: "artist" },
        href: `/artist/${item.id}`,
      })
    } else if (item.type === "album" && albums.length < 3) {
      albums.push({
        kind: "album",
        item: item as MusicAlbum & { type: "album" },
        href: `/album/${item.id}`,
      })
    } else if (item.type === "track" && tracks.length < 3) {
      tracks.push({
        kind: "track",
        item: item as MusicTrack & { type: "track" },
      })
    }
  }

  return [...artists, ...albums, ...tracks]
}

export function SearchDropdown({
  id: suppliedId,
  activeIndex,
  onActiveIndexChange,
  onClose,
}: Props) {
  const generatedId = useId()
  const id = suppliedId ?? generatedId
  const [, navigate] = useLocation()
  const { results, query, error, isSearching, search } = useSearchStore(
    useShallow((s) => ({
      results: s.results,
      query: s.query,
      error: s.error,
      isSearching: s.isSearching,
      search: s.search,
    }))
  )
  const playTrack = usePlayerStore((s) => s.playTrack)

  const items = buildSearchItems(results)
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
      void playTrack(row.item as MusicTrack)
      onClose()
    } else {
      navigate(row.href)
      onClose()
    }
  }

  // Allow the parent's Enter key handler to activate the currently highlighted item
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as Element | null
      if (target?.getAttribute?.("data-library-search") !== "true") return
      if (e.key === "Enter" && activeIndex >= 0) {
        e.preventDefault()
        activateItem(activeIndex)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [activeIndex, items])

  const popupRef = useRef<HTMLDivElement>(null)
  const [maxHeight, setMaxHeight] = useState(360)
  useLayoutEffect(() => {
    const update = () => {
      const top = popupRef.current?.getBoundingClientRect().top ?? 80
      setMaxHeight(Math.max(48, window.innerHeight - top - 12))
    }
    update()
    window.addEventListener("resize", update)
    window.addEventListener("scroll", update, true)
    return () => {
      window.removeEventListener("resize", update)
      window.removeEventListener("scroll", update, true)
    }
  }, [])
  useLayoutEffect(() => {
    const popup = popupRef.current
    const option = popup?.querySelector<HTMLElement>(
      `[data-search-index="${activeIndex}"]`
    )
    if (!popup || !option) return
    const footer = popup.querySelector<HTMLElement>("[data-search-footer]")
    if (footer?.contains(option)) return
    const bounds = popup.getBoundingClientRect()
    const visibleBottom = Math.min(
      bounds.bottom,
      footer?.getBoundingClientRect().top ?? bounds.bottom
    )
    const row = option.getBoundingClientRect()
    if (row.top < bounds.top) popup.scrollTop -= bounds.top - row.top
    else if (row.bottom > visibleBottom)
      popup.scrollTop += row.bottom - visibleBottom
  }, [activeIndex, results])

  if (!query.trim()) return null
  return (
    <div
      ref={popupRef}
      id={id}
      role="listbox"
      aria-label="Music search results"
      aria-busy={isSearching}
      onKeyDown={(event) => event.stopPropagation()}
      style={{ maxHeight: Math.min(480, maxHeight) }}
      className="absolute left-0 top-full z-50 mt-2 w-full max-w-[calc(100vw-24px)] overflow-y-auto overscroll-contain rounded-xl border border-[var(--border)] bg-app-card py-1 text-white shadow-2xl"
    >
      {isSearching && (
        <p role="status" className="px-3 py-3 text-sm text-white/60">
          Searching…
        </p>
      )}
      {results.length === 0 ? (
        error ? (
          <div role="alert" className="p-3 text-sm text-red-400">
            <p>Search failed: {error}</p>
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void search(query)}
              className="mt-2 rounded-md bg-app-surface px-3 py-2 text-white"
            >
              Try again
            </button>
          </div>
        ) : (
          !isSearching && (
            <p role="status" className="px-3 py-3 text-sm text-white/60">
              No results for “{query}”.
            </p>
          )
        )
      ) : (
        <>
          {(["artist", "album", "track"] as const).map((kind) => {
            const rows = items
              .map((row, index) => ({ row, index }))
              .filter(({ row }) => row.kind === kind)
            if (!rows.length) return null
            const label =
              kind === "artist"
                ? "Artists"
                : kind === "album"
                  ? "Albums"
                  : "Tracks"
            return (
              <div
                key={kind}
                role="group"
                aria-label={label}
                className="border-b border-[var(--border)] pb-1 last:border-b-0"
              >
                <div
                  aria-hidden="true"
                  className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-white/50"
                >
                  {label}
                </div>
                {rows.map(({ row, index }) => (
                  <div
                    key={`${kind}:${row.item.id}`}
                    id={`${id}-option-${index}`}
                    role="option"
                    aria-selected={index === activeIndex}
                    data-search-index={index}
                    className={`flex cursor-pointer items-center gap-3 px-3 py-2 ${index === activeIndex ? "bg-hl-menu" : "hover:bg-hl-menu"}`}
                    onMouseEnter={() => onActiveIndexChange(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => activateItem(index)}
                  >
                    {row.item.thumbUrl ? (
                      <ArtworkImage
                        loading="eager"
                        src={row.item.thumbUrl}
                        alt=""
                        className="h-9 w-9 shrink-0 rounded-md object-cover"
                      />
                    ) : (
                      <div className="h-9 w-9 shrink-0 rounded-md bg-app-surface" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">
                        {row.item.title}
                      </div>
                      {row.kind !== "artist" && (
                        <div className="truncate text-xs text-white/60">
                          {row.item.artistName}
                          {row.kind === "track" && row.item.albumName
                            ? ` · ${row.item.albumName}`
                            : ""}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )
          })}
          <div
            data-search-footer
            className="sticky bottom-0 z-10 border-t border-[var(--border)] bg-app-card"
          >
            <div
              id={`${id}-option-${items.length}`}
              role="option"
              aria-selected={activeIndex === items.length}
              data-search-index={items.length}
              onMouseEnter={() => onActiveIndexChange(items.length)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => activateItem(items.length)}
              className={`cursor-pointer px-3 py-3 text-sm ${activeIndex === items.length ? "bg-hl-menu" : "hover:bg-hl-menu"}`}
            >
              See all results for{" "}
              <span className="font-semibold">“{query}”</span>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
