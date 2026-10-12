/**
 * MusicBrainz metadata cache — persisted to IndexedDB via Zustand persist.
 *
 * Rust fetches data from MusicBrainz on demand; this store caches the results
 * client-side with a 7-day TTL to avoid redundant API calls.
 */

import { musicbrainzGetArtistInfo, musicbrainzGetAlbumInfo } from "./api"
import type { MusicBrainzArtistInfo, MusicBrainzAlbumInfo } from "./api"
import { createMetadataStore } from "../../stores/createMetadataStore"

export const useMusicBrainzMetadataStore = createMetadataStore<
  MusicBrainzArtistInfo,
  MusicBrainzAlbumInfo
>({
  storeName: "musicbrainz-metadata-v1",
  fetchArtist: musicbrainzGetArtistInfo,
  fetchAlbum: musicbrainzGetAlbumInfo,
  validateAlbum: (data, artist, album) =>
    data.artist?.trim().toLowerCase() === artist.trim().toLowerCase() &&
    data.title.trim().toLowerCase() === album.trim().toLowerCase(),
})
