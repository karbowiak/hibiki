import { invoke } from "@tauri-apps/api/core"
import type { MusicProvider } from "../providers/types"
import type { CatalogueChange } from "./catalogue"
import { expireProviderMetadata, offlinePrefix } from "./providerCache"
import { expireMetadataItem, metadataParents } from "../stores/metadataCache"
import { playbackMetadata } from "../audio/playbackMetadata"
import { useCatalogueStore } from "./catalogueStore"

const summaries = [
  "search",
  "getHubs",
  "getRecentlyAdded",
  "getLatestReleases",
  "getAllArtists",
  "getAllAlbums",
  "getAllTracks",
]
const artistLists = [
  "getArtistAlbums",
  "getArtistAlbumsInSection",
  "getArtistPopularTracks",
  "getArtistPopularTracksInSection",
  "getArtistSimilar",
  "getArtistStations",
  "getRelatedHubs",
]
/** Websocket hints invalidate visited data; they never schedule a library crawl.
 * Resolve a few missing parents, then conservatively expire visited relationship
 * lists for an overflow/scan. The matching index retains its independent path. */
export async function expireMetadataEvents(
  provider: MusicProvider,
  changes: CatalogueChange[],
  catchup: boolean,
  current: () => boolean
) {
  if (!current()) return
  const prefixes = new Set(summaries.map((method) => offlinePrefix(method)))
  const removed = changes
    .filter((change) => change.state === 9)
    .map((change) => String(change.id))
  const parents = new Map<string, { artists: string[]; albums: string[] }>()
  const unknown: CatalogueChange[] = []
  for (const change of changes) {
    if (![8, 9, 10].includes(change.type)) continue
    const kind =
        change.type === 8 ? "artist" : change.type === 9 ? "album" : "track",
      id = String(change.id)
    const known = metadataParents(kind, id)
    parents.set(id, known)
    if (kind !== "artist" && !known.artists.length && change.state !== 9)
      unknown.push(change)
    // Collect entity and relationship dependencies before persisting expiry.
    prefixes.add(
      offlinePrefix(
        kind === "artist"
          ? "getArtist"
          : kind === "album"
            ? "getAlbum"
            : "getTrack",
        id
      )
    )
    if (kind === "album") known.albums.push(id)
    if (kind === "artist") known.artists.push(id)
  }
  if (
    catchup ||
    unknown.length > 8 ||
    changes.some(
      (change) =>
        change.state === 9 && !parents.get(String(change.id))?.artists.length
    )
  ) {
    for (const method of [
      "getArtist",
      "getAlbum",
      "getTrack",
      "getAlbumTracks",
      ...artistLists,
    ])
      prefixes.add(offlinePrefix(method))
  }
  // The provider's native request owner is captured by its scoped API. Resolve
  // it from the active context rather than serializing playback credentials.
  const nativeContext = useCatalogueStore.getState().context
  if (nativeContext && nativeContext.cacheScope === provider.cacheScope) {
    await invoke("plex_metadata_expire", {
      context: nativeContext,
      ids: [
        ...new Set([
          ...changes.map((change) => String(change.id)),
          ...[...parents.values()].flatMap((parent) => [
            ...parent.albums,
            ...parent.artists,
          ]),
        ]),
      ],
      catchup: catchup || unknown.length > 0,
      removed,
    })
    if (!current()) return
  }
  for (const change of changes) {
    if ([8, 9, 10].includes(change.type))
      expireMetadataItem(
        change.type === 8 ? "artist" : change.type === 9 ? "album" : "track",
        String(change.id),
        change.state === 9
      )
  }
  if (
    catchup ||
    unknown.length > 8 ||
    changes.some(
      (change) =>
        change.state === 9 && !parents.get(String(change.id))?.artists.length
    )
  )
    expireMetadataItem()
  // Persist expiry first: a shutdown while parent resolution is pending must
  // not lose the event, nor let a pre-event request publish a fresh snapshot.
  const list = [...prefixes]
  for (let at = 0; at < list.length; at += 32)
    await expireProviderMetadata(
      provider,
      list.slice(at, at + 32),
      at === 0 ? removed : undefined
    )
  if (!current()) return
  const raw = provider
  if (!catchup && unknown.length <= 8)
    for (const change of unknown) {
      try {
        const item =
          change.type === 10
            ? await raw.getTrack(String(change.id))
            : await raw.getAlbum(String(change.id))
        if (!current()) return
        const known = parents.get(String(change.id))!
        if ("artistId" in item && item.artistId)
          known.artists.push(item.artistId)
        if ("albumId" in item && item.albumId) known.albums.push(item.albumId)
      } catch {
        /* TTL and conservative list expiry cover unavailable parents. */
      }
    }
  const dependent = new Set<string>()
  for (const known of parents.values()) {
    for (const id of known.albums) {
      expireMetadataItem("album", id)
      dependent.add(offlinePrefix("getAlbum", id))
      dependent.add(offlinePrefix("getAlbumTracks", id))
    }
    for (const id of known.artists) {
      expireMetadataItem("artist", id)
      dependent.add(offlinePrefix("getArtist", id))
      for (const method of artistLists) dependent.add(offlinePrefix(method, id))
    }
  }
  const dependencies = [...dependent]
  for (let at = 0; at < dependencies.length; at += 32) {
    if (!current()) return
    await expireProviderMetadata(provider, dependencies.slice(at, at + 32))
  }
  playbackMetadata.invalidate(provider)
}
