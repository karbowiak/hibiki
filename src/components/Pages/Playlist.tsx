import { useEntityDownloadStatus } from "../shared/DownloadBadge"
import { PlaylistInformationDialog } from "../PlaylistInformationDialog"
import { IconInfoCircle } from "@tabler/icons-react"
import { MetadataEditDialog } from "../shared/MetadataEditDialog"
import { LinkedPlaylistManager } from "../PlaylistSync/LinkedPlaylistManager"
import {
  useLinkedPlaylistStore,
  linksForPlaylist,
} from "../../stores/linkedPlaylistStore"
import { useListenBrainzStore } from "../../metadata/listenbrainz/authStore"
import type { MusicTrack } from "../../types/music"
import { ArtworkImage } from "../shared/ArtworkImage"
import { AmbientHeroBackdrop } from "../shared/MediaBackdrop"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useShallow } from "zustand/react/shallow"
import { useLibraryStore, usePlayerStore, useUIStore } from "../../stores"
import { useProviderStore } from "../../stores/providerStore"
import { formatTotalMs } from "../../lib/formatters"
import {
  useContextMenuStore,
  type ContextAction,
} from "../../stores/contextMenuStore"
import { useTableSort } from "../../hooks/useTableSort"
import { RichText } from "../RichText"
import "../../styles/media-detail-controls.css"
import { useScrollContainer } from "../Page"
import { ALL_COLUMNS, usePlaylistColumns } from "../../hooks/useColumnPicker"
import { TrackTable } from "../shared/TrackTable"
import { PageLoading } from "../shared/PageLoading"
import { useWindowedPages } from "../../hooks/useWindowedPages"
import { playlistNeedsReview } from "../../lib/syncAttention"
import { SyncReviewIndicator } from "../shared/SyncReviewIndicator"

const PLAYLIST_COLUMNS = ALL_COLUMNS

const EMPTY_ITEMS: MusicTrack[] = []

