import { useEffect } from "react"
import type { StoreApi, UseBoundStore } from "zustand"
import type {
  CacheEntry,
  MetadataStoreState,
} from "../stores/createMetadataStore"

interface Options<A, B> {
  kind: "artist" | "album"
  artist: string | null
  title: string | null
  enabled: boolean
  allowFetch: boolean
  offline: boolean
  statusLoaded: boolean
  loadStatus(): Promise<void>
  reviewedChoice: boolean
  reviewedLease: unknown
  maxAge?: number
  validate(artist?: CacheEntry<A>, album?: CacheEntry<B>): boolean
}
type ArtworkState<A, B> = Pick<
  MetadataStoreState<A, B>,
  | "artists"
  | "albums"
  | "_hasHydrated"
  | "_loadingArtists"
  | "_loadingAlbums"
  | "getArtist"
  | "getAlbum"
>

/** Provider-specific identity/revision proof stays with the artwork adapter. */
export function useArtworkCache<A, B>(
  store: UseBoundStore<StoreApi<ArtworkState<A, B>>>,
  options: Options<A, B>
) {
  const {
    kind,
    artist,
    title,
    enabled,
    allowFetch,
    offline,
    statusLoaded,
    loadStatus,
    reviewedChoice,
    reviewedLease,
    maxAge = Infinity,
  } = options
  const key =
    kind === "artist"
      ? (artist?.toLowerCase() ?? "")
      : artist && title
        ? `${artist.toLowerCase()}::${title.toLowerCase()}`
        : ""
  const artistEntry = store((state) =>
    kind === "artist" ? state.artists[key] : undefined
  )
  const albumEntry = store((state) =>
    kind === "album" ? state.albums[key] : undefined
  )
  const hydrated = store((state) => state._hasHydrated)
  const pending = store(
    (state) =>
      !!(kind === "artist"
        ? state._loadingArtists[key]
        : state._loadingAlbums[key])
  )
  const getArtist = store((state) => state.getArtist)
  const getAlbum = store((state) => state.getAlbum)
  const data = artistEntry?.data ?? albumEntry?.data
  const valid = enabled && options.validate(artistEntry, albumEntry)
  useEffect(() => {
    if ((allowFetch || offline) && !statusLoaded) void loadStatus()
    if (
      reviewedChoice ||
      !allowFetch ||
      offline ||
      !enabled ||
      !hydrated ||
      !artist ||
      (kind === "album" && !title)
    )
      return
    const entry = kind === "artist" ? artistEntry : albumEntry
    if (
      entry &&
      Date.now() - entry.cachedAt < maxAge &&
      (entry.data === null || valid)
    )
      return
    if (kind === "artist") void getArtist(artist).catch(() => {})
    else void getAlbum(artist, title!).catch(() => {})
  }, [
    allowFetch,
    reviewedChoice,
    reviewedLease,
    offline,
    statusLoaded,
    enabled,
    hydrated,
    artist,
    title,
    kind,
    artistEntry,
    albumEntry,
    valid,
    maxAge,
    getArtist,
    getAlbum,
    loadStatus,
  ])
  return { key, data, valid, pending: enabled && (!hydrated || pending) }
}
