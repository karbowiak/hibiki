import { expect, test } from "bun:test"
import { createYoutubePlaylistCache, hydrateYoutubePlaylist, sameYoutubePlaylistOwner,
  type YoutubePlaylistHydration } from "../src/offline/youtubePlaylistCache"
import type { YoutubeMusicBrowsePage, YoutubeMusicItem } from "../src/backends/ytmusic/discovery"
import { deferred } from "./helpers/radioAudioFakes"

const playlist = (id: string, title = "Same title"): YoutubeMusicItem => ({
  id, title, kind: "playlist", artist: "Owner", thumbnail: null, duration: null, album: null, year: null,
})
const owner = { revision: 1, accountId: "account" }
const job = (id = "VLone"): YoutubePlaylistHydration => ({ id, key: `ytmusic:playlist:${id}`, title: id, owner })
const page = (continuation: string | null, items: YoutubeMusicItem[] = []): YoutubeMusicBrowsePage => ({
  title: "Playlist", items, hubs: [], continuation,
})
const settle = () => Bun.sleep(0)

test("YTM warming follows empty continuation pages, yields, and resumes instead of restarting", async () => {
  const reads: (string | null)[] = [], progress: [number, number | undefined][] = []
  const deps = {
    active: () => true,
    read: async (cursor: string | null) => {
      reads.push(cursor)
      const number = cursor ? Number(cursor) : 0
      return page(number === 4 ? null : String(number + 1), number === 1 ? [] : [playlist(String(number))])
    },
    progress: (completed: number, total?: number) => progress.push([completed, total]),
  }
  const first = await hydrateYoutubePlaylist(job(), deps)
  expect(first).toMatchObject({ done: false, resume: { cursor: "4", completed: 3, pages: 4 } })
  expect(first.resume?.visited).toHaveLength(3)
  expect(await hydrateYoutubePlaylist({ ...job(), resume: first.resume }, deps)).toEqual({ done: true })
  expect(reads).toEqual([null, "1", "2", "3", "4"])
  expect(progress).toEqual([[0, undefined], [1, undefined], [1, undefined], [2, undefined],
    [3, undefined], [3, undefined], [4, 4]])
})

test("YTM warming detects continuation cycles across separate queue claims", async () => {
  const reads: (string | null)[] = []
  const deps = { active: () => true, progress: () => {}, read: async (cursor: string | null) => {
    reads.push(cursor)
    return page(cursor === "4" ? "1" : String(Number(cursor ?? 0) + 1))
  } }
  const first = await hydrateYoutubePlaylist(job(), deps)
  await expect(hydrateYoutubePlaylist({ ...job(), resume: first.resume }, deps)).rejects.toThrow("did not advance")
  expect(reads).toEqual([null, "1", "2", "3", "4"])
})

test("long warmups keep their active cursor and measure expiry from completion", async () => {
  let now = 0
  const gate = deferred<void>(), calls: YoutubePlaylistHydration[] = []
  const cache = createYoutubePlaylistCache({ owner: () => owner, now: () => now,
    run: async current => { calls.push(current); if (!current.resume) {
      await gate.promise
      return { done: false, resume: { cursor: "next", completed: 100, pages: 4 } }
    } return { done: true } },
  })
  try {
    cache.offer([playlist("VLone")])
    now = 16 * 60_000
    cache.offer([playlist("VLone")])
    gate.resolve()
    await settle()
    expect(calls.map(call => call.resume?.cursor)).toEqual([undefined, "next"])
    cache.offer([playlist("VLone")])
    await settle()
    expect(calls).toHaveLength(2)
    now += 15 * 60_000
    cache.offer([playlist("VLone")])
    await settle()
    expect(calls).toHaveLength(4)
  } finally { gate.resolve(); cache.reset() }
})

test("YTM warming stops on a repeated cursor or a retired account", async () => {
  await expect(hydrateYoutubePlaylist({ ...job(), resume: { cursor: "loop", completed: 1, pages: 1 } }, {
    active: () => true, read: async () => page("loop"), progress: () => {},
  })).rejects.toThrow("did not advance")
  let active = true
  const progress: number[] = []
  await expect(hydrateYoutubePlaylist(job(), {
    active: () => active, read: async () => { active = false; return page("next", [playlist("song")]) },
    progress: completed => progress.push(completed),
  })).rejects.toThrow("connection changed")
  expect(progress).toEqual([0])
})

test("YTM feeder coalesces repeated rosters, preserves equal titles, and yields between playlists", async () => {
  const calls: YoutubePlaylistHydration[] = [], gate = deferred<void>()
  const cache = createYoutubePlaylistCache({
    owner: () => owner,
    run: async current => {
      calls.push(current)
      if (calls.length === 1) await gate.promise
      return current.resume || current.id !== "VLone" ? { done: true } :
        { done: false, resume: { cursor: "next", completed: 100, pages: 4 } }
    },
  })
  try {
    const items = [playlist("VLone"), playlist("VLtwo"), playlist("VLLM"), playlist("VLRDmix"),
      { ...playlist("not-a-playlist"), kind: "album" as const }]
    cache.offer(items)
    cache.offer(items)
    expect(calls).toHaveLength(1)
    gate.resolve()
    await settle()
    expect(calls.map(call => [call.id, call.resume?.cursor])).toEqual([
      ["VLone", undefined], ["VLtwo", undefined], ["VLone", "next"],
    ])
    cache.offer(items)
    await settle()
    expect(calls).toHaveLength(3)
    expect(Object.keys(calls[0].owner).sort()).toEqual(["accountId", "revision"])
  } finally { gate.resolve(); cache.reset() }
})

test("failed warmups retry at cache expiry without blocking other playlists", async () => {
  let now = 0
  const calls: string[] = []
  const cache = createYoutubePlaylistCache({ owner: () => owner, now: () => now,
    run: async current => { calls.push(current.id); if (current.id === "VLone") throw Error("offline"); return { done: true } },
  })
  try {
    const items = [playlist("VLone"), playlist("VLtwo")]
    cache.offer(items)
    await settle()
    cache.offer(items)
    await settle()
    expect(calls).toEqual(["VLone", "VLtwo"])
    now = 15 * 60_000
    cache.offer(items)
    await settle()
    expect(calls).toEqual(["VLone", "VLtwo", "VLone", "VLtwo"])
  } finally { cache.reset() }
})

test("account replacement drops old queued playlists and their unfinished continuations", async () => {
  let current = owner
  const gate = deferred<void>(), calls: YoutubePlaylistHydration[] = []
  const cache = createYoutubePlaylistCache({ owner: () => current,
    run: async next => {
      calls.push(next)
      if (calls.length === 1) { await gate.promise; return { done: false, resume: { cursor: "old", completed: 100, pages: 4 } } }
      return { done: true }
    },
  })
  try {
    cache.offer([playlist("VLone"), playlist("VLold")])
    current = { revision: 2, accountId: "new-account" }
    cache.offer([playlist("VLnew")])
    gate.resolve()
    await settle()
    expect(calls.map(call => call.id)).toEqual(["VLone", "VLnew"])
    expect(sameYoutubePlaylistOwner(calls[1].owner, current)).toBe(true)
    expect(calls[1].resume).toBeUndefined()
  } finally { gate.resolve(); cache.reset() }
})
