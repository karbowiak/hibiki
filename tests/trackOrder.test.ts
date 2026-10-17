import { expect, test } from "bun:test"
import { filterTracks, sortTracks } from "../src/lib/trackOrder"
import type { MusicTrack } from "../src/types/music"
const track = (id: string, extra: Partial<MusicTrack> = {}) =>
  ({
    id,
    title: id,
    artistName: "Artist",
    albumName: "Album",
    userRating: null,
    ...extra,
  }) as MusicTrack

test("sorting preserves duplicate occurrences and source order, and accepts local rating intent", () => {
  const rows = [
    track("a", { playlistItemId: "first" }),
    track("b"),
    track("a", { playlistItemId: "repeat" }),
  ]
  expect(sortTracks(rows, "default", "asc")).toBe(rows)
  expect(
    sortTracks(rows, "rating", "desc", (row) => (row.id === "b" ? 10 : 2)).map(
      (row) => row.id
    )
  ).toEqual(["b", "a", "a"])
  expect(rows.map((row) => row.playlistItemId)).toEqual([
    "first",
    undefined,
    "repeat",
  ])
  expect(filterTracks(rows, "ARTIST")).toHaveLength(3)
  expect(filterTracks(rows, "")).toBe(rows)
})

test("unknown love dates remain last in both directions", () => {
  const rows = [
    track("unknown"),
    track("new", { likedAt: "2026-10-01" }),
    track("old", { likedAt: "2025-01-01" }),
    track("invalid", { likedAt: "invalid" }),
  ]
  expect(sortTracks(rows, "liked_at", "asc").map((row) => row.id)).toEqual([
    "old",
    "new",
    "unknown",
    "invalid",
  ])
  expect(sortTracks(rows, "liked_at", "desc").map((row) => row.id)).toEqual([
    "new",
    "old",
    "unknown",
    "invalid",
  ])
})
