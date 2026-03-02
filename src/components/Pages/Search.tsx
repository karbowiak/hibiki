import { useEffect, useState } from "react"
import { useShallow } from "zustand/shallow"
import { useSearchStore, useConnectionStore, buildPlexImageUrl } from "../../stores"
import type { PlexMedia, Track } from "../../types/plex"
import { MediaCard } from "../MediaCard"
import { PriorityMediaCard } from "../PriorityMediaCard"
import { prefetchArtist, prefetchAlbum } from "../../stores/metadataCache"
import { usePlayerStore } from "../../stores/playerStore"
import { useContextMenuStore } from "../../stores/contextMenuStore"

type MediaType = "artist" | "album" | "track" | "playlist"

const GROUP_ORDER: MediaType[] = ["artist", "album", "track", "playlist"]
const GROUP_LABELS: Record<MediaType, string> = {
  artist: "Artists",
  album: "Albums",
  track: "Tracks",
  playlist: "Playlists",
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
        artistName: item.title,
        albumName: null as string | null,
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
        artistName: item.parent_title,
        albumName: item.title,
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
  const { results, isSearching, query } = useSearchStore()
  const { baseUrl, token, musicSectionId } = useConnectionStore(
    useShallow(s => ({
      baseUrl: s.baseUrl,
      token: s.token,
      musicSectionId: s.musicSectionId,
    }))
  )
  const playTrack = usePlayerStore(s => s.playTrack)
  const showContextMenu = useContextMenuStore(s => s.show)

  const showResults = query.trim().length > 0
  const groups = groupByType(results)

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
                <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(var(--card-size, 160px), 1fr))" }}>
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
                    const onContextMenu = (item.type === "artist" || item.type === "album")
                      ? (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); showContextMenu(e.clientX, e.clientY, item.type, item) }
                      : undefined
                    const usePriority = info.itemType === "artist" || info.itemType === "album"
                    const Card = usePriority ? PriorityMediaCard : MediaCard
                    return (
                      <Card
                        key={idx}
                        title={info.title}
                        desc={info.desc}
                        thumb={info.thumb}
                        isArtist={info.isArtist}
                        href={info.href ?? undefined}
                        onClick={onClick}
                        prefetch={prefetch}
                        onContextMenu={onContextMenu}
                        artistName={"artistName" in info ? info.artistName : undefined}
                        albumName={"albumName" in info ? info.albumName : undefined}
                      />
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="py-12 text-center text-sm text-white/40">
          Type something to search your library.
        </div>
      )}
    </div>
  )
}
