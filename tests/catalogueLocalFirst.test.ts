import { expect, test } from "bun:test"
import {
  createOfflineProvider,
  freshPlaylistReads,
  offlineKey,
  type OfflineSnapshot,
} from "../src/offline/providerCache"
import type { MusicProvider } from "../src/providers/types"
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((a, b) => {
    resolve = a
    reject = b
  })
  return { promise, resolve, reject }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
function fixture(read: () => Promise<unknown>) {
  const saved = new Map<string, OfflineSnapshot>()
  let calls = 0,
    offline = false,
    owns = true
  const updates: unknown[] = []
  const provider = {
    name: "Plex",
    cacheScope: `plex-${"a".repeat(64)}`,
    playbackSession: {},
    capabilities: { playlistEdit: true },
    getPlaybackInfo: async () => ({ url: "remote" }),
    getAlbum: () => {
      calls++
      return read()
    },
    getPlaylistItems: () => {
      calls++
      return read()
    },
    rate: async () => {},
    isConnected: () => true,
  } as unknown as MusicProvider
  const cache = {
    get: async (key: string) => saved.get(key) ?? null,
    put: async (key: string, payload: unknown) => {
      saved.set(key, { payload, cachedAt: 123 })
    },
    invalidate: async () => {
      saved.clear()
    },
  }
  const local = {
    capabilities: { playlistEdit: false },
    getPlaybackInfo: async () => ({ url: "hibiki-local:42" }),
  } as unknown as MusicProvider
  const wrapped = createOfflineProvider(provider, cache, {
    localFirst: true,
    owns: () => owns,
    isOffline: () => offline,
    offlineProvider: local,
    onRefresh: (...args) => updates.push(args),
  })
  return {
    saved,
    provider,
    wrapped,
    updates,
    get calls() {
      return calls
    },
    offline: () => {
      offline = true
    },
    retire: () => {
      owns = false
    },
  }
}
test("fresh persisted browsing data survives a new provider without submitting revalidation", async () => {
  const f = fixture(async () => { throw Error("Fresh data must not fetch") })
  f.saved.set(offlineKey("getAlbum", ["42"]), {
    payload: { id: "42", title: "Fresh persisted album" }, cachedAt: Date.now(),
  })
  expect((await f.wrapped.getAlbum("42")).title).toBe("Fresh persisted album")
  await tick()
  expect(f.calls).toBe(0)
  await f.wrapped.rate("42", 4)
  await expect(f.wrapped.getAlbum("42")).rejects.toThrow("Fresh data must not fetch")
  expect(f.calls).toBe(1)
})
test("failed stale refreshes are paced, while uncached foreground reads can retry", async () => {
  const f = fixture(async () => { throw Error("offline") })
  f.saved.set(offlineKey("getAlbum", ["42"]), {
    payload: { id: "42", title: "Saved" }, cachedAt: 1,
  })
  await f.wrapped.getAlbum("42")
  await tick()
  await f.wrapped.getAlbum("42")
  await tick()
  expect(f.calls).toBe(1)
  await expect(f.wrapped.getAlbum("cold")).rejects.toThrow("offline")
  await expect(f.wrapped.getAlbum("cold")).rejects.toThrow("offline")
  expect(f.calls).toBe(3)
})
test("local-first returns SQLite data before the pending remote read and refreshes once when changed", async () => {
  const remote = deferred<unknown>(),
    f = fixture(() => remote.promise)
  const key = offlineKey("getAlbum", ["42"])
  f.saved.set(key, { payload: { id: "42", title: "Saved" }, cachedAt: 1 })
  const result = await f.wrapped.getAlbum("42")
  expect(result.title).toBe("Saved")
  expect(f.calls).toBe(1)
  expect((await f.wrapped.getAlbum("42")).title).toBe("Saved")
  expect(f.calls).toBe(1)
  remote.resolve({
    id: "42",
    title: "Changed",
    _providerData: { secret: "private" },
  })
  await tick()
  expect(f.updates).toEqual([
    ["getAlbum", ["42"], { id: "42", title: "Changed" }],
  ])
  expect((await f.wrapped.getAlbum("42")).title).toBe("Changed")
  expect(f.calls).toBe(1)
})
test("unchanged sanitized metadata never creates refresh loops", async () => {
  const f = fixture(async () => ({
    id: "42",
    title: "Same",
    _providerData: { media: "native" },
  }))
  f.saved.set(offlineKey("getAlbum", ["42"]), {
    payload: { id: "42", title: "Same" },
    cachedAt: 1,
  })
  await f.wrapped.getAlbum("42")
  await tick()
  await f.wrapped.getAlbum("42")
  expect(f.calls).toBe(1)
  expect(f.updates).toEqual([])
})
test("native JSON field ordering never turns unchanged nested metadata into refreshes", async () => {
  const f = fixture(async () => ({
    id: "42",
    title: "Same",
    media: { codec: "flac", channels: 2 },
    tracks: [
      { id: "1", title: "First" },
      { id: "2", title: "Second" },
    ],
  }))
  f.saved.set(offlineKey("getAlbum", ["42"]), {
    cachedAt: 1,
    payload: {
      tracks: [
        { title: "First", id: "1" },
        { title: "Second", id: "2" },
      ],
      media: { channels: 2, codec: "flac" },
      title: "Same",
      id: "42",
    },
  })
  await f.wrapped.getAlbum("42")
  await tick()
  expect(f.updates).toEqual([])
})
for (const [label, before, after] of [
  ["track order", { tracks: ["1", "2"] }, { tracks: ["2", "1"] }],
  ["nested value", { media: { channels: 2 } }, { media: { channels: 6 } }],
  ["removed field", { title: "Old", summary: null }, { title: "Old" }],
  ["null value", { summary: null }, { summary: "Updated" }],
])
  test(`local-first still publishes a genuine change in ${label}`, async () => {
    const f = fixture(async () => after)
    f.saved.set(offlineKey("getAlbum", ["42"]), {
      cachedAt: 1,
      payload: before,
    })
    await f.wrapped.getAlbum("42")
    await tick()
    expect(f.updates).toEqual([["getAlbum", ["42"], after]])
  })
