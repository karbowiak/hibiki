import { useEffect, useState } from "react"
import { useLocation } from "wouter"
import { useShallow } from "zustand/shallow"
import clsx from "clsx"
import { useSearchStore, useConnectionStore, buildPlexImageUrl } from "../../stores"
import { getSectionTags, getSectionStations, buildRadioPlayQueueUri } from "../../lib/plex"
import type { KnownPlexMedia, LibraryTag, PlexMedia, Track } from "../../types/plex"
import { MediaCard } from "../MediaCard"
import { prefetchArtist, prefetchAlbum } from "../../stores/metadataCache"
import { usePlayerStore } from "../../stores/playerStore"

type MediaType = "artist" | "album" | "track" | "playlist"

const GROUP_ORDER: MediaType[] = ["artist", "album", "track", "playlist"]
const GROUP_LABELS: Record<MediaType, string> = {
  artist: "Artists",
  album: "Albums",
  track: "Tracks",
  playlist: "Playlists",
}

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

// Dark palette for station cards (distinct from the genre palette)
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

// Station icon (music note)
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

function groupByType(results: PlexMedia[]) {
  const groups: Record<MediaType, PlexMedia[]> = {
    artist: [],
    album: [],
    track: [],
    playlist: [],
  }
  for (const item of results) {
    if (item.type in groups) groups[item.type as MediaType].push(item)
  }
  return groups
}

function getInfo(item: PlexMedia, baseUrl: string, token: string) {
  switch (item.type) {
    case "artist":
      return {
        title: item.title,
        desc: "Artist",
        thumb: item.thumb ? buildPlexImageUrl(baseUrl, token, item.thumb) : null,
        isArtist: true,
        href: `/artist/${item.rating_key}`,
        ratingKey: item.rating_key,
        itemType: "artist" as const,
      }
    case "album":
      return {
        title: item.title,
        desc: item.parent_title,
        thumb: item.thumb ? buildPlexImageUrl(baseUrl, token, item.thumb) : null,
        isArtist: false,
        href: `/album/${item.rating_key}`,
        ratingKey: item.rating_key,
        itemType: "album" as const,
      }
    case "track":
      return {
        title: item.title,
        desc: `${item.grandparent_title} · ${item.parent_title}`,
        thumb: item.thumb ? buildPlexImageUrl(baseUrl, token, item.thumb) : null,
        isArtist: false,
        href: null,
        ratingKey: item.rating_key,
        itemType: "track" as const,
      }
    case "playlist":
      return {
        title: item.title,
        desc: "Playlist",
        thumb: item.composite ? buildPlexImageUrl(baseUrl, token, item.composite) : null,
        isArtist: false,
        href: `/playlist/${item.rating_key}`,
        ratingKey: item.rating_key,
        itemType: "playlist" as const,
      }
    default:
      return null
  }
}

