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
import type { MusicTrack } from "../../types/music"
import { type PagedTrackSource } from "../../lib/pagedPlayback"
import { IconPlayerPlay, IconArrowsShuffle } from "@tabler/icons-react"
import { TrackTable } from "../shared/TrackTable"
import { FavoritesSyncDialog } from "../FavoritesSyncDialog"
import { favoritesNeedReview } from "../../lib/syncAttention"
import { SyncReviewIndicator } from "../shared/SyncReviewIndicator"

const LIKED_COLUMNS = [...ALL_COLUMNS, LIKED_DATE_COLUMN]
const LIKED_DEFAULT_COLS = ["album", "rating", "rated_at", "liked_at"] as const

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
  const [syncOpen, setSyncOpen] = useState(false)
  const [filterQuery, setFilterQuery] = useState("")
  const [query, setQuery] = useState("")
  const { sortCol, sortDir, handleSort } = useTableSort<string>({
    descByDefault: ["rating", "liked_at", "rated_at"],
    resetKey: provider,
  })
  const ratedIndex = useRatedIndex(
    kind !== "loved" || !collection.ratingsImported
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
    if (ratedIndex.ready && favorites.loaded && !collection.ratingsImported)
      void useFavoritesStore
        .getState()
        .seedRatings(ratedIndex.tracks)
        .catch(() => {})
  }, [
    ratedIndex.ready,
    ratedIndex.tracks,
    favorites.loaded,
    collection.ratingsImported,
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
    if (query)
      items = items.filter((track) =>
        `${track.title}\n${track.artistName}\n${track.albumName}`
          .toLowerCase()
          .includes(query)
      )
    return {
      items: orderedTracks(items, sortCol, sortDir, favorites.ratingsByTrackId),
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
      return selected.map(
        (track) =>
          byEntry.get(indexed.entryById.get(track.id)?.id ?? "") ?? track
      )
    }
    return {
      key: `liked:${kind}`,
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
  }, [provider, kind, indexed, collection, seeds])
  const queryKey = JSON.stringify(["liked", kind, sortCol, sortDir, query])
  const preparing =
    (kind !== "loved" && !ratedIndex.ready) ||
    (needsFavoriteMetadata && !favoriteIndex.ready)
  const selectedPages = useWindowedPages(
    preparing ? null : queryKey,
    source.loadPage,
    source.total,
    source
  )
  const pages = selectedPages
  const count =
    preparing || (favorites.loading && kind !== "rated") ? null : pages.total
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
          <p className="max-w-xl text-sm text-[var(--text-secondary)]">
            Your saved favorites and songs you've rated.
          </p>
          <p className="text-sm text-[var(--text-secondary)]">
            {count === null
              ? "Preparing all saved songs…"
              : `${count.toLocaleString()} ${count === 1 ? "song" : "songs"}`}
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
      <div
        className="flex flex-wrap gap-2 px-8 pb-4"
        role="group"
        aria-label="Liked Songs filter"
      >
        {(["loved", "rated", "all"] as const).map((value) => (
          <button
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
      {unavailable > 0 && kind !== "rated" && (
        <p className="mx-8 mb-4 text-sm text-[var(--text-secondary)]">
          {unavailable.toLocaleString()} saved favorites still need a library
          match. Review them in Sync.
        </p>
      )}
      {favorites.error && (
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
      {preparing ? (
        <p
          role={ratedIndex.error ? "alert" : "status"}
          className="px-8 py-12 text-sm text-[var(--text-secondary)]"
        >
          {ratedIndex.error || "Preparing your complete collection…"}
          {ratedIndex.error && <button type="button" onClick={ratedIndex.retry} className="ml-2 underline">Try again</button>}
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
          isLoading={favorites.loading || (pages.loading && !pages.total)}
          currentTrackId={currentTrack?.id ?? null}
          emptyMessage={
            query
              ? "No songs match this filter."
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
function orderedTracks(
  filteredTracks: MusicTrack[],
  sortCol: string,
  sortDir: "asc" | "desc",
  ratings: ReturnType<typeof useFavoritesStore.getState>["ratingsByTrackId"]
) {
  if (sortCol === "default") return filteredTracks
  const items = [...filteredTracks]
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
        cmp =
          (effectiveTrackRating(a.userRating, ratings.get(a.id)) ?? 0) -
          (effectiveTrackRating(b.userRating, ratings.get(b.id)) ?? 0)
        break
      case "rated_at": {
        cmp =
          (a.lastRatedAt ? +new Date(a.lastRatedAt) : 0) -
          (b.lastRatedAt ? +new Date(b.lastRatedAt) : 0)
        break
      }
      case "liked_at": {
        const at = Date.parse(a.likedAt ?? ""),
          bt = Date.parse(b.likedAt ?? "")
        if (!Number.isFinite(at) || !Number.isFinite(bt))
          return Number.isFinite(at) ? -1 : Number.isFinite(bt) ? 1 : 0
        cmp = at - bt
        break
      }
      case "duration":
        cmp = a.duration - b.duration
        break
    }
    return sortDir === "asc" ? cmp : -cmp
  })
  return items
}
