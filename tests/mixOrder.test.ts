import { expect, test } from "bun:test"
import { mixPlaybackSource, orderMixTracks } from "../src/lib/mixOrder"
import { QueueSession } from "../src/lib/queueSession"
import type { MusicTrack } from "../src/types/music"
import type { MusicProvider } from "../src/providers/types"

const rows = Array.from(
  { length: 1200 },
  (_, index) =>
    ({
      id: String(index),
      title: `Track ${index}`,
      artistName: `Artist ${Math.floor(index / 400)}`,
    }) as MusicTrack
)
const ids = (tracks: readonly Partial<MusicTrack>[]) =>
  tracks.map((track) => track.id)

test("mix order blends the entire membership and changes only when contents change", () => {
  const order = orderMixTracks(rows)
  expect(
    new Set(order.slice(0, 30).map((track) => track.artistName)).size
  ).toBe(3)
  expect(ids(order)).not.toEqual(ids(rows))
  expect(ids(orderMixTracks(rows))).toEqual(ids(order))
  expect(ids(orderMixTracks([...rows].reverse()))).toEqual(ids(order))
  expect(
    ids(
      orderMixTracks(
        rows.map((track) => ({ ...track, title: "Edited", userRating: 10 }))
      )
    )
  ).toEqual(ids(order))
  const changed = orderMixTracks([...rows, { ...rows[0], id: "new" }])
  expect(ids(changed.filter((track) => track.id !== "new"))).not.toEqual(
    ids(order)
  )
  expect(rows[0].id).toBe("0")
  expect(orderMixTracks([rows[0], rows[0], rows[1]])).toHaveLength(3)
})

test("mix playback captures complete stable membership and never requests another shuffle", async () => {
  const captured = orderMixTracks(rows)
  const requests: unknown[] = []
  const snapshot = {
    key: "mix:snapshot",
    entries: captured.map((track) => ({ id: track.id })),
    total: captured.length,
    loadItems: async (positions: number[]) =>
      positions.map((index) => captured[index]),
    loadPage: async (offset: number, limit: number) => ({
      items: captured.slice(offset, offset + limit),
      total: captured.length,
      offset,
    }),
  }
  const provider = {
    getCachedTrackSource: async (...args: unknown[]) => {
      requests.push(args)
      return snapshot
    },
  } as unknown as MusicProvider
  const source = mixPlaybackSource(provider, "/mix/path", captured.length)
  const prepared = await source.prepare!()
  expect(requests).toEqual([["mix:/mix/path"]])
  const queue = new QueueSession(prepared!)
  expect(ids(queue.entries)).toEqual(ids(captured))
  await queue.ensure(queue.entries, 750, 751)
  expect(queue.project(queue.entries, 750)[750].id).toBe(captured[750].id)
  const missing = mixPlaybackSource(
    { ...provider, getCachedTrackSource: async () => null },
    "/mix/path"
  )
  await expect(missing.prepare!()).rejects.toThrow("mix changed while loading")
})
