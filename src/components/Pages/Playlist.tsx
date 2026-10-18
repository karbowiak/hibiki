import { PlaylistPage } from "../shared/PlaylistPage"
import { createEntityDownloads } from "../../offline/downloadEntities"
import {
  captureDownloadOwner,
  ownsDownloads,
  refreshDownloadStatuses,
} from "../../offline/downloadStatusStore"
import { playlistDownloadTracks } from "../../offline/playlistDownloads"
import { useMixedPlaylistStore } from "../../stores/mixedPlaylistStore"
import { useLocation } from "wouter"
import { Button } from "../shared/Button"
import {
  collectionPlaybackSource,
  selectCollectionTrack,
} from "../../lib/collectionPlayback"
import {
  filterTracks,
  sortTracks,
  type TrackSortColumn,
} from "../../lib/trackOrder"
import { useEntityDownloadStatus } from "../shared/DownloadBadge"
import { PlaylistInformationDialog } from "../PlaylistInformationDialog"
import { useMixedPlaylistLink } from "../MixedPlaylistControl"
import { MetadataEditDialog } from "../shared/MetadataEditDialog"
import { LinkedPlaylistManager } from "../PlaylistSync/LinkedPlaylistManager"
import {
  useLinkedPlaylistStore,
  linksForPlaylist,
} from "../../stores/linkedPlaylistStore"
import { useListenBrainzStore } from "../../metadata/listenbrainz/authStore"
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
import {
  useContextMenuStore,
  type ContextAction,
} from "../../stores/contextMenuStore"
import { useTableSort } from "../../hooks/useTableSort"
import "../../styles/media-detail-controls.css"
import { ALL_COLUMNS, usePlaylistColumns } from "../../hooks/useColumnPicker"
import { PageLoading } from "../shared/PageLoading"
import { useWindowedPages } from "../../hooks/useWindowedPages"
import { playlistNeedsReview } from "../../lib/syncAttention"
import { SyncReviewIndicator } from "../shared/SyncReviewIndicator"

const PLAYLIST_COLUMNS = ALL_COLUMNS

