import { useContextMenu } from "../../hooks/useContextMenu"
import { useContextMenuStore } from "../../stores/contextMenuStore"
import { ArtworkImage } from "../shared/ArtworkImage"
import { MediaShelfSkeleton } from "../shared/Skeleton"
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useLocation } from "wouter"
import { useShallow } from "zustand/react/shallow"
import clsx from "clsx"
import { useLibraryStore, useConnectionStore } from "../../stores"
import { usePlayerStore } from "../../stores/playerStore"
import { useProviderStore } from "../../stores/providerStore"
import { useCapability } from "../../hooks/useCapability"
import type { RecentMix, SeedItem } from "../../stores/libraryStore"
import { selectMix, shuffleTracks } from "./Mix"
import {
  mixTitleToArtistName,
  mixThumbnailKey,
  useMixThumbnails,
} from "../../hooks/useMixThumbnails"
import { ScrollRow } from "../ScrollRow"
import { formatTimeAgo } from "../../lib/formatters"
import { MediaCard } from "../MediaCard"
import { MediaGrid } from "../shared/MediaGrid"
import type { MusicItem, MusicPlaylist } from "../../types/music"

// ---------------------------------------------------------------------------
// Color palettes
// ---------------------------------------------------------------------------

const BG_COLORS = [
  "bg-blue-700",
  "bg-blue-950",
  "bg-green-700",
  "bg-orange-700",
  "bg-orange-600",
  "bg-cyan-700",
  "bg-purple-700",
  "bg-pink-700",
  "bg-red-700",
  "bg-teal-700",
  "bg-indigo-700",
  "bg-yellow-700",
]

const STATION_BG_COLORS = [
  "#1a3a5c",
  "#2d1b4e",
  "#1a4a3a",
  "#4a2d1a",
  "#4a1a2d",
  "#1a2d4a",
  "#3a1a4a",
  "#1a4a4a",
  "#4a3a1a",
  "#2d3a1a",
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Callback-only tiles never pretend generated stations are library playlists. */
function ActionTile({ title, actionLabel, onClick, children, ...props }: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "title"> & { title: string; actionLabel: string; onClick: () => void | Promise<void> }) {
  const owner = useRef({})
  const { actionsHandler } = useContextMenu()
  useEffect(() => () => {
    const menu = useContextMenuStore.getState()
    if (menu.type === "actions" && menu.data && "owner" in menu.data && menu.data.owner === owner.current) menu.close()
  }, [title])
  return <button {...props} type="button" title={title} onClick={onClick}
    onContextMenu={actionsHandler({ title, owner: owner.current, actions: [{ label: actionLabel, run: onClick }] })}
    onKeyDown={e => {
      if (e.repeat || e.nativeEvent.isComposing || e.altKey || e.ctrlKey || e.metaKey) return
      if (e.key !== "ContextMenu" && !(e.key === "F10" && e.shiftKey)) return
      e.preventDefault(); e.stopPropagation()
      e.currentTarget.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }))
    }}>{children}</button>
}

