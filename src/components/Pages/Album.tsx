import { Button } from "../shared/Button"
import { DropdownSurface } from "../shared/DropdownSurface"
import { ArtistCredits } from "../shared/ArtistCredits"
import { MusicEntityLink } from "../shared/MusicEntityLink"
import { albumArtistEntity } from "../../lib/musicLinks"
import { useAlbumCatalog } from "../../hooks/useAlbumCatalog"
import { DownloadBadge } from "../shared/DownloadBadge"
import { DownloadMenuItems } from "../shared/DownloadMenuItems"
import {
  metadataRefreshMessage,
} from "../../lib/metadataLoadError"
import "../../styles/media-detail-controls.css"
import { ArtworkImage, useArtworkFailures } from "../shared/ArtworkImage"
import { useAlbumImage, useAlbumBackground } from "../../hooks/useMediaImage"
import { useLayoutEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Link, useLocation } from "wouter"
import { openUrl as open } from "@tauri-apps/plugin-opener"
import { useShallow } from "zustand/react/shallow"
import { usePlayerStore, useLibraryStore } from "../../stores"
import { useProviderStore } from "../../stores/providerStore"
import { formatTotalDuration } from "../../lib/formatters"
import { ImageModal } from "../shared/ImageModal"
import { MediaCard } from "../MediaCard"
import { ScrollRow } from "../ScrollRow"
import { MediaBackdrop } from "../shared/MediaBackdrop"
import {
  prefetchAlbum,
  prefetchArtist,
} from "../../stores/metadataCache"
import { HeroRating } from "../HeroRating"
import { PageLoading } from "../shared/PageLoading"
import { PageRecovery } from "../shared/PageRecovery"
import { ArtworkSourcePicker } from "../shared/ArtworkSourcePicker"
import { StarRating } from "../shared/StarRating"
import { DetailTrackList } from "../shared/TrackTable"
import { useDebugStore } from "../../stores/debugStore"
import { useDebugPanelStore } from "../../stores/debugPanelStore"
import { useCapability } from "../../hooks/useCapability"
import { useMetadataSnapshot } from "../../hooks/useMetadataSnapshot"
import { MetadataEditDialog } from "../shared/MetadataEditDialog"
import { AppDialog } from "../shared/AppDialog"
import { VersionReviewPanel } from "../VersionReview/VersionReviewPanel"
import { MusicSourceBadge } from "../shared/MusicSource"

