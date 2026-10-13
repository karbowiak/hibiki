import { useReviewedArtwork } from "./useReviewedArtwork"
import { useMetadataIdentityStore } from "../stores/metadataIdentityStore"
import { resolveMetadataIdentity } from "../metadata/identity/resolve"
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

import { useHeyaArtwork } from "./useHeyaArtwork"
import { useFanartArtwork } from "./useFanartArtwork"
import { useEffect, useMemo } from "react"
import { useMetadataSourceStore } from "../stores/metadataSourceStore"
import { useDeezerMetadataStore } from "../metadata/deezer/store"
import { useCoverArtArchiveMetadataStore } from "../metadata/coverartarchive/store"
import { useItunesMetadataStore } from "../metadata/apple/store"
import { buildImageUrl } from "../lib/imageUrl"
import { useProviderStore } from "../stores/providerStore"
import {
  artworkPreferenceKey,
  artworkRevisionKey,
  applyArtworkRevision,
  useArtworkPreferenceStore,
  type ArtworkSource,
  type ArtworkRole,
} from "../stores/artworkPreferenceStore"
import {
  resolveArtworkCandidates,
  type ArtworkCandidate,
} from "../lib/artworkCandidates"
import { albumMatches } from "../metadata/albumMatch"

export interface ArtworkResolution {
  url: string | null
  source: ArtworkSource | null
  preference: ArtworkSource | null
  fallback: boolean
  pending: boolean
  images: Partial<Record<ArtworkSource, readonly ArtworkCandidate[]>>
  candidates: Partial<Record<ArtworkSource, string | null>>
  /** Valid identity/source URLs remain refreshable even after image-load failure. */
  refreshTargets: Partial<Record<ArtworkSource, string | null>>
}
function useArtworkOrder(
  kind: "artist" | "album",
  artist: string | null,
  album?: string | null,
  role: ArtworkRole = "poster"
) {
  const global = useMetadataSourceStore((s) => s.priority)
  const scope = useProviderStore((s) => s.provider?.cacheScope)
  const key = artworkPreferenceKey(scope, kind, artist, album, role)
  const preference = useArtworkPreferenceStore((s) =>
    key ? (s.choices[key] ?? null) : null
  )
  const automatic = useMemo(
    () =>
      role === "background"
        ? ["plex" as const, ...global.filter((source) => source !== "plex")]
        : global,
    [global, role]
  )
  const priority = useMemo(
    () =>
      preference
        ? [preference, ...automatic.filter((s) => s !== preference)]
        : automatic,
    [automatic, preference]
  )
  const revisions = useArtworkPreferenceStore((s) => s.revisions)
  const revise = (url: string | null) => {
    const key = artworkRevisionKey(scope, url, role)
    return applyArtworkRevision(url, key ? revisions[key] : undefined)
  }
  const savedCandidate = useArtworkPreferenceStore((s) =>
    key ? s.candidateChoices[key] : null
  )
  return { priority, preference, scope, revise, savedCandidate }
}
function resolution(
  priority: readonly string[],
  preference: ArtworkSource | null,
  candidates: ArtworkResolution["candidates"],
  pending: boolean,
  refreshTargets: ArtworkResolution["refreshTargets"] = candidates,
  savedCandidate?: { source: ArtworkSource; id: string } | null,
  extraImages: ArtworkResolution["images"] = {},
  failedUrls: readonly string[] = []
): ArtworkResolution {
  const images = {
    ...Object.fromEntries(
      Object.entries(refreshTargets).map(([source, url]) => [
        source,
        url ? [{ id: "default", url }] : [],
      ])
    ),
    ...extraImages,
  }
  const selected = resolveArtworkCandidates(
    images,
    [...priority, ...(!priority.includes("plex") ? ["plex"] : [])],
    preference,
    savedCandidate,
    failedUrls
  )
  return {
    ...selected,
    preference,
    pending,
    images,
    candidates: Object.fromEntries(
      Object.entries(selected.refreshTargets).map(([source, url]) => [
        source,
        url && !failedUrls.includes(url) ? url : null,
      ])
    ),
  }
}