export function Search() {
  const [, navigate] = useLocation()
  const { results, isSearching, query, setQuery } = useSearchStore()
  const { baseUrl, token, musicSectionId, sectionUuid } = useConnectionStore(
    useShallow(s => ({
      baseUrl: s.baseUrl,
      token: s.token,
      musicSectionId: s.musicSectionId,
      sectionUuid: s.sectionUuid,
    }))
  )
  const playFromUri = usePlayerStore(s => s.playFromUri)
  const playTrack = usePlayerStore(s => s.playTrack)
  const [moods, setMoods] = useState<LibraryTag[]>([])
  const [styles, setStyles] = useState<LibraryTag[]>([])
  const [tagsLoaded, setTagsLoaded] = useState(false)
  const [stations, setStations] = useState<KnownPlexMedia[]>([])
  const [stationsLoaded, setStationsLoaded] = useState(false)

  const showResults = query.trim().length > 0
  const groups = groupByType(results)

  // Fetch moods and styles from Plex when connected
  useEffect(() => {
    if (!musicSectionId) return
    Promise.allSettled([
      getSectionTags(musicSectionId, "mood"),
      getSectionTags(musicSectionId, "style"),
    ]).then(([moodResult, styleResult]) => {
      if (moodResult.status === "fulfilled")
        setMoods(moodResult.value.sort((a, b) => a.tag.localeCompare(b.tag)))
      if (styleResult.status === "fulfilled")
        setStyles(styleResult.value.sort((a, b) => a.tag.localeCompare(b.tag)))
      setTagsLoaded(true)
    })
  }, [musicSectionId])

  // Fetch available stations from Plex
  useEffect(() => {
    if (!musicSectionId) return
    getSectionStations(musicSectionId)
      .then(hubs => {
        const items = hubs
          .filter(h => h.hub_identifier.includes("station"))
          .flatMap(h => h.metadata)
          .filter((item): item is KnownPlexMedia => item.type !== "unknown" && Boolean(item.title))
        setStations(items)
      })
      .catch(() => {})
      .finally(() => setStationsLoaded(true))
  }, [musicSectionId])

  const handleTagClick = (tag: string) => {
    setQuery(tag)
    navigate("/search")
  }

  const handleStationClick = (item: KnownPlexMedia) => {
    if (!sectionUuid) return
    const uri = buildRadioPlayQueueUri(sectionUuid, item.key)
    void playFromUri(uri)
    // Derive route slug from GUID: "tv.plex://station/library" → "library"
    const typeSlug = item.guid?.replace("tv.plex://station/", "") ?? encodeURIComponent(item.key)
    navigate(`/radio/${typeSlug}`)
  }

  return (
    <div className="pb-32">
      {showResults ? (
        <div className="space-y-8">
          {isSearching && <div className="text-sm text-gray-400">Searching…</div>}
          {!isSearching && results.length === 0 && (
            <div className="text-sm text-gray-400">No results for "{query}"</div>
          )}
          {GROUP_ORDER.map(type => {
            const items = groups[type]
            if (!items || items.length === 0) return null
            const tracks = type === "track"
              ? items.filter((i): i is Track & { type: "track" } => i.type === "track")
              : []
            return (
              <div key={type}>
                <div className="mb-3 text-xl font-bold">{GROUP_LABELS[type]}</div>
                <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))" }}>
                  {items.slice(0, 10).map((item, idx) => {
                    const info = getInfo(item, baseUrl, token)
                    if (!info) return null
                    const prefetch = info.itemType === "artist"
                      ? () => prefetchArtist(info.ratingKey, musicSectionId ?? 0)
                      : info.itemType === "album"
                        ? () => prefetchAlbum(info.ratingKey)
                        : undefined
                    const onClick = info.itemType === "track"
                      ? () => void playTrack(tracks[idx], tracks)
                      : undefined
                    return (
                      <MediaCard
                        key={idx}
                        title={info.title}
                        desc={info.desc}
                        thumb={info.thumb}
                        isArtist={info.isArtist}
                        href={info.href ?? undefined}
                        onClick={onClick}
                        prefetch={prefetch}
                      />
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="space-y-8">
          {/* Stations — from Plex server */}
          <div>
            <div className="mb-4 text-2xl font-bold">Stations</div>
            {!stationsLoaded && (
              <div className="text-sm text-gray-400">Loading stations…</div>
            )}
            {stationsLoaded && stations.length === 0 && (
              <div className="text-sm text-gray-400">No stations available on this server.</div>
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
                    <span className="line-clamp-2 p-3 text-sm font-bold leading-snug">
                      {item.title}
                    </span>
                    <StationIcon />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Moods from Plex library */}
          {moods.length > 0 && (
            <div>
              <div className="mb-4 text-2xl font-bold">Browse by Mood</div>
              <div className="grid grid-cols-5 gap-3 2xl:grid-cols-6">
                {moods.map((g, idx) => (
                  <div
                    key={g.tag}
                    onClick={() => handleTagClick(g.tag)}
                    className={clsx(
                      "relative aspect-square cursor-pointer overflow-hidden rounded-lg select-none",
                      "hover:brightness-110 transition-[filter]",
                      BG_COLORS[idx % BG_COLORS.length]
                    )}
                  >
                    <span className="line-clamp-2 p-3 text-sm font-bold leading-snug">{g.tag}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Styles from Plex library */}
          {styles.length > 0 && (
            <div>
              <div className="mb-4 text-2xl font-bold">Browse by Style</div>
              <div className="grid grid-cols-5 gap-3 2xl:grid-cols-6">
                {styles.map((g, idx) => (
                  <div
                    key={g.tag}
                    onClick={() => handleTagClick(g.tag)}
                    className={clsx(
                      "relative aspect-square cursor-pointer overflow-hidden rounded-lg select-none",
                      "hover:brightness-110 transition-[filter]",
                      BG_COLORS[(idx + 4) % BG_COLORS.length]
                    )}
                  >
                    <span className="line-clamp-2 p-3 text-sm font-bold leading-snug">{g.tag}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Loading state — tags not yet fetched */}
          {!tagsLoaded && musicSectionId && (
            <div className="text-sm text-gray-400">Loading…</div>
          )}
        </div>
      )}
    </div>
  )
}
