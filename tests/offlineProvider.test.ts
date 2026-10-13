import { expect, test } from "bun:test"
import {
  createOfflineProvider,
  offlineKey,
  sanitizeOfflineData,
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
function setup(read: (...args: unknown[]) => Promise<unknown>) {
  const saved = new Map<string, OfflineSnapshot>()
  const notices: unknown[] = []
  let writes = 0
  const provider = {
    cacheScope: "plex-" + "a".repeat(64),
    playbackSession: {},
    name: "Plex",
    getPlaylistItems: read,
    getAlbum: read,
    rate: async () => {},
    isConnected() {
      return this.name === "Plex"
    },
  } as unknown as MusicProvider
  const wrapped = createOfflineProvider(
    provider,
    {
      get: async (key) => saved.get(key) ?? null,
      put: async (key, payload) => {
        writes++
        saved.set(key, { payload, cachedAt: 123 })
      },
    },
    { onOfflineRead: (notice) => notices.push(notice) }
  )
  return {
    provider,
    wrapped,
    saved,
    notices,
    get writes() {
      return writes
    },
  }
}
test("cached exact pages preserve duplicate occurrences, totals, aliases and strip playback payloads", async () => {
  let online = true
  const page = {
    items: [
      {
        id: "1",
        playlistItemId: "a",
        streamUrl: "secret",
        _providerData: { token: "secret" },
      },
      { id: "1", playlistItemId: "b" },
    ],
    total: 8,
    offset: 0,
    _alternateIds: ["2", "3"],
  }
  const state = setup(async () => {
    if (!online) throw new Error("Network unavailable")
    return page
  })
  expect(await state.wrapped.getPlaylistItems("1", 0, 2)).toBe(page)
  online = false
  const cached = await state.wrapped.getPlaylistItems("1", 0, 2)
  expect(cached).toEqual({
    ...page,
    items: [
      { id: "1", playlistItemId: "a", streamUrl: null },
      { id: "1", playlistItemId: "b" },
    ],
  })
  expect(state.notices).toHaveLength(1)
  await expect(state.wrapped.getPlaylistItems("1", 2, 2)).rejects.toThrow(
    "Network unavailable"
  )
  expect(state.wrapped.isConnected()).toBe(true)
})
test("account/session replacement retires pending fallback and cache writes", async () => {
  const pending = deferred<unknown>()
  const state = setup(() => pending.promise)
  const work = state.wrapped.getAlbum("1")
  ;(state.provider as any).cacheScope = "plex-" + "b".repeat(64)
  pending.resolve({ id: "1", title: "old account" })
  await expect(work).rejects.toThrow("superseded")
  expect(state.writes).toBe(0)
  const next = setup(async () => {
    throw new Error("offline")
  })
  const disk = deferred<OfflineSnapshot | null>()
  const wrapped = createOfflineProvider(next.provider, {
    get: () => disk.promise,
    put: async () => {},
  })
  const fallback = wrapped.getAlbum("1")
  await Promise.resolve()
  ;(next.provider as any).playbackSession = {}
  disk.resolve({ payload: { id: "1" }, cachedAt: 1 })
  await expect(fallback).rejects.toThrow("superseded")
})
test("latest same-key read owns durable cache even if older network result arrives later", async () => {
  const first = deferred<unknown>()
  let calls = 0
  const state = setup(() =>
    ++calls === 1 ? first.promise : Promise.resolve({ id: "1", title: "new" })
  )
  const old = state.wrapped.getAlbum("1")
  await state.wrapped.getAlbum("1")
  first.resolve({ id: "1", title: "old" })
  await old
  expect(state.saved.get(offlineKey("getAlbum", ["1"]))?.payload).toEqual({
    id: "1",
    title: "new",
  })
})
test("permission, not-found and mutation failures never masquerade as offline success", async () => {
  const state = setup(async () => {
    throw new Error("403 forbidden")
  })
  state.saved.set(offlineKey("getAlbum", ["1"]), {
    payload: { id: "1" },
    cachedAt: 1,
  })
  await expect(state.wrapped.getAlbum("1")).rejects.toThrow("403")
  expect(state.notices).toHaveLength(0)
  let rated = 0
  state.provider.rate = async () => {
    rated++
    throw new Error("offline")
  }
  await expect(state.wrapped.rate("1", 10)).rejects.toThrow("offline")
  expect(rated).toBe(1)
  expect(state.writes).toBe(0)
})
test("storage failure leaves online results usable and exact key encoding distinguishes omitted arguments", async () => {
  const state = setup(async () => ({ id: "1" }))
  const wrapped = createOfflineProvider(state.provider, {
    get: async () => {
      throw new Error("blocked")
    },
    put: async () => {
      throw new Error("blocked")
    },
  })
  expect(await wrapped.getAlbum("1")).toEqual({ id: "1" })
  expect(offlineKey("getPlaylistItems", ["1", undefined, 50])).not.toBe(
    offlineKey("getPlaylistItems", ["1", null, 50])
  )
  expect(offlineKey("getPlaylistItems", ["1", 0, 50])).not.toBe(
    offlineKey("getPlaylistItems", ["1", 0, 100])
  )
  expect(
    sanitizeOfflineData({
      id: "1",
      _alternateIds: ["2"],
      _providerData: { token: "secret" },
      streamUrl: "secret",
    })
  ).toEqual({ id: "1", _alternateIds: ["2"], streamUrl: null })
})

test("accepted playlist mutations evict only their pages and collection dependencies", async () => {
  const saved = new Map<string, OfflineSnapshot>()
  for (const [method, args] of [
    ["getPlaylistItems", ["1", 0, 2]],
    ["getPlaylistItems", ["10", 0, 2]],
    ["getAlbum", ["album"]],
    ["getPlaylists", []],
  ] as [string, unknown[]][])
    saved.set(offlineKey(method, args), { payload: [], cachedAt: 1 })
  const provider = {
    cacheScope: "plex-" + "a".repeat(64),
    playbackSession: {},
    addToPlaylist: async () => {},
  } as unknown as MusicProvider
  const wrapped = createOfflineProvider(provider, {
    get: async (key) => saved.get(key) ?? null,
    put: async () => {},
    invalidate: async (prefixes) => {
      for (const key of saved.keys())
        if (prefixes.some((prefix) => key.startsWith(prefix))) saved.delete(key)
    },
  })
  await wrapped.addToPlaylist("1", ["track"])
  expect(saved.has(offlineKey("getPlaylistItems", ["1", 0, 2]))).toBe(false)
  expect(saved.has(offlineKey("getPlaylists", []))).toBe(false)
  expect(saved.has(offlineKey("getPlaylistItems", ["10", 0, 2]))).toBe(true)
  expect(saved.has(offlineKey("getAlbum", ["album"]))).toBe(true)
})
test("failed or old-account mutation cannot invalidate the active cache", async () => {
  const pending = deferred<void>()
  let invalidations = 0
  const provider = {
    cacheScope: "plex-" + "a".repeat(64),
    playbackSession: {},
    rate: () => pending.promise,
  } as unknown as MusicProvider
  const wrapped = createOfflineProvider(provider, {
    get: async () => null,
    put: async () => {},
    invalidate: async () => {
      invalidations++
    },
  })
  const rating = wrapped.rate("1", 10)
  ;(provider as any).cacheScope = "plex-" + "b".repeat(64)
  pending.resolve()
  await rating
  expect(invalidations).toBe(0)
  const failure = createOfflineProvider(
    {
      ...provider,
      rate: async () => {
        throw new Error("failed")
      },
    } as MusicProvider,
    {
      get: async () => null,
      put: async () => {},
      invalidate: async () => {
        invalidations++
      },
    }
  )
  await expect(failure.rate("1", 10)).rejects.toThrow("failed")
  expect(invalidations).toBe(0)
})

test("explicit unconfirmed metadata/artwork writes invalidate owned dependencies and rethrow original failure", async () => {
  for (const [method, failure] of [
    [
      "editAdvancedMetadata",
      new Error(
        "Plex did not confirm the save. Check server permissions and reload the item before retrying."
      ),
    ],
    [
      "saveArtwork",
      new Error(
        "Plex may have accepted the artwork change. Reload it before retrying."
      ),
    ],
    ["editMetadata", { code: "unknown_outcome" }],
  ] as const) {
    const saved = new Map<string, OfflineSnapshot>()
    for (const [name, args] of [
      ["getAlbum", ["1"]],
      ["getAlbum", ["10"]],
      ["getArtistAlbums", ["artist"]],
      ["getHubs", []],
    ] as [string, unknown[]][])
      saved.set(offlineKey(name, args), { payload: { id: "old" }, cachedAt: 1 })
    const provider = {
      cacheScope: "plex-" + "a".repeat(64),
      playbackSession: {},
      [method]: async () => {
        throw failure
      },
    } as unknown as MusicProvider
    let invalidations = 0
    const wrapped = createOfflineProvider(provider, {
      get: async (key) => saved.get(key) ?? null,
      put: async () => {},
      invalidate: async (prefixes) => {
        invalidations++
        for (const key of saved.keys())
          if (prefixes.some((prefix) => key.startsWith(prefix)))
            saved.delete(key)
      },
    })
    try {
      await (wrapped as any)[method]("album", "1", {})
      throw new Error("must reject")
    } catch (error) {
      expect(error).toBe(failure)
    }
    expect(invalidations).toBe(1)
    expect(saved.has(offlineKey("getAlbum", ["1"]))).toBe(false)
    expect(saved.has(offlineKey("getArtistAlbums", ["artist"]))).toBe(false)
    expect(saved.has(offlineKey("getHubs", []))).toBe(false)
    expect(saved.has(offlineKey("getAlbum", ["10"]))).toBe(true)
  }
})
test("denied preflight writes preserve cache while unknown writes retire pending snapshot publication", async () => {
  for (const unknown of [false, true]) {
    const old = deferred<unknown>()
    let invalidations = 0
    let puts = 0
    const failure = new Error(
      unknown
        ? "Plex did not confirm the save"
        : "403 forbidden: preflight permission denied"
    )
    const provider = {
      cacheScope: "plex-" + "a".repeat(64),
      playbackSession: {},
      getAlbum: () => old.promise,
      editAdvancedMetadata: async () => {
        throw failure
      },
    } as unknown as MusicProvider
    const wrapped = createOfflineProvider(provider, {
      get: async () => null,
      put: async () => {
        puts++
      },
      invalidate: async () => {
        invalidations++
      },
    })
    const read = wrapped.getAlbum("1")
    await expect(
      wrapped.editAdvancedMetadata!("album", "1", {})
    ).rejects.toThrow(failure.message)
    old.resolve({ id: "1", title: "pre-write" })
    await read
    expect(invalidations).toBe(unknown ? 1 : 0)
    expect(puts).toBe(unknown ? 0 : 1)
  }
})
test("retired unknown completion never invalidates new account and failed invalidation disables stale fallback", async () => {
  const pending = deferred<void>()
  let invalidations = 0
  const provider = {
    cacheScope: "plex-" + "a".repeat(64),
    playbackSession: {},
    saveArtwork: () => pending.promise,
  } as unknown as MusicProvider
  const wrapped = createOfflineProvider(provider, {
    get: async () => null,
    put: async () => {},
    invalidate: async () => {
      invalidations++
    },
  })
  const work = wrapped.saveArtwork!("album", "1", "poster", "baseline", {
    choice: "x",
  })
  ;(provider as any).cacheScope = "plex-" + "b".repeat(64)
  pending.reject(new Error("Plex did not confirm the artwork change"))
  await expect(work).rejects.toThrow("did not confirm")
  expect(invalidations).toBe(0)
  const unavailable = new Error("network unavailable")
  const current = {
    cacheScope: "plex-" + "a".repeat(64),
    playbackSession: {},
    editAdvancedMetadata: async () => {
      throw new Error("Plex did not confirm the save")
    },
    getAlbum: async () => {
      throw unavailable
    },
  } as unknown as MusicProvider
  let gets = 0
  const failed = createOfflineProvider(current, {
    get: async () => {
      gets++
      return { payload: { id: "stale" }, cachedAt: 1 }
    },
    put: async () => {},
    invalidate: async () => {
      throw new Error("disk blocked")
    },
  })
  await expect(failed.editAdvancedMetadata!("album", "1", {})).rejects.toThrow(
    "did not confirm"
  )
  await expect(failed.getAlbum("1")).rejects.toThrow("network unavailable")
  expect(gets).toBe(0)
})
test("unknown write waits for an in-flight cache write before invalidating and prevents stale fallback racing deletion", async () => {
  const disk = deferred<void>()
  const order: string[] = []
  let networkOnline = true
  const provider = {
    cacheScope: "plex-" + "a".repeat(64),
    playbackSession: {},
    getAlbum: async () => {
      if (!networkOnline) throw new Error("network unavailable")
      return { id: "1", title: "old" }
    },
    editAdvancedMetadata: async () => {
      throw new Error("Plex may have saved the change")
    },
  } as unknown as MusicProvider
  const wrapped = createOfflineProvider(provider, {
    get: async () => {
      order.push("read")
      return null
    },
    put: async () => {
      order.push("put begin")
      await disk.promise
      order.push("put end")
    },
    invalidate: async () => {
      order.push("invalidate")
    },
  })
  const read = wrapped.getAlbum("1")
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  const mutation = wrapped.editAdvancedMetadata!("album", "1", {}).catch(
    (error) => error
  )
  await Promise.resolve()
  await Promise.resolve()
  networkOnline = false
  const fallback = wrapped.getAlbum("1").catch((error) => error)
  await Promise.resolve()
  expect(order).toEqual(["put begin"])
  disk.resolve()
  await read
  await mutation
  await fallback
  expect(order).toEqual(["put begin", "put end", "invalidate", "read"])
})
