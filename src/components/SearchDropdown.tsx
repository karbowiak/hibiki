import { deduplicateAlbumItems } from "../lib/dedup"
import { useUIStore } from "../stores/uiStore"
import "../styles/discovery.css"
import { useArtistImage, useAlbumImage } from "../hooks/useMediaImage"
import { ArtworkImage, useArtworkFailures } from "./shared/ArtworkImage"
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
  MusicHub,
} from "../types/music"

interface Props {
  id?: string
  activeIndex: number
  onActiveIndexChange: (index: number) => void
  onClose: () => void
  landingItems?: SearchLandingItem[]
}

export interface SearchLandingItem {
  kind: "action" | "recent" | "music"
  title: string
  description: string
  href?: string
  query?: string
  item?: MusicItem
}
export function buildSearchLandingItems(
  hubs: MusicHub[],
  recent: string[],
  stations: boolean
): SearchLandingItem[] {
  const actions: SearchLandingItem[] = [
    {
      kind: "action",
      title: "Your Library",
      description: "Browse your music",
      href: "/library",
    },
    {
      kind: "action",
      title: "Liked Songs",
      description: "Return to your favorites",
      href: "/collection/tracks",
    },
    {
      kind: "action",
      title: "Playlists",
      description: "Find the right collection",
      href: "/collection/playlists",
    },
  ]
  if (stations)
    actions.push({
      kind: "action",
      title: "Stations",
      description: "Find a new direction",
      href: "/stations",
    })
  const history = [...new Set(recent)]
    .filter((q) => q.trim())
    .slice(0, 4)
    .map((query) => ({
      kind: "recent" as const,
      title: query,
      description: "Recent search",
      query,
    }))
  const seen = new Set<string>(),
    music: SearchLandingItem[] = []
  for (const item of hubs
    .filter(
      (h) =>
        h.identifier === "music.recent.played" ||
        h.identifier?.startsWith("music.recent.played.")
    )
    .flatMap((h) => h.items)) {
    if (
      !["artist", "album", "track"].includes(item.type) ||
      seen.has(`${item.type}:${item.id}`)
    )
      continue
    seen.add(`${item.type}:${item.id}`)
    music.push({
      kind: "music",
      title: item.title,
      description:
        item.type === "artist"
          ? "Artist"
          : "artistName" in item
            ? item.artistName
            : "",
      item,
      href:
        item.type === "artist" || item.type === "album"
          ? `/${item.type}/${item.id}`
          : undefined,
    })
    if (music.length === 3) break
  }
  return [...actions, ...history, ...music]
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

function SearchArtwork({ item }: { item: MusicItem }) {
  const { failures, onFailure } = useArtworkFailures(
    JSON.stringify([item.type, item.id, item.thumbUrl])
  )
  const artist = useArtistImage(
    item.type === "artist" ? item.title : null,
    item.type === "artist" ? item.thumbUrl : null,
    item.id,
    failures
  )
  const album = useAlbumImage(
    item.type === "album" || item.type === "track" ? item.artistName : null,
    item.type === "album"
      ? item.title
      : item.type === "track"
        ? item.albumName
        : null,
    item.type === "album" || item.type === "track" ? item.thumbUrl : null,
    item.id,
    failures
  )
  const src = item.type === "artist" ? artist : album
  return src ? (
    <ArtworkImage
      src={src}
      alt=""
      loading="eager"
      onFailure={onFailure}
      className="h-10 w-10 shrink-0 rounded-md object-cover"
    />
  ) : (
    <div className="h-10 w-10 shrink-0 rounded-md bg-app-surface" />
  )
}

export function SearchDropdown({
  id: suppliedId,
  activeIndex,
  onActiveIndexChange,
  onClose,
  landingItems = [],
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

  const shouldDeduplicate=useUIStore(s=>s.deduplicateAlbums)
  const items = buildSearchItems(shouldDeduplicate ? deduplicateAlbumItems(results) : results)
  const emptyQuery = !query.trim()
  const totalRows = (emptyQuery ? landingItems.length : items.length) + 1 // +1 for "See all results"

  // Keep activeIndex clamped to valid range
  useEffect(() => {
    if (activeIndex >= totalRows) {
      onActiveIndexChange(0)
    }
  }, [activeIndex, totalRows])

  const activateItem = (index: number) => {
    if (emptyQuery) {
      const row = landingItems[index]
      if (row?.query) {
        void search(row.query)
        navigate("/search")
      } else if (row?.item?.type === "track") void playTrack(row.item)
      else navigate(row?.href ?? "/search")
      onClose()
      return
    }
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
  }, [activeIndex, items, landingItems, emptyQuery])

  const popupRef = useRef<HTMLDivElement>(null)
  const [maxHeight, setMaxHeight] = useState(360)
  const [panelWidth, setPanelWidth] = useState<number>()
  useLayoutEffect(() => {
    const update = () => {
      const bounds = popupRef.current?.getBoundingClientRect()
      const top = bounds?.top ?? 80
      const left = bounds?.left ?? 0
      const bottom = popupRef.current?.closest(".app-page")?.getBoundingClientRect().bottom ?? window.innerHeight
      setPanelWidth(Math.max(48, Math.min(560, window.innerWidth - left - 12)))
      setMaxHeight(Math.max(48, Math.min(window.innerHeight, bottom) - top - 12))
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

  return (
    <div
      ref={popupRef}
      id={id}
      role="listbox"
      aria-label={emptyQuery ? "Search suggestions" : "Music search results"}
      aria-busy={isSearching}
      onKeyDown={(event) => event.stopPropagation()}
      style={{ maxHeight: Math.min(480, maxHeight), width: panelWidth }}
      className="discovery-search-popup absolute left-0 top-full z-50 mt-2 w-full max-w-[calc(100vw-24px)] overflow-y-auto overscroll-contain rounded-xl border border-[var(--border)] bg-app-card py-1 text-[var(--text-primary)] shadow-2xl"
    >
      <div className="discovery-search-caption">
        {emptyQuery ? "A shortcut to your music" : "Search your library"}
      </div>
      {emptyQuery ? (
        <>
          {(["action", "recent", "music"] as const).map((kind) => {
            const rows = landingItems
              .map((row, index) => ({ row, index }))
              .filter(({ row }) => row.kind === kind)
            if (!rows.length) return null
            return (
              <div
                role="group"
                aria-label={
                  kind === "action"
                    ? "Quick actions"
                    : kind === "recent"
                      ? "Recent searches"
                      : "Jump back in"
                }
                key={kind}
              >
                <div aria-hidden="true" className="discovery-search-caption">
                  {kind === "action"
                    ? "Quick actions"
                    : kind === "recent"
                      ? "Recent searches"
                      : "Jump back in"}
                </div>
                {rows.map(({ row, index }) => (
                  <div
                    key={`${kind}:${row.title}:${index}`}
                    id={`${id}-option-${index}`}
                    role="option"
                    aria-selected={activeIndex === index}
                    data-search-index={index}
                    onMouseEnter={() => onActiveIndexChange(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => activateItem(index)}
                    className={`flex cursor-pointer items-center gap-3 px-4 py-2.5 ${activeIndex === index ? "bg-hl-menu" : "hover:bg-hl-menu"}`}
                  >
                    {row.item ? (
                      <SearchArtwork item={row.item} />
                    ) : (
                      <span
                        aria-hidden="true"
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-app-surface text-[var(--text-muted)]"
                      >
                        {kind === "recent" ? "↶" : "↗"}
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {row.title}
                      </span>
                      <span className="block truncate text-xs text-[var(--text-secondary)]">
                        {row.description}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            )
          })}
          <div
            data-search-footer
            className="sticky bottom-0 border-t border-[var(--border)] bg-app-card"
          >
            <div
              role="option"
              id={`${id}-option-${landingItems.length}`}
              aria-selected={activeIndex === landingItems.length}
              data-search-index={landingItems.length}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => onActiveIndexChange(landingItems.length)}
              onClick={() => activateItem(landingItems.length)}
              className={`cursor-pointer px-4 py-3 text-sm ${activeIndex === landingItems.length ? "bg-hl-menu" : "hover:bg-hl-menu"}`}
            >
              Explore search and suggestions <span aria-hidden="true">↗</span>
            </div>
          </div>
        </>
      ) : (
        <>
          {isSearching && (
            <p
              role="status"
              className="px-3 py-3 text-sm text-[var(--text-secondary)]"
            >
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
                  className="mt-2 rounded-md bg-app-surface px-3 py-2 text-[var(--text-primary)]"
                >
                  Try again
                </button>
              </div>
            ) : (
              !isSearching && (
                <p
                  role="status"
                  className="px-3 py-3 text-sm text-[var(--text-secondary)]"
                >
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
                      className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]"
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
                        <SearchArtwork item={row.item} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">
                            {row.item.title}
                          </div>
                          {row.kind !== "artist" && (
                            <div className="truncate text-xs text-[var(--text-secondary)]">
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
        </>
      )}
      <div className="discovery-search-hints" aria-hidden="true">
        <span>
          <kbd>↑ ↓</kbd> move
        </span>
        <span>
          <kbd>Enter</kbd> open
        </span>
        <span>
          <kbd>Esc</kbd> close
        </span>
      </div>
    </div>
  )
}
