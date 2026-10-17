import { expect, test } from "bun:test"
import { WindowedPages } from "../src/lib/windowedPages"
import { TrackQueuePager } from "../src/lib/pagedPlayback"
import type { MusicTrack } from "../src/types/music"
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const track = (index: number) =>
  ({ id: String(index), title: `Song ${index}` }) as MusicTrack

test("jumping across a huge collection fetches the target page and evicts old metadata", async () => {
  const calls: number[] = []
  const pages = new WindowedPages(async (offset, limit) => {
    calls.push(offset)
    return {
      items: Array.from({ length: limit }, (_, i) => track(offset + i)),
      total: 100000,
      offset,
    }
  }, 100000)
  pages.ensureRange(0, 20)
  await tick()
  expect(pages.total).toBe(100000)
  pages.ensureRange(50100, 50120)
  await tick()
  expect(calls).toEqual([0, 50000])
  expect(pages.getItem(50110)?.id).toBe("50110")
  for (let page = 1; page <= 12; page++) {
    pages.ensureRange(page * 1000, page * 1000 + 20)
    await tick()
  }
  expect(pages.residentCount).toBeLessThanOrEqual(1600)
  expect(pages.getItem(0)).toBeUndefined()
  const before = calls.length
  pages.ensureRange(0, 20)
  await tick()
  expect(pages.getItem(10)?.id).toBe("10")
  expect(calls.length).toBe(before + 1)
})

test("a superseded response cannot repopulate an invalidated collection", async () => {
  const pending: ((value: any) => void)[] = []
  const pages = new WindowedPages<MusicTrack>(
    () => new Promise((resolve) => pending.push(resolve)),
    1000
  )
  pages.ensureRange(0, 20)
  pages.invalidate()
  expect(pending).toHaveLength(1)
  pending[0]({ items: [track(1)], total: 1000, offset: 0 })
  await tick()
  pending[1]({ items: [track(99)], total: 1, offset: 0 })
  await tick()
  expect(pages.getItem(0)?.id).toBe("99")
  expect(pages.total).toBe(1)
})

test("page errors wait for explicit retry instead of a request loop", async () => {
  let calls = 0
  const pages = new WindowedPages(async (offset) => {
    if (++calls === 1) throw Error("Offline")
    return { items: [track(1)], total: 1, offset }
  }, 1)
  pages.ensureRange(0, 1)
  await tick()
  pages.ensureRange(0, 1)
  await tick()
  expect(calls).toBe(1)
  expect(pages.error).toBe("Offline")
  pages.retry()
  await tick()
  expect(calls).toBe(2)
  expect(pages.getItem(0)?.id).toBe("1")
})

test("live favorite updates keep visible rows until a replacement page is ready", async () => {
  const pages = new WindowedPages<MusicTrack>(
    async (offset) => ({ items: [track(1), track(2)], total: 2, offset }),
    2
  )
  pages.ensureRange(0, 2)
  await tick()
  let resolve!: (value: any) => void
  pages.updateSource(
    () =>
      new Promise((done) => {
        resolve = done
      }),
    2,
    1
  )
  expect(pages.getItem(0)?.id).toBe("1")
  expect(pages.getItem(1)?.id).toBe("2")
  expect(pages.loading).toBe(true)
  resolve({ items: [track(3), track(1)], total: 2, offset: 0 })
  await tick()
  expect(pages.getItem(0)?.id).toBe("3")
  expect(pages.getItem(1)?.id).toBe("1")
  expect(pages.loading).toBe(false)
})

test("short interior pages show an actionable error instead of permanent skeletons", async () => {
  const pages = new WindowedPages(
    async (offset) => ({ items: [track(0)], total: 5000, offset }),
    5000
  )
  pages.ensureRange(0, 20)
  await tick()
  expect(pages.error).toContain("incomplete page")
  expect(pages.loading).toBe(false)
})

test("progressive shuffle visits the entire collection once and preserves playlist occurrences", async () => {
  const calls: number[] = []
  let seed = 3
  const random = () => {
    seed = (seed * 16807) % 2147483647
    return seed / 2147483647
  }
  const pager = new TrackQueuePager(
    {
      key: "playlist",
      total: 2103,
      loadPage: async (offset, limit) => {
        calls.push(offset)
        return {
          items: Array.from(
            { length: Math.min(limit, 2103 - offset) },
            (_, i) => ({
              ...track(Math.floor((offset + i) / 2)),
              playlistItemId: String(offset + i),
            })
          ),
          total: 2103,
          offset,
        }
      },
    },
    true,
    random
  )
  const items = []
  while (pager.hasMore) items.push(...(await pager.next()))
  expect(items).toHaveLength(2103)
  expect(new Set(items.map((item) => item.playlistItemId)).size).toBe(2103)
  expect(new Set(calls).size).toBe(5)
  expect(calls.every((offset) => offset % 500 === 0)).toBe(true)
})

test("choosing a distant track starts there and continues without fetching earlier queue pages", async () => {
  const calls: number[] = []
  const pager = new TrackQueuePager(
    {
      key: "playlist",
      total: 1800,
      loadPage: async (offset, limit) => {
        calls.push(offset)
        return {
          items: Array.from(
            { length: Math.min(limit, 1800 - offset) },
            (_, i) => track(offset + i)
          ),
          total: 1800,
          offset,
        }
      },
    },
    false,
    Math.random,
    1123
  )
  expect((await pager.next())[0].id).toBe("1123")
  expect((await pager.next())[0].id).toBe("1500")
  expect(pager.hasMore).toBe(false)
  expect(calls).toEqual([1000, 1500])
})