const DETAIL_SOURCES = ["deezer"] as const

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
  const hasRadio = useCapability("radio")

  const catalog = useAlbumCatalog(albumId)
  const { entry, tracks, isLoading, error, retry } = catalog
  const album = entry?.album ?? null
  const relatedHubs = entry?.relatedHubs ?? []

  // UI state
  const [descExpanded, setDescExpanded] = useState(false)
  const [showImageModal, setShowImageModal] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [versionsOpen, setVersionsOpen] = useState(false)
  const menuBtnRef = useRef<HTMLButtonElement>(null)
  const heroRef = useRef<HTMLDivElement>(null)
  const debugEnabled = useDebugStore((s) => s.debugEnabled)
  const showDebugPanel = useDebugPanelStore((s) => s.show)

  const { tagsGenre, tagsMood, tagsStyle } = useLibraryStore(
    useShallow((s) => ({
      tagsGenre: s.tagsGenre,
      tagsMood: s.tagsMood,
      tagsStyle: s.tagsStyle,
    }))
  )

  const sharedMetadata = useMetadataSnapshot(
    album && provider?.cacheScope
      ? {
          kind: "album",
          entityId: album.id,
          artist: album.artistName,
          title: album.title,
          scope: provider.cacheScope,
        }
      : null,
    album,
    undefined,
    undefined,
    DETAIL_SOURCES
  )
  const deezerData = sharedMetadata.sourceFields("deezer")

  useLayoutEffect(() => {
    setDescExpanded(false)
    setShowImageModal(false)
    setEditOpen(false)
    setVersionsOpen(false)
  }, [provider, albumId])

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
  const backgroundUrl = useAlbumBackground(
    album?.artistName ?? null,
    album?.title ?? null,
    album?.artUrl ?? null,
    albumId,
    failures
  )

  if (isLoading) return <PageLoading message="Loading album…" variant="album" />
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
          onRetry={provider ? retry : undefined}
          onOpenSettings={() => navigate("/settings")}
          onReturnLibrary={() => navigate("/collection/albums")}
        />
      </div>
    )

  const playableTracks = provider?.isOffline
    ? tracks.filter(
        (track) =>
          track.mediaInfo?.offlineAvailable === true ||
          track.mediaInfo?.localAudio
      )
    : tracks
  const parentThumbUrl = album.artistThumbUrl

  const formatLabel = album.format ?? "Album"

  // Bio: pick from the highest-priority source that has text.
  // Only Plex and Last.fm have album bios/wiki; Deezer and Apple are skipped.
  const displayWiki = sharedMetadata.resolveField("summary")?.value

  const resolvedGenres = sharedMetadata.resolveField("genres")
  const resolvedTags = sharedMetadata.resolveField("tags")
  const seenTagKeys = new Set<string>()
  const allTags: string[] = []
  for (const resolved of [resolvedGenres, resolvedTags]) {
    for (const tag of resolved?.value ?? []) {
      if (resolved.source !== "plex" && !plexTagSet.has(tag.toLowerCase()))
        continue
      const key = tag.toLowerCase()
      if (!seenTagKeys.has(key)) {
        seenTagKeys.add(key)
        allTags.push(tag)
      }
    }
  }
  const displayLabel =
    sharedMetadata.resolveField("label")?.value ??
    (album.labels.length ? album.labels.join(", ") : null)

  // Show all non-empty hubs (sonically similar, more by artist, etc.)
  const nonEmptyHubs = relatedHubs.filter(
    (h) => h.identifier && h.items.length > 0
  )
  const review =
    album.reviews && album.reviews.length > 0 ? album.reviews[0] : null

  return (
    <div className="media-detail-page pb-12">
      {versionsOpen && (
        <AppDialog
          key={`${provider?.cacheScope}:versions:${album.id}`}
          title="Album and media versions"
          description={album.title}
          onClose={() => setVersionsOpen(false)}
        >
          <VersionReviewPanel album={album} tracks={entry?.tracks ?? []} />
        </AppDialog>
      )}
      {editOpen && (
        <MetadataEditDialog
          key={`${provider?.cacheScope}:album:${album.id}`}
          kind="album"
          item={album}
          artworkUrl={thumbUrl}
          backgroundUrl={backgroundUrl ?? thumbUrl ?? parentThumbUrl}
          onClose={() => setEditOpen(false)}
          onSaved={retry}
        />
      )}
      <MediaBackdrop
        src={backgroundUrl ?? thumbUrl ?? parentThumbUrl}
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
          <div className="artwork-edit-frame relative flex shrink-0 flex-col items-start">
            {thumbUrl ? (
              <Button
                variant="bare"
                type="button"
                aria-label={`View ${album.title} artwork`}
                onClick={(e) => {
                  e.currentTarget.focus({ preventScroll: true })
                  setShowImageModal(true)
                }}
                className="h-52 w-52 shrink-0 rounded-md shadow-2xl ring-2 ring-transparent transition-all duration-200 hover:ring-white/40 focus-visible:outline-none focus-visible:ring-white/70"
              >
                <ArtworkImage
                  src={thumbUrl}
                  onFailure={onFailure}
                  loading="eager"
                  alt=""
                  className="h-full w-full rounded-md object-cover"
                />
              </Button>
            ) : (
              <div className="h-52 w-52 shrink-0 rounded-md bg-app-surface shadow-2xl" />
            )}
            <ArtworkSourcePicker
              kind="album"
              artistName={album.artistName}
              albumName={album.title}
              plexThumb={album.thumbUrl}
              entityId={albumId}
              label={`Edit ${album.title} artwork sources`}
              iconOnly
              className="artwork-edit-trigger"
            />
          </div>

          {/* Info column — no fixed height so hero grows with expanded description */}
          <div className="flex min-w-0 flex-[1_1_20rem] flex-col gap-2 pb-2">
            <div className="flex items-center gap-2">
              <div className="media-detail-eyebrow">{formatLabel}</div>
              <DownloadBadge kind="album" id={albumId} />
            </div>
            <h1 className="media-detail-title select-text wrap-break-word">
              {album.title}
            </h1>

            <div className="flex flex-wrap items-center gap-2 text-sm text-gray-300">
              <MusicSourceBadge source="plex" />
              {catalog.youtube && <MusicSourceBadge source="ytmusic" />}
              {parentThumbUrl && (
                <ArtworkImage
                  src={parentThumbUrl}
                  alt=""
                  className="h-6 w-6 shrink-0 rounded object-cover"
                />
              )}
              <span><ArtistCredits item={album} className="font-semibold hover:underline" /></span>
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
            <Button
              size="md"
              variant="primary"
              onClick={() =>
                playableTracks.length > 0 &&
                void playTrack(
                  playableTracks[0],
                  playableTracks,
                  album.title,
                  `/album/${albumId}`,
                  albumId
                )
              }
              disabled={playableTracks.length === 0}
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
            </Button>
            {/* Shuffle */}
            <Button
              size="md"
              variant="secondary"
              onClick={() => {
                if (playableTracks.length === 0) return
                const s = [...playableTracks].sort(() => Math.random() - 0.5)
                void playTrack(
                  s[0],
                  s,
                  album.title,
                  `/album/${albumId}`,
                  albumId
                )
              }}
              disabled={playableTracks.length === 0}
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
            </Button>
            {/* Album Radio */}
            {hasRadio && (
              <Button
                size="md"
                variant="secondary"
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
              </Button>
            )}
            {/* Three-dot menu */}
            <div className="relative">
              <Button
                variant="bare"
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
              </Button>
              {album &&
                menuOpen &&
                (() => {
                  const rect = menuBtnRef.current?.getBoundingClientRect()
                  return createPortal(
                    <>
                      <div
                        className="fixed inset-0 z-9998"
                        onClick={() => setMenuOpen(false)}
                      />
                      <DropdownSurface
                        className="app-overlay-surface fixed z-9999 max-h-[70vh] w-56 overflow-y-auto rounded-lg border border-(--border) bg-app-surface py-1 shadow-xl"
                        style={{
                          top: (rect?.bottom ?? 0) + 4,
                          right: window.innerWidth - (rect?.right ?? 0),
                        }}
                      >
                        <DownloadMenuItems
                          kind="album"
                          id={albumId}
                          title={album.title}
                          close={() => setMenuOpen(false)}
                          current={() =>
                            menuOpen &&
                            useProviderStore.getState().provider === provider
                          }
                        />
                        {/* Queue */}
                        <Button
                          variant="menu"
                          type="button"
                          onClick={() => {
                            setMenuOpen(false)
                            setEditOpen(true)
                          }}
                          className="flex w-full items-center gap-2 px-3 py-2 text-sm text-(--text-primary) hover:bg-(--bg-surface-hover)"
                        >
                          Edit metadata and sources…
                        </Button>
                        <Button
                          variant="menu"
                          type="button"
                          onClick={() => {
                            setMenuOpen(false)
                            setVersionsOpen(true)
                          }}
                          className="flex w-full items-center gap-2 px-3 py-2 text-sm text-(--text-primary) hover:bg-(--bg-surface-hover)"
                        >
                          Compare album and media versions…
                        </Button>
                        <Button
                          variant="menu"
                          onClick={() => {
                            addNext(tracks)
                            setMenuOpen(false)
                          }}
                          className="flex w-full items-center gap-2 px-3 py-2 text-sm text-(--text-primary) hover:bg-(--bg-surface-hover)"
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
                        </Button>
                        <Button
                          variant="menu"
                          onClick={() => {
                            addToQueue(tracks)
                            setMenuOpen(false)
                          }}
                          className="flex w-full items-center gap-2 px-3 py-2 text-sm text-(--text-primary) hover:bg-(--bg-surface-hover)"
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
                        </Button>

                        <hr className="my-1 border-t border-(--border)" />

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

                        <hr className="my-1 border-t border-(--border)" />

                        {/* Share */}
                        <div className="px-3 pb-0.5 pt-2 text-xs font-semibold text-(--text-secondary)">
                          Share
                        </div>
                        <Button
                          variant="menu"
                          onClick={() => {
                            void open(
                              `https://www.last.fm/music/${encodeURIComponent(album.artistName)}`
                            )
                            setMenuOpen(false)
                          }}
                          className="flex w-full items-center gap-2 px-3 py-2 text-sm text-(--text-primary) hover:bg-(--bg-surface-hover)"
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
                        </Button>
                        <Button
                          variant="menu"
                          onClick={() => {
                            void open(
                              `https://www.last.fm/music/${encodeURIComponent(album.artistName)}/${encodeURIComponent(album.title)}`
                            )
                            setMenuOpen(false)
                          }}
                          className="flex w-full items-center gap-2 px-3 py-2 text-sm text-(--text-primary) hover:bg-(--bg-surface-hover)"
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
                        </Button>
                        {deezerData?.externalUrl && (
                          <Button
                            variant="menu"
                            onClick={() => {
                              void open(deezerData.externalUrl)
                              setMenuOpen(false)
                            }}
                            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-(--text-primary) hover:bg-(--bg-surface-hover)"
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
                          </Button>
                        )}

                        <hr className="my-1 border-t border-(--border)" />

                        {/* Navigation */}
                        <MusicEntityLink
                          entity={albumArtistEntity(album)}
                          onNavigate={() => setMenuOpen(false)}
                          className="flex w-full items-center gap-2 px-3 py-2 text-sm text-(--text-primary) hover:bg-(--bg-surface-hover)"
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
                        </MusicEntityLink>

                        {/* Debug */}
                        {debugEnabled && (
                          <>
                            <hr className="my-1 border-t border-(--border)" />
                            <div className="px-3 pb-0.5 pt-2 text-xs font-semibold text-(--text-secondary)">
                              Debug
                            </div>
                            <Button
                              variant="menu"
                              onClick={() => {
                                showDebugPanel("album", album)
                                setMenuOpen(false)
                              }}
                              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-(--text-primary) hover:bg-(--bg-surface-hover)"
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
                            </Button>
                          </>
                        )}
                      </DropdownSurface>
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
        {catalog.youtubeLoading && <p role="status" className="mb-3 text-sm text-(--text-secondary)">Loading YouTube Music tracks…</p>}
        {catalog.youtubeError && <p className="mb-3 text-sm text-(--text-secondary)">Couldn’t load YouTube Music tracks. <Button variant="bare" type="button" onClick={retry} className="text-accent hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">Try again</Button></p>}
        {error && metadataRefreshMessage(error, "album") && (
          <PageRecovery
            title="Couldn't refresh this album"
            description={metadataRefreshMessage(error, "album")!}
            onRetry={retry}
          />
        )}
        <DetailTrackList
          presentation="album"
          tracks={tracks}
          currentTrackId={currentTrack?.id}
          showRadio={hasRadio}
          onPlay={(track) => {
            void playTrack(
              track,
              playableTracks,
              album.title,
              `/album/${albumId}`,
              albumId
            )
          }}
          onAddToQueue={addToQueue}
          onPlayRadio={playRadio}
        />
      </div>

      {/* Review */}
      {review && (
        <div className="px-8 pt-6">
          <div className="max-w-2xl rounded-lg border border-(--border) bg-app-surface p-4">
            {review.tag && (
              <div className="mb-2 text-sm font-semibold text-(--text-primary)">
                {review.tag}
              </div>
            )}
            {review.text && (
              <p className="line-clamp-4 text-sm leading-relaxed text-(--text-secondary)">
                {review.text}
              </p>
            )}
            {review.source && (
              <div className="mt-2 text-xs text-(--text-muted)">
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
                      contextItem={a}
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
                      contextItem={a}
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
