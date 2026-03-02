/**
 * Priority-aware image resolution hooks.
 *
 * Each hook reads the source priority from metadataSourceStore and returns the
 * best available image URL based on what has been fetched so far (waterfall:
 * shows best currently-known image, upgrades on re-render when higher-priority
 * source resolves).
 *
 * Hooks use stable Zustand selectors (returning existing object references, not
 * new objects) to avoid the infinite-loop issue documented in MEMORY.md.
 */

import { useEffect } from "react"
import { useMetadataSourceStore } from "../stores/metadataSourceStore"
import { useDeezerMetadataStore } from "../stores/deezerMetadataStore"
import { useItunesMetadataStore } from "../stores/itunesMetadataStore"
import { buildMetaImageUrl } from "../lib/metadataImage"

/**
 * Returns the best available image for an artist per the current source priority.
 * Only Plex and Deezer have artist images; Last.fm and Apple are always skipped.
 *
 * @param artistName  Artist name used for external lookups (null = skip all external)
 * @param plexThumb   Plex artist.thumb URL (already a pleximg:// URL or null)
 */
export function useArtistImage(
  artistName: string | null,
  plexThumb: string | null,
): string | null {
  const priority = useMetadataSourceStore(s => s.priority)

  const key = artistName?.toLowerCase() ?? ""
  // Stable selector — returns the existing CacheEntry object ref (or undefined).
  // Re-renders only when THIS artist's entry changes in the store.
  const deezerEntry = useDeezerMetadataStore(s => key ? s.artists[key] : undefined)
  const getDeezerArtist = useDeezerMetadataStore(s => s.getArtist)

  // Warm the Deezer cache when this artist hasn't been fetched yet.
  useEffect(() => {
    if (!artistName || deezerEntry !== undefined) return
    void getDeezerArtist(artistName)
  }, [artistName, deezerEntry !== undefined, getDeezerArtist])

  const deezerUrl = deezerEntry?.data?.image_url ?? null

  for (const source of priority) {
    if (source === "plex" && plexThumb) return plexThumb
    if (source === "deezer" && deezerUrl) return buildMetaImageUrl(deezerUrl)
    // "lastfm" and "apple" have no artist images — skip
  }

  // Fallback: show whatever we have
  return plexThumb ?? null
}

/**
 * Returns the best available image for an album per the current source priority.
 * Plex, Deezer, and Apple have album images; Last.fm does not.
 *
 * @param artistName  Artist name (for cache key)
 * @param albumName   Album title (for cache key)
 * @param plexThumb   Plex album.thumb URL (already a pleximg:// URL or null)
 */
export function useAlbumImage(
  artistName: string | null,
  albumName: string | null,
  plexThumb: string | null,
): string | null {
  const priority = useMetadataSourceStore(s => s.priority)

  const key =
    artistName && albumName
      ? `${artistName.toLowerCase()}::${albumName.toLowerCase()}`
      : ""

  const deezerEntry = useDeezerMetadataStore(s => key ? s.albums[key] : undefined)
  const itunesEntry = useItunesMetadataStore(s => key ? s.albums[key] : undefined)
  const getDeezerAlbum = useDeezerMetadataStore(s => s.getAlbum)
  const getItunesAlbum = useItunesMetadataStore(s => s.getAlbum)

  // Warm caches when entries are missing
  useEffect(() => {
    if (!artistName || !albumName) return
    if (deezerEntry === undefined) void getDeezerAlbum(artistName, albumName)
    if (itunesEntry === undefined) void getItunesAlbum(artistName, albumName)
  }, [artistName, albumName, deezerEntry !== undefined, itunesEntry !== undefined, getDeezerAlbum, getItunesAlbum])

  const deezerUrl = deezerEntry?.data?.cover_url ?? null
  const appleUrl  = itunesEntry?.data?.cover_url ?? null

  for (const source of priority) {
    if (source === "plex"   && plexThumb) return plexThumb
    if (source === "deezer" && deezerUrl) return buildMetaImageUrl(deezerUrl)
    if (source === "apple"  && appleUrl)  return buildMetaImageUrl(appleUrl)
    // "lastfm" has no album images — skip
  }

  return plexThumb ?? null
}
