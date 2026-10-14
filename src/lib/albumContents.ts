import type { MusicProvider } from "../providers/types"
import type { MusicAlbum, MusicTrack } from "../types/music"
import { deduplicateAlbums, mergeAlbumTracks } from "./dedup"
import { useUIStore } from "../stores/uiStore"

/** Compose through the connected provider's local-first/offline reads. Never
 * bypass its proxy with raw Plex transport, or rewrite physical track IDs. */
export async function loadAlbumContents(
  provider: MusicProvider,
  id: string,
  deduplicate = useUIStore.getState().deduplicateAlbums
): Promise<{ album: MusicAlbum; tracks: MusicTrack[] }> {
  const scope = provider.cacheScope,
    session = provider.playbackSession
  const check = () => {
    if (provider.cacheScope !== scope || provider.playbackSession !== session)
      throw new Error("Album request was superseded")
  }
  const [album, ownTracks] = await Promise.all([
    provider.getAlbum(id),
    provider.getAlbumTracks(id),
  ])
  check()
  if (album.id !== id) throw new Error("Server returned a different album")
  if (ownTracks.some((track) => track.albumId && track.albumId !== id))
    throw new Error("Server returned tracks from a different album")
  if (!deduplicate || !album.artistId) return { album, tracks: ownTracks }
  const siblings = provider.getArtistAlbumsInSection
    ? await provider.getArtistAlbumsInSection(album.artistId)
    : await provider.getArtistAlbums(album.artistId)
  check()
  const group = deduplicateAlbums([...siblings, album]).find(
    (group) => group.id === id || group._alternateIds?.includes(id)
  )
  const ids = [
    ...new Set([
      id,
      ...(group ? [group.id, ...(group._alternateIds ?? [])] : []),
    ]),
  ]
  if (ids.length === 1) return { album, tracks: ownTracks }
  if (ids.length > 128)
    throw new Error("This album has too many physical copies to combine")
  const copies: MusicTrack[][] = [ownTracks]
  let next = 1
  const worker = async () => {
    while (next < ids.length) {
      const physical = ids[next++]
      check()
      const tracks = await provider.getAlbumTracks(physical)
      check()
      if (tracks.some((track) => track.albumId && track.albumId !== physical))
        throw new Error("Server returned tracks from a different album")
      copies.push(tracks)
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, ids.length - 1) }, worker))
  check()
  const tracks = mergeAlbumTracks(copies.flat(), ids, provider.isOffline)
  return {
    album: {
      ...album,
      _alternateIds: ids.filter((alias) => alias !== id),
      trackCount: tracks.length,
    },
    tracks,
  }
}

export async function loadAlbumTracks(
  provider: MusicProvider,
  id: string
): Promise<MusicTrack[]> {
  if (typeof provider.getAlbum !== "function")
    return provider.getAlbumTracks(id)
  return (await loadAlbumContents(provider, id)).tracks
}
