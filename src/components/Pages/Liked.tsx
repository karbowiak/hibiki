import { isCollectionIndexItem } from "../../lib/collectionIndexItem"
import { sortTracks, type TrackSortColumn } from "../../lib/trackOrder"
import { useEffect, useMemo, useState } from "react"
import { useShallow } from "zustand/react/shallow"
import { usePlayerStore } from "../../stores"
import { useProviderStore } from "../../stores/providerStore"
import { useFavoritesStore } from "../../stores/favoritesStore"
import { useTableSort } from "../../hooks/useTableSort"
import { useFavoriteIndex } from "../../hooks/useFavoriteIndex"
import { useRatedIndex } from "../../hooks/useRatedIndex"
import { useWindowedPages } from "../../hooks/useWindowedPages"
import {
  ALL_COLUMNS,
  LIKED_DATE_COLUMN,
  usePlaylistColumns,
} from "../../hooks/useColumnPicker"
import { sortLikedTracks } from "../../favorites/collection"
import { favoritePlaybackSource, favoriteStub } from "../../favorites/playback"
import { favoriteLikedAt } from "../../favorites/model"
import { effectiveTrackRating } from "../../favorites/ratings"
import type { FavoriteEntry } from "../../favorites/types"
import { type PagedTrackSource } from "../../lib/pagedPlayback"
import { IconPlayerPlay, IconArrowsShuffle } from "@tabler/icons-react"
import { TrackTable } from "../shared/TrackTable"
import { FavoritesSyncDialog } from "../FavoritesSyncDialog"
import { favoritesNeedReview } from "../../lib/syncAttention"
import { SyncReviewIndicator } from "../shared/SyncReviewIndicator"
import { loadAllYoutubeMusicLibrary, useYoutubeMusicLibrary, youtubeMusicVideo } from "../../backends/ytmusic/library"
import { useYoutubeMusicDiscoveryStore, youtubeMusicItemTrack } from "../../backends/ytmusic/discovery"
import { mergeLikedTrackSources } from "../../favorites/sourceRows"
import { useUIStore } from "../../stores/uiStore"
import type { MusicTrack } from "../../types/music"
import { PlexLogo, YoutubeMusicLogo } from "../shared/MusicSource"
import { useYoutubeMusicRatingsStore, youtubeRatingLiked } from "../../backends/ytmusic/ratings"
import { isYoutubeMusicId } from "../../backends/ytmusic/tracks"

const LIKED_COLUMNS = [...ALL_COLUMNS, LIKED_DATE_COLUMN]
const LIKED_DEFAULT_COLS = ["album", "rating", "rated_at", "liked_at"] as const
const EMPTY_YOUTUBE_RATINGS: ReturnType<typeof useYoutubeMusicRatingsStore.getState>["entries"] = {}

