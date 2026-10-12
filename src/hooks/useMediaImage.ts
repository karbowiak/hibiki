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

import { useEffect, useMemo } from "react"
import {
  useMetadataSourceStore,
  type MetadataSource,
} from "../stores/metadataSourceStore"
import { useDeezerMetadataStore } from "../metadata/deezer/store"
import { useItunesMetadataStore } from "../metadata/apple/store"
import { buildImageUrl } from "../lib/imageUrl"
import { useProviderStore } from "../stores/providerStore"
import {
  artworkPreferenceKey,
  artworkRevisionKey,
  applyArtworkRevision,
  useArtworkPreferenceStore,
  type ArtworkSource,
} from "../stores/artworkPreferenceStore"
import { albumMatches } from "../metadata/albumMatch"

export interface ArtworkResolution {
  url: string | null
  source: ArtworkSource | null
  preference: ArtworkSource | null
  fallback: boolean
  pending: boolean
  candidates: Partial<Record<ArtworkSource, string | null>>
  /** Valid identity/source URLs remain refreshable even after image-load failure. */
  refreshTargets: Partial<Record<ArtworkSource, string | null>>
}
function useArtworkOrder(
  kind: "artist" | "album",
  artist: string | null,
  album?: string | null
) {
  const global = useMetadataSourceStore((s) => s.priority)
  const scope = useProviderStore((s) => s.provider?.cacheScope)
  const key = artworkPreferenceKey(scope, kind, artist, album)
  const preference = useArtworkPreferenceStore((s) =>
    key ? (s.choices[key] ?? null) : null
  )
  const priority = useMemo(
    () =>
      preference
        ? [preference, ...global.filter((s) => s !== preference)]
        : global,
    [global, preference]
  )
  const revisions = useArtworkPreferenceStore((s) => s.revisions)
  const revise = (url: string | null) => {
    const key = artworkRevisionKey(scope, url)
    return applyArtworkRevision(url, key ? revisions[key] : undefined)
  }
  return { priority, preference, scope, revise }
}
function resolution(
  priority: MetadataSource[],
  preference: ArtworkSource | null,
  candidates: ArtworkResolution["candidates"],
  pending: boolean,
  refreshTargets: ArtworkResolution["refreshTargets"] = candidates
): ArtworkResolution {
  const source = priority.find(
    (s) =>
      ["plex", "deezer", "apple"].includes(s) && candidates[s as ArtworkSource]
  ) as ArtworkSource | undefined
  const actual = source ?? (candidates.plex ? "plex" : null)
  return {
    url: actual ? (candidates[actual] ?? null) : null,
    source: actual,
    preference,
    fallback: !!preference && actual !== preference,
    pending,
    candidates,
    refreshTargets,
  }
}

/** Fetch a source only when it can improve the currently available artwork. */
function shouldWarmSource(
  priority: MetadataSource[],
  source: MetadataSource,
  available: Partial<Record<MetadataSource, string | null>>
): boolean {
  const rank = priority.indexOf(source)
  return (
    rank !== -1 &&
    !priority
      .slice(0, rank)
      .some((s) => Object.hasOwn(available, s) && available[s])
  )
}

/**
 * Returns the best available image for an artist per the current source priority.
 * Only Plex and Deezer have artist images; Last.fm and Apple are always skipped.
 *
 * @param artistName  Artist name used for external lookups (null = skip all external)
 * @param plexThumb   Plex artist.thumb URL (already an image:// URL or null)
 * @param artistId    Entity ID for building semantic URLs
 */
