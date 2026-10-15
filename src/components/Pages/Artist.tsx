import { makeOnPlay } from "../../lib/mediaPlay"
import { DownloadMenuItems } from "../shared/DownloadMenuItems"
import { DownloadBadge } from "../shared/DownloadBadge"
import "../../styles/media-detail-controls.css"
import { ArtworkImage, useArtworkFailures } from "../shared/ArtworkImage"
import { useArtistImage, useArtistBackground } from "../../hooks/useMediaImage"
import { useLayoutEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Link, useLocation } from "wouter"
import { open } from "@tauri-apps/plugin-shell"
import { useShallow } from "zustand/react/shallow"
import { usePlayerStore, useUIStore, useLibraryStore } from "../../stores"
import { useProviderStore } from "../../stores/providerStore"
import { prefetchTrackAudio } from "../../stores/playerStore"
import { useContextMenu } from "../../hooks/useContextMenu"
import { useFocalPoint } from "../../lib/focalPoint"
import type {
  MusicArtist,
  MusicAlbum,
  MusicTrack,
  MusicHub,
  MusicPlaylist,
} from "../../types/music"
import { MediaCard } from "../MediaCard"
import { ScrollRow } from "../ScrollRow"
import { MediaBackdrop } from "../shared/MediaBackdrop"
import {
  getCachedArtist,
  prefetchAlbum,
  prefetchArtist,
  loadArtistPage,
  captureMetadataCache,
  isMetadataCacheCurrent,
  type ArtistCacheEntry,
} from "../../stores/metadataCache"
import { useArtistEnrichment } from "../../hooks/useMetadataEnrichment"
import { formatMs } from "../../lib/formatters"
import { ImageModal } from "../shared/ImageModal"
import { deduplicateHubAlbums } from "../../lib/dedup"
import { useMetadataSourceStore } from "../../stores/metadataSourceStore"
import { HeroRating } from "../HeroRating"
import { PageLoading } from "../shared/PageLoading"
import { PageRecovery } from "../shared/PageRecovery"
import { ArtworkSourcePicker } from "../shared/ArtworkSourcePicker"
import { StarRating } from "../shared/StarRating"
import { FavoriteButton } from "../shared/FavoriteButton"
import { useDebugStore } from "../../stores/debugStore"
import { useDebugPanelStore } from "../../stores/debugPanelStore"
import { useCapability } from "../../hooks/useCapability"
import { useTrackDrag } from "../../hooks/useTrackDrag"
import { useMetadataSnapshot } from "../../hooks/useMetadataSnapshot"
import { MetadataEditDialog } from "../shared/MetadataEditDialog"
import { AppDialog } from "../shared/AppDialog"
import { VersionReviewPanel } from "../VersionReview/VersionReviewPanel"

function dedupe<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
}

const SKIP_HUB_IDS = new Set([
  "artist.albums",
  "artist.albums.singles",
  "artist.albums.live",
  "artist.albums.soundtrack",
  "artist.albums.compilation",
  "artist.albums.demo",
  "artist.albums.remix",
  "artist.mostpopulartracks",
  "artist.mostplayedtracks",
])

/** Similar artists use the same artwork preferences as library cards. */
export function SimilarArtistAvatar({
  name,
  artist,
}: {
  name: string
  artist?: MusicArtist
}) {
  const { failures, onFailure } = useArtworkFailures(
    JSON.stringify([name, artist?.id, artist?.thumbUrl])
  )
  const imageUrl = useArtistImage(
    name,
    artist?.thumbUrl ?? null,
    artist?.id,
    failures
  )
  if (imageUrl) {
    return (
      <ArtworkImage
        src={imageUrl}
        alt={name}
        onFailure={onFailure}
        loading="lazy"
        className="h-16 w-16 rounded-md object-cover"
      />
    )
  }
  return (
    <div className="flex h-16 w-16 items-center justify-center rounded-md bg-app-surface text-xl font-bold text-[color:var(--text-muted)]">
      {name[0]}
    </div>
  )
}

