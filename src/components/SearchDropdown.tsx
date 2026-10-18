import { DropdownSurface } from "./shared/DropdownSurface"
import { Button } from "./shared/Button"
import { ArtistCredits } from "./shared/ArtistCredits"
import { MusicEntityLink } from "./shared/MusicEntityLink"
import { trackEntity } from "../lib/musicLinks"
import { presentSearchSuggestions, searchItemKey } from "../lib/searchSuggestions"
import { searchPlaylistHref } from "../lib/searchPlaylists"
import "../styles/discovery.css"
import { useArtistImage, useAlbumImage } from "../hooks/useMediaImage"
import { ArtworkImage, useArtworkFailures } from "./shared/ArtworkImage"
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { useLocation } from "wouter"
import { useShallow } from "zustand/react/shallow"
import { useSearchStore } from "../stores"
import { usePlayerStore } from "../stores/playerStore"
import { MusicSourceBadge } from "./shared/MusicSource"
import { YoutubeMusicLikeButton } from "./shared/YoutubeMusicLikeButton"
import type {
  MusicItem,
  MusicTrack,
  MusicAlbum,
  MusicArtist,
  MusicHub,
  MusicPlaylist,
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
  | { kind: "playlist"; item: MusicPlaylist & { type: "playlist" }; href: string }

export function buildSearchItems(results: MusicItem[], presented = false): DropdownItem[] {
  return (presented ? results : presentSearchSuggestions(results)).flatMap((item): DropdownItem[] => {
    const href = item.providerKey === "ytmusic" ? `/ytmusic/${encodeURIComponent(item.id.slice(8))}` : `/${item.type}/${item.id}`
    if (item.type === "artist") return [{ kind: "artist", item, href }]
    if (item.type === "album") return [{ kind: "album", item, href }]
    if (item.type === "playlist") return [{ kind: "playlist", item, href: searchPlaylistHref(item) }]
    return item.type === "track" ? [{ kind: "track", item }] : []
  })
}

function SearchArtwork({ item }: { item: MusicItem }) {
  const remote = item.providerKey === "ytmusic"
  const { failures, onFailure } = useArtworkFailures(
    JSON.stringify([item.type, item.id, item.thumbUrl])
  )
  const artist = useArtistImage(
    !remote && item.type === "artist" ? item.title : null,
    item.type === "artist" ? item.thumbUrl : null,
    item.id,
    failures
  )
  const album = useAlbumImage(
    !remote && (item.type === "album" || item.type === "track") ? item.artistName : null,
    item.type === "album"
      ? item.title
      : item.type === "track"
        ? item.albumName
        : null,
    item.type === "album" || item.type === "track" ? item.thumbUrl : null,
    item.id,
    failures
  )
  const src = remote || item.type === "playlist" ? item.thumbUrl : item.type === "artist" ? artist : album
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
  const { results, suggestions, context, query, error, isSearching, search } = useSearchStore(
    useShallow((s) => ({
      results: s.results,
      suggestions: s.suggestions,
      context: s.context,
      query: s.query,
      error: s.error,
      isSearching: s.isSearching,
      search: s.search,
    }))
  )
  const playTrack = usePlayerStore((s) => s.playTrack)

  const items = buildSearchItems(suggestions ?? results, !!suggestions)
  const emptyQuery = !query.trim()
  const count = emptyQuery ? landingItems.length : items.length
  const keys = emptyQuery ? landingItems.map(row => `${row.kind}:${row.href ?? row.query ?? row.title}`) : items.map(row => searchItemKey(row.item))
  const previous = useRef({ context, query, count, keys })
  const sameContext = previous.current.context === context && previous.current.query === query
  const selected = !sameContext ? -1 : activeIndex === previous.current.count ? count
    : activeIndex < 0 ? -1 : keys.indexOf(previous.current.keys[activeIndex])
  useLayoutEffect(() => {
    if (selected !== activeIndex) onActiveIndexChange(selected)
    previous.current = { context, query, count, keys }
  })

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
      if (e.key === "Enter" && selected >= 0) {
        e.preventDefault()
        activateItem(selected)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [selected, items, landingItems, emptyQuery])

  const popupRef = useRef<HTMLDivElement>(null)
  const scrollAnchor = useRef<{ key: string; top: number } | null>(null)
  const captureAnchor = () => {
    const scroll = popupRef.current?.querySelector<HTMLElement>("[data-search-scroll]")
    if (!scroll) return
    const top = scroll.getBoundingClientRect().top
    const rows = [...scroll.querySelectorAll<HTMLElement>("[data-search-key]")]
    const row = rows.find(row => row.getAttribute("aria-selected") === "true" && row.getBoundingClientRect().bottom > top)
      ?? rows.find(row => row.getBoundingClientRect().bottom > top)
    scrollAnchor.current = row ? { key: row.dataset.searchKey!, top: row.getBoundingClientRect().top - top } : null
  }
  const presentation = JSON.stringify(keys)
  useLayoutEffect(() => {
    const scroll = popupRef.current?.querySelector<HTMLElement>("[data-search-scroll]")
    const anchor = sameContext ? scrollAnchor.current : null
    const row = anchor && [...(scroll?.querySelectorAll<HTMLElement>("[data-search-key]") ?? [])].find(row => row.dataset.searchKey === anchor.key)
    if (row && scroll && anchor) scroll.scrollTop += row.getBoundingClientRect().top - scroll.getBoundingClientRect().top - anchor.top
    captureAnchor()
  }, [presentation, context, query])
  const [panelHeight, setPanelHeight] = useState(360)
  const [panelWidth, setPanelWidth] = useState<number>()
  useLayoutEffect(() => {
    const update = () => {
      const bounds = popupRef.current?.getBoundingClientRect()
      const top = bounds?.top ?? 80
      const left = bounds?.left ?? 0
      const bottom = popupRef.current?.closest(".app-page")?.getBoundingClientRect().bottom ?? window.innerHeight
      setPanelWidth(Math.max(48, Math.min(560, window.innerWidth - left - 12)))
      const viewportBottom = window.visualViewport ? window.visualViewport.height + window.visualViewport.offsetTop : window.innerHeight
      setPanelHeight(Math.max(48, Math.min(viewportBottom, bottom) - top - 12))
    }
    update()
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update)
    if (popupRef.current?.parentElement) observer?.observe(popupRef.current.parentElement)
    const app = popupRef.current?.closest(".app-page")
    if (app) observer?.observe(app)
    window.visualViewport?.addEventListener("resize", update)
    window.addEventListener("resize", update)
    window.addEventListener("scroll", update, true)
    return () => {
      observer?.disconnect()
      window.visualViewport?.removeEventListener("resize", update)
      window.removeEventListener("resize", update)
      window.removeEventListener("scroll", update, true)
    }
  }, [])
  useLayoutEffect(() => {
    const popup = popupRef.current?.querySelector<HTMLElement>("[data-search-scroll]")
    const option = popup?.querySelector<HTMLElement>(
      `[data-search-index="${selected}"]`
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
    captureAnchor()
  }, [selected === count ? "footer" : keys[selected]])
  useLayoutEffect(() => {
    const scroll = popupRef.current?.querySelector<HTMLElement>("[data-search-scroll]")
    if (scroll) scroll.scrollTop = 0
    captureAnchor()
  }, [context, query])

  // Presentation is canonical; stable category and result keys retain row DOM.
  const groups: { kind: DropdownItem["kind"]; rows: { row: DropdownItem; index: number }[] }[] = []
  items.forEach((row, index) => {
    if (groups.at(-1)?.kind !== row.kind) groups.push({ kind: row.kind, rows: [] })
    groups.at(-1)!.rows.push({ row, index })
  })
  return (
    <DropdownSurface
      ref={popupRef}
      id={id}
      role="listbox"
      aria-label={emptyQuery ? "Search suggestions" : "Music search results"}
      aria-busy={isSearching}
      onKeyDown={(event) => event.stopPropagation()}
      style={{ height: panelHeight, width: panelWidth }}
      className="app-overlay-surface discovery-search-popup absolute left-0 top-full z-50 mt-2 flex w-full max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-xl border border-(--border) bg-app-card py-1 text-(--text-primary) shadow-2xl"
    >
      <div className="discovery-search-caption flex h-10 shrink-0 items-center justify-between gap-3 whitespace-nowrap">
        <span>{emptyQuery ? "A shortcut to your music" : "Search music"}</span>
        <span role="status" title={error ?? undefined} className="min-w-0 truncate normal-case tracking-normal font-normal">{!emptyQuery && isSearching ? "Searching…" : !emptyQuery && error && items.length ? "Some results unavailable" : ""}</span>
      </div>
      <div data-search-scroll onScroll={captureAnchor} className="min-h-0 flex-1 overflow-y-auto overscroll-contain" style={{ overflowAnchor: "none" }}>
        {emptyQuery ? (["action", "recent", "music"] as const).map(kind => {
          const rows = landingItems.map((row, index) => ({ row, index })).filter(({ row }) => row.kind === kind)
          if (!rows.length) return null
          const label = kind === "action" ? "Quick actions" : kind === "recent" ? "Recent searches" : "Jump back in"
          return <div role="group" aria-label={label} key={kind}>
            <div aria-hidden="true" className="discovery-search-caption">{label}</div>
            {rows.map(({ row, index }) => <div
              key={`${kind}:${row.title}:${index}`} id={`${id}-option-${index}`} role="option"
              aria-selected={selected === index} data-search-index={index}
              onMouseEnter={() => onActiveIndexChange(index)} onMouseDown={event => event.preventDefault()}
              onClick={() => activateItem(index)}
              className={`flex cursor-pointer items-center gap-3 px-4 py-2.5 ${selected === index ? "bg-hl-menu" : "hover:bg-hl-menu"}`}
            >
              {row.item ? <SearchArtwork item={row.item} /> : <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-app-surface text-(--text-muted)">{kind === "recent" ? "↶" : "↗"}</span>}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{row.title}</span>
                <span className="block truncate text-xs text-(--text-secondary)">{row.description}</span>
              </span>
            </div>)}
          </div>
        }) : items.length === 0 ? error ? (
          <div role="alert" className="p-3 text-sm text-red-400">
            <p>Search failed: {error}</p>
            <Button variant="secondary" type="button" onMouseDown={event => event.preventDefault()} onClick={() => void search(query)} className="mt-2 rounded-md bg-app-surface px-3 py-2 text-(--text-primary)">Try again</Button>
          </div>
        ) : !isSearching && <p role="status" className="px-3 py-3 text-sm text-(--text-secondary)">No results for “{query}”.</p> : groups.map(({ kind, rows }) => {
          const label = kind === "artist" ? "Artists" : kind === "album" ? "Albums" : kind === "playlist" ? "Playlists" : "Tracks"
          return <div key={kind} role="group" aria-label={label} className="border-b border-(--border) pb-1 last:border-b-0">
            <div aria-hidden="true" className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-(--text-muted)">{label}</div>
            {rows.map(({ row, index }) => <div
              key={searchItemKey(row.item)} data-search-key={searchItemKey(row.item)} id={`${id}-option-${index}`} role="option" aria-selected={index === selected} data-search-index={index}
              className={`flex cursor-pointer items-center gap-3 px-3 py-2 ${index === selected ? "bg-hl-menu" : "hover:bg-hl-menu"}`}
              onMouseMove={() => { onActiveIndexChange(index); captureAnchor() }} onMouseDown={event => event.preventDefault()} onClick={() => activateItem(index)}
            >
              <SearchArtwork item={row.item} />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
                  {row.item.providerKey === "hibiki" ? <span className="shrink-0 text-xs text-(--text-secondary)">Hibiki</span> : <MusicSourceBadge source={row.item.providerKey === "ytmusic" ? "ytmusic" : "plex"} />}
                  <span className="truncate">{row.item.title}</span>
                </div>
                {row.kind === "playlist" && <div className="truncate text-xs text-(--text-secondary)">{row.item.trackCount > 0 ? `${row.item.trackCount} songs` : "Playlist"}</div>}
                {(row.kind === "track" || row.kind === "album") && <div className="truncate text-xs text-(--text-secondary)">
                  <ArtistCredits item={row.item} onNavigate={onClose} className="hover:underline" />
                  {row.kind === "track" && row.item.albumName && <><span> · </span><MusicEntityLink onNavigate={onClose} entity={trackEntity(row.item, "album")} className="hover:underline">{row.item.albumName}</MusicEntityLink></>}
                </div>}
              </div>
              {row.kind === "track" && <YoutubeMusicLikeButton track={row.item} />}
            </div>)}
          </div>
        })}
      </div>
      <div data-search-footer className="shrink-0 border-t border-(--border) bg-app-card">
        <div id={`${id}-option-${count}`} role="option" aria-selected={selected === count} data-search-index={count}
          onMouseEnter={() => onActiveIndexChange(count)} onMouseDown={event => event.preventDefault()} onClick={() => activateItem(count)}
          className={`cursor-pointer px-3 py-3 text-sm ${selected === count ? "bg-hl-menu" : "hover:bg-hl-menu"}`}
        >{emptyQuery ? <>Explore search and suggestions <span aria-hidden="true">↗</span></> : <>See all results for <span className="font-semibold">“{query}”</span></>}</div>
      </div>
      <div className="discovery-search-hints shrink-0" aria-hidden="true">
        <span><kbd>↑ ↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span>
      </div>
    </DropdownSurface>
  )
}
