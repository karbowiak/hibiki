import { useLikedCollection } from "../../hooks/useLikedCollection"
import { useEffect, useMemo, useState } from "react"
import { useShallow } from "zustand/react/shallow"
import { useLibraryStore, usePlayerStore } from "../../stores"
import { formatTotalMs } from "../../lib/formatters"
import { useTableSort } from "../../hooks/useTableSort"
import { ALL_COLUMNS, usePlaylistColumns } from "../../hooks/useColumnPicker"
import { TrackTable } from "../shared/TrackTable"
import { useFavoritesStore } from "../../stores/favoritesStore"
import { useFavoriteTracks } from "../../hooks/useFavoriteTracks"
import { FavoritesSyncDialog } from "../FavoritesSyncDialog"
import { useProviderStore } from "../../stores/providerStore"

const LIKED_COLUMNS = ALL_COLUMNS
const LIKED_DEFAULT_COLS = [
  "album" as const,
  "rating" as const,
  "rated_at" as const,
]

export function Liked() {
  const { likedTracks } = useLibraryStore(
    useShallow((s) => ({
      likedTracks: s.likedTracks,
    }))
  )
  const { playTrack, playRadio, addToQueue, currentTrack } = usePlayerStore(
    useShallow((s) => ({
      playTrack: s.playTrack,
      playRadio: s.playRadio,
      addToQueue: s.addToQueue,
      currentTrack: s.currentTrack,
    }))
  )
  const { status, retry } = useLikedCollection("tracks")
  const provider = useProviderStore((state) => state.provider)
  const { collection, loaded, loading, error, likedTrackIds } =
    useFavoritesStore()
  const local = useFavoriteTracks(likedTracks)
  const [syncOpen, setSyncOpen] = useState(false)
  const [kind, setKind] = useState<"loved" | "rated" | "all">("loved")
  useEffect(() => {
    if (status === "ready" && loaded && !collection.ratingsImported)
      void useFavoritesStore
        .getState()
        .seedRatings(likedTracks)
        .catch(() => {})
  }, [status, loaded, collection.ratingsImported, likedTracks])

  const { visible: visibleCols, toggle: toggleCol } = usePlaylistColumns(
    "plex-liked-columns",
    LIKED_DEFAULT_COLS
  )

  // In-playlist search
  const [filterQuery, setFilterQuery] = useState("")
  const [debouncedQuery, setDebouncedQuery] = useState("")

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(filterQuery), 150)
    return () => clearTimeout(t)
  }, [filterQuery])

  const dedupedTracks = useMemo(() => {
    if (kind === "loved") return local.tracks
    const byId = new Map<string, (typeof likedTracks)[number]>()
    if (kind === "all")
      local.tracks.forEach((track) => byId.set(track.id, track))
    likedTracks
      .filter((track) => (track.userRating ?? 0) > 0)
      .forEach((track) => {
        if (kind === "rated" || !likedTrackIds.has(track.id))
          byId.set(track.id, track)
      })
    return [...byId.values()]
  }, [kind, local.tracks, likedTracks, likedTrackIds])
  const visibleIds = new Set(local.tracks.map((track) => track.id))
  const unavailable = Object.values(collection.entries).filter(
    (item) => item.liked && !item.localTrackIds.some((id) => visibleIds.has(id))
  ).length

  const filteredTracks = useMemo(() => {
    if (!debouncedQuery) return dedupedTracks
    const q = debouncedQuery.toLowerCase()
    return dedupedTracks.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.artistName.toLowerCase().includes(q) ||
        t.albumName.toLowerCase().includes(q)
    )
  }, [dedupedTracks, debouncedQuery])

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
    descByDefault: ["rating"],
  })

  const tracks = useMemo(() => {
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
          cmp = (a.userRating ?? 0) - (b.userRating ?? 0)
          break
        case "rated_at": {
          cmp =
            (a.lastRatedAt ? +new Date(a.lastRatedAt) : 0) -
            (b.lastRatedAt ? +new Date(b.lastRatedAt) : 0)
          break
        }
        case "duration":
          cmp = a.duration - b.duration
          break
      }
      return sortDir === "asc" ? cmp : -cmp
    })
    return items
  }, [filteredTracks, sortCol, sortDir])

  const totalMs = tracks.reduce((sum, t) => sum + t.duration, 0)
  const count = tracks.length

  return (
    <div className="pb-12">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-5 px-8 py-6">
        <div className="flex h-32 w-32 flex-shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-accent/70 to-accent/20 shadow-lg">
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            width="56"
            height="56"
            fill="white"
          >
            <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
          </svg>
        </div>

        {/* Info column */}
        <div className="flex min-w-0 flex-[1_1_14rem] flex-col gap-3">
          <div>
            <h1 className="break-words text-[clamp(1.75rem,3.2vw,3rem)] font-bold leading-tight tracking-tight">
              Liked Songs
            </h1>
            <p className="mt-2 max-w-xl select-text text-sm text-gray-400">
              Your favorites, saved in Hibiki. Browse star ratings separately or
              keep your likes in sync.
            </p>
          </div>

          {/* Bottom row: stats + buttons */}
          <div className="flex flex-wrap items-center justify-between gap-4">
            <p className="text-sm text-gray-400">
              {count.toLocaleString()} {count === 1 ? "song" : "songs"}
              {totalMs > 0 && <> · {formatTotalMs(totalMs)}</>}
            </p>
            <div className="flex items-center gap-3">
              <button
                className="media-secondary"
                disabled={!loaded || !provider?.favorites}
                onClick={() => setSyncOpen(true)}
              >
                Sync
              </button>
              {/* Play */}
              <button
                onClick={() =>
                  count > 0 &&
                  void playTrack(
                    tracks[0],
                    tracks,
                    "Liked Songs",
                    "/collection/tracks"
                  )
                }
                disabled={count === 0}
                title="Play"
                className="flex h-14 w-14 items-center justify-center rounded-full border border-white/10 bg-black/30 text-accent backdrop-blur-sm transition-all hover:scale-105 hover:bg-black/45 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <svg
                  viewBox="0 0 16 16"
                  width="22"
                  height="22"
                  fill="currentColor"
                >
                  <polygon points="3,2 13,8 3,14" />
                </svg>
              </button>
              {/* Shuffle */}
              <button
                onClick={() => {
                  if (count === 0) return
                  const s = [...tracks].sort(() => Math.random() - 0.5)
                  void playTrack(s[0], s, "Liked Songs", "/collection/tracks")
                }}
                disabled={count === 0}
                title="Shuffle"
                className="flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-black/30 text-accent backdrop-blur-sm transition-all hover:scale-105 hover:bg-black/45 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <svg
                  viewBox="0 0 16 16"
                  width="16"
                  height="16"
                  fill="currentColor"
                >
                  <path d="M13.151.922a.75.75 0 1 0-1.06 1.06L13.109 3H11.16a3.75 3.75 0 0 0-2.873 1.34l-6.173 7.356A2.25 2.25 0 0 1 .39 12.5H0V14h.391a3.75 3.75 0 0 0 2.873-1.34l6.173-7.356a2.25 2.25 0 0 1 1.724-.804h1.947l-1.017 1.018a.75.75 0 0 0 1.06 1.06L15.98 3.75 13.15.922zM.391 3.5H0V2h.391c1.109 0 2.16.49 2.873 1.34L4.89 5.277l-.979 1.167-1.796-2.14A2.25 2.25 0 0 0 .39 3.5z" />
                  <path d="m7.5 10.723.98-1.167.957 1.14a2.25 2.25 0 0 0 1.724.804h1.947l-1.017-1.018a.75.75 0 1 1 1.06-1.06l2.829 2.828-2.829 2.828a.75.75 0 1 1-1.06-1.06L13.109 13H11.16a3.75 3.75 0 0 1-2.873-1.34l-.787-.938z" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Track list */}
      <div
        className="flex flex-wrap gap-2 px-8 pb-4"
        role="group"
        aria-label="Liked Songs filter"
      >
        {(["loved", "rated", "all"] as const).map((value) => (
          <button
            key={value}
            aria-pressed={kind === value}
            className={kind === value ? "media-primary" : "media-secondary"}
            onClick={() => setKind(value)}
          >
            {value === "loved" ? "Loved" : value === "rated" ? "Rated" : "All"}
          </button>
        ))}
      </div>
      {unavailable > 0 && kind !== "rated" && (
        <div className="mx-8 mb-4 rounded-lg border border-white/10 p-3 text-sm text-[var(--text-secondary)]">
          {unavailable.toLocaleString()} favorites are saved but not available
          in this library yet.{" "}
          <button className="underline" onClick={() => setSyncOpen(true)}>
            Review matches
          </button>
          {" · "}
          <button
            className="underline"
            disabled={local.loading}
            onClick={local.retry}
          >
            Load missing library details
          </button>
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="mx-8 mb-4 rounded-lg border border-red-400/30 p-3 text-sm text-red-400"
        >
          {error}{" "}
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
        </div>
      )}
      {(loading ||
        local.loading ||
        (status === "loading" &&
          (kind !== "loved" || !collection.ratingsImported))) &&
      !tracks.length ? (
        <p
          role="status"
          className="px-8 py-12 text-center text-sm text-gray-400"
        >
          Loading saved songs…
        </p>
      ) : status === "error" && kind === "rated" ? (
        <div
          role="alert"
          className="mx-8 my-4 rounded-lg border border-red-400/30 p-4 text-sm text-red-400"
        >
          <p>Could not load rated tracks.</p>
          <button
            onClick={retry}
            className="mt-2 rounded-full border border-white/20 px-4 py-2 text-white"
          >
            Try again
          </button>
        </div>
      ) : (
        <TrackTable
          tracks={tracks}
          visibleCols={visibleCols}
          toggleCol={toggleCol}
          sortCol={sortCol}
          sortDir={sortDir}
          onSort={handleSort}
          onPlay={(track, all) =>
            void playTrack(track, all, "Liked Songs", "/collection/tracks")
          }
          onAddToQueue={addToQueue}
          onPlayRadio={playRadio}
          columns={LIKED_COLUMNS}
          searchPlaceholder="Search in liked songs…"
          filterQuery={filterQuery}
          onFilterChange={setFilterQuery}
          defaultResetTitle="Restore default order"
          emptyMessage={
            kind === "loved"
              ? "Tap a song’s heart to save it here, or connect your favorites in Sync."
              : "No rated tracks yet. Rate a song to see it here."
          }
          currentTrackId={currentTrack?.id ?? null}
        />
      )}
      {syncOpen && <FavoritesSyncDialog onClose={() => setSyncOpen(false)} />}
    </div>
  )
}