export function Liked() {
  const provider = useProviderStore((state) => state.provider)
  const favorites = useFavoritesStore(
    useShallow((state) => ({
      collection: state.collection,
      loaded: state.loaded,
      loading: state.loading,
      error: state.error,
      issues: state.issues,
      ratingsByTrackId: state.ratingsByTrackId,
    }))
  )
  const { collection } = favorites
  const syncNeedsReview = favoritesNeedReview(collection, favorites.issues)
  const [kind, setKind] = useState<"loved" | "rated" | "all">("loved")
  const [service, setService] = useState<"all" | "plex" | "ytmusic">("all")
  const includeVideos = useUIStore(state => state.likedMusicVideos)
  const setIncludeVideos = useUIStore(state => state.setLikedMusicVideos)
  const youtubeKind = includeVideos ? "videos" : "songs"
  const youtube = useYoutubeMusicLibrary(youtubeKind)
  const activeService = youtube.connected ? service : "all"
  const includesPlex = activeService !== "ytmusic"
  const includesYoutube = activeService !== "plex" && youtube.connected
  const youtubeAccount = useYoutubeMusicDiscoveryStore(state => state.accountId)
  const youtubeRatings = useYoutubeMusicRatingsStore(state => state.owner === youtubeAccount ? state.entries : EMPTY_YOUTUBE_RATINGS)
  const youtubeRevision = useYoutubeMusicDiscoveryStore(state => state.revision)
  const refresh = useUIStore(state => state.pageRefreshKey)
  useEffect(() => {
    if (!includesYoutube || youtube.error) return
    let active = true
    void loadAllYoutubeMusicLibrary(youtubeKind, () => active)
    return () => { active = false }
  }, [includesYoutube, youtubeKind, youtube.error, youtubeRevision, refresh, youtube.version])
  const [syncOpen, setSyncOpen] = useState(false)
  const [filterQuery, setFilterQuery] = useState("")
  const [query, setQuery] = useState("")
  const { sortCol, sortDir, handleSort } = useTableSort<TrackSortColumn>({
    descByDefault: ["rating", "liked_at", "rated_at"],
    resetKey: provider,
  })
  const ratedIndex = useRatedIndex(
    includesPlex && (kind !== "loved" || !collection.ratingsImported)
  )
  const { visible: visibleCols, toggle: toggleCol } = usePlaylistColumns(
    "plex-liked-columns",
    [...LIKED_DEFAULT_COLS]
  )
  const { playPagedTracks, playRadio, addToQueue, currentTrack } =
    usePlayerStore(
      useShallow((state) => ({
        playPagedTracks: state.playPagedTracks,
        playRadio: state.playRadio,
        addToQueue: state.addToQueue,
        currentTrack: state.currentTrack,
      }))
    )
  useEffect(() => {
    const timer = setTimeout(
      () => setQuery(filterQuery.trim().toLowerCase()),
      150
    )
    return () => clearTimeout(timer)
  }, [filterQuery])
  useEffect(() => {
    if (includesPlex && ratedIndex.ready && favorites.loaded && !collection.ratingsImported)
      void useFavoritesStore
        .getState()
        .seedRatings(ratedIndex.tracks)
        .catch(() => {})
  }, [
    ratedIndex.ready,
    ratedIndex.tracks,
    favorites.loaded,
    collection.ratingsImported,
    includesPlex,
  ])

  const entries = useMemo(() => {
    const seen = new Set<string>()
    return Object.values(collection.entries)
      .filter((item) => item.liked && item.localTrackIds.length)
      .sort(
        (a, b) =>
          (favoriteLikedAt(b) ?? 0) - (favoriteLikedAt(a) ?? 0) ||
          a.id.localeCompare(b.id)
      )
      .filter((item) => {
        if (item.localTrackIds.some((id) => seen.has(id))) return false
        item.localTrackIds.forEach((id) => seen.add(id))
        return true
      })
  }, [collection.entries])
  const unavailable = useMemo(
    () =>
      Object.values(collection.entries).filter(
        (item) => item.liked && !item.localTrackIds.length
      ).length,
    [collection.entries]
  )
  const needsFavoriteMetadata =
    includesPlex &&
    kind !== "rated" &&
    !["default", "title", "artist", "album", "liked_at"].includes(sortCol)
  const favoriteIndex = useFavoriteIndex(needsFavoriteMetadata)
  const seeds = useMemo(
    () => [
      ...(ratedIndex.ready ? ratedIndex.tracks : []),
      ...favoriteIndex.tracks,
    ],
    [ratedIndex.ready, ratedIndex.tracks, favoriteIndex.tracks]
  )
  const indexed = useMemo(() => {
    const entryById = new Map<string, FavoriteEntry>()
    const available = new Map(seeds.map((track) => [track.id, track]))
    const loved = entries.map((entry) => {
      const stub = favoriteStub(entry)
      const detail = entry.localTrackIds
        .map((id) => available.get(id))
        .find(Boolean)
      const track = detail ? { ...detail, likedAt: stub.likedAt } : stub
      entryById.set(track.id, entry)
      return track
    })
    const manual = Object.values(collection.entries)
      .filter(
        (entry) => entry.rating?.value != null && entry.localTrackIds.length
      )
      .map((entry) => {
        const detail =
          entry.localTrackIds.map((id) => available.get(id)).find(Boolean) ??
          favoriteStub(entry)
        entryById.set(detail.id, entry)
        return detail
      })
    const explicitRated = [
      ...new Map(
        [
          ...seeds.filter((track) => (track.userRating ?? 0) > 0),
          ...manual,
        ].map((track) => [track.id, track])
      ).values(),
    ].filter(
      (track) =>
        (effectiveTrackRating(
          track.userRating,
          favorites.ratingsByTrackId.get(track.id)
        ) ?? 0) > 0
    )
    const used = new Set(entries.flatMap((entry) => entry.localTrackIds))
    let items =
      kind === "loved"
        ? loved
        : kind === "rated"
          ? explicitRated
          : sortLikedTracks([
              ...loved,
              ...explicitRated.filter((track) => !used.has(track.id)),
            ])
    if (!includesPlex) items = []
    if (includesYoutube) {
      const remote = new Map((kind === "rated" ? [] : youtube.items).map(item => [item.id, item]))
      const local: MusicTrack[] = []
      for (const rating of Object.values(youtubeRatings)) {
        const original = (rating.track._providerData as { youtubeMusic?: { videoType?: string | null } } | null)?.youtubeMusic
        if (!includeVideos && original && youtubeMusicVideo(original)) continue
        remote.delete(rating.track.id.slice(8))
        if (kind === "loved" ? youtubeRatingLiked(rating.value) : (rating.value ?? 0) > 0)
          local.push({ ...rating.track, userRating: rating.value, lastRatedAt: new Date(rating.changedAt).toISOString() })
      }
      items = mergeLikedTrackSources(items, [...[...remote.values()].map(youtubeMusicItemTrack), ...local])
    }
    if (query)
      items = items.filter((track) =>
        `${track.title}\n${track.artistName}\n${track.albumName}`
          .toLowerCase()
          .includes(query)
      )
    return {
      items: sortTracks(items, sortCol, sortDir, track => isYoutubeMusicId(track.id) ? track.userRating : effectiveTrackRating(track.userRating, favorites.ratingsByTrackId.get(track.id))),
      entryById,
    }
  }, [
    entries,
    seeds,
    kind,
    query,
    sortCol,
    sortDir,
    collection.entries,
    favorites.ratingsByTrackId,
    youtube.connected,
    youtube.items,
    includesPlex,
    includesYoutube,
    youtubeRatings,
    includeVideos,
  ])
  const source = useMemo<PagedTrackSource>(() => {
    const loadItems = async (positions: number[]) => {
      const selected = positions.map((position) => indexed.items[position])
      const selectedEntries = selected.flatMap((track) =>
        indexed.entryById.has(track.id)
          ? [indexed.entryById.get(track.id)!]
          : []
      )
      const details =
        provider && selectedEntries.length
          ? await favoritePlaybackSource(
              collection,
              seeds,
              provider,
              selectedEntries
            ).loadPage(0, selectedEntries.length)
          : { items: [] }
      const byEntry = new Map(
        selectedEntries.map((entry, i) => [entry.id, details.items[i]])
      )
      const indexIds = selected.filter(track => isCollectionIndexItem(track) && !indexed.entryById.has(track.id)).map(track => track.id)
      const hydrated = indexIds.length && provider
        ? provider.getCollectionItems
          ? await provider.getCollectionItems("rated:track", indexIds)
          : await Promise.all(indexIds.map(id => provider.getTrack(id)))
        : []
      const byId = new Map<string, MusicTrack>(hydrated.map(item => [item.id, item as MusicTrack] as const))
      return selected.map(
        (track) =>
          byEntry.get(indexed.entryById.get(track.id)?.id ?? "") ?? byId.get(track.id) ?? track
      )
    }
    return {
      key: `liked:${kind}:${activeService}:${youtubeKind}`,
      total: indexed.items.length,
      entries: indexed.items,
      loadItems,
      loadPage: async (offset, limit) => {
        const positions = Array.from(
          {
            length: Math.max(0, Math.min(limit, indexed.items.length - offset)),
          },
          (_, i) => offset + i
        )
        return {
          items: await loadItems(positions),
          total: indexed.items.length,
          offset,
        }
      },
    }
  }, [provider, kind, activeService, youtubeKind, indexed, collection, seeds])
  const queryKey = JSON.stringify(["liked", kind, activeService, youtubeKind, sortCol, sortDir, query])
  const preparing =
    (includesPlex && kind !== "loved" && !ratedIndex.ready) ||
    (needsFavoriteMetadata && !favoriteIndex.ready) ||
    (includesYoutube && !youtube.error &&
      (!youtube.initialized || youtube.loading || youtube.more))
  const selectedPages = useWindowedPages(
    preparing ? null : queryKey,
    source.loadPage,
    source.total,
    source
  )
  const pages = selectedPages
  const count =
    preparing || (includesPlex && favorites.loading && kind !== "rated") ? null : pages.total
  const play = async (shuffle = false, index = 0) => {
    if (preparing || !provider) return
    await playPagedTracks(
      source,
      "Liked Songs",
      "/collection/tracks",
      shuffle,
      index
    )
  }

  return (
    <div className="pb-12">
      <div className="collection-header">
        <div className="flex min-w-0 flex-[1_1_14rem] flex-col gap-3">
          <h1 className="discovery-title">Liked Songs</h1>
          <p className="max-w-xl text-sm text-(--text-secondary)">
            Your saved favorites and songs you've rated.
          </p>
          <p className="text-sm text-(--text-secondary)">
            {count === null
              ? "Preparing all saved songs…"
              : `${count.toLocaleString()}${includesYoutube && youtube.more ? "+" : ""} ${includesPlex && includesYoutube ? "source entries" : count === 1 ? "song" : "songs"}${includesYoutube && youtube.error ? " · YouTube Music incomplete" : ""}`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            className="media-secondary"
            title={
              syncNeedsReview
                ? "Some likes or sync changes need review"
                : "Manage liked songs sync"
            }
            aria-label={
              syncNeedsReview
                ? "Sync liked songs — review needed"
                : "Sync liked songs"
            }
            disabled={!favorites.loaded || !provider?.favorites}
            onClick={() => setSyncOpen(true)}
          >
            Sync
            {syncNeedsReview && <SyncReviewIndicator />}
          </button>
          <button
            className="media-primary"
            aria-label="Play liked songs"
            disabled={!count}
            onClick={() => void play()}
          >
            <IconPlayerPlay size={16} aria-hidden="true" />
            Play
          </button>
          <button
            className="media-secondary"
            aria-label="Shuffle liked songs"
            disabled={!count}
            onClick={() => void play(true)}
          >
            <IconArrowsShuffle size={16} aria-hidden="true" />
            Shuffle
          </button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-4 px-8 pb-4">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Liked Songs filter">
        {(["loved", "rated", "all"] as const).map((value) => (
          <button
            type="button"
            key={value}
            aria-pressed={kind === value}
            title={
              value === "rated"
                ? "Ratings you set yourself or saved in Plex"
                : value === "loved"
                  ? "Songs liked in Hibiki, including connected services"
                  : "All likes and explicit ratings"
            }
            className={kind === value ? "media-primary" : "media-secondary"}
            onClick={() => setKind(value)}
          >
            {value === "loved" ? "Loved" : value === "rated" ? "Rated" : "All"}
          </button>
        ))}
        </div>
        {youtube.connected && (
          <div className="flex flex-wrap gap-2" role="group" aria-label="Music source">
            {(["all", "plex", "ytmusic"] as const).map(value => (
              <button
                key={value}
                type="button"
                aria-pressed={activeService === value}
                title={value === "all" ? "Show songs from both services" : value === "plex" ? "Show only Plex songs" : "Show only YouTube Music songs"}
                className={activeService === value ? "media-primary" : "media-secondary"}
                onClick={() => setService(value)}
              >
                {value === "plex" && <PlexLogo size={14} />}
                {value === "ytmusic" && <YoutubeMusicLogo size={14} />}
                {value === "all" ? "Both" : value === "plex" ? "Plex" : "YTM"}
              </button>
            ))}
          </div>
        )}
        {includesYoutube && (
          <label className="flex items-center gap-2 text-sm text-(--text-secondary)" title="Include music videos and uploaded music returned in your YouTube Music likes. This does not load all YouTube video likes.">
            <input type="checkbox" checked={includeVideos} onChange={event => setIncludeVideos(event.target.checked)} className="accent-(--accent)" />
            Include music videos
          </label>
        )}
      </div>
      {includesPlex && unavailable > 0 && kind !== "rated" && (
        <p className="mx-8 mb-4 text-sm text-(--text-secondary)">
          {unavailable.toLocaleString()} saved favorites still need a library
          match. Review them in Sync.
        </p>
      )}
      {includesPlex && favorites.error && (
        <p role="alert" className="mx-8 mb-4 text-sm text-red-400">
          {favorites.error}{" "}
          <button
            className="underline"
            onClick={() =>
              void useFavoritesStore
                .getState()
                .load(provider)
                .catch(() => {})
            }
          >
            Retry local favorites
          </button>
        </p>
      )}
      {includesYoutube && youtube.error && (
        <p role="alert" className="mx-8 mb-4 text-sm text-(--text-secondary)">
          Could not load all YouTube Music likes. Loaded songs are still available.{" "}
          <button className="underline" onClick={() => void youtube.retry()}>Try again</button>
        </p>
      )}
      {includesPlex && !preparing && (ratedIndex.error || favoriteIndex.error) && (
        <p role="alert" className="mx-8 mb-4 text-sm text-(--text-secondary)">
          {favoriteIndex.error || ratedIndex.error}{" "}
          <button type="button" className="underline" onClick={() => { if (favoriteIndex.error) favoriteIndex.retry(); if (ratedIndex.error) ratedIndex.retry() }}>Try again</button>
        </p>
      )}
      {preparing ? (
        <p
          role={ratedIndex.error || favoriteIndex.error ? "alert" : "status"}
          className="px-8 py-12 text-sm text-(--text-secondary)"
        >
          {favoriteIndex.error || ratedIndex.error || "Preparing your complete collection…"}
          {(ratedIndex.error || favoriteIndex.error) && <button type="button" className="ml-2 underline" onClick={() => { if (favoriteIndex.error) favoriteIndex.retry(); if (ratedIndex.error) ratedIndex.retry() }}>Try again</button>}
        </p>
      ) : (
        <TrackTable
          tracks={[]}
          paged={pages}
          visibleCols={visibleCols}
          toggleCol={toggleCol}
          sortCol={sortCol}
          sortDir={sortDir}
          onSort={handleSort}
          onPlay={(_track, _all, index) => play(false, index ?? 0)}
          onAddToQueue={addToQueue}
          onPlayRadio={playRadio}
          columns={LIKED_COLUMNS}
          searchPlaceholder="Search in liked songs…"
          filterQuery={filterQuery}
          onFilterChange={setFilterQuery}
          isLoading={(includesPlex && favorites.loading) || (pages.loading && !pages.total)}
          currentTrackId={currentTrack?.id ?? null}
          emptyMessage={
            query
              ? "No songs match this filter."
              : activeService === "ytmusic"
                ? kind === "rated"
                  ? "No rated YTM songs. Choose Loved or All to see your YouTube Music likes."
                  : "No liked songs in YouTube Music yet."
              : kind === "rated"
                ? "No rated songs yet. Set a song’s stars to see it here."
                : "Give a song three stars or more, or connect your favorites in Sync."
          }
        />
      )}
      {syncOpen && <FavoritesSyncDialog onClose={() => setSyncOpen(false)} />}
    </div>
  )
}
