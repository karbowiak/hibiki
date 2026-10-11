/**
 * Priority-aware image resolution hooks.
 *
 * Each hook reads the source priority from metadataSourceStore and returns the
 * best available image URL based on what has been fetched so far (waterfall:
 * shows best currently-known image, upgrades on re-render when higher-priority
 * source resolves).
 *
 * When a metadata source wins, the hook builds a semantic image URL using
 * buildImageUrl() with the entity info embedded — the Rust handler then
 * fetches + caches the CDN image.
 *
 * Hooks use stable Zustand selectors (returning existing object references, not
 * new objects) to avoid the infinite-loop issue documented in MEMORY.md.
 */

import { useEffect } from "react"
import { useMetadataSourceStore, type MetadataSource } from "../stores/metadataSourceStore"
import { useDeezerMetadataStore } from "../metadata/deezer/store"
import { useItunesMetadataStore } from "../metadata/apple/store"
import { buildImageUrl } from "../lib/imageUrl"

/** Fetch a source only when it can improve the currently available artwork. */
function shouldWarmSource(
  priority: MetadataSource[],
  source: MetadataSource,
  available: Partial<Record<MetadataSource, string | null>>,
): boolean {
  const rank = priority.indexOf(source)
  return rank !== -1 && !priority.slice(0, rank).some(s => available[s])
}

/**
 * Returns the best available image for an artist per the current source priority.
 * Only Plex and Deezer have artist images; Last.fm and Apple are always skipped.
 *
 * @param artistName  Artist name used for external lookups (null = skip all external)
 * @param plexThumb   Plex artist.thumb URL (already an image:// URL or null)
 * @param artistId    Entity ID for building semantic URLs
 */
export function useArtistImage(
  artistName: string | null,
  plexThumb: string | null,
  artistId?: string | null,
): string | null {
  const priority = useMetadataSourceStore(s => s.priority)

  const key = artistName?.toLowerCase() ?? ""
  // Stable selector — returns the existing CacheEntry object ref (or undefined).
  // Re-renders only when THIS artist's entry changes in the store.
  const deezerEntry = useDeezerMetadataStore(s => key ? s.artists[key] : undefined)
  const getDeezerArtist = useDeezerMetadataStore(s => s.getArtist)
  const deezerHydrated = useDeezerMetadataStore(s => s._hasHydrated)

  // Warm the Deezer cache when this artist hasn't been fetched yet.
  // Gate on hydration to avoid firing fetches before IndexedDB data loads.
  useEffect(() => {
    if (!deezerHydrated || !artistName || deezerEntry !== undefined
      || !shouldWarmSource(priority, "deezer", { plex: plexThumb })) return
    void getDeezerArtist(artistName)
  }, [priority, plexThumb, deezerHydrated, artistName, deezerEntry !== undefined, getDeezerArtist])

  const deezerUrl = deezerEntry?.data?.image_url ?? null

  for (const source of priority) {
    if (source === "plex" && plexThumb) return plexThumb
    if (source === "deezer" && deezerUrl) {
      const id = artistId ?? key
      return id ? buildImageUrl("artist", id, deezerUrl, artistName) : null
    }
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
 * @param plexThumb   Plex album.thumb URL (already an image:// URL or null)
 * @param albumId     Entity ID for building semantic URLs
 */
export function useAlbumImage(
  artistName: string | null,
  albumName: string | null,
  plexThumb: string | null,
  albumId?: string | null,
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
  const deezerHydrated = useDeezerMetadataStore(s => s._hasHydrated)
  const itunesHydrated = useItunesMetadataStore(s => s._hasHydrated)

  const deezerUrl = deezerEntry?.data?.cover_url ?? null
  const appleUrl  = itunesEntry?.data?.cover_url ?? null

  // Warm caches when entries are missing.
  // Gate on hydration to avoid firing fetches before IndexedDB data loads.
  // An available lower-priority image must not prevent an upgrade.
  useEffect(() => {
    if (!artistName || !albumName) return
    if (deezerHydrated && deezerEntry === undefined
      && shouldWarmSource(priority, "deezer", { plex: plexThumb, apple: appleUrl })) void getDeezerAlbum(artistName, albumName)
    if (itunesHydrated && itunesEntry === undefined
      && shouldWarmSource(priority, "apple", { plex: plexThumb, deezer: deezerUrl })) void getItunesAlbum(artistName, albumName)
  }, [priority, artistName, albumName, plexThumb, deezerUrl, appleUrl, deezerHydrated, itunesHydrated, deezerEntry !== undefined, itunesEntry !== undefined, getDeezerAlbum, getItunesAlbum])

  for (const source of priority) {
    if (source === "plex"   && plexThumb) return plexThumb
    if (source === "deezer" && deezerUrl) {
      const id = albumId ?? key
      return id ? buildImageUrl("album", id, deezerUrl, albumName, artistName) : null
    }
    if (source === "apple" && appleUrl) {
      const id = albumId ?? key
      return id ? buildImageUrl("album", id, appleUrl, albumName, artistName) : null
    }
    // "lastfm" has no album images — skip
  }

  return plexThumb ?? null
}
