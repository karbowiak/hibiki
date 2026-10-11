import { useEffect, useState } from "react"
import { useShallow } from "zustand/shallow"
import { useSearchStore } from "../../stores"
import {
  getRecentSearches,
  clearRecentSearches,
} from "../../lib/recentSearches"
import type { MusicItem, MusicTrack } from "../../types/music"
import { MediaCard } from "../MediaCard"
import { MediaGrid } from "../shared/MediaGrid"
import { prefetchArtist, prefetchAlbum } from "../../stores/metadataCache"
import { usePlayerStore } from "../../stores/playerStore"
import { useContextMenu } from "../../hooks/useContextMenu"
import { makeDragPayload } from "./Home"

type MediaType = "artist" | "album" | "track" | "playlist"

const GROUP_ORDER: MediaType[] = ["artist", "album", "track", "playlist"]
const GROUP_LABELS: Record<MediaType, string> = {
  artist: "Artists",
  album: "Albums",
  track: "Tracks",
  playlist: "Playlists",
}

function groupByType(results: MusicItem[]) {
  const groups: Record<MediaType, MusicItem[]> = {
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

function getInfo(item: MusicItem) {
  switch (item.type) {
    case "artist":
      return {
        title: item.title,
        desc: "Artist",
        thumb: item.thumbUrl,
        isArtist: true,
        href: `/artist/${item.id}`,
        id: item.id,
        itemType: "artist" as const,
        artistName: item.title,
        albumName: null as string | null,
      }
    case "album":
      return {
        title: item.title,
        desc: item.artistName,
        thumb: item.thumbUrl,
        isArtist: false,
        href: `/album/${item.id}`,
        id: item.id,
        itemType: "album" as const,
        artistName: item.artistName,
        albumName: item.title,
      }
    case "track":
      return {
        title: item.title,
        desc: `${item.artistName} · ${item.albumName}`,
        thumb: item.thumbUrl,
        isArtist: false,
        href: null,
        id: item.id,
        itemType: "track" as const,
      }
    case "playlist":
      return {
        title: item.title,
        desc: "Playlist",
        thumb: item.thumbUrl,
        isArtist: false,
        href: `/playlist/${item.id}`,
        id: item.id,
        itemType: "playlist" as const,
      }
    default:
      return null
  }
}

export function Search() {
  const { results, isSearching, error, query, search } = useSearchStore(
    useShallow((s) => ({
      results: s.results,
      isSearching: s.isSearching,
      error: s.error,
      query: s.query,
      search: s.search,
    }))
  )
  const playTrack = usePlayerStore((s) => s.playTrack)
  const { handler: ctxMenu } = useContextMenu()

  const [historyError, setHistoryError] = useState<string | null>(null)
  const [recentSearches, setRecentSearches] = useState<string[]>(() =>
    getRecentSearches()
  )

  // Refresh the list whenever the query is cleared so newly-recorded searches appear
  useEffect(() => {
    if (!query.trim()) setRecentSearches(getRecentSearches())
  }, [query])

  const showResults = query.trim().length > 0
  const groups = groupByType(results)

  return (
    <div className="pb-32">
      {showResults ? (
        <div className="space-y-8">
          {isSearching && (
            <div role="status" className="text-sm text-gray-400">
              Searching…
            </div>
          )}
          {error && (
            <div role="alert" className="text-sm text-red-400">
              <p>Search failed: {error}</p>
              <button
                onClick={() => void search(query)}
                className="mt-2 rounded-full border border-white/20 px-4 py-2 text-white"
              >
                Try again
              </button>
            </div>
          )}
          {!isSearching && !error && results.length === 0 && (
            <div className="text-sm text-gray-400">
              No results for "{query}"
            </div>
          )}
          {GROUP_ORDER.map((type) => {
            const items = groups[type]
            if (!items || items.length === 0) return null
            const tracks =
              type === "track"
                ? items.filter(
                    (i): i is MusicTrack & { type: "track" } =>
                      i.type === "track"
                  )
                : []
            return (
              <div key={type}>
                <div className="mb-3 text-xl font-bold">
                  {GROUP_LABELS[type]}
                </div>
                <MediaGrid gap={3}>
                  {items.slice(0, 10).map((item) => {
                    const info = getInfo(item)
                    if (!info) return null
                    const prefetch =
                      info.itemType === "artist"
                        ? () => prefetchArtist(info.id)
                        : info.itemType === "album"
                          ? () => prefetchAlbum(info.id)
                          : undefined
                    const onClick =
                      info.itemType === "track"
                        ? () =>
                            void playTrack(
                              item as MusicTrack & { type: "track" },
                              tracks
                            )
                        : undefined
                    const onContextMenu =
                      item.type === "artist" || item.type === "album"
                        ? ctxMenu(item.type, item)
                        : undefined
                    const Card = MediaCard
                    return (
                      <Card
                        key={info.id}
                        title={info.title}
                        desc={info.desc}
                        thumb={info.thumb}
                        isArtist={info.isArtist}
                        href={info.href ?? undefined}
                        onClick={onClick}
                        prefetch={prefetch}
                        onContextMenu={onContextMenu}
                        dragPayload={makeDragPayload(item)}
                        artistName={
                          "artistName" in info ? info.artistName : undefined
                        }
                        albumName={
                          "albumName" in info ? info.albumName : undefined
                        }
                      />
                    )
                  })}
                </MediaGrid>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="py-8">
          {historyError && (
            <p role="alert" className="mb-3 text-sm text-red-400">
              {historyError}
            </p>
          )}
          {recentSearches.length > 0 ? (
            <>
              <div className="mb-3 flex items-center justify-between">
                <span className="text-sm font-semibold text-gray-400">
                  Recent searches
                </span>
                <button
                  onClick={() => {
                    if (clearRecentSearches()) {
                      setRecentSearches([])
                      setHistoryError(null)
                    } else
                      setHistoryError(
                        "Could not clear recent searches. Try again."
                      )
                  }}
                  className="text-xs text-gray-600 transition-colors hover:text-gray-300"
                >
                  Clear
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {recentSearches.map((q) => (
                  <button
                    key={q}
                    onClick={() => void search(q)}
                    className="rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-sm text-gray-300 transition-all hover:border-accent/30 hover:bg-hl-menu hover:text-white"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className="py-12 text-center text-sm text-white/40">
              Type something to search your library.
            </div>
          )}
        </div>
      )}
    </div>
  )
}