function StationIcon() {
  return (
    <svg
      height="48" width="48" viewBox="0 0 24 24" fill="currentColor"
      className="absolute right-2 bottom-2 text-white/20"
    >
      <path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6zm-2 16a2 2 0 1 1 0-4 2 2 0 0 1 0 4z" />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


export function RecentMixCard({ mix, sectionUuid, sectionId, playFromUri }: {
  mix: RecentMix
  sectionUuid: string
  sectionId: number
  playFromUri: (uri: string, forceShuffle?: boolean) => Promise<void>
}) {
  const filterKey = mix.tabType === "artist" ? "artist.id" :
                    mix.tabType === "album"  ? "album.id" : "ratingKey"
  const params = mix.seeds.map(s => `${filterKey}=${s.id}`).join("&")
  const uri = `library://${sectionUuid}/directory//library/sections/${sectionId}/all?type=10&${params}`

  const label = mix.seeds.length <= 2
    ? mix.seeds.map(s => s.title).join(" + ")
    : `${mix.seeds.slice(0, 2).map(s => s.title).join(" + ")} +${mix.seeds.length - 2}`

  const thumbs = mix.seeds.slice(0, 4).map(s => s.thumb)
  const emptyCells = Math.max(0, 4 - thumbs.length)

  return (
    <ActionTile
      title={label} actionLabel="Play mix"
      aria-label={`Play ${label} mix`}
      onClick={() => playFromUri(uri, true)}
      className="text-left w-full cursor-pointer rounded-xl bg-app-card focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent p-3 hover:bg-hl-menu transition-colors active:scale-[0.97]"
    >
      <div className="mb-3 aspect-square overflow-hidden rounded-lg grid grid-cols-2 gap-px bg-black/20">
        {thumbs.map((t, i) => t ? (
          <ArtworkImage key={i} src={t} alt="" className="h-full w-full object-cover" />
        ) : (
          <div key={i} className="bg-white/10" />
        ))}
        {Array.from({ length: emptyCells }).map((_, i) => (
          <div key={`e${i}`} className="bg-white/5" />
        ))}
      </div>
      <div className="truncate text-sm font-semibold">{label}</div>
      <div className="mt-0.5 flex items-center gap-1 text-xs text-[var(--text-secondary)]">
        <span className="capitalize">{mix.tabType} Mix</span>
        <span>·</span>
        <span>{formatTimeAgo(mix.createdAt)}</span>
      </div>
    </ActionTile>
  )
}

// ---------------------------------------------------------------------------
// Mix builder tab types
// ---------------------------------------------------------------------------

type BuilderTab = "artist" | "album" | "track" | "genre" | "mood" | "style"

const BUILDER_TABS: { key: BuilderTab; label: string }[] = [
  { key: "artist", label: "Artist" },
  { key: "album",  label: "Album" },
  { key: "track",  label: "Track" },
  { key: "genre",  label: "Genre" },
  { key: "mood",   label: "Mood" },
  { key: "style",  label: "Style" },
]

// ---------------------------------------------------------------------------
// SearchBasedMixBuilder — for Artist / Album / Track tabs
// ---------------------------------------------------------------------------

const MAX_SEEDS = 50

interface SearchBasedMixBuilderProps {
  tabType: "artist" | "album" | "track"
  sectionUuid: string
  sectionId: number
  playFromUri: (uri: string, forceShuffle?: boolean) => Promise<void>
  onMixStarted?: (seeds: SeedItem[], tabType: "artist" | "album" | "track") => void
}

function SearchBasedMixBuilder({
  tabType,
  sectionUuid,
  sectionId,
  playFromUri,
  onMixStarted,
}: SearchBasedMixBuilderProps) {
  const provider = useProviderStore((s) => s.provider)
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<MusicItem[]>([])
  const [seeds, setSeeds] = useState<MusicItem[]>([])
  const [isSearching, setIsSearching] = useState(false)

  const [searchError, setSearchError] = useState(false)
  const [searchAttempt, setSearchAttempt] = useState(0)
  useLayoutEffect(() => {
    setQuery("")
    setSeeds([])
    setResults([])
    setSearchError(false)
  }, [provider, sectionUuid, sectionId, tabType])

  useLayoutEffect(() => {
    let active = true
    const current = () =>
      active && useProviderStore.getState().provider === provider
    setResults([])
    setSearchError(false)
    if (!provider || !query.trim()) {
      setIsSearching(false)
      return () => {
        active = false
      }
    }
    setIsSearching(true)
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const items = await provider.search(query, tabType)
          if (current())
            setResults(items.filter((item) => item.type === tabType))
        } catch {
          if (current()) setSearchError(true)
        } finally {
          if (current()) setIsSearching(false)
        }
      })()
    }, 350)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [query, provider, tabType, searchAttempt])

  const seedKeys = new Set(seeds.map((s) => s.id))

  const toggleSeed = (item: MusicItem) => {
    const key = item.id
    if (seedKeys.has(key)) {
      setSeeds((prev) => prev.filter((s) => s.id !== key))
    } else if (seeds.length < MAX_SEEDS) {
      setSeeds((prev) => [...prev, item])
    }
  }

  const getSubtitle = (item: MusicItem): string => {
    if (item.type === "artist") return "Artist"
    if (item.type === "album") return item.artistName
    if (item.type === "track") return `${item.artistName} · ${item.albumName}`
    return ""
  }

  const getThumb = (item: MusicItem): string | null => {
    return (item as any).thumbUrl ?? null
  }

  const handleStartMix = () => {
    if (!seeds.length || !sectionUuid || !sectionId) return
    const filterKey =
      tabType === "artist"
        ? "artist.id"
        : tabType === "album"
          ? "album.id"
          : "ratingKey"
    const params = seeds.map((s) => `${filterKey}=${s.id}`).join("&")
    const uri = `library://${sectionUuid}/directory//library/sections/${sectionId}/all?type=10&${params}`
    void playFromUri(uri, true)
    onMixStarted?.(
      seeds.map((s) => ({
        id: s.id,
        title: s.title,
        thumb: getThumb(s),
        subtitle: getSubtitle(s),
      })),
      tabType
    )
  }

  return (
    <div className="max-w-xl space-y-4">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label={`Search for ${tabType}`}
        placeholder={`Search for ${tabType === "artist" ? "an artist" : `a ${tabType}`}…`}
        className="w-full rounded-lg bg-white/10 px-4 py-2.5 text-sm placeholder-white/40 outline-none transition-colors focus:bg-white/15"
        autoComplete="off"
        spellCheck={false}
      />

      {isSearching && <div className="text-sm text-white/40">Searching…</div>}

      {!isSearching && results.length > 0 && (
        <div className="max-h-64 divide-y divide-white/5 overflow-y-auto rounded-lg bg-white/5">
          {results.slice(0, 20).map((item, idx) => {
            const itemKey = item.id ?? idx
            const title = item.title
            const isSeeded = seedKeys.has(item.id)
            const atLimit = seeds.length >= MAX_SEEDS
            const thumb = getThumb(item)
            return (
              <button
                type="button"
                aria-label={`Add ${title} to mix`}
                aria-pressed={isSeeded}
                disabled={!isSeeded && atLimit}
                key={itemKey}
                onClick={() => toggleSeed(item)}
                className={clsx(
                  "flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors",
                  isSeeded
                    ? "cursor-pointer bg-accent/20"
                    : atLimit
                      ? "cursor-not-allowed opacity-40"
                      : "cursor-pointer hover:bg-hl-row"
                )}
              >
                {thumb ? (
                  <ArtworkImage
                    src={thumb}
                    alt=""
                    className={"h-9 w-9 flex-shrink-0 rounded-md object-cover"}
                  />
                ) : (
                  <div
                    className={"h-9 w-9 flex-shrink-0 rounded-md bg-white/10"}
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div
                    className={clsx(
                      "truncate text-sm font-medium",
                      isSeeded ? "text-accent" : "text-white"
                    )}
                  >
                    {title}
                  </div>
                  <div className="truncate text-xs text-white/40">
                    {getSubtitle(item)}
                  </div>
                </div>
                <div
                  className={clsx(
                    "flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border transition-colors",
                    isSeeded ? "border-accent bg-accent" : "border-white/30"
                  )}
                >
                  {isSeeded && (
                    <svg
                      viewBox="0 0 12 12"
                      width="10"
                      height="10"
                      fill="currentColor"
                      className="text-black"
                    >
                      <path d="M10.28 2.28a.75.75 0 0 1 0 1.06l-5.5 5.5a.75.75 0 0 1-1.06 0l-2.5-2.5a.75.75 0 1 1 1.06-1.06L4.5 7.19l4.72-4.91a.75.75 0 0 1 1.06 0z" />
                    </svg>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      )}

      {searchError && (
        <div role="alert" className="text-sm text-red-400">
          <p>Could not search this library.</p>
          <button
            onClick={() => setSearchAttempt((value) => value + 1)}
            className="mt-2 rounded-full border border-white/20 px-4 py-2 text-white"
          >
            Try again
          </button>
        </div>
      )}
      {!isSearching &&
        !searchError &&
        query.trim().length > 0 &&
        results.length === 0 && (
          <div className="text-sm text-white/40">
            No {tabType}s found for "{query}"
          </div>
        )}

      {/* Selected seeds list */}
      {seeds.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-medium uppercase tracking-wide text-white/50">
            Seeds ({seeds.length}/{MAX_SEEDS})
          </div>
          <div className="flex flex-wrap gap-2">
            {seeds.map((item) => {
              const key = item.id
              const thumb = getThumb(item)
              return (
                <div
                  key={key}
                  className="flex items-center gap-1.5 rounded-full bg-white/10 py-1 pl-1 pr-2 text-xs font-medium"
                >
                  {thumb ? (
                    <ArtworkImage
                      src={thumb}
                      alt=""
                      className={
                        "h-5 w-5 flex-shrink-0 rounded-sm object-cover"
                      }
                    />
                  ) : (
                    <div
                      className={"h-5 w-5 flex-shrink-0 rounded-sm bg-white/20"}
                    />
                  )}
                  <span className="max-w-[120px] truncate">{item.title}</span>
                  <button
                    aria-label={`Remove ${item.title} from mix`}
                    onClick={() =>
                      setSeeds((prev) => prev.filter((s) => s.id !== key))
                    }
                    className="ml-0.5 text-white/40 transition-colors hover:text-white"
                  >
                    <svg
                      viewBox="0 0 12 12"
                      width="10"
                      height="10"
                      fill="currentColor"
                    >
                      <path d="M2.22 2.22a.75.75 0 0 1 1.06 0L6 4.94l2.72-2.72a.75.75 0 1 1 1.06 1.06L7.06 6l2.72 2.72a.75.75 0 1 1-1.06 1.06L6 7.06 3.28 9.78a.75.75 0 0 1-1.06-1.06L4.94 6 2.22 3.28a.75.75 0 0 1 0-1.06z" />
                    </svg>
                  </button>
                </div>
              )
            })}
          </div>
          <button
            onClick={handleStartMix}
            className="mt-2 flex items-center gap-2 rounded-full bg-accent px-6 py-2.5 text-sm font-bold text-black transition-all hover:brightness-110 active:scale-95"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
              <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM8 5a3 3 0 1 0 0 6A3 3 0 0 0 8 5zm0 1.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z" />
            </svg>
            Start Mix ({seeds.length} {tabType}
            {seeds.length !== 1 ? "s" : ""})
          </button>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// TagGridMixBuilder — for Genre / Mood / Style tabs
// ---------------------------------------------------------------------------

interface TagGridMixBuilderProps {
  tags: { tag: string; count: number | null }[]
  tabType: "genre" | "mood" | "style"
  sectionUuid: string
  sectionId: number
  colorPalette: string[]
  playFromUri: (uri: string, forceShuffle?: boolean) => Promise<void>
}

export function TagGridMixBuilder({
  tags,
  tabType,
  sectionUuid,
  sectionId,
  colorPalette,
  playFromUri,
}: TagGridMixBuilderProps) {
  const provider = useProviderStore((s) => s.provider)
  const [lastPlayed, setLastPlayed] = useState<string | null>(null)
  const [filterQuery, setFilterQuery] = useState("")
  const [page, setPage] = useState(0)
  const pageSize = 96

  useLayoutEffect(() => {
    setLastPlayed(null)
    setFilterQuery("")
    setPage(0)
  }, [provider, sectionUuid, sectionId, tabType])

  const filtered = useMemo(() => {
    const query = filterQuery.trim().toLowerCase()
    return query ? tags.filter(t => t.tag.toLowerCase().includes(query)) : tags
  }, [tags, filterQuery])
  const lastPage = Math.max(0, Math.ceil(filtered.length / pageSize) - 1)
  const currentPage = Math.min(page, lastPage)
  const start = currentPage * pageSize
  const visible = filtered.slice(start, start + pageSize)

  const handleTagClick = (tag: { tag: string; count: number | null }) => {
    if (!sectionUuid || !sectionId) return
    const uri = provider?.buildTagFilterUri?.(tabType, tag.tag)
    if (!uri) return
    void playFromUri(uri, true)
    setLastPlayed(tag.tag)
  }

  if (tags.length === 0) {
    return (
      <div className="text-sm text-white/40">
        No {tabType}s available in this library.
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <input
        type="text"
        value={filterQuery}
        onChange={e => {
          setFilterQuery(e.target.value)
          setPage(0)
        }}
        aria-label={`Filter ${tabType}s`}
        placeholder={`Filter ${tabType}s…`}
        className="w-full max-w-xs rounded-lg bg-white/10 px-4 py-2 text-sm placeholder-white/40 outline-none focus:bg-white/15 transition-colors"
        autoComplete="off"
        spellCheck={false}
      />
      {filtered.length === 0 && (
        <div className="text-sm text-white/40">No {tabType}s match "{filterQuery}"</div>
      )}
      <MediaGrid gap={3}>
        {visible.map((tag, idx) => (
          <ActionTile
            key={tag.tag}
            actionLabel={`Play ${tabType} mix`}
            onClick={() => handleTagClick(tag)}
            className={clsx(
              "relative aspect-square cursor-pointer overflow-hidden rounded-lg select-none text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent",
              "hover:brightness-110 transition-[filter]",
              lastPlayed === tag.tag && "ring-2 ring-accent",
              colorPalette[(start + idx) % colorPalette.length]
            )}
            title={tag.count ? `${tag.tag} (${tag.count} tracks)` : tag.tag}
          >
            <span className="line-clamp-2 p-3 text-sm font-bold leading-snug">{tag.tag}</span>
            {tag.count != null && (
              <span className="absolute bottom-1.5 right-2 text-[10px] text-white/30 tabular-nums">
                {tag.count.toLocaleString()}
              </span>
            )}
          </ActionTile>
        ))}
      </MediaGrid>
      {filtered.length > pageSize && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <p className="text-white/60" aria-live="polite">
            Showing {(start + 1).toLocaleString()}–{(start + visible.length).toLocaleString()} of {filtered.length.toLocaleString()} {tabType}s
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              aria-label={`Previous ${tabType}s`}
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
              className="rounded-full border border-white/20 px-4 py-2 transition-colors hover:bg-white/10 disabled:cursor-default disabled:opacity-40"
            >Previous</button>
            <button
              type="button"
              aria-label={`Next ${tabType}s`}
              disabled={currentPage === lastPage}
              onClick={() => setPage(currentPage + 1)}
              className="rounded-full border border-white/20 px-4 py-2 transition-colors hover:bg-white/10 disabled:cursor-default disabled:opacity-40"
            >Next</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// StationsPage
// ---------------------------------------------------------------------------

export function StationsPage() {
  const [, navigate] = useLocation()
  const hasStations = useCapability("stations")
  const provider = useProviderStore((s) => s.provider)

  const { hubs, tagsGenre, tagsMood, tagsStyle, recentMixes, addRecentMix } =
    useLibraryStore(
      useShallow((s) => ({
        hubs: s.hubs,
        tagsGenre: s.tagsGenre,
        tagsMood: s.tagsMood,
        tagsStyle: s.tagsStyle,
        recentMixes: s.recentMixes,
        addRecentMix: s.addRecentMix,
      }))
    )

  const { musicSectionId, sectionUuid } = useConnectionStore(
    useShallow((s) => ({
      musicSectionId: s.musicSectionId,
      sectionUuid: s.sectionUuid,
    }))
  )

  const { playFromUri, playTrack } = usePlayerStore(
    useShallow((s) => ({
      playFromUri: s.playFromUri,
      playTrack: s.playTrack,
    }))
  )

  const [stations, setStations] = useState<MusicItem[]>([])
  const [stationsLoaded, setStationsLoaded] = useState(false)
  const [stationError, setStationError] = useState(false)
  const [stationAttempt, setStationAttempt] = useState(0)
  const [activeTab, setActiveTab] = useState<BuilderTab>("artist")
  // Mixes for You from hubs store
  const { mixesHubs, mixesItems, mixesTitle } = useMemo(() => {
    const mh = hubs.filter((h) => h.identifier?.startsWith("music.mixes"))
    return {
      mixesHubs: mh,
      mixesItems: mh.flatMap((h) => h.items),
      mixesTitle: mh[0]?.title ?? "Mixes for You",
    }
  }, [hubs])

  const mixThumbs = useMixThumbnails(hasStations ? provider : null, mixesItems)
  const playbackView = useRef({ active: false, revision: 0 })
  const [playError, setPlayError] = useState(false)
  useLayoutEffect(() => {
    const view = { active: true, revision: 0 }
    playbackView.current = view
    setPlayError(false)
    return () => {
      view.active = false
    }
  }, [provider, hasStations])
  function playMix(item: MusicPlaylist) {
    if (!provider?.getMixTracks || !item.providerKey) return
    const view = playbackView.current
    const revision = ++view.revision
    const current = () =>
      view.active &&
      view.revision === revision &&
      useProviderStore.getState().provider === provider
    setPlayError(false)
    void (async () => {
      try {
        const items = await provider.getMixTracks!(item.providerKey!)
        if (!current() || !items.length) return
        const tracks = shuffleTracks(items, item.title)
        await playTrack(tracks[0], tracks, item.title, "/mix")
      } catch {
        if (current()) setPlayError(true)
      }
    })()
  }

  useEffect(() => {
    if (!hasStations) navigate("/")
  }, [hasStations, navigate])

  // A retired section request cannot populate a replacement library.
  useLayoutEffect(() => {
    let active = true
    const current = () =>
      active && useProviderStore.getState().provider === provider
    setStations([])
    setStationsLoaded(false)
    setStationError(false)
    if (!provider || !hasStations)
      return () => {
        active = false
      }
    void (async () => {
      try {
        const stationHubs = (await provider.getSectionStations?.()) ?? []
        if (current())
          setStations(
            stationHubs
              .filter((hub) => hub.identifier?.includes("station"))
              .flatMap((hub) => hub.items)
              .filter((item): item is MusicItem => Boolean(item.title))
          )
      } catch {
        if (current()) setStationError(true)
      } finally {
        if (current()) setStationsLoaded(true)
      }
    })()
    return () => {
      active = false
    }
  }, [provider, hasStations, stationAttempt])

  const handleStationClick = (item: MusicItem) => {
    if (!sectionUuid) return
    const stationKey = item.providerKey ?? item.id
    const uri = provider?.buildRadioUri?.(stationKey)
    if (!uri) return
    void playFromUri(uri)
    const guid = item.guid
    const typeSlug =
      guid?.replace("tv.plex://station/", "") ?? encodeURIComponent(stationKey)
    navigate(`/radio/${typeSlug}`)
  }

  // Tag sets and palettes for each tab
  const activeTags: { tag: string; count: number | null }[] =
    activeTab === "genre"
      ? tagsGenre
      : activeTab === "mood"
        ? tagsMood
        : activeTab === "style"
          ? tagsStyle
          : []

  const activeColorPalette =
    activeTab === "genre"
      ? BG_COLORS
      : activeTab === "mood"
        ? [...BG_COLORS.slice(4), ...BG_COLORS.slice(0, 4)]
        : [...BG_COLORS.slice(8), ...BG_COLORS.slice(0, 8)]

  if (!hasStations) return null

  return (
    <div className="space-y-10 pb-8">
      {playError && <p role="alert" className="text-sm text-red-400">Could not play this mix. Please try again.</p>}

      {/* Mixes for You */}
      {mixesItems.length > 0 && (
        <ScrollRow title={mixesTitle} restoreKey="stations-mixes">
          {mixesItems.map((item) => {
            if (item.type !== "playlist") return null
            const thumb =
              mixThumbs[mixThumbnailKey(item)] ?? item.thumbUrl ?? null
            return (
              <MediaCard
                key={mixThumbnailKey(item)}
                title={item.title}
                desc="Mix for You"
                thumb={thumb}
                isArtist
                artistName={mixTitleToArtistName(item.title)}
                onClick={() => {
                  selectMix(item as MusicPlaylist)
                  navigate("/mix")
                }}
                onPlay={() => playMix(item)}
                contextActions={[
                  { label: "Open mix", run: () => { selectMix(item); navigate("/mix") } },
                  ...(provider?.getMixTracks && item.providerKey ? [{ label: "Play mix", run: () => { playMix(item) } }] : []),
                ]}
                scrollItem
                large
              />
            )
          })}
        </ScrollRow>
      )}

      {/* Stations */}
      <div>
        <div className="mb-4 text-2xl font-bold">Stations</div>
        {!stationsLoaded && (
          <div><span role="status" className="sr-only">Loading stations…</span><MediaShelfSkeleton /></div>
        )}
        {stationError && (
          <div role="alert" className="text-sm text-red-400">
            <p>Could not load stations.</p>
            <button onClick={() => setStationAttempt(value => value + 1)} className="mt-2 rounded-full border border-white/20 px-4 py-2 text-white">Try again</button>
          </div>
        )}
        {stationsLoaded && !stationError && stations.length === 0 && (
          <div className="text-sm text-white/40">No stations available on this server.</div>
        )}
        {stations.length > 0 && (
          <MediaGrid gap={3}>
            {stations.map((item, idx) => (
              <ActionTile
                key={item.providerKey ?? item.id}
                actionLabel="Play station"
                onClick={() => handleStationClick(item)}
                className="relative aspect-square cursor-pointer overflow-hidden rounded-lg select-none text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent hover:brightness-110 transition-[filter]"
                style={{ background: STATION_BG_COLORS[idx % STATION_BG_COLORS.length] }}
                title={item.title}
              >
                <span className="line-clamp-2 p-3 text-sm font-bold leading-snug">{item.title}</span>
                <StationIcon />
              </ActionTile>
            ))}
          </MediaGrid>
        )}
      </div>

      {/* Recent Mixes */}
      {recentMixes.length > 0 && (
        <div>
          <div className="mb-4 text-2xl font-bold">Recent Mixes</div>
          <MediaGrid gap={3}>
            {recentMixes.map(mix => (
              <RecentMixCard
                key={mix.id}
                mix={mix}
                sectionUuid={sectionUuid ?? ""}
                sectionId={musicSectionId ?? 0}
                playFromUri={playFromUri}
              />
            ))}
          </MediaGrid>
        </div>
      )}

      {/* Build a Mix */}
      <div>
        <div className="mb-4 text-2xl font-bold">Build a Mix</div>

        {/* Tab bar */}
        <div className="mb-6 flex gap-1 rounded-lg bg-white/5 p-1 w-fit">
          {BUILDER_TABS.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={clsx(
                "rounded-md px-4 py-1.5 text-sm font-medium transition-colors",
                activeTab === tab.key
                  ? "bg-accent text-black"
                  : "text-white/60 hover:text-white"
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        {(activeTab === "artist" || activeTab === "album" || activeTab === "track") && (
          <SearchBasedMixBuilder
            key={activeTab}
            tabType={activeTab}
            sectionUuid={sectionUuid ?? ""}
            sectionId={musicSectionId ?? 0}
            playFromUri={playFromUri}
            onMixStarted={addRecentMix}
          />
        )}

        {(activeTab === "genre" || activeTab === "mood" || activeTab === "style") && (
          <TagGridMixBuilder
            key={activeTab}
            tags={activeTags}
            tabType={activeTab}
            sectionUuid={sectionUuid ?? ""}
            sectionId={musicSectionId ?? 0}
            colorPalette={activeColorPalette}
            playFromUri={playFromUri}
          />
        )}
      </div>
    </div>
  )
}
