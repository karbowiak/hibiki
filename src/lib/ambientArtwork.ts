import type { LibraryState } from "../stores/libraryStore"
import type { MusicArtist, MusicTrack, MusicItem } from "../types/music"
export interface AmbientCandidate {
  key: string
  kind: "artist" | "album" | "plain"
  id: string
  src: string
  artist: string | null
  album: string | null
}
export function eligibleAmbientUrl(
  src: string | null | undefined,
  scope: string
): src is string {
  if (!src) return false
  try {
    const url = new URL(src)
    if (url.username || url.password || url.hash) return false
    const native =
      (url.protocol === "image:" && url.hostname === "localhost") ||
      (["http:", "https:"].includes(url.protocol) &&
        url.hostname === "image.localhost")
    if (native) {
      const source = url.searchParams.get("src")
      if (
        !source ||
        url.port ||
        (url.searchParams.get("scope") &&
          url.searchParams.get("scope") !== scope)
      )
        return false
      const upstream = new URL(source)
      return (
        ["http:", "https:"].includes(upstream.protocol) &&
        !upstream.username &&
        !upstream.password
      )
    }
    return ["http:", "https:"].includes(url.protocol)
  } catch {
    return false
  }
}
export function collectAmbientCandidates(
  library: Pick<
    LibraryState,
    | "likedArtists"
    | "likedAlbums"
    | "latestReleases"
    | "recentlyAdded"
    | "hubs"
    | "likedTracks"
    | "playlists"
  >,
  scope: string
): AmbientCandidate[] {
  const result: AmbientCandidate[] = [],
    seen = new Set<string>()
  const add = (item: MusicItem) => {
    if (
      !item ||
      !item.id ||
      !["artist", "album", "track", "playlist"].includes(item.type)
    )
      return
    let kind: AmbientCandidate["kind"] = "plain",
      artist: string | null = null,
      album: string | null = null,
      id = item.id
    let src = item.thumbUrl
    if (item.type === "artist") {
      kind = "artist"
      artist = item.title
      src = eligibleAmbientUrl(item.artUrl, scope) ? item.artUrl : item.thumbUrl
    }
    if (item.type === "album") {
      kind = "album"
      artist = item.artistName
      album = item.title
    }
    if (item.type === "track") {
      kind = "album"
      artist = item.artistName
      album = item.albumName
      id = item.albumId ?? item.id
      src = item.albumThumbUrl ?? item.thumbUrl
    }
    if (!eligibleAmbientUrl(src, scope)) return
    const key = JSON.stringify([kind, id, artist, album])
    if (seen.has(key) || result.some((candidate) => candidate.src === src))
      return
    seen.add(key)
    result.push({ key, kind, id, src, artist, album })
  }
  // Inspect bounded slices only: no playlist-item caches or library-wide reads.
  const items: MusicItem[] = [
    ...(library.likedArtists ?? [])
      .slice(0, 32)
      .filter((a) => a.artUrl)
      .map((a) => ({ ...a, type: "artist" as const })),
    ...(library.latestReleases ?? [])
      .slice(0, 32)
      .map((a) => ({ ...a, type: "album" as const })),
    ...(library.likedAlbums ?? [])
      .slice(0, 32)
      .map((a) => ({ ...a, type: "album" as const })),
    ...(library.recentlyAdded ?? []).slice(0, 32),
    ...(library.hubs ?? []).slice(0, 16).flatMap((h) => h.items.slice(0, 8)),
    ...(library.likedArtists ?? [])
      .slice(0, 32)
      .map((a) => ({ ...a, type: "artist" as const })),
    ...(library.likedTracks ?? [])
      .slice(0, 32)
      .map((a) => ({ ...a, type: "track" as const })),
    ...(library.playlists ?? [])
      .slice(0, 16)
      .map((a) => ({ ...a, type: "playlist" as const })),
  ]
  for (const item of items) {
    if (result.length === 96) break
    add(item)
  }
  return result
}

/** Only artwork whose artist or album occurs among this playlist's loaded members. */
export function collectPlaylistAmbientCandidates(
  tracks: readonly MusicTrack[],
  scope: string,
  artists: readonly MusicArtist[] = []
): AmbientCandidate[] {
  const result: AmbientCandidate[] = [],
    seen = new Set<string>(),
    urls = new Set<string>()
  const add = (
    kind: "artist" | "album",
    id: string | null,
    src: string | null,
    artist: string,
    album: string | null
  ) => {
    if (!id || !artist || !eligibleAmbientUrl(src, scope)) return
    const key = JSON.stringify([kind, id, artist, album])
    if (seen.has(key) || urls.has(src)) return
    seen.add(key)
    urls.add(src)
    result.push({ key, kind, id, src, artist, album })
  }
  const knownArtists = new Map(
    artists.slice(0, 256).map((artist) => [artist.id, artist])
  )
  for (const track of tracks.slice(0, 512)) {
    if (!track) continue
    const cachedArtist = track.artistId
      ? knownArtists.get(track.artistId)
      : undefined
    const knownArtist =
      cachedArtist?.title === track.artistName ? cachedArtist : undefined
    add(
      "artist",
      track.artistId,
      eligibleAmbientUrl(knownArtist?.artUrl, scope)
        ? knownArtist.artUrl
        : track.artistThumbUrl,
      track.artistName,
      null
    )
    add(
      "album",
      track.albumId,
      track.albumThumbUrl ?? track.thumbUrl,
      track.artistName,
      track.albumName
    )
    if (result.length >= 96) break
  }
  return result.slice(0, 96)
}
export function isCurrentPlaylistRoute(
  route: string,
  id: string | null | undefined
): boolean {
  if (!id) return false
  return (
    route === `/playlist/${id}` ||
    route === decodeURI(`/playlist/${encodeURIComponent(id)}`)
  )
}