export function Playlist({ playlistId }: { playlistId: string }) {
  const [, navigate] = useLocation()
  const [preparingDownload, setPreparingDownload] = useState(false)
  const mixedLink = useMixedPlaylistLink(playlistId)
  const [showLinked, setShowLinked] = useState(false)
  const [syncReview, setSyncReview] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [showInformation, setShowInformation] = useState(false)
  const downloadStatus = useEntityDownloadStatus("playlist", playlistId)
  const linkedState = useLinkedPlaylistStore()
  const syncAuthenticated = useListenBrainzStore((s) => s.isAuthenticated)
  const [showEdit, setShowEdit] = useState(false)
  const ownedMenuActions = useRef<ContextAction[]>([])
  const invalidatePlaylistItems = useLibraryStore(
    (s) => s.invalidatePlaylistItems
  )
  const currentPlaylist = useLibraryStore(
    (s) =>
      s.playlists.find((playlist) => playlist.id === playlistId) ??
      (s.currentPlaylist?.id === playlistId ? s.currentPlaylist : null)
  )
  const [reorderError, setReorderError] = useState<string | null>(null)
  const [isReordering, setIsReordering] = useState(false)
  const viewRef = useRef<{ active: boolean; pending: boolean } | null>(null)

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
  const syncNeedsReview =
    !!syncError ||
    playlistNeedsReview(
      syncLink,
      !!linkedState.error || !!linkedState.checkedErrors?.[syncLink?.id ?? ""],
      !!linkedState.holds[syncLink?.id ?? ""]
    )
  const windowed = useWindowedPages(
    `playlist:${playlistId}`,
    async (offset, limit) =>
      provider
        ? provider.getPlaylistItems(playlistId, offset, limit)
        : { items: [], total: 0 },
    currentPlaylist?.trackCount ?? 0
  )
  const currentPlaylistItems = windowed.loadedItems
  const isLoading = windowed.loading && !windowed.initialized
  const isFetchingMore = windowed.loading && windowed.initialized
  const isFullyLoaded =
    windowed.initialized && windowed.residentCount >= windowed.total
  const loadError = windowed.error
  const [fallbackEnd, setFallbackEnd] = useState(200)
  const pageRefreshKey = useUIStore((s) => s.pageRefreshKey)

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

  const filteredItems = useMemo(
    () => filterTracks(currentPlaylistItems, debouncedQuery),
    [windowed, windowed.snapshot(), debouncedQuery]
  )

  const { sortCol, sortDir, handleSort } = useTableSort<TrackSortColumn>({
    resetKey: playlistId,
  })

  const sortedItems = useMemo(
    () => sortTracks(filteredItems, sortCol, sortDir),
    [filteredItems, sortCol, sortDir]
  )

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
    setFallbackEnd(200)
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
      const movedTrack = windowed.getItem(fromIndex)
      if (!movedTrack?.playlistItemId) return

      const afterIndex = toIndex > fromIndex ? toIndex : toIndex - 1
      const afterTrack = afterIndex >= 0 ? windowed.getItem(afterIndex) : null
      const afterItemId = afterTrack?.playlistItemId ?? "0"

      const current = () =>
        view.active &&
        useProviderStore.getState().provider === provider &&
        viewRef.current === view
      view.pending = true
      setIsReordering(true)
      setReorderError(null)

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
          if (current()) {
            invalidatePlaylistItems(playlistId)
            windowed.invalidate()
          }
        })
        .catch(() => {
          if (!current()) return
          setReorderError(
            "The playlist order could not be saved. Please try again."
          )
          windowed.invalidate()
        })
        .finally(() => {
          if (!current()) return
          view.pending = false
          setIsReordering(false)
        })
    },
    [provider, canReorder, windowed, playlistId, invalidatePlaylistItems]
  )

  const errorNotice = (loadError || reorderError) && (
    <div
      role="alert"
      className="m-8 rounded-lg border border-red-400/30 p-4 text-sm text-red-400"
    >
      <p>
        {loadError ? "Could not load this playlist's songs." : reorderError}
      </p>
      <Button
        variant="bare"
        disabled={isLoading}
        onClick={() => {
          setReorderError(null)
          windowed.invalidate()
        }}
        className="mt-2 rounded-full border border-white/20 px-4 py-2 text-white disabled:opacity-50"
      >
        Reload playlist
      </Button>
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

  const loadedCount = currentPlaylistItems.length
  const totalCount = windowed.initialized
    ? windowed.total
    : currentPlaylist.trackCount
  const displayCount = totalCount
  const totalMs =
    currentPlaylist.duration ??
    currentPlaylistItems.reduce((sum, t) => sum + t.duration, 0)
  const download = async () => {
    const owner = captureDownloadOwner()
    if (!owner || preparingDownload) return
    setPreparingDownload(true)
    try {
      await createEntityDownloads(owner, () => ownsDownloads(owner)).download(
        "playlist",
        playlistId,
        currentPlaylist.title
      )
      refreshDownloadStatuses()
    } catch (failure) {
      if (ownsDownloads(owner)) setSyncError(String(failure))
    } finally {
      if (ownsDownloads(owner)) setPreparingDownload(false)
    }
  }
  const copy = async () => {
    const owner = captureDownloadOwner()
    if (!owner) return
    try {
      const tracks = await playlistDownloadTracks(
        {
          key: playlistId,
          loadPage: (offset, limit) =>
            owner.provider.getPlaylistItems(playlistId, offset, limit),
        },
        () => ownsDownloads(owner)
      )
      const draft = await useMixedPlaylistStore
        .getState()
        .copy(
          currentPlaylist.title,
          currentPlaylist.summary ?? "",
          tracks,
          `mixed:copy:${owner.context.cacheScope}:${playlistId}`
        )
      if (ownsDownloads(owner))
        navigate(`/mixed-playlist/${encodeURIComponent(draft.id)}`)
    } catch (failure) {
      if (ownsDownloads(owner)) setSyncError(String(failure))
    }
  }

  const playbackSource = provider
    ? {
        key: `playlist:${playlistId}`,
        total: totalCount,
        loadPage: (offset: number, limit: number) =>
          provider.getPlaylistItems(playlistId, offset, limit),
      }
    : null

  const querySource = provider
    ? collectionPlaybackSource(
        provider,
        {
          key: `playlist:${playlistId}`,
          filter: debouncedQuery,
          sort: sortCol,
          dir: sortDir,
        },
        queried.total
      )
    : null

  return (
    <PlaylistPage
      model={{
        playlist: {
          ...currentPlaylist,
          trackCount: displayCount,
          duration: totalMs,
        },
        source: "Plex",
        countPartial: false,
        runtimePartial: !currentPlaylist.duration && !isFullyLoaded,
        actions: {
          play: {
            onClick: () =>
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
                  )),
            disabled:
              totalCount === 0 ||
              (!!provider?.isOffline &&
                currentPlaylist.offlineAvailable !== true),
            title: "Play",
            className: "media-primary",
          },
          shuffle: {
            onClick: () =>
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
              ),
            disabled:
              !playbackSource || totalCount === 0 || !!provider?.isOffline,
            title: "Shuffle play",
            className: "media-secondary",
          },
          radio: {
            onClick: () =>
              totalCount > 0 &&
              void playRadio(playlistId, "playlist", currentPlaylist.title),
            disabled: totalCount === 0 || !provider?.capabilities.radio,
            title: "Playlist Radio — continuous sonically-similar music",
            className: "media-secondary",
          },
          sync: {
            type: "button",
            className: "media-secondary",
            disabled:
              !syncLink ||
              !!linkedState.running[syncLink.id] ||
              (!syncNeedsReview &&
                (!syncAuthenticated || !!provider?.isOffline)),
            title: syncNeedsReview
              ? "Review this playlist's sync"
              : syncLink
                ? "Run this playlist's configured sync"
                : "Configure sync from the playlist menu first",
            "aria-label": syncNeedsReview
              ? "Sync playlist — review needed"
              : "Sync playlist",
            onClick: () => {
              if (!syncLink) return
              if (
                syncNeedsReview ||
                !syncLink.enabled ||
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
                    windowed.invalidate()
                    queried.invalidate()
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
            },
            children: (
              <>
                {syncLink && linkedState.running[syncLink.id]
                  ? "Syncing…"
                  : "Sync"}
                {syncNeedsReview && <SyncReviewIndicator />}
              </>
            ),
          },
          link: {
            onClick: () => void mixedLink.link(),
            disabled:
              currentPlaylist.smart ||
              !mixedLink.connected ||
              mixedLink.pending,
            title: currentPlaylist.smart
              ? "Smart playlists cannot be linked. Use Copy to Hibiki in More."
              : mixedLink.requirement,
          },
          download: {
            onClick: () => void download(),
            disabled: !!provider?.isOffline || preparingDownload || !totalCount,
            children: preparingDownload
              ? "Preparing…"
              : downloadStatus?.downloaded === totalCount && totalCount > 0
                ? "Downloaded"
                : "Download",
          },
          more: {
            onClick: (e) => {
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
                {
                  label: "Copy to Hibiki",
                  disabled: !!provider?.isOffline,
                  run: () => void copy(),
                },
                ...(!currentPlaylist.smart
                  ? [
                      {
                        label: "Link Plex + YTM",
                        disabled: mixedLink.pending || !mixedLink.connected,
                        run: () => {
                          if (current()) void mixedLink.link()
                        },
                      },
                    ]
                  : []),
                ...(provider?.mutatePlaylistOccurrence && !provider.isOffline
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
            },
            title: "More actions",
            className: "media-secondary",
          },
          info: {
            className: "media-secondary",
            "aria-haspopup": "dialog",
            "aria-label": "Playlist information",
            title: "Playlist information and download issues",
            onClick: (event) => {
              event.currentTarget.focus({ preventScroll: true })
              setShowInformation(true)
            },
            children: (
              <>
                Info
                {downloadStatus?.failed ? <SyncReviewIndicator /> : null}
              </>
            ),
          },
        },
        table: {
          tracks: sortedItems,
          paged:
            !useQuery || provider?.getCollectionPage ? visiblePage : undefined,
          visibleCols: visibleCols,
          toggleCol: toggleCol,
          sortCol: sortCol,
          sortDir: sortDir,
          onSort: handleSort,
          onPlay: (track, all, index) => {
            if (playbackSource && (!useQuery || provider?.getCollectionPage))
              void playPagedTracks(
                useQuery
                  ? selectCollectionTrack(
                      querySource,
                      track,
                      index ?? all.indexOf(track)
                    )
                  : playbackSource,
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
          },
          onAddToQueue: addToQueue,
          onPlayRadio: playRadio,
          columns: PLAYLIST_COLUMNS,
          searchPlaceholder: "Search in playlist…",
          filterQuery: filterQuery,
          onFilterChange: setFilterQuery,
          defaultResetTitle: "Restore playlist order",
          isLoading: isLoading,
          loadedCount: loadedCount,
          emptyMessage: debouncedQuery
            ? isFullyLoaded
              ? "No songs match this filter."
              : "No matches in loaded songs. Load more songs or clear the filter."
            : "This playlist is empty.",
          isFetchingMore: isFetchingMore,
          currentTrackId: currentTrack?.id ?? null,
          playlistId: currentPlaylist.smart ? undefined : playlistId,
          onReorder: canReorder ? handleReorder : undefined,
        },
      }}
      dialogs={
        <>
          {showEdit && (
            <MetadataEditDialog
              key={`playlist:${playlistId}:${provider?.cacheScope ?? ""}`}
              kind="playlist"
              item={currentPlaylist}
              onClose={() => setShowEdit(false)}
              onSaved={() => {
                invalidatePlaylistItems(playlistId)
                windowed.invalidate()
              }}
            />
          )}
          {showInformation && (
            <PlaylistInformationDialog
              key={`information:${playlistId}:${provider?.cacheScope ?? ""}`}
              playlist={{ ...currentPlaylist, trackCount: totalCount }}
              downloads={downloadStatus}
              link={syncLink}
              syncError={
                syncError || linkedState.checkedErrors?.[syncLink?.id ?? ""]
              }
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
        </>
      }
      notice={
        <>
          {(syncError || mixedLink.error) && (
            <p
              role="status"
              className="basis-full text-sm text-(--text-secondary)"
            >
              {syncError || mixedLink.error}
            </p>
          )}
          {errorNotice}
        </>
      }
      overview={<></>}
      after={
        <>
          {!provider?.getCollectionPage &&
            (!!debouncedQuery || sortCol !== "default") &&
            !isFullyLoaded &&
            loadedCount > 0 && (
              <div className="mx-8 mt-4 flex flex-wrap items-center gap-3">
                {loadError && (
                  <p role="alert" className="w-full text-sm text-red-400">
                    {loadError}
                  </p>
                )}
                <Button
                  variant="bare"
                  type="button"
                  disabled={isFetchingMore || isLoading}
                  onClick={() => {
                    if (loadError) windowed.retry()
                    else {
                      windowed.ensureRange(fallbackEnd, fallbackEnd + 200)
                      setFallbackEnd(fallbackEnd + 200)
                    }
                  }}
                  className="bg-app-surface hover:bg-app-surface-hover focus-visible:outline-accent rounded-full px-4 py-2 text-sm text-(--text-primary) focus-visible:outline focus-visible:outline-2 disabled:opacity-50"
                >
                  {isFetchingMore
                    ? "Loading more…"
                    : loadError
                      ? "Retry loading more"
                      : "Load more songs"}
                </Button>
                {loadError && (
                  <Button
                    variant="bare"
                    type="button"
                    onClick={() => windowed.invalidate()}
                    className="focus-visible:outline-accent rounded-full border border-white/20 px-4 py-2 text-sm text-(--text-primary) focus-visible:outline focus-visible:outline-2"
                  >
                    Reload playlist
                  </Button>
                )}
                {filterQuery && (
                  <span className="text-xs text-(--text-secondary)">
                    Filter applies to loaded songs; up to 1,600 songs are kept
                    in this view.
                  </span>
                )}
              </div>
            )}
        </>
      }
    />
  )
}
