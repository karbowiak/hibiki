import type { MusicItem, MusicTrack } from "../types/music"
import type { DragPayload } from "../stores/dragStore"
import { musicEntityHref } from "./musicEntity"

export function getMediaInfo(item: MusicItem, opts?: { showYear?: boolean }) {
  switch (item.type) {
    case "album":
      return {
        title: item.title,
        desc:
          opts?.showYear && item.year > 0
            ? `${item.artistName} · ${item.year}`
            : item.artistName,
        thumb: item.thumbUrl,
        isArtist: false,
        href: musicEntityHref("album", item.id),
        id: item.id,
        itemType: "album" as const,
        artistName: item.artistName,
        albumName: item.title,
      }
    case "artist":
      return {
        title: item.title,
        desc: "Artist",
        thumb: item.thumbUrl,
        isArtist: true,
        href: musicEntityHref("artist", item.id),
        id: item.id,
        itemType: "artist" as const,
        artistName: item.title,
        albumName: null,
      }
    case "track":
      return {
        title: item.title,
        desc:
          opts?.showYear && item.year > 0
            ? `${item.artistName} · ${item.year}`
            : item.artistName,
        thumb: item.thumbUrl,
        isArtist: false,
        href: musicEntityHref("album", item.albumId),
        id: item.id,
        itemType: "track" as const,
        artistName: item.artistName,
        albumName: item.albumName,
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

/** Build a drag payload for any media item (track, album, artist). */
export function makeDragPayload(item: MusicItem): DragPayload | undefined {
  switch (item.type) {
    case "track":
      return {
        type: "track",
        ids: [item.id],
        label: item.title,
        tracks: [item as MusicTrack],
      }
    case "album":
      return { type: "album", ids: [item.id], label: item.title }
    case "artist":
      return { type: "artist", ids: [item.id], label: item.title }
    default:
      return undefined
  }
}