/** Fetch a source only when it can improve the currently available artwork. */
function shouldWarmSource(
  priority: readonly string[],
  source: string,
  available: Partial<Record<string, string | null>>
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
  failedUrls: readonly string[] = [],
  allowFetch = true,
  role: ArtworkRole = "poster"
): ArtworkResolution {
  const offline = useProviderStore((state) => state.provider?.isOffline)
  allowFetch = allowFetch && !offline
  const { priority, preference, scope, revise, savedCandidate } =
    useArtworkOrder("artist", artistName, undefined, role)

  useMetadataIdentityStore((state) => state.choices)
  useMetadataIdentityStore((state) => state.versions)
  useMetadataIdentityStore((state) => state.hydrated)
  const originalIdentity =
    scope && artistName
      ? {
          kind: "artist" as const,
          artist: artistName,
          entityId: artistId ?? undefined,
          scope,
        }
      : undefined
  const reviewedIdentity = originalIdentity
    ? resolveMetadataIdentity(originalIdentity)
    : null
  allowFetch = allowFetch && !!reviewedIdentity?.ready
  artistName = reviewedIdentity?.lookupArtist ?? artistName

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

  const rawDeezerUrl = reviewedIdentity?.ready
    ? (deezerEntry?.data?.image_url ?? null)
    : null
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

  const fanart = useFanartArtwork(
    "artist",
    artistName,
    null,
    artistId,
    role,
    scope,
    revise,
    allowFetch &&
      shouldWarmSource(priority, "fanart", {
        plex: plexThumb,
        deezer: deezerUrl,
      }),
    originalIdentity
  )
  const heya = useHeyaArtwork(
    "artist",
    artistName,
    null,
    artistId,
    role,
    scope,
    revise,
    allowFetch &&
      shouldWarmSource(priority, "heya", {
        plex: plexThumb,
        fanart: fanart.images[0]?.url ?? null,
        deezer: deezerUrl,
      }),
    originalIdentity,
    preference === "heya" && savedCandidate?.source === "heya"
      ? savedCandidate.id
      : undefined
  )
  // Warm the Deezer cache when this artist hasn't been fetched yet.
  // Gate on hydration to avoid firing fetches before IndexedDB data loads.
  useEffect(() => {
    if (
      !allowFetch ||
      !deezerHydrated ||
      !artistName ||
      deezerEntry !== undefined ||
      !shouldWarmSource(priority, "deezer", {
        plex: plexThumb,
        fanart: fanart.images[0]?.url ?? null,
        heya: heya.images[0]?.url ?? null,
      })
    )
      return
    void getDeezerArtist(artistName)
  }, [
    allowFetch,
    reviewedIdentity?.lease,
    priority,
    plexThumb,
    deezerHydrated,
    artistName,
    deezerEntry !== undefined,
    getDeezerArtist,
    fanart.images[0]?.url,
    heya.images[0]?.url,
  ])

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
    (preference === "deezer" && (!deezerHydrated || deezerPending)) ||
      (preference === "fanart" && fanart.pending) ||
      (preference === "heya" && heya.pending),
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
    },
    savedCandidate,
    { fanart: fanart.images, heya: heya.images },
    failedUrls
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
  failedUrls: readonly string[] = [],
  allowFetch = true,
  role: ArtworkRole = "poster"
): ArtworkResolution {
  const offline = useProviderStore((state) => state.provider?.isOffline)
  allowFetch = allowFetch && !offline
  const { priority, preference, scope, revise, savedCandidate } =
    useArtworkOrder("album", artistName, albumName, role)

  useMetadataIdentityStore((state) => state.choices)
  useMetadataIdentityStore((state) => state.versions)
  useMetadataIdentityStore((state) => state.hydrated)
  const originalIdentity =
    scope && artistName
      ? {
          kind: "album" as const,
          artist: artistName,
          title: albumName ?? undefined,
          entityId: albumId ?? undefined,
          scope,
        }
      : undefined
  const reviewedCaa = useReviewedArtwork(
    "coverartarchive",
    originalIdentity ?? null,
    allowFetch &&
      shouldWarmSource(priority, "coverartarchive", { plex: plexThumb })
  )
  const reviewedIdentity = originalIdentity
    ? resolveMetadataIdentity(originalIdentity)
    : null
  allowFetch = allowFetch && !!reviewedIdentity?.ready
  artistName = reviewedIdentity?.lookupArtist ?? artistName
  albumName = reviewedIdentity?.lookupTitle ?? albumName

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
  const caaEntry = useCoverArtArchiveMetadataStore((s) =>
    key ? s.albums[key] : undefined
  )
  const caaHydrated = useCoverArtArchiveMetadataStore((s) => s._hasHydrated)
  const caaPending = useCoverArtArchiveMetadataStore(
    (s) => !!s._loadingAlbums[key]
  )
  const getCaaAlbum = useCoverArtArchiveMetadataStore((s) => s.getAlbum)
  const caaInvalid =
    !!caaEntry?.data &&
    !albumMatches(caaEntry.data, artistName ?? "", albumName ?? "")
  const rawCaaUrl = reviewedIdentity?.choice
    ? (reviewedCaa.data?.posters[0]?.url ?? null)
    : !caaInvalid
      ? (caaEntry?.data?.cover_url ?? null)
      : null
  const caaTarget = rawCaaUrl
    ? revise(
        buildImageUrl(
          "album",
          albumId ?? key,
          rawCaaUrl,
          albumName,
          artistName,
          scope
        )
      )
    : null
  const caaUrl = caaTarget && !failedUrls.includes(caaTarget) ? caaTarget : null
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
  const rawDeezerUrl =
    reviewedIdentity?.ready && !deezerInvalid
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
  const rawAppleUrl =
    reviewedIdentity?.ready && !appleInvalid
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

  const fanart = useFanartArtwork(
    "album",
    artistName,
    albumName,
    albumId,
    role,
    scope,
    revise,
    allowFetch &&
      shouldWarmSource(priority, "fanart", {
        plex: plexThumb,
        deezer: deezerUrl,
        apple: appleUrl,
        coverartarchive: caaUrl,
      }),
    originalIdentity
  )
  const heya = useHeyaArtwork(
    "album",
    artistName,
    albumName,
    albumId,
    role,
    scope,
    revise,
    allowFetch &&
      shouldWarmSource(priority, "heya", {
        plex: plexThumb,
        fanart: fanart.images[0]?.url ?? null,
        deezer: deezerUrl,
        apple: appleUrl,
        coverartarchive: caaUrl,
      }),
    originalIdentity,
    preference === "heya" && savedCandidate?.source === "heya"
      ? savedCandidate.id
      : undefined
  )
  // Warm caches when entries are missing.
  // Gate on hydration to avoid firing fetches before IndexedDB data loads.
  // An available lower-priority image must not prevent an upgrade.
  useEffect(() => {
    if (!allowFetch || !artistName || !albumName) return
    if (
      deezerHydrated &&
      (deezerEntry === undefined || deezerInvalid) &&
      shouldWarmSource(priority, "deezer", {
        plex: plexThumb,
        fanart: fanart.images[0]?.url ?? null,
        heya: heya.images[0]?.url ?? null,
        apple: appleUrl,
        coverartarchive: caaUrl,
      })
    )
      void getDeezerAlbum(artistName, albumName)
    if (
      itunesHydrated &&
      (itunesEntry === undefined || appleInvalid) &&
      shouldWarmSource(priority, "apple", {
        plex: plexThumb,
        fanart: fanart.images[0]?.url ?? null,
        heya: heya.images[0]?.url ?? null,
        deezer: deezerUrl,
        coverartarchive: caaUrl,
      })
    )
      void getItunesAlbum(artistName, albumName)
    if (
      !reviewedIdentity?.choice &&
      caaHydrated &&
      (caaEntry === undefined || caaInvalid) &&
      shouldWarmSource(priority, "coverartarchive", {
        plex: plexThumb,
        fanart: fanart.images[0]?.url ?? null,
        heya: heya.images[0]?.url ?? null,
        deezer: deezerUrl,
        apple: appleUrl,
      })
    )
      void getCaaAlbum(artistName, albumName)
  }, [
    allowFetch,
    reviewedIdentity?.lease,
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
    fanart.images[0]?.url,
    heya.images[0]?.url,
    caaHydrated,
    caaEntry !== undefined,
    caaInvalid,
    caaUrl,
    getCaaAlbum,
  ])

  return resolution(
    priority,
    preference,
    {
      plex: plexThumb,
      coverartarchive: caaUrl,
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
      (preference === "apple" && (!itunesHydrated || applePending)) ||
      (preference === "coverartarchive" &&
        (reviewedIdentity?.choice
          ? reviewedCaa.pending
          : !caaHydrated || caaPending)) ||
      (preference === "fanart" && fanart.pending) ||
      (preference === "heya" && heya.pending),
    {
      plex: plexTarget,
      coverartarchive: caaTarget,
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
    },
    savedCandidate,
    { fanart: fanart.images, heya: heya.images },
    failedUrls
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

/** Backgrounds use Plex art, independently of saved poster choices.
 * Deezer/Apple candidates are expressly reused covers, never provider fanart. */
export function useArtistBackgroundArtwork(
  artistName: string | null,
  plexArt: string | null,
  artistId?: string | null,
  failedUrls: readonly string[] = [],
  allowFetch = true
): ArtworkResolution {
  return useArtistArtwork(
    artistName,
    plexArt,
    artistId,
    failedUrls,
    allowFetch,
    "background"
  )
}
export function useAlbumBackgroundArtwork(
  artistName: string | null,
  albumName: string | null,
  plexArt: string | null,
  albumId?: string | null,
  failedUrls: readonly string[] = [],
  allowFetch = true
): ArtworkResolution {
  return useAlbumArtwork(
    artistName,
    albumName,
    plexArt,
    albumId,
    failedUrls,
    allowFetch,
    "background"
  )
}
export function useArtistBackground(
  ...args: Parameters<typeof useArtistBackgroundArtwork>
): string | null {
  return useArtistBackgroundArtwork(...args).url
}
export function useAlbumBackground(
  ...args: Parameters<typeof useAlbumBackgroundArtwork>
): string | null {
  return useAlbumBackgroundArtwork(...args).url
}
