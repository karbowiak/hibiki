import type { MusicAlbum, MusicTrack } from "../types/music"
import type { YoutubeMusicItem } from "../backends/ytmusic/discovery"
import { itemArtistCredits } from "./artistCredits"

export type MusicEntityKind = "artist" | "album"
export interface MusicEntityRef {
  kind: MusicEntityKind
  id?: string | null
  name: string
  artist?: string
  year?: number | null
  trackId?: string
}
export function musicEntityHref(kind: MusicEntityKind, id?: string | null) {
  if (!id) return null
  const remote = id.slice(8)
  return id.startsWith("ytmusic:") ? `/ytmusic/${encodeURIComponent(kind === "artist" ? remote.replace(/^MPLA(?=UC)/, "") : remote)}` : `/${kind}/${encodeURIComponent(id)}`
}
export function trackEntity(track: MusicTrack | null | undefined, kind: MusicEntityKind): MusicEntityRef | null {
  if (!track) return null
  if (kind === "artist") {
    const credit = itemArtistCredits(track)[0]
    return credit ? { kind, id: credit.id, name: credit.name } : null
  }
  const raw = (track._providerData as { youtubeMusic?: YoutubeMusicItem } | null)?.youtubeMusic
  const name = track.albumName
  const id = track.albumId || (raw?.albumId ? `ytmusic:${raw.albumId}` : null)
  return name || id || track.id ? { kind, id, name, artist: track.artistName, year: track.albumYear || track.year, trackId: track.id } : null
}
export const albumArtistEntity = (album: MusicAlbum): MusicEntityRef => {
  const credit = itemArtistCredits(album)[0]
  return { kind: "artist", id: credit?.id, name: credit?.name || album.artistName }
}

