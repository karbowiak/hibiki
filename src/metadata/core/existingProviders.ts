import { useDeezerMetadataStore } from "../deezer/store"
import { useItunesMetadataStore } from "../apple/store"
import { useLastfmMetadataStore } from "../lastfm/store"
import { useMusicBrainzMetadataStore } from "../musicbrainz/store"
import { nativeHeyaAdapter } from "../heya/adapter"
import { useHeyaServiceStore } from "../services/store"
import { fanartMetadataAdapter } from "../fanart/adapter"
import { theAudioDbAdapter } from "../theaudiodb/adapter"
import { publicMetadataProviders } from "./publicProviders"
import { createExistingMetadataAdapters } from "./adapters"
import type { MetadataIdentity } from "./types"
/** Bind existing providers lazily; importing this does not issue network requests. */
export function existingMetadataProviders() {
  const adapters = createExistingMetadataAdapters({
    deezer: {
      artist: (name) => useDeezerMetadataStore.getState().getArtist(name),
      album: (artist, title) =>
        useDeezerMetadataStore.getState().getAlbum(artist, title),
    },
    apple: {
      artist: (name) => useItunesMetadataStore.getState().getArtist(name),
      album: (artist, title) =>
        useItunesMetadataStore.getState().getAlbum(artist, title),
    },
    lastfm: {
      artist: (name) => useLastfmMetadataStore.getState().getArtist(name),
      album: (artist, title) =>
        useLastfmMetadataStore.getState().getAlbum(artist, title),
      track: (artist, title) =>
        useLastfmMetadataStore.getState().getTrack(artist, title),
    },
    musicbrainz: {
      artist: (name) => useMusicBrainzMetadataStore.getState().getArtist(name),
      album: (artist, title) =>
        useMusicBrainzMetadataStore.getState().getAlbum(artist, title),
    },
  })
  for (const adapter of adapters) {
    if (adapter.id === "lastfm") continue // This store has no targeted invalidation; never clear it globally.
    const store =
      adapter.id === "deezer"
        ? useDeezerMetadataStore
        : adapter.id === "apple"
          ? useItunesMetadataStore
          : useMusicBrainzMetadataStore
    adapter.invalidate = (identity: MetadataIdentity) => {
      if (identity.kind === "artist")
        store.getState().invalidateArtist(identity.artist)
      else if (identity.kind === "album")
        store.getState().invalidateAlbum(identity.artist, identity.title ?? "")
    }
  }
  return [
    ...adapters,
    ...publicMetadataProviders(),
    fanartMetadataAdapter,
    theAudioDbAdapter(),
    nativeHeyaAdapter(
      useHeyaServiceStore.getState().status,
      () => useHeyaServiceStore.getState().status
    ),
  ]
}
