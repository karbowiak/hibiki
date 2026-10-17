import { expect, test } from "bun:test"
import { QueueSession, isQueuePlaceholder, copyQueueTrack } from "../src/lib/queueSession"
import type { MusicTrack } from "../src/types/music"
import { deferred } from "./helpers/radioAudioFakes"
const track = (index: number) =>
  ({
    id: String(index + 1),
    title: `Song ${index}`,
    artistName: "Artist",
    duration: 180000,
  }) as MusicTrack

test("copied queue rows and foreign sessions cannot borrow another source's positions", async () => {
  const source = (key:string, id:string) => ({key,entries:[{id}],loadPage:async()=>({items:[],total:1}),
    loadItems:async()=>[{...track(0),id,title:key}]})
  const first = new QueueSession(source("first","1")), second = new QueueSession(source("second","2"))
  await first.ensure(first.entries,0,1)
  const original = first.project(first.entries,0)[0]
  const copy = copyQueueTrack(original)
  expect(copy).not.toBe(original)
  expect(first.sourcePosition(copy)).toBeUndefined()
  expect(second.sourcePosition(original)).toBeUndefined()
  const queue = [...second.entries,original,copy]
  await second.ensure(queue,0,3)
  const projected = second.project(queue,0)
  expect(projected.map(track=>track.title)).toEqual(["second","first","first"])
  expect(second.snapshot(projected).map(entry=>entry.sourceIndex)).toEqual([0,undefined,undefined])
})

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
  const artwork = { thumbUrl: "image://localhost/ext/img?src=https%3A%2F%2Fimages.test%2Ftrack.jpg", albumThumbUrl: "https://images.test/album.jpg", artistThumbUrl: "https://images.test/artist.jpg" }
  const session = new QueueSession({
    key: "large",
    entries: Array.from({ length: 2000 }, (_, i) => ({ ...track(i), ...artwork })),
    loadItems: async (selected) => selected.map(i => ({ ...track(i), ...artwork })),
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
  expect(isQueuePlaceholder(queue[100])).toBe(true)
  expect(queue[100]).toMatchObject(artwork)
  expect(session.snapshot(queue)[100]).toMatchObject(artwork)
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

test("playback overtakes scrolling and obsolete viewports never enter the loader", async () => {
  const gate = deferred<MusicTrack[]>()
  const loaded: number[][] = []
  const session = new QueueSession({ key: "large", total: 1000,
    loadItems: async positions => {
      loaded.push(positions)
      return loaded.length === 1 ? gate.promise : positions.map(track)
    }, loadPage: async () => { throw Error("unexpected") },
  })
  const first = session.ensure(session.entries, 0, 10, { priority: "viewport" })
  const abandoned = session.ensure(session.entries, 100, 110, { priority: "viewport" })
  const visible = session.ensure(session.entries, 900, 910, { priority: "viewport" })
  const next = session.ensure(session.entries, 50, 51)
  gate.resolve(Array.from({ length: 10 }, (_, index) => track(index)))
  await Promise.all([first, abandoned, visible, next])
  expect(loaded.map(positions => positions[0])).toEqual([0, 50, 900])
  expect(session.project(session.entries, 50)[50].id).toBe("51")
})

test("retiring a queue drops deferred reads and never publishes a late hydration", async () => {
  const gate = deferred<MusicTrack[]>()
  let reads = 0
  const session = new QueueSession({ key: "old", total: 1000,
    loadItems: () => { reads++; return gate.promise },
    loadPage: async () => { throw Error("unexpected") },
  })
  const first = session.ensure(session.entries, 0, 1)
  const waiting = session.ensure(session.entries, 900, 901)
  session.retire()
  await waiting
  gate.resolve([track(0)])
  await first
  expect(reads).toBe(1)
  expect(session.project(session.entries, 0)).toBe(session.entries)
})

test("projection changes only resident slots and handles moved and repeated members", async () => {
  const session = new QueueSession({ key: "large", total: 100000,
    loadItems: async positions => positions.map(track),
    loadPage: async () => { throw Error("unexpected") },
  })
  await session.ensure(session.entries, 99999, 100000)
  let queue = session.project(session.entries, 0)
  expect(queue[0]).toBe(session.entries[0])
  expect(session.project(queue, 0)).toBe(queue)
  const moved = [...queue.slice(0, 3), queue[99999], ...queue.slice(3, 99999), queue[99999]]
  queue = session.project(moved, 0)
  expect(queue[3].id).toBe("100000")
  expect(queue.at(-1)?.id).toBe("100000")
  expect(session.project(queue, 0)).toBe(queue)
})
