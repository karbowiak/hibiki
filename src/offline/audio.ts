import type { MusicTrack } from "../types/music"
import type { MusicProvider } from "../providers/types"
import { buildPlexImageUrl } from "../backends/plex/imageUrl"
import { freshPlaylistReads } from "./providerCache"

export interface LocalAudioItem {
  trackId: number
  track: MusicTrack | null
  status:
    | "queued"
    | "downloading"
    | "paused"
    | "downloaded"
    | "error"
    | "cached"
    | "unavailable"
  received: number
  total: number | null
  error: string | null
  available: boolean
}
export interface LocalAudioPage {
  items: LocalAudioItem[]
  total: number
  downloadedBytes: number
}

export function localAudioTrack(
  raw: MusicTrack,
  baseUrl: string,
  scope: string
): MusicTrack {
  const paths = raw as MusicTrack & {
    localAlbumThumbPath?: string
    localArtistThumbPath?: string
  }
  const img = (
    path: string | null | undefined,
    type: "track" | "album" | "artist",
    id: string,
    name: string
  ) =>
    path
      ? buildPlexImageUrl(
          baseUrl,
          "native-owned",
          type,
          id,
          path,
          name,
          raw.artistName,
          scope
        )
      : null
  return {
    ...raw,
    mediaInfo: { ...raw.mediaInfo, localAudio: true, offlineAvailable: true, metadataComplete: true },
    thumbUrl: img(raw.rawThumbPath, "track", raw.id, raw.title),
    albumThumbUrl: img(
      paths.localAlbumThumbPath,
      "album",
      raw.albumId ?? raw.id,
      raw.albumName
    ),
    artistThumbUrl: img(
      paths.localArtistThumbPath,
      "artist",
      raw.artistId ?? raw.id,
      raw.artistName
    ),
    streamUrl: null,
  }
}

/** Collection reads are paged and admitted in small batches, without a full-library fetch. */
export async function downloadMedia(
  provider: MusicProvider,
  kind: "track" | "album" | "playlist",
  id: string,
  owns: () => boolean = () => true
): Promise<number> {
  if (provider.isOffline || !provider.downloadTracks)
    throw new Error("Reconnect to Plex to download music.")
  const check = () => {
    if (!owns()) throw new Error("Download selection changed")
  }
  let count = 0
  const seen = new Set<string>()
  const add = async (ids: string[]) => {
    check()
    const fresh = ids.filter((id) => {
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })
    for (let at = 0; at < fresh.length; at += 256) {
      check()
      await provider.downloadTracks!(fresh.slice(at, at + 256))
      check()
      count += Math.min(256, fresh.length - at)
    }
  }
  if (kind === "track") await add([id])
  else if (kind === "album") {
    const tracks = await provider.getAlbumTracks(id)
    check()
    await add(tracks.map((track) => track.id))
  } else {
    const reads = freshPlaylistReads(provider)
    let offset = 0
    for (;;) {
      check()
      const page = await reads.getPlaylistItems(id, offset, 100)
      check()
      if (
        page.items.length > 100 ||
        (page.offset !== undefined && page.offset !== offset)
      )
        throw new Error(
          "Plex returned an unexpected playlist page. Downloaded batches are retained."
        )
      await add(page.items.map((track) => track.id))
      if (!page.items.length || offset + page.items.length >= page.total) break
      offset += page.items.length
      if (offset >= 10000)
        throw new Error(
          "The first 10,000 tracks are queued. Let them finish before adding more."
        )
    }
  }
  return count
}