test("cold misses coalesce and retired remote completions cannot publish or refresh", async () => {
  const remote = deferred<unknown>(),
    f = fixture(() => remote.promise)
  const first = f.wrapped.getAlbum("42"),
    second = f.wrapped.getAlbum("42")
  await tick()
  expect(f.calls).toBe(1)
  f.retire()
  remote.resolve({ id: "42", title: "Wrong account" })
  expect(await first.catch(() => "retired")).toBe("retired")
  expect(await second.catch(() => "retired")).toBe("retired")
  expect(f.saved.size).toBe(0)
  expect(f.updates).toEqual([])
})
test("offline mode reads local-only, blocks writes, and delegates complete local playback", async () => {
  const f = fixture(async () => {
    throw new Error("should not fetch")
  })
  f.saved.set(offlineKey("getAlbum", ["42"]), {
    payload: { id: "42", title: "Saved" },
    cachedAt: 1,
  })
  f.offline()
  expect(f.wrapped.isOffline).toBe(true)
  expect(f.wrapped.capabilities.playlistEdit).toBe(false)
  expect((await f.wrapped.getAlbum("42")).title).toBe("Saved")
  expect(f.calls).toBe(0)
  expect(
    await f.wrapped.rate("42", 5).catch((error) => String(error))
  ).toContain("Reconnect")
  expect((await f.wrapped.getPlaybackInfo({ id: "42" } as never)).url).toBe(
    "hibiki-local:42"
  )
  expect(f.wrapped.createPlayQueue).toBeUndefined()
  expect(() => freshPlaylistReads(f.wrapped)).toThrow("Reconnect")
})
test("fresh sync reads bypass the immediate local-first snapshot", async () => {
  const f = fixture(async () => ({ items: [{ id: "new" }], total: 1 }))
  const args = ["7", 0, 100]
  f.saved.set(offlineKey("getPlaylistItems", args), {
    payload: { items: [{ id: "old" }], total: 1 },
    cachedAt: 1,
  })
  const result = await freshPlaylistReads(f.wrapped).getPlaylistItems(
    "7",
    0,
    100
  )
  expect(result.items[0].id).toBe("new")
  expect(f.updates).toEqual([])
})
test("a mutation retires pending refresh publication and forces a fresh post-write read", async () => {
  const remote = deferred<unknown>()
  let first = true
  const f = fixture(() =>
    first
      ? remote.promise
      : Promise.resolve({ id: "42", title: "After mutation" })
  )
  f.saved.set(offlineKey("getAlbum", ["42"]), {
    payload: { id: "42", title: "Before" },
    cachedAt: 1,
  })
  await f.wrapped.getAlbum("42")
  await f.wrapped.rate("42", 4)
  first = false
  expect((await f.wrapped.getAlbum("42")).title).toBe("After mutation")
  remote.resolve({ id: "42", title: "Stale" })
  await tick()
  expect((await f.wrapped.getAlbum("42")).title).toBe("After mutation")
  expect(f.updates).toEqual([])
})
