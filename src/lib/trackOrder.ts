import type { MusicTrack } from "../types/music"

export type TrackSortColumn =
  | "default"
  | "title"
  | "artist"
  | "album"
  | "year"
  | "plays"
  | "views"
  | "popularity"
  | "label"
  | "bitrate"
  | "format"
  | "added_at"
  | "rating"
  | "rated_at"
  | "liked_at"
  | "duration"

type RatingReader = (track: MusicTrack) => number | null | undefined
const date = (value: string | null | undefined) =>
  value ? +new Date(value) : 0
const comparators = {
  title: (a, b) => a.title.localeCompare(b.title),
  artist: (a, b) => a.artistName.localeCompare(b.artistName),
  album: (a, b) => a.albumName.localeCompare(b.albumName),
  year: (a, b) => (a.albumYear ?? a.year) - (b.albumYear ?? b.year),
  plays: (a, b) => a.playCount - b.playCount,
  views: (a, b) => (a.viewCount ?? 0) - (b.viewCount ?? 0),
  popularity: (a, b) => (a.ratingCount ?? 0) - (b.ratingCount ?? 0),
  label: (a, b) => (a.parentStudio ?? "").localeCompare(b.parentStudio ?? ""),
  bitrate: (a, b) => (a.bitrate ?? 0) - (b.bitrate ?? 0),
  format: (a, b) => (a.codec ?? "").localeCompare(b.codec ?? ""),
  added_at: (a, b) => date(a.addedAt ?? a.libraryObservedAt) - date(b.addedAt ?? b.libraryObservedAt),
  rated_at: (a, b) => date(a.lastRatedAt) - date(b.lastRatedAt),
  duration: (a, b) => a.duration - b.duration,
} satisfies Record<
  Exclude<TrackSortColumn, "default" | "rating" | "liked_at">,
  (a: MusicTrack, b: MusicTrack) => number
>

/** Preserve source order/occurrences and keep unknown love dates last in either direction. */
export function sortTracks(
  tracks: MusicTrack[],
  column: TrackSortColumn,
  direction: "asc" | "desc",
  rating: RatingReader = (track) => track.userRating
): MusicTrack[] {
  if (column === "default") return tracks
  const sign = direction === "asc" ? 1 : -1
  return [...tracks].sort((a, b) => {
    if (column === "liked_at") {
      const at = Date.parse(a.likedAt ?? ""),
        bt = Date.parse(b.likedAt ?? "")
      if (!Number.isFinite(at) || !Number.isFinite(bt))
        return Number.isFinite(at) ? -1 : Number.isFinite(bt) ? 1 : 0
      return (at - bt) * sign
    }
    return (
      sign *
      (column === "rating"
        ? (rating(a) ?? 0) - (rating(b) ?? 0)
        : comparators[column](a, b))
    )
  })
}

export function filterTracks(
  tracks: MusicTrack[],
  query: string
): MusicTrack[] {
  if (!query) return tracks
  const search = query.toLowerCase()
  return tracks.filter(
    (track) =>
      track.title.toLowerCase().includes(search) ||
      track.artistName.toLowerCase().includes(search) ||
      track.albumName.toLowerCase().includes(search)
  )
}
