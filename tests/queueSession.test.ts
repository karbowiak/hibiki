import { expect, test } from "bun:test"
import { QueueSession, isQueuePlaceholder } from "../src/lib/queueSession"
import type { MusicTrack } from "../src/types/music"
const track = (index: number) =>
  ({
    id: String(index + 1),
    title: `Song ${index}`,
    artistName: "Artist",
    duration: 180000,
  }) as MusicTrack

test("the full 1831-song queue exists before hydrating a distant item", async () => {
  const requests: number[][] = []
  const session = new QueueSession({
    key: "liked:loved",
    entries: Array.from({ length: 1831 }, (_, i) => ({ id: String(i + 1) })),
    loadItems: async (positions) => {
      requests.push(positions)
      return positions.map(track)
    },
    loadPage: async () => {
      throw Error("must use sparse lookup")
    },
  })
  expect(session.entries).toHaveLength(1831)
  await session.ensure(session.entries, 1830, 1831)
  const queue = session.project(session.entries, 1830)
  expect(queue[1830].title).toBe("Song 1830")
  expect(isQueuePlaceholder(queue[0])).toBe(true)
  expect(requests).toEqual([[1830]])
})

test("shuffled queue membership covers all songs and reads only chosen positions", async () => {
  const positions: number[][] = []
  const session = new QueueSession(
    {
      key: "large",
      entries: Array.from({ length: 20000 }, (_, i) => ({ id: String(i + 1) })),
      loadItems: async (selected) => {
        positions.push(selected)
        return selected.map(track)
      },
      loadPage: async () => {
        throw Error("unexpected page")
      },
    },
    true
  )
  expect(new Set(session.entries.map((track) => track.id)).size).toBe(20000)
  await session.ensure(session.entries, 0, 30)
  expect(positions.flat()).toHaveLength(30)
  expect(Math.max(...positions[0]) - Math.min(...positions[0])).toBeGreaterThan(
    15000
  )
})

test("reordering pending metadata and repeated recordings preserves each occurrence", async () => {
  let finish!: (tracks: MusicTrack[]) => void
  const entries = Array.from({ length: 1831 }, (_, i) => ({
    id: String(Math.floor(i / 2) + 1),
    playlistItemId: String(i),
  }))
  const session = new QueueSession({
    key: "playlist:1",
    entries,
    loadItems: () =>
      new Promise((resolve) => {
        finish = resolve
      }),
    loadPage: async () => {
      throw Error("unexpected")
    },
  })
  const pending = session.ensure(session.entries, 1800, 1801)
  await Promise.resolve()
  await Promise.resolve()
  const reordered = [...session.entries]
  const [moved] = reordered.splice(1800, 1)
  reordered.splice(1, 0, moved)
  finish([{ ...track(900), playlistItemId: "1800" }])
  await pending
  const queue = session.project(reordered, 0)
  expect(queue[1].title).toBe("Song 900")
  expect(queue[1].playlistItemId).toBe("1800")
  expect(session.snapshot(queue)[1].sourceIndex).toBe(1800)
})

test("queue metadata stays bounded while the complete order is retained", async () => {
  const session = new QueueSession({
    key: "large",
    total: 2000,
    loadItems: async (selected) => selected.map(track),
    loadPage: async () => {
      throw Error("unexpected")
    },
  })
  let queue: MusicTrack[] = session.entries
  for (let i = 0; i < 1800; i += 100) {
    await session.ensure(queue, i, i + 100)
    queue = session.project(queue, 0)
  }
  expect(queue).toHaveLength(2000)
  expect(
    queue.filter((track) => !isQueuePlaceholder(track)).length
  ).toBeLessThanOrEqual(805)
  expect(session.snapshot(queue)[1999].sourceIndex).toBe(1999)
})

test("a second snapshot retains original offsets of cold, reordered source slots", () => {
  const session = new QueueSession({
    key: "playlist:7",
    entries: [
      { id: "", sourceIndex: 1800 },
      { id: "", sourceIndex: 20 },
    ] as any,
    loadPage: async () => ({ items: [], total: 2 }),
  })
  expect(
    session.snapshot(session.entries).map((entry) => entry.sourceIndex)
  ).toEqual([1800, 20])
})
