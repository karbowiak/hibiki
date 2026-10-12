/**
 * Deezer metadata cache — persisted to IndexedDB via Zustand persist.
 *
 * Rust fetches data from Deezer on demand; this store caches the results
 * client-side with a 7-day TTL to avoid redundant API calls.
 *
 * Naming conventions for cache keys:
 *   - artists : lowercase artist name
 *   - albums  : `${artist.toLowerCase()}::${album.toLowerCase()}`
 */

import { deezerSearchArtist, deezerSearchAlbum } from "./api"
import type { DeezerArtistInfo, DeezerAlbumInfo } from "./api"
import { createMetadataStore } from "../../stores/createMetadataStore"
import { albumMatches, albumMatchesCacheKey } from "../albumMatch"

export const useDeezerMetadataStore = createMetadataStore<DeezerArtistInfo, DeezerAlbumInfo>({
  storeName: "deezer-metadata-v1",
  fetchArtist: deezerSearchArtist,
  fetchAlbum: deezerSearchAlbum,
  validateAlbum: albumMatches,
  validateCachedAlbum: albumMatchesCacheKey,
})