export function Playlist({ playlistId }: { playlistId: string }) {
  const [showLinked, setShowLinked] = useState(false)
  const [syncReview, setSyncReview] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [showInformation, setShowInformation] = useState(false)
  const downloadStatus=useEntityDownloadStatus("playlist",playlistId)
  const linkedState = useLinkedPlaylistStore()
  const syncAuthenticated = useListenBrainzStore((s) => s.isAuthenticated)
  const [showEdit, setShowEdit] = useState(false)
  const ownedMenuActions = useRef<ContextAction[]>([])
  // Granular selectors: changes to playlistItemsCache (background prefetch)
  // do NOT trigger re-renders of this component.
  const {
    fetchPlaylistItems,
    fetchMorePlaylistItems,
    reorderPlaylistItems,
    invalidatePlaylistItems,
  } = useLibraryStore(
    useShallow((s) => ({
      fetchPlaylistItems: s.fetchPlaylistItems,
      fetchMorePlaylistItems: s.fetchMorePlaylistItems,
      reorderPlaylistItems: s.reorderPlaylistItems,
      invalidatePlaylistItems: s.invalidatePlaylistItems,
    }))
  )
  const currentPlaylist = useLibraryStore((s) =>
    s.currentPlaylist?.id === playlistId ? s.currentPlaylist : null
  )
  const currentPlaylistItems = useLibraryStore((s) =>
    s.currentPlaylistId === playlistId ? s.currentPlaylistItems : EMPTY_ITEMS
  )
  const loadError = useLibraryStore((s) =>
    s.currentPlaylistId === playlistId &&
    !s.isLoading &&
    !Object.hasOwn(s.playlistItemsCache, playlistId)
      ? s.error
      : null
  )
  const [reorderError, setReorderError] = useState<string | null>(null)
  const [isReordering, setIsReordering] = useState(false)
  const viewRef = useRef<{ active: boolean; pending: boolean } | null>(null)
  const isLoading = useLibraryStore((s) => s.isLoading)
  const isFetchingMore = useLibraryStore((s) => s.isFetchingMore)
  // Subscribe only to this specific playlist's fullness, not the whole record.
  const isFullyLoaded = useLibraryStore(
    (s) => s.playlistIsFullyLoaded[playlistId] ?? false
  )

  const {
    playTrack,
    playPagedTracks,
    playPlaylist,
    playRadio,
    addToQueue,
    currentTrack,
  } = usePlayerStore(
    useShallow((s) => ({
      playTrack: s.playTrack,
      playPagedTracks: s.playPagedTracks,
      playPlaylist: s.playPlaylist,
      playRadio: s.playRadio,
      addToQueue: s.addToQueue,
      currentTrack: s.currentTrack,
    }))
  )
  const provider = useProviderStore((s) => s.provider)
  const syncLink = linksForPlaylist(provider, playlistId)[0]
  const syncNeedsReview = !!syncError || playlistNeedsReview(syncLink, !!linkedState.error || !!linkedState.checkedErrors?.[syncLink?.id ?? ""], !!linkedState.holds[syncLink?.id ?? ""])
  const windowed = useWindowedPages(
    `playlist:${playlistId}`,
    async (offset, limit) =>
      provider
        ? provider.getPlaylistItems(playlistId, offset, limit)
        : { items: [], total: 0 },
    currentPlaylist?.trackCount ?? 0
  )
  const pageRefreshKey = useUIStore((s) => s.pageRefreshKey)
  const scrollContainerRef = useScrollContainer()
  const heroRef = useRef<HTMLDivElement>(null)

  const { visible: visibleCols, toggle: toggleCol } = usePlaylistColumns(
    "plex-playlist-columns"
  )

  // In-playlist search
  const [filterQuery, setFilterQuery] = useState("")
  const [debouncedQuery, setDebouncedQuery] = useState("")

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(filterQuery), 150)
    return () => clearTimeout(t)
  }, [filterQuery])

  const filteredItems = useMemo(() => {
    if (!debouncedQuery) return currentPlaylistItems
    const q = debouncedQuery.toLowerCase()
    return currentPlaylistItems.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.artistName.toLowerCase().includes(q) ||
        t.albumName.toLowerCase().includes(q)
    )
  }, [currentPlaylistItems, debouncedQuery])

  type SortCol =
    | "default"
    | "title"
    | "artist"
    | "album"
    | "year"
    | "plays"
    | "popularity"
    | "label"
    | "bitrate"
    | "format"
    | "added_at"
    | "rating"
    | "rated_at"
    | "duration"
  const { sortCol, sortDir, handleSort } = useTableSort<SortCol>({
    resetKey: playlistId,
  })

  const sortedItems = useMemo(() => {
    if (sortCol === "default") return filteredItems
    const items = [...filteredItems]
    items.sort((a, b) => {
      let cmp = 0
      switch (sortCol) {
        case "title":
          cmp = a.title.localeCompare(b.title)
          break
        case "artist":
          cmp = a.artistName.localeCompare(b.artistName)
          break
        case "album":
          cmp = a.albumName.localeCompare(b.albumName)
          break
        case "year":
          cmp = (a.albumYear ?? a.year) - (b.albumYear ?? b.year)
          break
        case "plays":
          cmp = a.playCount - b.playCount
          break
        case "popularity":
          cmp = (a.ratingCount ?? 0) - (b.ratingCount ?? 0)
          break
        case "label":
          cmp = (a.parentStudio ?? "").localeCompare(b.parentStudio ?? "")
          break
        case "bitrate":
          cmp = (a.bitrate ?? 0) - (b.bitrate ?? 0)
          break
        case "format":
          cmp = (a.codec ?? "").localeCompare(b.codec ?? "")
          break
        case "added_at":
          cmp =
            (a.addedAt ? +new Date(a.addedAt) : 0) -
            (b.addedAt ? +new Date(b.addedAt) : 0)
          break
        case "rating":
          cmp = (a.userRating ?? 0) - (b.userRating ?? 0)
          break
        case "rated_at":
          cmp =
            (a.lastRatedAt ? +new Date(a.lastRatedAt) : 0) -
            (b.lastRatedAt ? +new Date(b.lastRatedAt) : 0)
          break
        case "duration":
          cmp = a.duration - b.duration
          break
      }
      return sortDir === "asc" ? cmp : -cmp
    })
    return items
  }, [filteredItems, sortCol, sortDir])

  const useQuery = !!debouncedQuery || sortCol !== "default"
  const queried = useWindowedPages(
    useQuery && provider?.getCollectionPage
      ? JSON.stringify([
          "playlist-query",
          playlistId,
          debouncedQuery,
          sortCol,
          sortDir,
        ])
      : null,
    async (offset, limit) => {
      const page = await provider!.getCollectionPage!(
        `playlist:${playlistId}`,
        offset,
        limit,
        debouncedQuery,
        sortCol,
        sortDir
      )
      return {
        ...page,
        items: page.items.filter((item) => item.type === "track"),
      }
    },
    currentPlaylist?.trackCount ?? 0
  )
  const visiblePage =
    useQuery && provider?.getCollectionPage ? queried : windowed

  useLayoutEffect(() => {
    setFilterQuery("")
    setDebouncedQuery("")
    setShowInformation(false)
  }, [playlistId, provider])

  useLayoutEffect(() => {
    const view = { active: true, pending: false }
    viewRef.current = view
    setReorderError(null)
    setIsReordering(false)
    if (playlistId) void fetchPlaylistItems(playlistId)
    return () => {
      view.active = false
      const menu = useContextMenuStore.getState()
      if (
        menu.extraActions?.some((action) =>
          ownedMenuActions.current.includes(action)
        )
      )
        menu.close()
      ownedMenuActions.current = []
    }
  }, [playlistId, pageRefreshKey, provider])

  const pageError = useLibraryStore(
    (s) => s.playlistPageErrors?.[playlistId] ?? null
  )
  // Reorder is only available for non-smart playlists in default sort order with no filter
  const canReorder =
    !isReordering &&
    !!currentPlaylist &&
    !currentPlaylist.smart &&
    sortCol === "default" &&
    !debouncedQuery

  const handleReorder = useCallback(
    (fromIndex: number, toIndex: number) => {
      const view = viewRef.current
      if (!provider || !canReorder || !view?.active || view.pending) return
      const movedTrack =
        windowed.getItem(fromIndex) ?? currentPlaylistItems[fromIndex]
      if (!movedTrack?.playlistItemId) return

      const afterIndex = toIndex > fromIndex ? toIndex : toIndex - 1
      const afterTrack =
        afterIndex >= 0
          ? (windowed.getItem(afterIndex) ?? currentPlaylistItems[afterIndex])
          : null
      const afterItemId = afterTrack?.playlistItemId ?? "0"

      const current = () =>
        view.active &&
        useProviderStore.getState().provider === provider &&
        useLibraryStore.getState().currentPlaylistId === playlistId
      view.pending = true
      setIsReordering(true)
      setReorderError(null)
      if (
        fromIndex < currentPlaylistItems.length &&
        toIndex < currentPlaylistItems.length
      )
        reorderPlaylistItems(playlistId, fromIndex, toIndex)

      void (async () => {
        let after = afterItemId
        if (afterIndex >= 0 && !afterTrack) {
          const page = await provider.getPlaylistItems(
            playlistId,
            afterIndex,
            1
          )
          if (!current()) return
          if (!page.items[0]?.playlistItemId)
            throw Error("Playlist position is unavailable")
          after = page.items[0].playlistItemId
        }
        if (current())
          await provider.movePlaylistItem(
            playlistId,
            movedTrack.playlistItemId!,
            after
          )
      })()
        .then(() => {
          if (current()) windowed.invalidate()
        })
        .catch(() => {
          if (!current()) return
          setReorderError(
            "The playlist order could not be saved. Please try again."
          )
          // Drop the optimistic cache so recovery reads the saved server order.
          invalidatePlaylistItems(playlistId)
        })
        .finally(() => {
          if (!current()) return
          view.pending = false
          setIsReordering(false)
        })
    },
    [
      provider,
      canReorder,
      currentPlaylistItems,
      windowed,
      playlistId,
      reorderPlaylistItems,
      invalidatePlaylistItems,
    ]
  )

  const errorNotice = (loadError || reorderError) && (
    <div
      role="alert"
      className="m-8 rounded-lg border border-red-400/30 p-4 text-sm text-red-400"
    >
      <p>
        {loadError ? "Could not load this playlist's songs." : reorderError}
      </p>
      <button
        disabled={isLoading}
        onClick={() => {
          setReorderError(null)
          invalidatePlaylistItems(playlistId)
        }}
        className="mt-2 rounded-full border border-white/20 px-4 py-2 text-white disabled:opacity-50"
      >
        Reload playlist
      </button>
    </div>
  )

  if (!currentPlaylist && !isLoading) {
    return (
      errorNotice || (
        <div className="p-8 text-gray-400">Playlist not found.</div>
      )
    )
  }

  if (!currentPlaylist) {
    return <PageLoading message="Loading playlist…" variant="playlist" />
  }

  const thumbUrl = currentPlaylist.thumbUrl

  const loadedCount = currentPlaylistItems.length
  const totalCount = windowed.initialized
    ? windowed.total
    : currentPlaylist.trackCount
  const displayCount = totalCount
  const totalMs =
    currentPlaylist.duration ??
    currentPlaylistItems.reduce((sum, t) => sum + t.duration, 0)

  const playbackSource = provider
    ? {
        key: `playlist:${playlistId}`,
        total: totalCount,
        loadPage: (offset: number, limit: number) =>
          provider.getPlaylistItems(playlistId, offset, limit),
      }
    : null

  const querySource = {
    key: `playlist-query:${playlistId}`,
    restoreQuery: { key: `playlist:${playlistId}`, filter: debouncedQuery, sort: sortCol, dir: sortDir },
    total: queried.total,
    loadPage: async (offset: number, limit: number) => {
      const page = await provider!.getCollectionPage!(
        `playlist:${playlistId}`,
        offset,
        limit,
        debouncedQuery,
        sortCol,
        sortDir
      )
      return {
        ...page,
        items: page.items.filter((item) => item.type === "track"),
      }
    },
  }

  return (
    <div className="media-detail-page playlist-detail-page pb-12">
      <AmbientHeroBackdrop heroRef={heroRef} />
      {/* The global artwork layer supplies the sharp hero and aligned blur. */}
      <div
        ref={heroRef}
        className="media-detail-hero hero-overlay relative flex items-end"
      >
        <div className="relative z-10 flex w-full flex-wrap items-end gap-5">
          {/* Cover art */}
          {thumbUrl ? (
            <ArtworkImage
              loading="eager"
              src={thumbUrl}
              alt=""
              className="h-44 w-44 flex-shrink-0 rounded-lg object-cover shadow-xl"
            />
          ) : (
            <div className="h-44 w-44 flex-shrink-0 rounded-lg bg-app-surface shadow-xl" />
          )}

          {/* Info column */}
          <div className="flex min-h-44 min-w-0 flex-[1_1_16rem] flex-col justify-between gap-4">
            <div className="min-w-0">
              <h1 className="media-detail-title break-words">
                {currentPlaylist.title}
              </h1>
              {currentPlaylist.summary && (
                <RichText
                  html={currentPlaylist.summary}
                  className="mt-2 line-clamp-2 max-w-xl text-sm text-gray-300"
                />
              )}
            </div>

            {/* Playlist actions stay beneath the description. */}
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative z-20 flex flex-wrap items-center gap-3">
                {/* Play in order */}
                <button
                  onClick={() =>
                    totalCount > 0 &&
                    void (useQuery && provider?.getCollectionPage
                      ? playPagedTracks(
                          querySource,
                          currentPlaylist.title,
                          `/playlist/${playlistId}`
                        )
                      : playPlaylist(
                          playlistId,
                          totalCount,
                          currentPlaylist.title,
                          `/playlist/${playlistId}`
                        ))
                  }
                  disabled={
                    totalCount === 0 ||
                    (!!provider?.isOffline &&
                      currentPlaylist.offlineAvailable !== true)
                  }
                  title="Play"
                  className="media-primary"
                >
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 16 16"
                    width="22"
                    height="22"
                    fill="currentColor"
                  >
                    <polygon points="3,2 13,8 3,14" />
                  </svg>
                  Play
                </button>

                {/* Shuffle */}
                <button
                  onClick={() =>
                    playbackSource &&
                    void playPagedTracks(
                      useQuery && provider?.getCollectionPage
                        ? querySource
                        : {
                            ...playbackSource,
                            prepare: () =>
                              provider?.getCachedTrackSource?.(
                                `playlist:${playlistId}`,
                                true
                              ) ?? Promise.resolve(null),
                          },
                      currentPlaylist.title,
                      `/playlist/${playlistId}`,
                      true
                    )
                  }
                  disabled={
                    !playbackSource || totalCount === 0 || !!provider?.isOffline
                  }
                  title="Shuffle play"
                  className="media-secondary"
                >
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 16 16"
                    width="16"
                    height="16"
                    fill="currentColor"
                  >
                    <path d="M13.151.922a.75.75 0 1 0-1.06 1.06L13.109 3H11.16a3.75 3.75 0 0 0-2.873 1.34l-6.173 7.356A2.25 2.25 0 0 1 .39 12.5H0V14h.391a3.75 3.75 0 0 0 2.873-1.34l6.173-7.356A2.25 2.25 0 0 1 11.16 4.5h1.949l-1.018 1.018a.75.75 0 0 0 1.06 1.06L15.98 3.75 13.15.922zM.391 3.5H0V2h.391c1.109 0 2.16.49 2.873 1.34L4.89 5.277l-.979 1.167-1.796-2.14A2.25 2.25 0 0 0 .39 3.5zm9.831 8.17l.979 1.167.28.334A3.75 3.75 0 0 0 14.36 14.5h1.64V13h-1.64a2.25 2.25 0 0 1-1.726-.83l-.28-.335-1.733-2.063-.979 1.167 1.18 1.731z" />
                  </svg>
                  Shuffle
                </button>

                {/* Playlist Radio */}
                <button
                  onClick={() =>
                    totalCount > 0 &&
                    void playRadio(
                      playlistId,
                      "playlist",
                      currentPlaylist.title
                    )
                  }
                  disabled={totalCount === 0 || !provider?.capabilities.radio}
                  title="Playlist Radio — continuous sonically-similar music"
                  className="media-secondary"
                >
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 16 16"
                    width="16"
                    height="16"
                    fill="currentColor"
                  >
                    <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM8 5a3 3 0 1 0 0 6A3 3 0 0 0 8 5zm0 1.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z" />
                  </svg>
                  Radio
                </button>

                <button
                  type="button"
                  className="media-secondary"
                  disabled={
                    !syncLink ||
                    !!linkedState.running[syncLink.id] ||
                    (!syncNeedsReview && (!syncAuthenticated || !!provider?.isOffline))
                  }
                  title={
                    syncNeedsReview ? "Review this playlist's sync" : syncLink
                      ? "Run this playlist's configured sync"
                      : "Configure sync from the playlist menu first"
                  }
                  aria-label={syncNeedsReview ? "Sync playlist — review needed" : "Sync playlist"}
                  onClick={() => {
                    if (!syncLink) return
                    if (
                      syncNeedsReview || !syncLink.enabled ||
                      syncLink.paused ||
                      syncLink.state === "conflict" ||
                      !!syncLink.incomplete ||
                      syncLink.job?.step ||
                      syncLink.job?.descriptionStep ||
                      linkedState.holds[syncLink.id] ||
                      linkedState.error
                    ) {
                      setSyncReview(true)
                      setShowLinked(true)
                      return
                    }
                    const pageOwner = viewRef.current,
                      scope = provider?.cacheScope,
                      session = provider?.playbackSession
                    const current = () =>
                      !!pageOwner?.active &&
                      useProviderStore.getState().provider === provider &&
                      provider?.cacheScope === scope &&
                      provider?.playbackSession === session
                    setSyncError(null)
                    void linkedState.syncNow(syncLink.id, current).then(
                      () => {
                        if (current()) {
                          invalidatePlaylistItems(playlistId)
                          void useLibraryStore
                            .getState()
                            .fetchPlaylists({ force: true })
                        }
                      },
                      () => {
                        if (current())
                          setSyncError(
                            "Sync needs review. Open Configure sync to check matching, settings or a retained update."
                          )
                      }
                    )
                  }}
                >
                  {syncLink && linkedState.running[syncLink.id]
                    ? "Syncing…"
                    : "Sync"}
                  {syncNeedsReview && <SyncReviewIndicator />}
                </button>
                {syncError && (
                  <p
                    role="status"
                    className="basis-full text-sm text-[var(--text-secondary)]"
                  >
                    {syncError}
                  </p>
                )}

                {/* More actions */}
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    const rect = e.currentTarget.getBoundingClientRect()
                    const pageOwner = viewRef.current,
                      scope = provider?.cacheScope,
                      session = provider?.playbackSession
                    const current = () =>
                      pageOwner?.active &&
                      useProviderStore.getState().provider === provider &&
                      provider?.cacheScope === scope &&
                      provider?.playbackSession === session
                    const actions: ContextAction[] = [
                      ...(provider?.mutatePlaylistOccurrence &&
                      !provider.isOffline
                        ? [
                            {
                              label: "Configure sync",
                              run: () => {
                                if (current()) {
                                  setSyncReview(false)
                                  setShowLinked(true)
                                }
                              },
                            },
                          ]
                        : []),
                      ...(provider?.capabilities.playlistEdit &&
                      !currentPlaylist.smart
                        ? [
                            {
                              label: "Edit playlist",
                              run: () => {
                                if (current()) setShowEdit(true)
                              },
                            },
                          ]
                        : []),
                    ]
                    ownedMenuActions.current = actions
                    useContextMenuStore
                      .getState()
                      .show(
                        rect.right,
                        rect.bottom + 4,
                        "playlist",
                        currentPlaylist,
                        null,
                        actions
                      )
                  }}
                  title="More actions"
                  className="media-secondary"
                >
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 16 16"
                    width="16"
                    height="16"
                    fill="currentColor"
                  >
                    <circle cx="3" cy="8" r="1.5" />
                    <circle cx="8" cy="8" r="1.5" />
                    <circle cx="13" cy="8" r="1.5" />
                  </svg>
                  More
                </button>
                <button
                  className="media-secondary"
                  aria-haspopup="dialog"
                  aria-label="Playlist information"
                  title="Playlist information and download issues"
                  onClick={(event) => {
                    event.currentTarget.focus({ preventScroll: true })
                    setShowInformation(true)
                  }}
                >
                  <IconInfoCircle size={16} aria-hidden="true" />
                  Info
                  {downloadStatus?.failed ? <SyncReviewIndicator /> : null}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {showEdit && (
        <MetadataEditDialog
          key={`playlist:${playlistId}:${provider?.cacheScope ?? ""}`}
          kind="playlist"
          item={currentPlaylist}
          onClose={() => setShowEdit(false)}
          onSaved={() => {
            invalidatePlaylistItems(playlistId)
            void fetchPlaylistItems(playlistId)
          }}
        />
      )}
      {showInformation && (
        <PlaylistInformationDialog
          key={`information:${playlistId}:${provider?.cacheScope ?? ""}`}
          playlist={{ ...currentPlaylist, trackCount: totalCount }}
          downloads={downloadStatus}
          link={syncLink}
          syncError={syncError || linkedState.checkedErrors?.[syncLink?.id ?? ""]}
          onClose={() => setShowInformation(false)}
          onReviewSync={() => {
            setShowInformation(false)
            setSyncReview(true)
            setShowLinked(true)
          }}
        />
      )}
      {showLinked && (
        <LinkedPlaylistManager
          key={`linked:${playlistId}:${provider?.cacheScope ?? ""}`}
          playlistId={playlistId}
          initialTab={syncReview ? "review" : "setup"}
          onClose={() => setShowLinked(false)}
        />
      )}

      <dl
        className="media-ledger playlist-overview"
        aria-label="Playlist overview"
      >
        <div>
          <dt>Songs</dt>
          <dd>{displayCount.toLocaleString()}</dd>
        </div>
        {totalMs > 0 && (
          <div>
            <dt>
              Runtime{!currentPlaylist.duration && !isFullyLoaded && " so far"}
            </dt>
            <dd>{formatTotalMs(totalMs)}</dd>
          </div>
        )}
      </dl>

      {errorNotice}
      {/* Track list */}
      <TrackTable
        tracks={sortedItems}
        paged={
          !useQuery || provider?.getCollectionPage ? visiblePage : undefined
        }
        visibleCols={visibleCols}
        toggleCol={toggleCol}
        sortCol={sortCol}
        sortDir={sortDir}
        onSort={handleSort}
        onPlay={(track, all, index) => {
          if (playbackSource && (!useQuery || provider?.getCollectionPage))
            void playPagedTracks(
              useQuery ? querySource : playbackSource,
              currentPlaylist.title,
              `/playlist/${playlistId}`,
              false,
              index ?? all.indexOf(track)
            )
          else
            void playTrack(
              track,
              all,
              currentPlaylist.title,
              `/playlist/${playlistId}`
            )
        }}
        onAddToQueue={addToQueue}
        onPlayRadio={playRadio}
        columns={PLAYLIST_COLUMNS}
        searchPlaceholder="Search in playlist…"
        filterQuery={filterQuery}
        onFilterChange={setFilterQuery}
        defaultResetTitle="Restore playlist order"
        isLoading={isLoading}
        loadedCount={loadedCount}
        emptyMessage={
          debouncedQuery
            ? isFullyLoaded
              ? "No songs match this filter."
              : "No matches in loaded songs. Load more songs or clear the filter."
            : "This playlist is empty."
        }
        isFetchingMore={isFetchingMore}
        currentTrackId={currentTrack?.id ?? null}
        playlistId={currentPlaylist.smart ? undefined : playlistId}
        onReorder={canReorder ? handleReorder : undefined}
      />
      {!provider?.getCollectionPage &&
        (!!debouncedQuery || sortCol !== "default") &&
        !isFullyLoaded &&
        loadedCount > 0 && (
          <div className="mx-8 mt-4 flex flex-wrap items-center gap-3">
            {pageError && (
              <p role="alert" className="w-full text-sm text-red-400">
                {pageError}
              </p>
            )}
            <button
              type="button"
              disabled={isFetchingMore || isLoading}
              onClick={() =>
                void fetchMorePlaylistItems(playlistId, { force: true })
              }
              className="rounded-full bg-app-surface px-4 py-2 text-sm text-[var(--text-primary)] hover:bg-app-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
            >
              {isFetchingMore
                ? "Loading more…"
                : pageError
                  ? "Retry loading more"
                  : "Load more songs"}
            </button>
            {pageError && (
              <button
                type="button"
                onClick={() => invalidatePlaylistItems(playlistId)}
                className="rounded-full border border-white/20 px-4 py-2 text-sm text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              >
                Reload playlist
              </button>
            )}
            {filterQuery && (
              <span className="text-xs text-[var(--text-secondary)]">
                Filter applies to loaded songs; loading more is optional.
              </span>
            )}
          </div>
        )}
    </div>
  )
}