export function ArtistPage({ artistId }: { artistId: string }) {
  const [, navigate] = useLocation()
  const provider = useProviderStore((s) => s.provider)
  const { playTrack, playFromUri, playRadio, addToQueue, currentTrack } =
    usePlayerStore(
      useShallow((s) => ({
        playTrack: s.playTrack,
        playFromUri: s.playFromUri,
        playRadio: s.playRadio,
        addToQueue: s.addToQueue,
        currentTrack: s.currentTrack,
      }))
    )
  const { handler: ctxMenu, isTarget: isCtxTarget } = useContextMenu()
  const trackDrag = useTrackDrag()
  const pageRefreshKey = useUIStore((s) => s.pageRefreshKey)
  const shouldDedup = useUIStore((s) => s.deduplicateAlbums)
  const hasRadio = useCapability("radio")
  const hasSonicSimilarity = useCapability("sonicSimilarity")

  const cached = getCachedArtist(artistId, shouldDedup)
  const [artist, setArtist] = useState<MusicArtist | null>(
    cached?.artist ?? null
  )
  const [fullAlbums, setFullAlbums] = useState<MusicAlbum[]>(
    cached?.albums ?? []
  )
  const [singles, setSingles] = useState<MusicAlbum[]>(cached?.singles ?? [])
  const [popularTracks, setPopularTracks] = useState<MusicTrack[]>(
    cached?.popularTracks ?? []
  )
  const [similarArtists, setSimilarArtists] = useState<MusicArtist[]>(
    cached?.similarArtists ?? []
  )
  const [sonicallySimilar, setSonicallySimilar] = useState<MusicArtist[]>(
    cached?.sonicallySimilar ?? []
  )
  const [relatedHubs, setRelatedHubs] = useState<MusicHub[]>(
    cached?.relatedHubs ?? []
  )
  const [stations, setStations] = useState<MusicPlaylist[]>(
    cached?.stations ?? []
  )
  const [isLoading, setIsLoading] = useState(!cached)
  const [error, setError] = useState<string | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const pageOwner = useRef<{ provider: typeof provider; id: string } | null>(
    null
  )

  // UI state
  const [bioExpanded, setBioExpanded] = useState(false)
  const [showImageModal, setShowImageModal] = useState(false)
  const [showHeroModal, setShowHeroModal] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [versionAlbum, setVersionAlbum] = useState<MusicAlbum | null>(null)
  const menuBtnRef = useRef<HTMLButtonElement>(null)
  const heroRef = useRef<HTMLDivElement>(null)
  const debugEnabled = useDebugStore((s) => s.debugEnabled)
  const showDebugPanel = useDebugPanelStore((s) => s.show)

  // Metadata source priority
  const priority = useMetadataSourceStore((s) => s.priority)
  const { tagsGenre, tagsMood, tagsStyle } = useLibraryStore(
    useShallow((s) => ({
      tagsGenre: s.tagsGenre,
      tagsMood: s.tagsMood,
      tagsStyle: s.tagsStyle,
    }))
  )

  // Enrichment metadata from all backends
  const {
    lastfm: lastfmData,
    deezer: deezerData,
    itunes: itunesData,
  } = useArtistEnrichment(artist?.title ?? null)

  useLayoutEffect(() => {
    let active = true
    const session = captureMetadataCache(provider)
    const current = () => active && isMetadataCacheCurrent(session)
    setError(null)
    const changedPage =
      pageOwner.current?.provider !== provider ||
      pageOwner.current?.id !== artistId
    pageOwner.current = { provider, id: artistId }
    if (changedPage) {
      setBioExpanded(false)
      setShowImageModal(false)
      setEditOpen(false)
      setVersionAlbum(null)
      setShowHeroModal(false)
    }

    // Seed ALL state from persistent cache — avoids loading flash AND layout shift.
    // useState(initialValue) only runs on mount, so navigating between artists
    // needs this explicit re-seed at the start of every effect run.
    const freshCache = getCachedArtist(artistId, shouldDedup)
    if (freshCache) {
      setArtist(freshCache.artist)
      setFullAlbums(freshCache.albums)
      setSingles(freshCache.singles)
      setPopularTracks(freshCache.popularTracks)
      setSimilarArtists(freshCache.similarArtists)
      setSonicallySimilar(freshCache.sonicallySimilar)
      setRelatedHubs(freshCache.relatedHubs)
      setStations(freshCache.stations)
      setIsLoading(false)
    } else if (changedPage) {
      // No cache — clear stale data from previous artist, show loading spinner.
      setArtist(null)
      setFullAlbums([])
      setSingles([])
      setPopularTracks([])
      setSimilarArtists([])
      setSonicallySimilar([])
      setRelatedHubs([])
      setStations([])
      setIsLoading(true)
    }

    if (!provider || !session) {
      setIsLoading(false)
      return
    }
    const applyEntry = (entry: ArtistCacheEntry) => {
      if (!current()) return
      setArtist(entry.artist)
      setFullAlbums(entry.albums)
      setSingles(entry.singles)
      setPopularTracks(entry.popularTracks)
      setSimilarArtists(entry.similarArtists)
      setSonicallySimilar(entry.sonicallySimilar)
      setRelatedHubs(entry.relatedHubs)
      setStations(entry.stations)
      setIsLoading(false)
    }
    loadArtistPage(artistId, {
      force: true,
      deduplicate: shouldDedup,
      onCore: applyEntry,
    })
      .then(applyEntry)
      .catch((error) => {
        if (current()) setError(String(error))
      })
      .finally(() => {
        if (current()) setIsLoading(false)
      })
    return () => {
      active = false
    }
  }, [artistId, provider, pageRefreshKey, shouldDedup, loadAttempt])

  const { failures, onFailure } = useArtworkFailures(
    JSON.stringify([artistId, artist?.title, artist?.thumbUrl, artist?.artUrl])
  )
  const artUrl = useArtistBackground(
    artist?.title ?? null,
    artist?.artUrl ?? null,
    artistId,
    failures
  )
  const thumbUrl = useArtistImage(
    artist?.title ?? null,
    artist?.thumbUrl ?? null,
    artistId,
    failures
  )
  const heroBgPos = useFocalPoint(artUrl ?? thumbUrl)

  // Map from lowercase artist name → library artist for "Fans Also Like" linking.
  // Covers both Plex-similar and sonically-similar artists that are in the library.
  const plexArtistMap = useMemo(() => {
    const map = new Map<string, MusicArtist>()
    for (const a of [...similarArtists, ...sonicallySimilar]) {
      map.set(a.title.toLowerCase(), a)
    }
    return map
  }, [similarArtists, sonicallySimilar])

  // Must be before early returns — hooks cannot be called conditionally.
  const plexTagSet = useMemo(
    () =>
      new Set(
        [...tagsGenre, ...tagsMood, ...tagsStyle].map((t) =>
          t.tag.toLowerCase()
        )
      ),
    [tagsGenre, tagsMood, tagsStyle]
  )

  // Memoize album/hub filtering — depends on relatedHubs, fullAlbums, singles
  const { albumHubs, displayAlbums, displaySingles, genres } = useMemo(() => {
    const albumHubs = relatedHubs
      .filter(
        (h) =>
          h.identifier &&
          !SKIP_HUB_IDS.has(h.identifier) &&
          h.items.some((m) => m.type === "album")
      )
      .map((h) => (shouldDedup ? deduplicateHubAlbums(h) : h))
    const hubAlbumKeys = new Set(
      albumHubs.flatMap((h) =>
        h.items.filter((m) => m.type === "album").map((m) => m.id)
      )
    )
    const hasId = (id: string) => hubAlbumKeys.has(id)
    const da = fullAlbums.filter(
      (a) => !hasId(a.id) && !(a._alternateIds ?? []).some(hasId)
    )
    const ds = singles.filter(
      (a) => !hasId(a.id) && !(a._alternateIds ?? []).some(hasId)
    )

    const g: string[] = []
    const seenGenres = new Set<string>()
    for (const album of [...fullAlbums, ...singles]) {
      for (const gn of album.genres) {
        if (!seenGenres.has(gn)) {
          seenGenres.add(gn)
          g.push(gn)
        }
      }
    }
    return { albumHubs, displayAlbums: da, displaySingles: ds, genres: g }
  }, [relatedHubs, fullAlbums, singles, shouldDedup])
  const sharedMetadata = useMetadataSnapshot(
    artist && provider?.cacheScope
      ? {
          kind: "artist",
          entityId: artist.id,
          artist: artist.title,
          scope: provider.cacheScope,
        }
      : null,
    artist ? { ...artist, genres } : null
  )

  // Count how many duplicate albums were merged (for the hero badge)
  const dedupStats = useMemo(() => {
    const countAlts = (list: MusicAlbum[]) =>
      list.reduce((n, a) => n + (a._alternateIds?.length ?? 0), 0)
    const albumDupes = countAlts(fullAlbums)
    const singleDupes = countAlts(singles)
    const hubDupes = relatedHubs.reduce(
      (n, h) =>
        n +
        h.items
          .filter((i) => i.type === "album")
          .reduce(
            (m, a) => m + ((a as MusicAlbum)._alternateIds?.length ?? 0),
            0
          ),
      0
    )
    const total = albumDupes + singleDupes + hubDupes
    if (total === 0) return null
    const parts: string[] = []
    if (albumDupes > 0)
      parts.push(`${albumDupes} album${albumDupes > 1 ? "s" : ""}`)
    if (singleDupes > 0)
      parts.push(`${singleDupes} single${singleDupes > 1 ? "s" : ""}`)
    if (hubDupes > 0) parts.push(`${hubDupes} other`)
    return `deduplicated: ${parts.join(", ")}`
  }, [fullAlbums, singles, relatedHubs])

  if (isLoading)
    return <PageLoading message="Loading artist…" variant="artist" />
  if (!artist)
    return (
      <div className="p-6">
        <PageRecovery
          title={
            !provider
              ? "Connect your music library"
              : error
                ? "Couldn't load this artist"
                : "Artist unavailable"
          }
          description={
            !provider
              ? "Choose a music server in Settings to browse artists."
              : "Check your connection and try again, or choose another artist from your library."
          }
          kind={!provider || !error ? "empty" : "error"}
          onRetry={provider ? () => setLoadAttempt((n) => n + 1) : undefined}
          onOpenSettings={() => navigate("/settings")}
          onReturnLibrary={() => navigate("/collection/artists")}
        />
      </div>
    )

  const playablePopularTracks = provider?.isOffline
    ? popularTracks.filter(
        (track) =>
          track.mediaInfo?.offlineAvailable || track.mediaInfo?.localAudio
      )
    : popularTracks
  const playOfflineArtist = () =>
    makeOnPlay(
      { ...artist, type: "artist" },
      { ...usePlayerStore.getState(), provider }
    )?.()
  const artistUri = provider?.buildItemUri
    ? provider.buildItemUri(`/library/metadata/${artistId}`)
    : null

  // Bio: pick from the highest-priority source that has text.
  // Only Plex and Last.fm have artist bios; Deezer and Apple are skipped.
  const displayBio = sharedMetadata.resolveField("biography")?.value

  // Enrichment choices retain only tags that can open a real library collection.
  const resolvedGenres = sharedMetadata.resolveField("genres")
  const resolvedTags = sharedMetadata.resolveField("tags")
  const seenTags = new Set<string>()
  const mergedTags: string[] = []
  for (const resolved of [resolvedGenres, resolvedTags]) {
    for (const tag of resolved?.value ?? []) {
      if (resolved.source !== "plex" && !plexTagSet.has(tag.toLowerCase()))
        continue
      const key = tag.toLowerCase()
      if (!seenTags.has(key)) {
        seenTags.add(key)
        mergedTags.push(tag)
      }
    }
  }
  const heroTags = mergedTags.slice(0, 8)

  return (
    <div className="media-detail-page">
      {versionAlbum && (
        <AppDialog
          key={`${provider?.cacheScope}:versions:${versionAlbum.id}`}
          title="Album and media versions"
          description={versionAlbum.title}
          onClose={() => setVersionAlbum(null)}
        >
          <VersionReviewPanel album={versionAlbum} />
        </AppDialog>
      )}
      {editOpen && (
        <MetadataEditDialog
          key={`${provider?.cacheScope}:artist:${artist.id}`}
          kind="artist"
          item={{ ...artist, genres }}
          artworkUrl={thumbUrl}
          backgroundUrl={artUrl ?? thumbUrl}
          onClose={() => setEditOpen(false)}
          onSaved={() => setLoadAttempt((value) => value + 1)}
        />
      )}
      <MediaBackdrop
        src={artUrl ?? thumbUrl}
        heroRef={heroRef}
        position={heroBgPos}
        onFailure={onFailure}
      />
      {/* ── Hero ── */}
      <div
        ref={heroRef}
        className="media-detail-hero hero-overlay relative flex items-end"
      >
        {/* Expand hero image — top-right, only when a banner image exists */}
        {artUrl && (
          <button
            onClick={(e) => {
              e.currentTarget.focus({ preventScroll: true })
              setShowHeroModal(true)
            }}
            title="View full image"
            className="absolute right-4 top-4 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-black/40 text-white/70 transition-all hover:bg-black/60 hover:text-white"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
              <path d="M1.5 1h4a.5.5 0 0 1 0 1H2.707L6.354 5.646a.5.5 0 1 1-.708.708L2 2.707V5.5a.5.5 0 0 1-1 0v-4A.5.5 0 0 1 1.5 1zm13 0a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-1 0V2.707l-3.646 3.647a.5.5 0 1 1-.708-.708L13.293 2H10.5a.5.5 0 0 1 0-1zM1 10.5a.5.5 0 0 1 1 0v2.793l3.646-3.647a.5.5 0 1 1 .708.708L2.707 14H5.5a.5.5 0 0 1 0 1h-4a.5.5 0 0 1-.5-.5zm15 0a.5.5 0 0 1-.5.5h-4a.5.5 0 0 1 0-1h2.793l-3.647-3.646a.5.5 0 1 1 .708-.708L14 13.293V10.5a.5.5 0 0 1 1 0z" />
            </svg>
          </button>
        )}

        {/* Main content row */}
        <div className="relative z-10 flex w-full flex-wrap items-end gap-6">
          {/* Avatar — click to open modal */}
          <div className="artwork-edit-frame relative flex flex-shrink-0 flex-col items-start">
            {thumbUrl ? (
              <button
                type="button"
                aria-label={`View ${artist.title} artwork`}
                onClick={(e) => {
                  e.currentTarget.focus({ preventScroll: true })
                  setShowImageModal(true)
                }}
                className="h-36 w-36 flex-shrink-0 rounded-lg shadow-2xl ring-2 ring-transparent transition-all hover:ring-white/40 focus-visible:outline-none focus-visible:ring-white/70"
              >
                <ArtworkImage
                  src={thumbUrl}
                  onFailure={onFailure}
                  loading="eager"
                  alt=""
                  className="h-full w-full rounded-lg object-cover"
                />
              </button>
            ) : (
              <div className="h-36 w-36 flex-shrink-0 rounded-lg bg-app-surface shadow-2xl" />
            )}
            <ArtworkSourcePicker
              kind="artist"
              artistName={artist.title}
              plexThumb={artist.thumbUrl}
              entityId={artistId}
              label={`Edit ${artist.title} artwork sources`}
              iconOnly
              className="artwork-edit-trigger"
            />
          </div>

          {/* Info column — no fixed height, flows naturally */}
          <div className="flex min-w-0 flex-[1_1_20rem] flex-col gap-2">
            <div className="flex items-center gap-2">
              <div className="media-detail-eyebrow">Artist</div>
              <DownloadBadge kind="artist" id={artistId} />
            </div>
            <h1 className="media-detail-title select-text break-words">
              {artist.title}
            </h1>

            {heroTags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {heroTags.map((g) => (
                  <Link
                    key={g}
                    href={`/genre/genre/${encodeURIComponent(g)}`}
                    className="rounded-full bg-white/10 px-3 py-0.5 text-xs text-gray-300 transition-colors hover:bg-white/20 hover:text-white"
                  >
                    {g}
                  </Link>
                ))}
              </div>
            )}

            {/* Expandable bio */}
            {displayBio && (
              <div
                className="cursor-pointer select-text"
                onClick={() => setBioExpanded((v) => !v)}
                title={bioExpanded ? "Collapse" : "Expand"}
              >
                <div
                  className="overflow-hidden transition-all duration-500 ease-in-out"
                  style={{ maxHeight: bioExpanded ? "500px" : "2.8rem" }}
                >
                  <p className="text-sm leading-relaxed text-gray-300">
                    {displayBio}
                  </p>
                </div>
                <span className="mt-1 flex items-center gap-1 text-xs text-white/80 transition-colors hover:text-white">
                  <svg
                    viewBox="0 0 16 16"
                    width="12"
                    height="12"
                    fill="currentColor"
                    className={`transition-transform duration-300 ${bioExpanded ? "rotate-180" : ""}`}
                  >
                    <path d="M8 10.94L1.53 4.47l1.06-1.06L8 8.82l5.41-5.41 1.06 1.06z" />
                  </svg>
                  {bioExpanded ? "Less" : "More"}
                </span>
              </div>
            )}

            {/* Rating */}
            <HeroRating
              itemId={artistId}
              userRating={artist.userRating}
              itemType="artist"
              onHero
            />

            {/* Metadata stats row */}
            {(lastfmData || deezerData || dedupStats) && (
              <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-white/80">
                {lastfmData && lastfmData.listeners > 0 && (
                  <span>{lastfmData.listeners.toLocaleString()} listeners</span>
                )}
                {lastfmData && lastfmData.play_count > 0 && (
                  <span>
                    {lastfmData.play_count.toLocaleString()} scrobbles
                  </span>
                )}
                {lastfmData &&
                  (lastfmData.listeners > 0 || lastfmData.play_count > 0) && (
                    <span className="text-white/80">· Last.fm</span>
                  )}
                {deezerData && deezerData.fans > 0 && (
                  <>
                    {lastfmData && <span className="text-white/60">·</span>}
                    <span>{deezerData.fans.toLocaleString()} fans</span>
                    <span className="text-white/80">· Deezer</span>
                  </>
                )}
                {dedupStats && (
                  <>
                    {(lastfmData || deezerData) && (
                      <span className="text-white/60">·</span>
                    )}
                    <span className="italic text-white/80">{dedupStats}</span>
                  </>
                )}
              </div>
            )}
          </div>
          <div className="relative z-20 flex w-full flex-wrap items-center gap-2 pt-3">
            {/* Play */}
            <button
              onClick={() =>
                provider?.isOffline
                  ? playOfflineArtist()
                  : artistUri &&
                    void playFromUri(
                      artistUri,
                      false,
                      artist.title,
                      `/artist/${artistId}`
                    )
              }
              disabled={
                provider?.isOffline
                  ? artist.offlineAvailable !== true
                  : !artistUri
              }
              title="Play"
              className="media-primary"
            >
              <svg
                viewBox="0 0 16 16"
                width="22"
                height="22"
                fill="currentColor"
              >
                <polygon points="3,2 13,8 3,14" />
              </svg>
              <span>Play</span>
            </button>
            {/* Shuffle */}
            <button
              onClick={() =>
                artistUri &&
                void playFromUri(
                  artistUri,
                  true,
                  artist.title,
                  `/artist/${artistId}`
                )
              }
              disabled={
                !artistUri ||
                (!!provider?.isOffline && artist.offlineAvailable !== true)
              }
              title="Shuffle play"
              className="media-secondary"
            >
              <svg
                viewBox="0 0 16 16"
                width="16"
                height="16"
                fill="currentColor"
              >
                <path d="M13.151.922a.75.75 0 1 0-1.06 1.06L13.109 3H11.16a3.75 3.75 0 0 0-2.873 1.34l-6.173 7.356A2.25 2.25 0 0 1 .39 12.5H0V14h.391a3.75 3.75 0 0 0 2.873-1.34l6.173-7.356A2.25 2.25 0 0 1 11.16 4.5h1.949l-1.018 1.018a.75.75 0 0 0 1.06 1.06L15.98 3.75 13.15.922zM.391 3.5H0V2h.391c1.109 0 2.16.49 2.873 1.34L4.89 5.277l-.979 1.167-1.796-2.14A2.25 2.25 0 0 0 .39 3.5zm9.831 8.17l.979 1.167.28.334A3.75 3.75 0 0 0 14.36 14.5h1.64V13h-1.64a2.25 2.25 0 0 1-1.726-.83l-.28-.335-1.733-2.063-.979 1.167 1.18 1.731z" />
              </svg>
              <span>Shuffle</span>
            </button>
            {/* Artist Radio */}
            {hasRadio && (
              <button
                onClick={() => void playRadio(artistId, "artist", artist.title)}
                title="Artist Radio — continuous sonically-similar music"
                className="media-secondary"
              >
                <svg
                  viewBox="0 0 16 16"
                  width="16"
                  height="16"
                  fill="currentColor"
                >
                  <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM8 5a3 3 0 1 0 0 6A3 3 0 0 0 8 5zm0 1.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z" />
                </svg>
                <span>Radio</span>
              </button>
            )}
            {/* Three-dot menu */}
            <div className="relative">
              <button
                ref={menuBtnRef}
                onClick={() => setMenuOpen((v) => !v)}
                className="flex h-9 w-9 items-center justify-center rounded-full text-white/50 transition-all hover:bg-white/10 hover:text-white"
                title="More options"
              >
                <svg
                  viewBox="0 0 16 16"
                  width="16"
                  height="16"
                  fill="currentColor"
                >
                  <circle cx="8" cy="3" r="1.5" />
                  <circle cx="8" cy="8" r="1.5" />
                  <circle cx="8" cy="13" r="1.5" />
                </svg>
              </button>
              {artist &&
                menuOpen &&
                (() => {
                  const rect = menuBtnRef.current?.getBoundingClientRect()
                  return createPortal(
                    <>
                      <div
                        className="fixed inset-0 z-[9998]"
                        onClick={() => setMenuOpen(false)}
                      />
                      <div
                        className="fixed z-[9999] max-h-[70vh] w-56 overflow-y-auto rounded-lg border border-[var(--border)] bg-app-surface py-1 shadow-xl"
                        style={{
                          top: (rect?.bottom ?? 0) + 4,
                          right: window.innerWidth - (rect?.right ?? 0),
                        }}
                      >
                        <DownloadMenuItems
                          kind="artist"
                          id={artistId}
                          title={artist.title}
                          close={() => setMenuOpen(false)}
                          current={() =>
                            menuOpen &&
                            useProviderStore.getState().provider === provider
                          }
                        />
                        {/* Queue */}
                        <button
                          type="button"
                          onClick={() => {
                            setMenuOpen(false)
                            setEditOpen(true)
                          }}
                          className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[color:var(--text-primary)] hover:bg-[var(--bg-surface-hover)]"
                        >
                          Edit metadata and sources…
                        </button>
                        <button
                          onClick={() => {
                            addToQueue(popularTracks)
                            setMenuOpen(false)
                          }}
                          className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[color:var(--text-primary)] hover:bg-[var(--bg-surface-hover)]"
                        >
                          <svg
                            viewBox="0 0 24 24"
                            fill="currentColor"
                            width="14"
                            height="14"
                          >
                            <path d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z" />
                          </svg>
                          Add popular to queue
                        </button>

                        <hr className="my-1 border-t border-[var(--border)]" />

                        {/* Rating */}
                        <StarRating
                          itemId={artist.id}
                          itemType="artist"
                          userRating={artist.userRating ?? null}
                          enableLove={false}
                          artist={artist.title}
                          track=""
                          size={14}
                          onRated={() => setMenuOpen(false)}
                        />

                        <hr className="my-1 border-t border-[var(--border)]" />

                        {/* Share */}
                        <div className="px-3 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-white/30">
                          Share
                        </div>
                        <button
                          onClick={() => {
                            void open(
                              `https://www.last.fm/music/${encodeURIComponent(artist.title)}`
                            )
                            setMenuOpen(false)
                          }}
                          className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[color:var(--text-primary)] hover:bg-[var(--bg-surface-hover)]"
                        >
                          <svg
                            viewBox="0 0 24 24"
                            fill="currentColor"
                            width="14"
                            height="14"
                          >
                            <path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z" />
                          </svg>
                          Last.fm
                        </button>
                        {deezerData?.deezer_url && (
                          <button
                            onClick={() => {
                              void open(deezerData.deezer_url)
                              setMenuOpen(false)
                            }}
                            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[color:var(--text-primary)] hover:bg-[var(--bg-surface-hover)]"
                          >
                            <svg
                              viewBox="0 0 24 24"
                              fill="currentColor"
                              width="14"
                              height="14"
                            >
                              <path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z" />
                            </svg>
                            Deezer
                          </button>
                        )}

                        {/* Debug */}
                        {debugEnabled && (
                          <>
                            <hr className="my-1 border-t border-[var(--border)]" />
                            <div className="px-3 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-white/30">
                              Debug
                            </div>
                            <button
                              onClick={() => {
                                showDebugPanel("artist", artist)
                                setMenuOpen(false)
                              }}
                              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[color:var(--text-primary)] hover:bg-[var(--bg-surface-hover)]"
                            >
                              <svg
                                viewBox="0 0 24 24"
                                fill="currentColor"
                                width="14"
                                height="14"
                              >
                                <path d="M20 8h-2.81a5.985 5.985 0 0 0-1.82-1.96L17 4.41 15.59 3l-2.17 2.17a5.947 5.947 0 0 0-2.84 0L8.41 3 7 4.41l1.62 1.63C7.88 6.55 7.26 7.22 6.81 8H4v2h2.09c-.05.33-.09.66-.09 1v1H4v2h2v1c0 .34.04.67.09 1H4v2h2.81A6.008 6.008 0 0 0 12 22a6.008 6.008 0 0 0 5.19-3H20v-2h-2.09c.05-.33.09-.66.09-1v-1h2v-2h-2v-1c0-.34-.04-.67-.09-1H20V8zm-6 8h-4v-2h4v2zm0-4h-4v-2h4v2z" />
                              </svg>
                              Debug Info
                            </button>
                          </>
                        )}
                      </div>
                    </>,
                    document.body
                  )
                })()}
            </div>
          </div>
        </div>
      </div>

      <dl className="media-ledger" aria-label="Artist overview">
        <div>
          <dt>Albums</dt>
          <dd>{fullAlbums.length}</dd>
        </div>
        <div>
          <dt>Singles &amp; EPs</dt>
          <dd>{singles.length}</dd>
        </div>
        {lastfmData?.listeners != null && (
          <div>
            <dt>Listeners</dt>
            <dd>{lastfmData.listeners.toLocaleString()}</dd>
          </div>
        )}
      </dl>
      <div className="flex flex-col gap-10 p-8">
        {error && (
          <PageRecovery
            title="Couldn't refresh this artist"
            description="Showing saved artist information. Try again when your connection is available."
            onRetry={() => setLoadAttempt((n) => n + 1)}
          />
        )}
        {/* ── Popular Tracks ── */}
        {popularTracks.length > 0 && (
          <section>
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <h2 className="media-section-heading">Popular Tracks</h2>
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <button
                  onClick={() =>
                    void playTrack(
                      popularTracks[0],
                      popularTracks,
                      artist.title,
                      `/artist/${artistId}`
                    )
                  }
                  title="Play popular tracks"
                  className="group flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 px-3 py-1 text-xs font-semibold text-accent transition-all duration-200 hover:border-accent hover:bg-accent/20 active:scale-95"
                >
                  <svg
                    viewBox="0 0 16 16"
                    width="9"
                    height="9"
                    fill="currentColor"
                    className="transition-transform duration-200 group-hover:scale-110"
                  >
                    <polygon points="3,2 13,8 3,14" />
                  </svg>
                  Play
                </button>
                <button
                  onClick={() => {
                    const s = [...popularTracks].sort(() => Math.random() - 0.5)
                    void playTrack(s[0], s, artist.title, `/artist/${artistId}`)
                  }}
                  title="Shuffle popular tracks"
                  className="group flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-app-surface px-3 py-1 text-xs font-semibold text-[color:var(--text-secondary)] transition-all duration-200 hover:border-[var(--border-strong)] hover:bg-app-surface-hover hover:text-[color:var(--text-primary)] active:scale-95"
                >
                  <svg
                    viewBox="0 0 16 16"
                    width="11"
                    height="11"
                    fill="currentColor"
                    className="transition-transform duration-200 group-hover:scale-110"
                  >
                    <path d="M13.151.922a.75.75 0 1 0-1.06 1.06L13.109 3H11.16a3.75 3.75 0 0 0-2.873 1.34l-6.173 7.356A2.25 2.25 0 0 1 .39 12.5H0V14h.391a3.75 3.75 0 0 0 2.873-1.34l6.173-7.356a2.25 2.25 0 0 1 1.724-.804h1.947l-1.017 1.018a.75.75 0 0 0 1.06 1.06L15.98 3.75 13.15.922zM.391 3.5H0V2h.391c1.109 0 2.16.49 2.873 1.34L4.89 5.277l-.979 1.167-1.796-2.14A2.25 2.25 0 0 0 .39 3.5z" />
                    <path d="m7.5 10.723.98-1.167.957 1.14a2.25 2.25 0 0 0 1.724.804h1.947l-1.017-1.018a.75.75 0 1 1 1.06-1.06l2.829 2.828-2.829 2.828a.75.75 0 1 1-1.06-1.06L13.109 13H11.16a3.75 3.75 0 0 1-2.873-1.34l-.787-.938z" />
                  </svg>
                  Shuffle
                </button>
              </div>
            </div>
            <div className="flex flex-col">
              {popularTracks.map((track, i) => {
                const albumId = track.albumId
                const unavailable =
                  !!provider?.isOffline &&
                  !track.mediaInfo?.offlineAvailable &&
                  !track.mediaInfo?.localAudio
                const isActive = currentTrack?.id === track.id
                const isContextTarget = isCtxTarget(track.id)
                return (
                  <div
                    key={`${track.id}-${i}`}
                    onClick={() =>
                      !unavailable &&
                      playTrack(
                        track,
                        playablePopularTracks,
                        artist.title,
                        `/artist/${artistId}`
                      )
                    }
                    onMouseEnter={() => prefetchTrackAudio(track)}
                    onContextMenu={ctxMenu("track", track)}
                    className={`media-track-row group flex ${unavailable ? "cursor-default opacity-40" : "cursor-pointer"} flex-wrap items-center gap-3 rounded-md px-3 py-1.5 focus-within:bg-hl-menu ${isActive || isContextTarget ? "bg-hl-menu" : "hover:bg-hl-menu"}`}
                    onPointerDown={(e) =>
                      trackDrag.onPointerDown(e, {
                        type: "track",
                        ids: [track.id],
                        label: track.title,
                        tracks: [track],
                      })
                    }
                    onPointerMove={trackDrag.onPointerMove}
                    onPointerUp={trackDrag.onPointerUp}
                  >
                    <button
                      type="button"
                      aria-label={`Play ${track.title}`}
                      disabled={unavailable}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation()
                        void playTrack(
                          track,
                          playablePopularTracks,
                          artist.title,
                          `/artist/${artistId}`
                        )
                      }}
                      className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${isActive ? "text-accent" : "text-[color:var(--text-secondary)]"}`}
                    >
                      <span
                        aria-hidden="true"
                        className="group-focus-within:hidden group-hover:hidden"
                      >
                        {isActive ? (
                          <svg
                            viewBox="0 0 16 16"
                            width="12"
                            height="12"
                            fill="currentColor"
                          >
                            <rect x="1" y="3" width="3" height="10" rx="1" />
                            <rect x="6" y="1" width="3" height="12" rx="1" />
                            <rect x="11" y="5" width="3" height="8" rx="1" />
                          </svg>
                        ) : (
                          i + 1
                        )}
                      </span>
                      <svg
                        aria-hidden="true"
                        className="hidden group-focus-within:block group-hover:block"
                        viewBox="0 0 16 16"
                        width="14"
                        height="14"
                        fill="currentColor"
                      >
                        <polygon points="3,2 13,8 3,14" />
                      </svg>
                    </button>
                    <div className="flex min-w-0 flex-1 flex-col">
                      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <span
                          className={`min-w-0 truncate text-sm font-medium ${isActive ? "text-accent" : "text-[color:var(--text-primary)]"}`}
                        >
                          {track.title}
                        </span>
                        <DownloadBadge kind="track" id={track.id} />
                        {albumId && (
                          <span className="flex min-w-0 max-w-full items-center gap-1.5">
                            <span className="text-xs text-[color:var(--text-muted)]">
                              ·
                            </span>
                            <Link
                              href={`/album/${albumId}`}
                              className="max-w-full truncate text-xs text-[color:var(--text-muted)] transition-colors hover:text-[color:var(--text-primary)] hover:underline"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {track.albumName}
                            </Link>
                          </span>
                        )}
                      </div>
                      {track.originalTitle &&
                        track.originalTitle !== artist.title && (
                          <span className="text-xs text-[color:var(--text-muted)]">
                            {track.originalTitle}
                          </span>
                        )}
                    </div>
                    <span onClick={(e) => e.stopPropagation()}>
                      <HeroRating
                        itemId={track.id}
                        userRating={track.userRating}
                        itemType="track"
                        musicTrack={track}
                      />
                    </span>
                    <span className="flex w-32 flex-shrink-0 items-center justify-end gap-2">
                      <FavoriteButton track={track} />
                      <button
                        className="flex items-center gap-0.5 text-xs text-[color:var(--text-secondary)] opacity-0 transition-colors group-focus-within:opacity-100 group-hover:opacity-100 hover:text-[color:var(--text-primary)] focus-visible:opacity-100"
                        aria-label={`Add ${track.title} to queue`}
                        title="Add to Queue"
                        onClick={(e) => {
                          e.stopPropagation()
                          addToQueue([track])
                        }}
                      >
                        <svg
                          viewBox="0 0 16 16"
                          width="11"
                          height="11"
                          fill="currentColor"
                        >
                          <path d="M8 2a.75.75 0 0 1 .75.75v4.5h4.5a.75.75 0 0 1 0 1.5h-4.5v4.5a.75.75 0 0 1-1.5 0v-4.5h-4.5a.75.75 0 0 1 0-1.5h4.5v-4.5A.75.75 0 0 1 8 2z" />
                        </svg>
                        Queue
                      </button>
                      {hasRadio && (
                        <button
                          className="flex items-center gap-1 text-xs text-[color:var(--text-secondary)] opacity-0 transition-colors group-focus-within:opacity-100 group-hover:opacity-100 hover:text-[color:var(--text-primary)] focus-visible:opacity-100"
                          aria-label={`Start radio for ${track.title}`}
                          title="Track Radio"
                          onClick={(e) => {
                            e.stopPropagation()
                            void playRadio(track.id, "track")
                          }}
                        >
                          <svg
                            viewBox="0 0 16 16"
                            width="12"
                            height="12"
                            fill="currentColor"
                          >
                            <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM8 5a3 3 0 1 0 0 6A3 3 0 0 0 8 5zm0 1.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z" />
                          </svg>
                          Radio
                        </button>
                      )}
                      <span className="text-xs tabular-nums text-[color:var(--text-secondary)] group-focus-within:hidden group-hover:hidden">
                        {formatMs(track.duration)}
                      </span>
                    </span>
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {displayAlbums.length > 0 && (
          <ScrollRow title="Albums" restoreKey={`artist-${artistId}-albums`}>
            {displayAlbums.map((album) => (
              <MediaCard
                key={album.id}
                title={album.title}
                desc={String(album.year)}
                versionCount={1 + (album._alternateIds?.length ?? 0)}
                onViewVersions={() => setVersionAlbum(album)}
                thumb={album.thumbUrl}
                href={`/album/${album.id}`}
                prefetch={() => prefetchAlbum(album.id)}
                onPlay={() => {
                  const uri = provider?.buildItemUri?.(
                    `/library/metadata/${album.id}`
                  )
                  if (uri)
                    void playFromUri(
                      uri,
                      false,
                      album.title,
                      `/album/${album.id}`,
                      album.id
                    )
                }}
                onContextMenu={ctxMenu("album", album)}
                dragPayload={{
                  type: "album",
                  ids: [album.id],
                  label: album.title,
                }}
                scrollItem
              />
            ))}
          </ScrollRow>
        )}

        {displaySingles.length > 0 && (
          <ScrollRow
            title="Singles & EPs"
            restoreKey={`artist-${artistId}-singles`}
          >
            {displaySingles.map((album) => (
              <MediaCard
                key={album.id}
                title={album.title}
                desc={`Single · ${album.year}`}
                versionCount={1 + (album._alternateIds?.length ?? 0)}
                onViewVersions={() => setVersionAlbum(album)}
                thumb={album.thumbUrl}
                href={`/album/${album.id}`}
                prefetch={() => prefetchAlbum(album.id)}
                onPlay={() => {
                  const uri = provider?.buildItemUri?.(
                    `/library/metadata/${album.id}`
                  )
                  if (uri)
                    void playFromUri(
                      uri,
                      false,
                      album.title,
                      `/album/${album.id}`,
                      album.id
                    )
                }}
                onContextMenu={ctxMenu("album", album)}
                dragPayload={{
                  type: "album",
                  ids: [album.id],
                  label: album.title,
                }}
                scrollItem
              />
            ))}
          </ScrollRow>
        )}

        {albumHubs.map((hub) => {
          const albums = hub.items.filter((m) => m.type === "album")
          if (albums.length === 0) return null
          return (
            <ScrollRow
              key={hub.identifier}
              title={hub.title}
              restoreKey={`artist-${artistId}-${hub.identifier}`}
            >
              {albums.map((a) => (
                <MediaCard
                  key={a.id}
                  title={a.title}
                  desc={String(a.year)}
                  versionCount={
                    1 + ((a as MusicAlbum)._alternateIds?.length ?? 0)
                  }
                  onViewVersions={() => setVersionAlbum(a as MusicAlbum)}
                  thumb={a.thumbUrl}
                  href={`/album/${a.id}`}
                  prefetch={() => prefetchAlbum(a.id)}
                  onPlay={() => {
                    const uri = provider?.buildItemUri?.(
                      `/library/metadata/${a.id}`
                    )
                    if (uri)
                      void playFromUri(
                        uri,
                        false,
                        a.title,
                        `/album/${a.id}`,
                        a.id
                      )
                  }}
                  onContextMenu={ctxMenu("album", a)}
                  dragPayload={{ type: "album", ids: [a.id], label: a.title }}
                  scrollItem
                />
              ))}
            </ScrollRow>
          )
        })}

        {similarArtists.length > 0 && (
          <ScrollRow
            title="Similar Artists"
            restoreKey={`artist-${artistId}-similar`}
          >
            {similarArtists.map((a) => (
              <MediaCard
                key={a.id}
                title={a.title}
                desc="Artist"
                thumb={a.thumbUrl}
                href={`/artist/${a.id}`}
                prefetch={() => prefetchArtist(a.id)}
                onPlay={() => {
                  const uri = provider?.buildItemUri?.(
                    `/library/metadata/${a.id}`
                  )
                  if (uri)
                    void playFromUri(uri, false, a.title, `/artist/${a.id}`)
                }}
                onContextMenu={ctxMenu("artist", a)}
                dragPayload={{ type: "artist", ids: [a.id], label: a.title }}
                isArtist
                scrollItem
              />
            ))}
          </ScrollRow>
        )}

        {hasSonicSimilarity && sonicallySimilar.length > 0 && (
          <ScrollRow
            title="Sonically Similar Artists"
            restoreKey={`artist-${artistId}-sonic`}
          >
            {sonicallySimilar.map((a) => {
              const distance = a.distance
              const matchPct =
                distance != null
                  ? `${Math.round((1 - distance) * 100)}% match`
                  : "Artist"
              return (
                <MediaCard
                  key={a.id}
                  title={a.title}
                  desc={matchPct}
                  thumb={a.thumbUrl}
                  href={`/artist/${a.id}`}
                  prefetch={() => prefetchArtist(a.id)}
                  onPlay={() => {
                    const uri = provider?.buildItemUri?.(
                      `/library/metadata/${a.id}`
                    )
                    if (uri)
                      void playFromUri(uri, false, a.title, `/artist/${a.id}`)
                  }}
                  onContextMenu={ctxMenu("artist", a)}
                  dragPayload={{ type: "artist", ids: [a.id], label: a.title }}
                  isArtist
                  scrollItem
                />
              )
            })}
          </ScrollRow>
        )}

        {/* ── Last.fm Similar Artists ── */}
        {lastfmData && lastfmData.similar.length > 0 && (
          <section>
            <h2 className="media-section-heading mb-4">
              {priority[0] === "lastfm" ? "Similar Artists" : "Fans Also Like"}
              <span className="ml-2 text-xs font-normal text-[color:var(--text-muted)]">
                via Last.fm
              </span>
            </h2>
            <div className="flex flex-wrap gap-4">
              {lastfmData.similar.map((a) => {
                const libraryArtist = plexArtistMap.get(a.name.toLowerCase())
                const plexId = libraryArtist?.id
                const avatar = (
                  <SimilarArtistAvatar name={a.name} artist={libraryArtist} />
                )
                return (
                  <div
                    key={a.name}
                    className="flex w-20 flex-col items-center gap-1.5"
                  >
                    {plexId ? (
                      <Link
                        href={`/artist/${plexId}`}
                        className="block rounded-md ring-2 ring-transparent transition-all hover:ring-white/40"
                        title={`Open ${a.name}`}
                      >
                        {avatar}
                      </Link>
                    ) : (
                      <div className="opacity-40">{avatar}</div>
                    )}
                    <span
                      className={`line-clamp-2 text-center text-xs leading-tight ${plexId ? "text-[color:var(--text-secondary)]" : "text-[color:var(--text-muted)]"}`}
                    >
                      {a.name}
                    </span>
                  </div>
                )
              })}
            </div>
          </section>
        )}
      </div>

      {showImageModal && thumbUrl && (
        <ImageModal
          src={thumbUrl}
          alt={artist.title}
          onClose={() => setShowImageModal(false)}
        />
      )}
      {showHeroModal && artUrl && (
        <ImageModal
          src={artUrl}
          alt={artist.title}
          onClose={() => setShowHeroModal(false)}
          overlay="dark"
        />
      )}
    </div>
  )
}
