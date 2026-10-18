import { expect, test } from "bun:test"
import { playlistDownloadTracks } from "../src/offline/playlistDownloads"
import type { MusicTrack } from "../src/types/music"

test("explicit playlist preparation drains pagination and preserves repeated occurrences", async () => {
  const tracks = Array.from(
    { length: 237 },
    (_, index) =>
      ({
        id: index % 3 ? `ytmusic:${index}` : "42",
        playlistItemId: String(index),
      }) as MusicTrack
  )
  const offsets: number[] = []
  const result = await playlistDownloadTracks(
    {
      key: "playlist",
      loadPage: async (offset, limit) => {
        offsets.push(offset)
        return {
          offset,
          items: tracks.slice(offset, offset + limit),
          total: tracks.length,
        }
      },
    },
    () => true
  )
  expect(offsets).toEqual([0, 100, 200])
  expect(result.map((item) => item.playlistItemId)).toEqual(
    tracks.map((item) => item.playlistItemId)
  )
  expect(result.filter((item) => item.id === "42")).toHaveLength(79)
})

test("departed owners and incomplete pages cannot publish partial download manifests", async () => {
  await expect(
    playlistDownloadTracks(
      { key: "playlist", loadPage: async () => ({ items: [], total: 1 }) },
      () => true
    )
  ).rejects.toThrow("complete playlist")
  let current = true
  await expect(
    playlistDownloadTracks(
      {
        key: "playlist",
        loadPage: async () => {
          current = false
          return { items: [], total: 0 }
        },
      },
      () => current
    )
  ).rejects.toThrow("selection changed")
})
