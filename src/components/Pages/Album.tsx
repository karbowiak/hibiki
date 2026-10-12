import { ArtworkImage, useArtworkFailures } from "../shared/ArtworkImage"
import { useAlbumImage } from "../../hooks/useMediaImage"
import { useLayoutEffect, useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Link, useLocation } from "wouter"
import { open } from "@tauri-apps/plugin-shell"
import { useShallow } from "zustand/react/shallow"
import { usePlayerStore, useUIStore, useLibraryStore } from "../../stores"
import { useProviderStore } from "../../stores/providerStore"
import { formatMs, formatTotalDuration } from "../../lib/formatters"
import { ImageModal } from "../shared/ImageModal"
import { prefetchTrackAudio } from "../../stores/playerStore"
import { useContextMenu } from "../../hooks/useContextMenu"
import type {
  MusicAlbum,
  MusicTrack,
  MusicHub,
  MusicItem,
} from "../../types/music"
import { MediaCard } from "../MediaCard"
import { ScrollRow } from "../ScrollRow"
import { MediaBackdrop } from "../shared/MediaBackdrop"
import {
  getCachedAlbum,
  prefetchAlbum,
  prefetchArtist,
  loadAlbumPage,
  captureMetadataCache,
  isMetadataCacheCurrent,
} from "../../stores/metadataCache"
import { useAlbumEnrichment } from "../../hooks/useMetadataEnrichment"
import { useMetadataSourceStore } from "../../stores/metadataSourceStore"
import { HeroRating } from "../HeroRating"
import { PageLoading } from "../shared/PageLoading"
import { PageRecovery } from "../shared/PageRecovery"
import { ArtworkSourcePicker } from "../shared/ArtworkSourcePicker"
import { StarRating } from "../shared/StarRating"
import { useDebugStore } from "../../stores/debugStore"
import { useDebugPanelStore } from "../../stores/debugPanelStore"
import { useCapability } from "../../hooks/useCapability"
import { useTrackDrag } from "../../hooks/useTrackDrag"

function TagChip({
  tag,
  tagType,
}: {
  tag: string
  tagType: "genre" | "mood" | "style"
}) {
  return (
    <Link
      href={`/genre/${tagType}/${encodeURIComponent(tag)}`}
      className="rounded-full border border-white/20 px-2.5 py-0.5 text-xs text-gray-300 transition-colors hover:border-white/40 hover:text-white"
    >
      {tag}
    </Link>
  )
}