export function useArtistArtwork(
  artistName: string | null,
  plexThumb: string | null,
  artistId?: string | null,
  failedUrls: readonly string[] = []
): ArtworkResolution {
  const { priority, preference, scope, revise } = useArtworkOrder(
    "artist",
    artistName
  )
  plexThumb = revise(plexThumb)
  const plexTarget = plexThumb
  if (plexThumb && failedUrls.includes(plexThumb)) plexThumb = null

  const key = artistName?.toLowerCase() ?? ""
  // Stable selector — returns the existing CacheEntry object ref (or undefined).
  // Re-renders only when THIS artist's entry changes in the store.
  const deezerEntry = useDeezerMetadataStore((s) =>
    key ? s.artists[key] : undefined
  )
  const deezerPending = useDeezerMetadataStore(
    (s) => !!s._loadingArtists?.[key]
  )
  const getDeezerArtist = useDeezerMetadataStore((s) => s.getArtist)
  const deezerHydrated = useDeezerMetadataStore((s) => s._hasHydrated)

  // Warm the Deezer cache when this artist hasn't been fetched yet.
  // Gate on hydration to avoid firing fetches before IndexedDB data loads.
  useEffect(() => {
    if (
      !deezerHydrated ||
      !artistName ||
      deezerEntry !== undefined ||
      !shouldWarmSource(priority, "deezer", { plex: plexThumb })
    )
      return
    void getDeezerArtist(artistName)
  }, [
    priority,
    plexThumb,
    deezerHydrated,
    artistName,
    deezerEntry !== undefined,
    getDeezerArtist,
  ])

  const rawDeezerUrl = deezerEntry?.data?.image_url ?? null
  const deezerUrl =
    rawDeezerUrl &&
    !failedUrls.includes(
      revise(
        buildImageUrl(
          "artist",
          artistId ?? key,
          rawDeezerUrl,
          artistName,
          undefined,
          scope
        )
      ) ?? ""
    )
      ? rawDeezerUrl
      : null

  return resolution(
    priority,
    preference,
    {
      plex: plexThumb,
      deezer: deezerUrl
        ? revise(
            buildImageUrl(
              "artist",
              artistId ?? key,
              deezerUrl,
              artistName,
              undefined,
              scope
            )
          )
        : null,
    },
    preference === "deezer" && (!deezerHydrated || deezerPending),
    {
      plex: plexTarget,
      deezer: rawDeezerUrl
        ? revise(
            buildImageUrl(
              "artist",
              artistId ?? key,
              rawDeezerUrl,
              artistName,
              undefined,
              scope
            )
          )
        : null,
    }
  )
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
export function useAlbumArtwork(
  artistName: string | null,
  albumName: string | null,
  plexThumb: string | null,
  albumId?: string | null,
  failedUrls: readonly string[] = []
): ArtworkResolution {
  const { priority, preference, scope, revise } = useArtworkOrder(
    "album",
    artistName,
    albumName
  )
  plexThumb = revise(plexThumb)
  const plexTarget = plexThumb
  if (plexThumb && failedUrls.includes(plexThumb)) plexThumb = null

  const key =
    artistName && albumName
      ? `${artistName.toLowerCase()}::${albumName.toLowerCase()}`
      : ""

  const deezerEntry = useDeezerMetadataStore((s) =>
    key ? s.albums[key] : undefined
  )
  const itunesEntry = useItunesMetadataStore((s) =>
    key ? s.albums[key] : undefined
  )
  const deezerPending = useDeezerMetadataStore((s) => !!s._loadingAlbums?.[key])
  const applePending = useItunesMetadataStore((s) => !!s._loadingAlbums?.[key])
  const getDeezerAlbum = useDeezerMetadataStore((s) => s.getAlbum)
  const getItunesAlbum = useItunesMetadataStore((s) => s.getAlbum)
  const deezerHydrated = useDeezerMetadataStore((s) => s._hasHydrated)
  const itunesHydrated = useItunesMetadataStore((s) => s._hasHydrated)

  const deezerInvalid =
    !!deezerEntry &&
    deezerEntry.data !== null &&
    !albumMatches(deezerEntry.data, artistName ?? "", albumName ?? "")
  const appleInvalid =
    !!itunesEntry &&
    itunesEntry.data !== null &&
    !albumMatches(itunesEntry.data, artistName ?? "", albumName ?? "")
  const rawDeezerUrl = !deezerInvalid
    ? (deezerEntry?.data?.cover_url ?? null)
    : null
  const deezerUrl =
    rawDeezerUrl &&
    !failedUrls.includes(
      revise(
        buildImageUrl(
          "album",
          albumId ?? key,
          rawDeezerUrl,
          albumName,
          artistName,
          scope
        )
      ) ?? ""
    )
      ? rawDeezerUrl
      : null
  const rawAppleUrl = !appleInvalid
    ? (itunesEntry?.data?.cover_url ?? null)
    : null
  const appleUrl =
    rawAppleUrl &&
    !failedUrls.includes(
      revise(
        buildImageUrl(
          "album",
          albumId ?? key,
          rawAppleUrl,
          albumName,
          artistName,
          scope
        )
      ) ?? ""
    )
      ? rawAppleUrl
      : null

  // Warm caches when entries are missing.
  // Gate on hydration to avoid firing fetches before IndexedDB data loads.
  // An available lower-priority image must not prevent an upgrade.
  useEffect(() => {
    if (!artistName || !albumName) return
    if (
      deezerHydrated &&
      (deezerEntry === undefined || deezerInvalid) &&
      shouldWarmSource(priority, "deezer", { plex: plexThumb, apple: appleUrl })
    )
      void getDeezerAlbum(artistName, albumName)
    if (
      itunesHydrated &&
      (itunesEntry === undefined || appleInvalid) &&
      shouldWarmSource(priority, "apple", {
        plex: plexThumb,
        deezer: deezerUrl,
      })
    )
      void getItunesAlbum(artistName, albumName)
  }, [
    priority,
    artistName,
    albumName,
    plexThumb,
    deezerUrl,
    appleUrl,
    deezerHydrated,
    itunesHydrated,
    deezerEntry !== undefined,
    itunesEntry !== undefined,
    deezerInvalid,
    appleInvalid,
    getDeezerAlbum,
    getItunesAlbum,
  ])

  return resolution(
    priority,
    preference,
    {
      plex: plexThumb,
      deezer: deezerUrl
        ? revise(
            buildImageUrl(
              "album",
              albumId ?? key,
              deezerUrl,
              albumName,
              artistName,
              scope
            )
          )
        : null,
      apple: appleUrl
        ? revise(
            buildImageUrl(
              "album",
              albumId ?? key,
              appleUrl,
              albumName,
              artistName,
              scope
            )
          )
        : null,
    },
    (preference === "deezer" && (!deezerHydrated || deezerPending)) ||
      (preference === "apple" && (!itunesHydrated || applePending)),
    {
      plex: plexTarget,
      deezer: rawDeezerUrl
        ? revise(
            buildImageUrl(
              "album",
              albumId ?? key,
              rawDeezerUrl,
              albumName,
              artistName,
              scope
            )
          )
        : null,
      apple: rawAppleUrl
        ? revise(
            buildImageUrl(
              "album",
              albumId ?? key,
              rawAppleUrl,
              albumName,
              artistName,
              scope
            )
          )
        : null,
    }
  )
}

/** Backward-compatible URL-only hooks used by existing cards and image consumers. */
export function useArtistImage(
  ...args: Parameters<typeof useArtistArtwork>
): string | null {
  return useArtistArtwork(...args).url
}
export function useAlbumImage(
  ...args: Parameters<typeof useAlbumArtwork>
): string | null {
  return useAlbumArtwork(...args).url
}
