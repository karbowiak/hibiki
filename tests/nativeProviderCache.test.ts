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
    owns: () => owns,
    isOffline: () => offline,
    offlineProvider: local,
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
test("online reads delegate freshness to the native provider and ignore old frontend projections", async () => {
  const f = fixture(async () => ({ id:"42", title:"Native cache" }))
  f.saved.set(offlineKey("getAlbum",["42"]), { payload:{id:"42",title:"Old frontend snapshot"},cachedAt:1 })
  expect((await f.wrapped.getAlbum("42")).title).toBe("Native cache")
  expect(f.calls).toBe(1)
})
test("retired native completions cannot publish an offline projection", async () => {
  const pending=deferred<unknown>(), f=fixture(() => pending.promise)
  const request=f.wrapped.getAlbum("42").catch(error=>String(error))
  f.retire();pending.resolve({id:"42",title:"Wrong owner"})
  expect(await request).toContain("superseded")
  expect(f.saved.size).toBe(0)
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
