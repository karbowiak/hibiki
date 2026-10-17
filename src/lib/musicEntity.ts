import type { MusicAlbum, MusicTrack } from "../types/music"
import type { YoutubeMusicItem } from "../backends/ytmusic/discovery"

export type MusicEntityKind = "artist" | "album"
export interface MusicEntityRef {
  kind: MusicEntityKind
  id?: string | null
  name: string
  artist?: string
  year?: number | null
}
export function musicEntityHref(kind: MusicEntityKind, id?: string | null) {
  if (!id) return null
  return id.startsWith("ytmusic:") ? `/ytmusic/${encodeURIComponent(id.slice(8))}` : `/${kind}/${encodeURIComponent(id)}`
}
export function trackEntity(track: MusicTrack | null | undefined, kind: MusicEntityKind): MusicEntityRef | null {
  if (!track) return null
  const raw = (track._providerData as { youtubeMusic?: YoutubeMusicItem } | null)?.youtubeMusic
  const name = kind === "artist" ? track.artistName : track.albumName
  const id = (kind === "artist" ? track.artistId : track.albumId) ??
    ((kind === "artist" ? raw?.artistId : raw?.albumId) ? `ytmusic:${kind === "artist" ? raw!.artistId : raw!.albumId}` : null)
  return name || id ? { kind, id, name, artist: track.artistName, year: track.albumYear || track.year } : null
}
export const albumArtistEntity = (album: MusicAlbum): MusicEntityRef => ({ kind: "artist", id: album.artistId, name: album.artistName })

