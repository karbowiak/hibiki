import type { MusicItem, MusicTrack } from "../types/music"
import type { MusicProvider } from "../providers/types"

interface PlayStore {
  playTrack: (track: MusicTrack, queue?: MusicTrack[], title?: string, sourceUri?: string | null, albumPlaybackId?: string | null) => Promise<void>
  playFromUri: (uri: string, forceShuffle?: boolean, title?: string, sourceUri?: string | null, albumPlaybackId?: string | null) => Promise<void>
  playPlaylist: (playlistId: string, totalCount: number, title: string, sourceUri: string | null) => Promise<void>
  provider: MusicProvider | null
}

/**
 * Returns an onPlay callback for a MusicItem, or undefined if the item
 * type is not playable (or provider is not available).
 */
export function makeOnPlay(item: MusicItem, store: PlayStore): (() => void) | undefined {
  const { playTrack, playFromUri, playPlaylist, provider } = store
  if (item.type === "track") {
    return () => void playTrack(item, [item], item.artistName, null)
  }
  if (!provider) return undefined
  if (item.type === "album") {
    if (provider.buildItemUri) {
      const uri = provider.buildItemUri(`/library/metadata/${item.id}`)
      if (uri) return () => void playFromUri(uri, false, item.title, `/album/${item.id}`, item.id)
    }
    return () => void provider.getAlbumTracks(item.id).then(tracks => {
      if (tracks.length > 0) playTrack(tracks[0], tracks, item.title, `/album/${item.id}`, item.id)
    })
  }
  if (item.type === "artist") {
    if (provider.buildItemUri) {
      const uri = provider.buildItemUri(`/library/metadata/${item.id}`)
      if (uri) return () => void playFromUri(uri, false, item.title, `/artist/${item.id}`)
    }
    return () => void provider.getArtistPopularTracks(item.id).then(tracks => {
      if (tracks.length > 0) playTrack(tracks[0], tracks, item.title, `/artist/${item.id}`)
    })
  }
  if (item.type === "playlist") {
    return () => void playPlaylist(item.id, item.trackCount, item.title, `/playlist/${item.id}`)
  }
  return undefined
}
