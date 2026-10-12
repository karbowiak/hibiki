/**
 * iTunes metadata cache — persisted to IndexedDB via Zustand persist.
 *
 * Rust fetches data from the iTunes Search API on demand; this store caches
 * the results client-side with aggressive TTLs to avoid redundant API calls.
 * Null results (album not found) are also cached to prevent re-querying.
 *
 * Naming conventions for cache keys:
 *   - artists : lowercase artist name
 *   - albums  : `${artist.toLowerCase()}::${album.toLowerCase()}`
 */

import { itunesSearchArtist, itunesSearchAlbum } from "./api"
import type { ItunesArtistInfo, ItunesAlbumInfo } from "./api"
import { createMetadataStore } from "../../stores/createMetadataStore"
import { albumMatches, albumMatchesCacheKey } from "../albumMatch"

const DAY = 24 * 60 * 60_000

export const useItunesMetadataStore = createMetadataStore<ItunesArtistInfo, ItunesAlbumInfo>({
  storeName: "itunes-metadata-v2",
  fetchArtist: itunesSearchArtist,
  fetchAlbum: itunesSearchAlbum,
  validateAlbum: albumMatches,
  validateCachedAlbum: albumMatchesCacheKey,
  artistTtl: 30 * DAY,   // 30 days — artist data rarely changes
  albumTtl: 90 * DAY,    // 90 days — album metadata is immutable once released
  negativeTtl: 7 * DAY,  // 7 days — retry "not found" after a week
  evictionTtl: 120 * DAY, // 120 days — don't evict before TTL expires
})