export function AlbumPage({ albumId }: { albumId: string }) {
  const [, navigate] = useLocation()
  const provider = useProviderStore((s) => s.provider)
  const { playTrack, playRadio, addToQueue, addNext, currentTrack } =
    usePlayerStore(
      useShallow((s) => ({
        playTrack: s.playTrack,
        playRadio: s.playRadio,
        addToQueue: s.addToQueue,
        addNext: s.addNext,
        currentTrack: s.currentTrack,
      }))
    )
  const { handler: ctxMenu, isTarget: isCtxTarget } = useContextMenu()
  const trackDrag = useTrackDrag()
  const pageRefreshKey = useUIStore((s) => s.pageRefreshKey)
  const hasRadio = useCapability("radio")

  // Seed from eager-load cache for an instant first render.
  const cached = getCachedAlbum(albumId)
  const [album, setAlbum] = useState<MusicAlbum | null>(cached?.album ?? null)
  const [tracks, setTracks] = useState<MusicTrack[]>(cached?.tracks ?? [])
  const [relatedHubs, setRelatedHubs] = useState<MusicHub[]>(
    cached?.relatedHubs ?? []
  )
  const [isLoading, setIsLoading] = useState(!cached)
  const [error, setError] = useState<string | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)

  // UI state
  const [descExpanded, setDescExpanded] = useState(false)
  const [showImageModal, setShowImageModal] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
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
  } = useAlbumEnrichment(album?.artistName ?? null, album?.title ?? null)

  useLayoutEffect(() => {
    let active = true
    const session = captureMetadataCache(provider)
    const current = () => active && isMetadataCacheCurrent(session)
    setError(null)
    setDescExpanded(false)
    setShowImageModal(false)

    // Seed ALL state from persistent cache — avoids loading flash.
    const freshCache = getCachedAlbum(albumId)
    if (freshCache) {
      setAlbum(freshCache.album)
      setTracks(freshCache.tracks)
      setRelatedHubs(freshCache.relatedHubs)
      setIsLoading(false)
    } else {
      setAlbum(null)
      setTracks([])
      setRelatedHubs([])
      setIsLoading(true)
    }

    if (!provider || !session) {
      setIsLoading(false)
      return
    }
    loadAlbumPage(albumId, { force: true })
      .then((entry) => {
        if (!current()) return
        setAlbum(entry.album)
        setTracks(entry.tracks)
        setRelatedHubs(entry.relatedHubs)
      })
      .catch((error) => {
        if (current()) setError(String(error))
      })
      .finally(() => {
        if (current()) setIsLoading(false)
      })
    return () => {
      active = false
    }
  }, [albumId, provider, pageRefreshKey, loadAttempt])

  // Build set of all Plex-known tags so external tags can be filtered to only
  // those that link to something in the library (genre/mood/style stations).
  const plexTagSet = useMemo(
    () =>
      new Set(
        [...tagsGenre, ...tagsMood, ...tagsStyle].map((t) =>
          t.tag.toLowerCase()
        )
      ),
    [tagsGenre, tagsMood, tagsStyle]
  )

  // Map each tag name (lowercase) to its tagType for building correct genre links.
  // Must be before early returns — hooks cannot be called conditionally.
  const albumGenre = album?.genres ?? []
  const albumStyle = album?.styles ?? []
  const albumMood = album?.moods ?? []
  const tagTypeMap = useMemo(() => {
    const m = new Map<string, "genre" | "mood" | "style">()
    for (const t of tagsGenre) m.set(t.tag.toLowerCase(), "genre")
    for (const t of tagsMood) m.set(t.tag.toLowerCase(), "mood")
    for (const t of tagsStyle) m.set(t.tag.toLowerCase(), "style")
    // Album-specific tags override (they are authoritative)
    for (const t of albumGenre) m.set(t.toLowerCase(), "genre")
    for (const t of albumStyle) m.set(t.toLowerCase(), "style")
    for (const t of albumMood) m.set(t.toLowerCase(), "mood")
    return m
  }, [albumGenre, albumStyle, albumMood, tagsGenre, tagsMood, tagsStyle])

  const { failures, onFailure } = useArtworkFailures(
    JSON.stringify([albumId, album?.artistName, album?.title, album?.thumbUrl])
  )
  const thumbUrl = useAlbumImage(
    album?.artistName ?? null,
    album?.title ?? null,
    album?.thumbUrl ?? null,
    albumId,
    failures
  )


  if (isLoading) return <PageLoading message="Loading album…" />
  if (!album)
    return (
      <div className="p-6">
        <PageRecovery
          title={
            !provider
              ? "Connect your music library"
              : error
                ? "Couldn't load this album"
                : "Album unavailable"
          }
          description={
            !provider
              ? "Choose a music server in Settings to browse albums."
              : "Check your connection and try again, or choose another album from your library."
          }
          kind={!provider || !error ? "empty" : "error"}
          onRetry={provider ? () => setLoadAttempt((n) => n + 1) : undefined}
          onOpenSettings={() => navigate("/settings")}
          onReturnLibrary={() => navigate("/collection/albums")}
        />
      </div>
    )

  const parentThumbUrl = album.artistThumbUrl

  const formatLabel = album.format ?? "Album"

  const plexTags = [...album.genres, ...album.styles, ...album.moods]

  // Bio: pick from the highest-priority source that has text.
  // Only Plex and Last.fm have album bios/wiki; Deezer and Apple are skipped.
  let displayWiki: string | undefined
  for (const src of priority) {
    if (src === "lastfm" && lastfmData?.wiki) {
      displayWiki = lastfmData.wiki
      break
    }
    if (src === "plex" && album.summary) {
      displayWiki = album.summary
      break
    }
  }

  // Merge tags in priority order; Plex tags always valid; external tags filtered.
  const tagsBySource: Record<string, string[]> = {
    plex: plexTags,
    lastfm: (lastfmData?.tags ?? []).filter((t) =>
      plexTagSet.has(t.toLowerCase())
    ),
    deezer: (deezerData?.genres ?? []).filter((g) =>
      plexTagSet.has(g.toLowerCase())
    ),
    apple:
      itunesData?.genre && plexTagSet.has(itunesData.genre.toLowerCase())
        ? [itunesData.genre]
        : [],
  }
  const seenTagKeys = new Set<string>()
  const allTags: string[] = []
  for (const src of priority) {
    for (const tag of tagsBySource[src] ?? []) {
      const key = tag.toLowerCase()
      if (!seenTagKeys.has(key)) {
        seenTagKeys.add(key)
        allTags.push(tag)
      }
    }
  }
  // Use Deezer label as fallback when Plex has none.
  // Deezer returns the literal string "[no label]" for unlabelled releases — filter that out.
  const deezerLabel =
    deezerData?.label && deezerData.label !== "[no label]"
      ? deezerData.label
      : null
  const displayLabel =
    album.labels.length > 0 ? album.labels.join(", ") : deezerLabel

  // Show all non-empty hubs (sonically similar, more by artist, etc.)
  const nonEmptyHubs = relatedHubs.filter(
    (h) => h.identifier && h.items.length > 0
  )
  const review =
    album.reviews && album.reviews.length > 0 ? album.reviews[0] : null

  return (
    <div className="media-detail-page pb-12">
      <MediaBackdrop
        src={thumbUrl ?? parentThumbUrl}
        heroRef={heroRef}
        onFailure={onFailure}
      />
      {/* Header */}
      <div
        ref={heroRef}
        className="media-detail-hero hero-overlay relative flex items-end"
      >
        <div className="relative z-10 flex w-full flex-wrap items-end gap-6">
          {/* Album art — click to open modal */}
          <div className="flex flex-shrink-0 flex-col items-start gap-2">
            {thumbUrl ? (
              <button
                type="button"
                aria-label={`View ${album.title} artwork`}
                onClick={(e) => {
                  e.currentTarget.focus({ preventScroll: true })
                  setShowImageModal(true)
                }}
                className="h-52 w-52 flex-shrink-0 rounded-md shadow-2xl ring-2 ring-transparent transition-all duration-200 hover:ring-white/40 focus-visible:outline-none focus-visible:ring-white/70"
              >
                <ArtworkImage
                  src={thumbUrl}
                  onFailure={onFailure}
                  loading="eager"
                  alt=""
                  className="h-full w-full rounded-md object-cover"
                />
              </button>
            ) : (
              <div className="h-52 w-52 flex-shrink-0 rounded-md bg-app-surface shadow-2xl" />
            )}
            <ArtworkSourcePicker
              kind="album"
              artistName={album.artistName}
              albumName={album.title}
              plexThumb={album.thumbUrl}
              entityId={albumId}
              className="rounded-full border border-white/20 bg-black/30 px-3 py-1.5 text-xs text-white hover:bg-black/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            />
          </div>

          {/* Info column — no fixed height so hero grows with expanded description */}
          <div className="flex min-w-0 flex-[1_1_20rem] flex-col gap-2 pb-2">
            <div className="media-detail-eyebrow">{formatLabel}</div>
            <h1 className="media-detail-title select-text break-words">
              {album.title}
            </h1>

            <div className="flex flex-wrap items-center gap-2 text-sm text-gray-300">
              {parentThumbUrl && (
                <ArtworkImage
                  src={parentThumbUrl}
                  alt=""
                  className="h-6 w-6 flex-shrink-0 rounded object-cover"
                />
              )}
              <Link
                href={`/artist/${album.artistId}`}
                className="font-semibold hover:underline"
              >
                {album.artistName}
              </Link>
              <span className="text-gray-500">·</span>
              <span className="text-gray-400">{album.year}</span>
              <span className="text-gray-500">·</span>
              <span className="text-gray-400">
                {tracks.length} {tracks.length === 1 ? "song" : "songs"}
              </span>
              <span className="text-gray-500">·</span>
              <span className="text-gray-400">
                {formatTotalDuration(tracks)}
              </span>
              {album.studio && (
                <>
                  <span className="text-gray-500">·</span>
                  <span className="text-gray-400">{album.studio}</span>
                </>
              )}
              {displayLabel && (
                <>
                  <span className="text-gray-500">·</span>
                  <span className="text-gray-400">{displayLabel}</span>
                </>
              )}
              {deezerData && deezerData.fans > 0 && (
                <>
                  <span className="text-gray-500">·</span>
                  <span className="text-gray-400">
                    {deezerData.fans.toLocaleString()} fans
                  </span>
                </>
              )}
            </div>

            {/* Rating */}
            <HeroRating
              itemId={albumId}
              userRating={album.userRating}
              itemType="album"
              onHero
            />

            {allTags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {allTags.map((t) => (
                  <TagChip
                    key={t}
                    tag={t}
                    tagType={tagTypeMap.get(t.toLowerCase()) ?? "genre"}
                  />
                ))}
              </div>
            )}

            {/* Expandable description */}
            {displayWiki && (
              <div
                className="max-w-xl cursor-pointer select-text"
                onClick={() => setDescExpanded((v) => !v)}
              >
                <div
                  className="overflow-hidden transition-all duration-500 ease-in-out"
                  style={{ maxHeight: descExpanded ? "500px" : "2.8rem" }}
                >
                  <p className="text-sm leading-relaxed text-gray-300">
                    {displayWiki}
                  </p>
                </div>
                <span className="mt-0.5 flex items-center gap-1 text-xs text-gray-500 transition-colors hover:text-gray-300">
                  <svg
                    viewBox="0 0 16 16"
                    width="12"
                    height="12"
                    fill="currentColor"
                    className={`transition-transform duration-300 ${descExpanded ? "rotate-180" : ""}`}
                  >
                    <path d="M8 10.94 2.53 5.47l1.06-1.06L8 8.82l4.41-4.41 1.06 1.06z" />
                  </svg>
                  {descExpanded ? "Less" : "More"}
                </span>
              </div>
            )}
          </div>
          <div className="relative z-20 flex w-full flex-wrap items-center gap-2 pt-3">
            {/* Play */}
            <button
              onClick={() =>
                tracks.length > 0 &&
                void playTrack(
                  tracks[0],
                  tracks,
                  album.title,
                  `/album/${albumId}`,
                  albumId
                )
              }
              disabled={tracks.length === 0}
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
              onClick={() => {
                if (tracks.length === 0) return
                const s = [...tracks].sort(() => Math.random() - 0.5)
                void playTrack(
                  s[0],
                  s,
                  album.title,
                  `/album/${albumId}`,
                  albumId
                )
              }}
              disabled={tracks.length === 0}
              title="Shuffle"
              className="media-secondary"
            >
              <svg
                role="img"
                height="16"
                width="16"
                viewBox="0 0 16 16"
                fill="currentColor"
              >
                <path d="M13.151.922a.75.75 0 1 0-1.06 1.06L13.109 3H11.16a3.75 3.75 0 0 0-2.873 1.34l-6.173 7.356A2.25 2.25 0 0 1 .39 12.5H0V14h.391a3.75 3.75 0 0 0 2.873-1.34l6.173-7.356a2.25 2.25 0 0 1 1.724-.804h1.947l-1.017 1.018a.75.75 0 0 0 1.06 1.06L15.98 3.75 13.15.922zM.391 3.5H0V2h.391c1.109 0 2.16.49 2.873 1.34L4.89 5.277l-.979 1.167-1.796-2.14A2.25 2.25 0 0 0 .39 3.5z" />
                <path d="m7.5 10.723.98-1.167.957 1.14a2.25 2.25 0 0 0 1.724.804h1.947l-1.017-1.018a.75.75 0 1 1 1.06-1.06l2.829 2.828-2.829 2.828a.75.75 0 1 1-1.06-1.06L13.109 13H11.16a3.75 3.75 0 0 1-2.873-1.34l-.787-.938z" />
              </svg>
              <span>Shuffle</span>
            </button>
            {/* Album Radio */}
            {hasRadio && (
              <button
                onClick={() => void playRadio(albumId, "album")}
                title="Album Radio — continuous sonically-similar music"
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
              {album &&
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
                        {/* Queue */}
                        <button
                          onClick={() => {
                            addNext(tracks)
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
                            <path d="M6 18l8.5-6L6 6v12zm2-8.14L11.03 12 8 14.14V9.86zM16 6h2v12h-2z" />
                          </svg>
                          Play next
                        </button>
                        <button
                          onClick={() => {
                            addToQueue(tracks)
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
                          Add to queue
                        </button>

                        <hr className="my-1 border-t border-[var(--border)]" />

                        {/* Rating */}
                        <StarRating
                          itemId={album.id}
                          itemType="album"
                          userRating={album.userRating ?? null}
                          enableLove={false}
                          artist={album.artistName}
                          track={album.title}
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
                              `https://www.last.fm/music/${encodeURIComponent(album.artistName)}`
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
                          Last.fm artist
                        </button>
                        <button
                          onClick={() => {
                            void open(
                              `https://www.last.fm/music/${encodeURIComponent(album.artistName)}/${encodeURIComponent(album.title)}`
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
                          Last.fm album
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

                        <hr className="my-1 border-t border-[var(--border)]" />

                        {/* Navigation */}
                        <Link
                          href={`/artist/${album.artistId}`}
                          onClick={() => setMenuOpen(false)}
                          className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[color:var(--text-primary)] hover:bg-[var(--bg-surface-hover)]"
                        >
                          <svg
                            viewBox="0 0 24 24"
                            fill="currentColor"
                            width="14"
                            height="14"
                          >
                            <path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0 2c-5.33 0-8 2.67-8 4v1h16v-1c0-1.33-2.67-4-8-4z" />
                          </svg>
                          Go to artist
                        </Link>

                        {/* Debug */}
                        {debugEnabled && (
                          <>
                            <hr className="my-1 border-t border-[var(--border)]" />
                            <div className="px-3 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-white/30">
                              Debug
                            </div>
                            <button
                              onClick={() => {
                                showDebugPanel("album", album)
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

      <dl className="media-ledger" aria-label="Album overview">
        {album.year > 0 && (
          <div>
            <dt>Released</dt>
            <dd>{album.year}</dd>
          </div>
        )}
        <div>
          <dt>Tracks</dt>
          <dd>{tracks.length}</dd>
        </div>
        <div>
          <dt>Runtime</dt>
          <dd>{formatTotalDuration(tracks)}</dd>
        </div>
        {tracks[0]?.codec && (
          <div>
            <dt>Quality</dt>
            <dd>
              {tracks[0].codec.toUpperCase()}
              {tracks[0].bitrate ? ` · ${tracks[0].bitrate} kbps` : ""}
            </dd>
          </div>
        )}
      </dl>
      {/* Track list */}
      <div className="px-8">
        {error && (
          <PageRecovery
            title="Couldn't refresh this album"
            description="Showing saved album information. Try again when your connection is available."
            onRetry={() => setLoadAttempt((n) => n + 1)}
          />
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-[color:var(--text-secondary)]">
            <thead className="border-b border-[var(--border)]">
              <tr>
                <th className="w-8 p-2 text-center">#</th>
                <th className="p-2 text-left">Title</th>
                <th className="w-32 p-2 text-right">Rating</th>
                <th className="w-36 p-2 text-right">Duration</th>
              </tr>
            </thead>
            <tbody>
              {tracks.map((track, idx) => {
                const isActive = currentTrack?.id === track.id
                const isContextTarget = isCtxTarget(track.id)
                return (
                  <tr
                    key={track.id}
                    className={`media-track-row group cursor-pointer rounded focus-within:bg-hl-row ${isActive || isContextTarget ? "bg-hl-row" : "hover:bg-hl-row"}`}
                    onClick={() =>
                      void playTrack(
                        track,
                        tracks,
                        album.title,
                        `/album/${albumId}`,
                        albumId
                      )
                    }
                    onMouseEnter={() => prefetchTrackAudio(track)}
                    onContextMenu={ctxMenu("track", track)}
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
                    <td className="w-8 p-2 text-center">
                      <button
                        type="button"
                        aria-label={`Play ${track.title}`}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation()
                          void playTrack(
                            track,
                            tracks,
                            album.title,
                            `/album/${albumId}`,
                            albumId
                          )
                        }}
                        className={`flex h-7 w-7 items-center justify-center rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${isActive ? "text-accent" : "text-[color:var(--text-secondary)]"}`}
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
                            track.trackNumber || idx + 1
                          )}
                        </span>
                        <svg
                          aria-hidden="true"
                          className="hidden group-focus-within:block group-hover:block"
                          viewBox="0 0 16 16"
                          width="12"
                          height="12"
                          fill="currentColor"
                        >
                          <polygon points="3,2 13,8 3,14" />
                        </svg>
                      </button>
                    </td>
                    <td className="p-2">
                      <div
                        className={
                          isActive
                            ? "text-accent"
                            : "text-[color:var(--text-primary)]"
                        }
                      >
                        {track.title}
                      </div>
                      {track.originalTitle &&
                        track.originalTitle !== album.artistName && (
                          <div className="text-xs text-[color:var(--text-muted)]">
                            {track.originalTitle}
                          </div>
                        )}
                    </td>
                    <td
                      className="p-2 text-right"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <HeroRating
                        itemId={track.id}
                        userRating={track.userRating}
                      />
                    </td>
                    <td className="w-36 p-2 text-right tabular-nums">
                      <span className="group-focus-within:hidden group-hover:hidden">
                        {formatMs(track.duration)}
                      </span>
                      <div className="inline-flex items-center gap-2 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                        <button
                          className="flex items-center gap-0.5 px-1 text-xs text-[color:var(--text-secondary)] transition-colors hover:text-[color:var(--text-primary)]"
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
                            className="flex items-center gap-1 px-1 text-xs text-[color:var(--text-secondary)] transition-colors hover:text-[color:var(--text-primary)]"
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
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Review */}
      {review && (
        <div className="px-8 pt-6">
          <div className="max-w-2xl rounded-lg border border-[var(--border)] bg-app-surface p-4">
            {review.tag && (
              <div className="mb-2 text-sm font-semibold text-[color:var(--text-primary)]">
                {review.tag}
              </div>
            )}
            {review.text && (
              <p className="line-clamp-4 text-sm leading-relaxed text-[color:var(--text-secondary)]">
                {review.text}
              </p>
            )}
            {review.source && (
              <div className="mt-2 text-xs text-[color:var(--text-muted)]">
                — {review.source}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Related hubs (sonically similar, more by artist, etc.) */}
      {nonEmptyHubs.length > 0 && (
        <div className="flex flex-col gap-8 px-8 pt-10">
          {nonEmptyHubs.map((hub) => {
            const albumItems = hub.items.filter((m) => m.type === "album")
            const artistItems = hub.items.filter((m) => m.type === "artist")

            if (albumItems.length > 0) {
              return (
                <ScrollRow
                  key={hub.identifier}
                  title={hub.title}
                  restoreKey={`album-${albumId}-${hub.identifier}`}
                >
                  {albumItems.map((a) => (
                    <MediaCard
                      key={a.id}
                      title={a.title}
                      desc={`${(a as any).artistName ?? ""} · ${(a as any).year ?? ""}`}
                      thumb={(a as any).thumbUrl ?? null}
                      href={`/album/${a.id}`}
                      prefetch={() => prefetchAlbum(a.id)}
                      dragPayload={{
                        type: "album",
                        ids: [a.id],
                        label: a.title,
                      }}
                      scrollItem
                    />
                  ))}
                </ScrollRow>
              )
            }

            if (artistItems.length > 0) {
              return (
                <ScrollRow
                  key={hub.identifier}
                  title={hub.title}
                  restoreKey={`album-${albumId}-${hub.identifier}`}
                >
                  {artistItems.map((a) => (
                    <MediaCard
                      key={a.id}
                      title={a.title}
                      desc="Artist"
                      thumb={(a as any).thumbUrl ?? null}
                      href={`/artist/${a.id}`}
                      prefetch={() => prefetchArtist(a.id)}
                      dragPayload={{
                        type: "artist",
                        ids: [a.id],
                        label: a.title,
                      }}
                      isArtist
                      scrollItem
                    />
                  ))}
                </ScrollRow>
              )
            }

            return null
          })}
        </div>
      )}

      {showImageModal && thumbUrl && (
        <ImageModal
          src={thumbUrl}
          alt={album.title}
          onClose={() => setShowImageModal(false)}
        />
      )}
    </div>
  )
}
