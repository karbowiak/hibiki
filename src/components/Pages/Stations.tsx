import { useEffect, useState } from "react"
import { useLocation } from "wouter"
import { useShallow } from "zustand/react/shallow"
import clsx from "clsx"
import { useLibraryStore, useConnectionStore, buildPlexImageUrl } from "../../stores"
import { usePlayerStore } from "../../stores/playerStore"
import type { RecentMix, SeedItem } from "../../stores/libraryStore"
import { selectMix } from "./Mix"
import { mixThumbCache, mixTitleToArtistName } from "./Home"
import {
  getSectionStations,
  buildRadioPlayQueueUri,
  buildTagFilterUri,
  searchLibrary,
} from "../../lib/plex"
import { ScrollRow } from "../ScrollRow"
import { MediaCard } from "../MediaCard"
import type { KnownPlexMedia, LibraryTag, PlexMedia, Playlist } from "../../types/plex"

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

function formatTimeAgo(ts: number): string {
  const m = Math.floor((Date.now() - ts) / 60_000)
  if (m < 1) return "Just now"
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function RecentMixCard({ mix, sectionUuid, sectionId, playFromUri }: {
  mix: RecentMix
  sectionUuid: string
  sectionId: number
  playFromUri: (uri: string, forceShuffle?: boolean) => Promise<void>
}) {
  const filterKey = mix.tabType === "artist" ? "artist.id" :
                    mix.tabType === "album"  ? "album.id" : "ratingKey"
  const params = mix.seeds.map(s => `${filterKey}=${s.rating_key}`).join("&")
  const uri = `library://${sectionUuid}/directory//library/sections/${sectionId}/all?type=10&${params}`

  const label = mix.seeds.length <= 2
    ? mix.seeds.map(s => s.title).join(" + ")
    : `${mix.seeds.slice(0, 2).map(s => s.title).join(" + ")} +${mix.seeds.length - 2}`

  const thumbs = mix.seeds.slice(0, 4).map(s => s.thumb)
  const emptyCells = Math.max(0, 4 - thumbs.length)

  return (
    <div
      onClick={() => void playFromUri(uri, true)}
      className="cursor-pointer rounded-xl bg-white/5 p-3 hover:bg-white/10 transition-colors active:scale-[0.97]"
    >
      <div className="mb-3 aspect-square overflow-hidden rounded-lg grid grid-cols-2 gap-px bg-black/20">
        {thumbs.map((t, i) => t ? (
          <img key={i} src={t} alt="" className="h-full w-full object-cover" />
        ) : (
          <div key={i} className="bg-white/10" />
        ))}
        {Array.from({ length: emptyCells }).map((_, i) => (
          <div key={`e${i}`} className="bg-white/5" />
        ))}
      </div>
      <div className="truncate text-sm font-semibold">{label}</div>
      <div className="mt-0.5 flex items-center gap-1 text-xs text-white/40">
        <span className="capitalize">{mix.tabType} Mix</span>
        <span>·</span>
        <span>{formatTimeAgo(mix.createdAt)}</span>
      </div>
    </div>
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
  musicSectionId: number
  baseUrl: string
  token: string
  sectionUuid: string
  sectionId: number
  playFromUri: (uri: string, forceShuffle?: boolean) => Promise<void>
  onMixStarted?: (seeds: SeedItem[], tabType: "artist" | "album" | "track") => void
}

function SearchBasedMixBuilder({ tabType, musicSectionId, baseUrl, token, sectionUuid, sectionId, playFromUri, onMixStarted }: SearchBasedMixBuilderProps) {
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<PlexMedia[]>([])
  const [seeds, setSeeds] = useState<PlexMedia[]>([])
  const [isSearching, setIsSearching] = useState(false)

  useEffect(() => {
    if (!musicSectionId || !query.trim()) {
      setResults([])
      setIsSearching(false)
      return
    }
    setIsSearching(true)
    const timer = setTimeout(() => {
      searchLibrary(musicSectionId, query, tabType)
        .then(res => setResults(res.filter(r => r.type === tabType)))
        .catch(() => setResults([]))
        .finally(() => setIsSearching(false))
    }, 350)
    return () => clearTimeout(timer)
  }, [query, musicSectionId, tabType])

  const getRatingKey = (item: PlexMedia): number =>
    (item as { rating_key: number }).rating_key

  const getTitle = (item: PlexMedia): string =>
    (item as { title: string }).title ?? ""

  const seedKeys = new Set(seeds.map(getRatingKey))

  const toggleSeed = (item: PlexMedia) => {
    if (item.type === "unknown") return
    const key = getRatingKey(item)
    if (seedKeys.has(key)) {
      setSeeds(prev => prev.filter(s => getRatingKey(s) !== key))
    } else if (seeds.length < MAX_SEEDS) {
      setSeeds(prev => [...prev, item])
    }
  }

  const getSubtitle = (item: PlexMedia): string => {
    if (item.type === "artist") return "Artist"
    if (item.type === "album") return item.parent_title
    if (item.type === "track") return `${item.grandparent_title} · ${item.parent_title}`
    return ""
  }

  const getThumb = (item: PlexMedia): string | null => {
    if (item.type === "track") {
      const src = item.thumb || item.parent_thumb
      return src ? buildPlexImageUrl(baseUrl, token, src) : null
    }
    const src = (item as { thumb?: string | null }).thumb
    return src ? buildPlexImageUrl(baseUrl, token, src) : null
  }

  const handleStartMix = () => {
    if (!seeds.length || !sectionUuid || !sectionId) return
    const filterKey = tabType === "artist" ? "artist.id" :
                      tabType === "album"  ? "album.id" : "ratingKey"
    const params = seeds.map(s => `${filterKey}=${getRatingKey(s)}`).join("&")
    const uri = `library://${sectionUuid}/directory//library/sections/${sectionId}/all?type=10&${params}`
    void playFromUri(uri, true)
    onMixStarted?.(seeds.map(s => ({
      rating_key: getRatingKey(s),
      title: getTitle(s),
      thumb: getThumb(s),
      subtitle: getSubtitle(s),
    })), tabType)
  }

  return (
    <div className="max-w-xl space-y-4">
      <input
        type="text"
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder={`Search for ${tabType === "artist" ? "an artist" : `a ${tabType}`}…`}
        className="w-full rounded-lg bg-white/10 px-4 py-2.5 text-sm placeholder-white/40 outline-none focus:bg-white/15 transition-colors"
        autoComplete="off"
        spellCheck={false}
      />

      {isSearching && (
        <div className="text-sm text-white/40">Searching…</div>
      )}

      {!isSearching && results.length > 0 && (
        <div className="max-h-64 overflow-y-auto rounded-lg bg-white/5 divide-y divide-white/5">
          {results.slice(0, 20).map((item, idx) => {
            if (item.type === "unknown") return null
            const itemKey = getRatingKey(item) ?? idx
            const title = getTitle(item)
            const isSeeded = seedKeys.has(itemKey)
            const atLimit = seeds.length >= MAX_SEEDS
            const thumb = getThumb(item)
            return (
              <div
                key={itemKey}
                onClick={() => toggleSeed(item)}
                className={clsx(
                  "flex items-center gap-3 px-3 py-2.5 transition-colors",
                  isSeeded ? "cursor-pointer bg-accent/20" :
                  atLimit   ? "cursor-not-allowed opacity-40" : "cursor-pointer hover:bg-white/5"
                )}
              >
                {thumb ? (
                  <img src={thumb} alt="" className={clsx("h-9 w-9 flex-shrink-0 object-cover", tabType === "artist" ? "rounded-full" : "rounded")} />
                ) : (
                  <div className={clsx("h-9 w-9 flex-shrink-0 bg-white/10", tabType === "artist" ? "rounded-full" : "rounded")} />
                )}
                <div className="min-w-0 flex-1">
                  <div className={clsx("truncate text-sm font-medium", isSeeded ? "text-accent" : "text-white")}>{title}</div>
                  <div className="truncate text-xs text-white/40">{getSubtitle(item)}</div>
                </div>
                <div className={clsx(
                  "flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border transition-colors",
                  isSeeded ? "border-accent bg-accent" : "border-white/30"
                )}>
                  {isSeeded && (
                    <svg viewBox="0 0 12 12" width="10" height="10" fill="currentColor" className="text-black">
                      <path d="M10.28 2.28a.75.75 0 0 1 0 1.06l-5.5 5.5a.75.75 0 0 1-1.06 0l-2.5-2.5a.75.75 0 1 1 1.06-1.06L4.5 7.19l4.72-4.91a.75.75 0 0 1 1.06 0z" />
                    </svg>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {!isSearching && query.trim().length > 0 && results.length === 0 && (
        <div className="text-sm text-white/40">No {tabType}s found for "{query}"</div>
      )}

      {/* Selected seeds list */}
      {seeds.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-white/50 uppercase tracking-wide">
            Seeds ({seeds.length}/{MAX_SEEDS})
          </div>
          <div className="flex flex-wrap gap-2">
            {seeds.map(item => {
              const key = getRatingKey(item)
              const thumb = getThumb(item)
              return (
                <div
                  key={key}
                  className="flex items-center gap-1.5 rounded-full bg-white/10 pl-1 pr-2 py-1 text-xs font-medium"
                >
                  {thumb ? (
                    <img src={thumb} alt="" className={clsx("h-5 w-5 flex-shrink-0 object-cover", tabType === "artist" ? "rounded-full" : "rounded-sm")} />
                  ) : (
                    <div className={clsx("h-5 w-5 flex-shrink-0 bg-white/20", tabType === "artist" ? "rounded-full" : "rounded-sm")} />
                  )}
                  <span className="max-w-[120px] truncate">{getTitle(item)}</span>
                  <button
                    onClick={() => setSeeds(prev => prev.filter(s => getRatingKey(s) !== key))}
                    className="ml-0.5 text-white/40 hover:text-white transition-colors"
                  >
                    <svg viewBox="0 0 12 12" width="10" height="10" fill="currentColor">
                      <path d="M2.22 2.22a.75.75 0 0 1 1.06 0L6 4.94l2.72-2.72a.75.75 0 1 1 1.06 1.06L7.06 6l2.72 2.72a.75.75 0 1 1-1.06 1.06L6 7.06 3.28 9.78a.75.75 0 0 1-1.06-1.06L4.94 6 2.22 3.28a.75.75 0 0 1 0-1.06z" />
                    </svg>
                  </button>
                </div>
              )
            })}
          </div>
          <button
            onClick={handleStartMix}
            className="mt-2 flex items-center gap-2 rounded-full bg-accent px-6 py-2.5 text-sm font-bold text-black hover:brightness-110 active:scale-95 transition-all"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
              <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM8 5a3 3 0 1 0 0 6A3 3 0 0 0 8 5zm0 1.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z" />
            </svg>
            Start Mix ({seeds.length} {tabType}{seeds.length !== 1 ? "s" : ""})
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
  tags: LibraryTag[]
  tabType: "genre" | "mood" | "style"
  sectionUuid: string
  sectionId: number
  colorPalette: string[]
  playFromUri: (uri: string, forceShuffle?: boolean) => Promise<void>
}

function TagGridMixBuilder({ tags, tabType, sectionUuid, sectionId, colorPalette, playFromUri }: TagGridMixBuilderProps) {
  const [lastPlayed, setLastPlayed] = useState<string | null>(null)
  const [filterQuery, setFilterQuery] = useState("")

  const filtered = filterQuery.trim()
    ? tags.filter(t => t.tag.toLowerCase().includes(filterQuery.toLowerCase()))
    : tags

  const handleTagClick = (tag: LibraryTag) => {
    if (!sectionUuid || !sectionId) return
    const uri = buildTagFilterUri(sectionUuid, sectionId, tabType, tag.tag)
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
        onChange={e => setFilterQuery(e.target.value)}
        placeholder={`Filter ${tabType}s…`}
        className="w-full max-w-xs rounded-lg bg-white/10 px-4 py-2 text-sm placeholder-white/40 outline-none focus:bg-white/15 transition-colors"
        autoComplete="off"
        spellCheck={false}
      />
      {filtered.length === 0 && (
        <div className="text-sm text-white/40">No {tabType}s match "{filterQuery}"</div>
      )}
      <div className="grid grid-cols-5 gap-3 2xl:grid-cols-6">
        {filtered.map((tag, idx) => (
          <div
            key={tag.tag}
            onClick={() => handleTagClick(tag)}
            className={clsx(
              "relative aspect-square cursor-pointer overflow-hidden rounded-lg select-none",
              "hover:brightness-110 transition-[filter]",
              lastPlayed === tag.tag && "ring-2 ring-accent",
              colorPalette[idx % colorPalette.length]
            )}
            title={tag.count ? `${tag.tag} (${tag.count} tracks)` : tag.tag}
          >
            <span className="line-clamp-2 p-3 text-sm font-bold leading-snug">{tag.tag}</span>
            {tag.count != null && (
              <span className="absolute bottom-1.5 right-2 text-[10px] text-white/30 tabular-nums">
                {tag.count.toLocaleString()}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// StationsPage
// ---------------------------------------------------------------------------

export function StationsPage() {
  const [, navigate] = useLocation()

  const { hubs, tagsGenre, tagsMood, tagsStyle, recentMixes, addRecentMix } = useLibraryStore(
    useShallow(s => ({
      hubs: s.hubs,
      tagsGenre: s.tagsGenre,
      tagsMood: s.tagsMood,
      tagsStyle: s.tagsStyle,
      recentMixes: s.recentMixes,
      addRecentMix: s.addRecentMix,
    }))
  )

  const { baseUrl, token, musicSectionId, sectionUuid } = useConnectionStore(
    useShallow(s => ({
      baseUrl: s.baseUrl,
      token: s.token,
      musicSectionId: s.musicSectionId,
      sectionUuid: s.sectionUuid,
    }))
  )

  const playFromUri = usePlayerStore(s => s.playFromUri)

  const [stations, setStations] = useState<KnownPlexMedia[]>([])
  const [stationsLoaded, setStationsLoaded] = useState(false)
  const [activeTab, setActiveTab] = useState<BuilderTab>("artist")
  const [mixThumbs, setMixThumbs] = useState<Record<string, string>>(() =>
    Object.fromEntries(mixThumbCache.entries())
  )

  // Mixes for You from hubs store
  const mixesHubs  = hubs.filter(h => h.hub_identifier.startsWith("music.mixes"))
  const mixesItems = mixesHubs.flatMap(h => h.metadata)
  const mixesTitle = mixesHubs[0]?.title ?? "Mixes for You"

  // Resolve artist thumbnails for each mix (same logic as Home.tsx)
  useEffect(() => {
    if (!musicSectionId || mixesItems.length === 0) return
    const controller = new AbortController()
    const run = async () => {
      const updates: Record<string, string> = {}
      for (const item of mixesItems) {
        if (controller.signal.aborted) break
        if (item.type !== "playlist") continue
        if (mixThumbCache.has(item.title)) continue
        const artistName = mixTitleToArtistName(item.title)
        if (!artistName) continue
        try {
          const results = await searchLibrary(musicSectionId, artistName, "artist")
          const artist = results.find(
            r => r.type === "artist" && r.title.toLowerCase() === artistName.toLowerCase()
          ) ?? results.find(r => r.type === "artist")
          if (artist && artist.type === "artist" && artist.thumb) {
            const url = buildPlexImageUrl(baseUrl, token, artist.thumb)
            mixThumbCache.set(item.title, url)
            updates[item.title] = url
          }
        } catch { }
      }
      if (!controller.signal.aborted && Object.keys(updates).length > 0) {
        setMixThumbs(prev => ({ ...prev, ...updates }))
      }
    }
    void run()
    return () => controller.abort()
  }, [musicSectionId, mixesItems.length])

  // Fetch section stations on mount
  useEffect(() => {
    if (!musicSectionId) return
    setStationsLoaded(false)
    getSectionStations(musicSectionId)
      .then(stationHubs => {
        const items = stationHubs
          .filter(h => h.hub_identifier.includes("station"))
          .flatMap(h => h.metadata)
          .filter((item): item is KnownPlexMedia => item.type !== "unknown" && Boolean(item.title))
        setStations(items)
      })
      .catch(() => {})
      .finally(() => setStationsLoaded(true))
  }, [musicSectionId])

  const handleStationClick = (item: KnownPlexMedia) => {
    if (!sectionUuid) return
    const uri = buildRadioPlayQueueUri(sectionUuid, item.key)
    void playFromUri(uri)
    const typeSlug = item.guid?.replace("tv.plex://station/", "") ?? encodeURIComponent(item.key)
    navigate(`/radio/${typeSlug}`)
  }

  // Tag sets and palettes for each tab
  const activeTags: LibraryTag[] =
    activeTab === "genre" ? tagsGenre :
    activeTab === "mood"  ? tagsMood  :
    activeTab === "style" ? tagsStyle :
    []

  const activeColorPalette =
    activeTab === "genre" ? BG_COLORS :
    activeTab === "mood"  ? [...BG_COLORS.slice(4), ...BG_COLORS.slice(0, 4)] :
    [...BG_COLORS.slice(8), ...BG_COLORS.slice(0, 8)]

  return (
    <div className="space-y-10 pb-8">

      {/* Mixes for You */}
      {mixesItems.length > 0 && (
        <ScrollRow title={mixesTitle} restoreKey="stations-mixes">
          {mixesItems.map((item, idx) => {
            if (item.type !== "playlist") return null
            const thumb =
              mixThumbs[item.title] ??
              (item.thumb ? buildPlexImageUrl(baseUrl, token, item.thumb) : null) ??
              (item.composite ? buildPlexImageUrl(baseUrl, token, item.composite) : null)
            return (
              <MediaCard
                key={idx}
                title={item.title}
                desc="Mix for You"
                thumb={thumb}
                isArtist={false}
                onClick={() => {
                  selectMix(item as Playlist & { type: "playlist" })
                  navigate("/mix")
                }}
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
          <div className="text-sm text-white/40">Loading stations…</div>
        )}
        {stationsLoaded && stations.length === 0 && (
          <div className="text-sm text-white/40">No stations available on this server.</div>
        )}
        {stations.length > 0 && (
          <div className="grid grid-cols-5 gap-3 2xl:grid-cols-6">
            {stations.map((item, idx) => (
              <div
                key={item.key}
                onClick={() => handleStationClick(item)}
                className="relative aspect-square cursor-pointer overflow-hidden rounded-lg select-none hover:brightness-110 transition-[filter]"
                style={{ background: STATION_BG_COLORS[idx % STATION_BG_COLORS.length] }}
                title={item.title}
              >
                <span className="line-clamp-2 p-3 text-sm font-bold leading-snug">{item.title}</span>
                <StationIcon />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Recent Mixes */}
      {recentMixes.length > 0 && (
        <div>
          <div className="mb-4 text-2xl font-bold">Recent Mixes</div>
          <div className="grid grid-cols-5 gap-3 2xl:grid-cols-6">
            {recentMixes.map(mix => (
              <RecentMixCard
                key={mix.id}
                mix={mix}
                sectionUuid={sectionUuid ?? ""}
                sectionId={musicSectionId ?? 0}
                playFromUri={playFromUri}
              />
            ))}
          </div>
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
            musicSectionId={musicSectionId ?? 0}
            baseUrl={baseUrl}
            token={token}
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
