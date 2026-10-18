import { expect, test } from "bun:test"
import { createCollectionCacheProvider } from "../src/offline/collectionCache"
import {
  createOfflineProvider,
  freshPlaylistReads,
} from "../src/offline/providerCache"
import type { MusicProvider } from "../src/providers/types"
import { orderMixTracks } from "../src/lib/mixOrder"
import { deferred } from "./helpers/radioAudioFakes"
import type { MusicTrack } from "../src/types/music"
import { setBackgroundDispatcher } from "../src/background/actions"
const cached = { id: "1", title: "Cached song", type: "track" }

test("fresh persisted collections never submit a background hydration job", async () => {
  const admitted: string[] = [], checked: string[] = []
  const playlists = [{ id: "1", trackCount: 1, duration: 1000 }]
  const rosterStamp = Buffer.from(await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(JSON.stringify(playlists)))).toString("hex")
  const raw = { cacheScope: "owner", playbackSession: {}, isConnected: () => true,
    getPlaylists: async () => playlists,
    getPlaylistItems: async () => { throw Error("Fresh membership must not fetch") },
  } as unknown as MusicProvider
  setBackgroundDispatcher(async call => { admitted.push(call.method); return { done: true, changed: false } })
  const provider = createCollectionCacheProvider(raw, raw, { cacheScope: "owner", connectionRevision: 1 },
    async <T>(_command: string, { request }: any): Promise<T> => {
      if (request.op === "info") {
        checked.push(request.key)
        return { complete: true, dirty: false, refreshing: false, cachedAt: Date.now(),
          stamp: request.key === "playlist:1" ? JSON.stringify([1, 1000, undefined]) : rosterStamp } as T
      }
      return null as T
    })
  try {
    provider.warmCollections!()
    for (let i = 0; i < 50 && !checked.includes("playlist:1"); i++) await Bun.sleep(10)
    expect(checked).toContain("playlist:1")
    expect(admitted).toEqual([])
  } finally { provider.stopCollectionWarmup!(); setBackgroundDispatcher(undefined) }
})

test("warmup retains smart playlists in the roster without fetching their contents", async () => {
  const loaded: [string, number, number][] = [], complete = new Set<string>()
  const roster: any[] = [], ready = deferred<void>()
  const playlists = [
    { id: "all", title: "All Music", smart: true, trackCount: 381397, duration: null },
    { id: "normal", title: "Favorites", smart: false, trackCount: 1, duration: null },
  ]
  const raw = {
    cacheScope: "owner", playbackSession: {}, isConnected: () => true,
    getPlaylists: async () => playlists,
    getPlaylistItems: async (id: string, offset: number, limit: number) => {
      loaded.push([id, offset, limit])
      return { items: [cached], total: id === "all" ? 381397 : 1, offset }
    },
  } as unknown as MusicProvider
  const provider = createCollectionCacheProvider(raw, raw, { connectionRevision: 1, cacheScope: "owner" },
    async <T>(_command: string, { request }: any): Promise<T> => {
      if (request.op === "begin") return { generation: 1, offset: 0 } as T
      if (request.op === "put" && request.key === "playlists") roster.push(...request.items)
      if (request.op === "commit") {
        complete.add(request.key)
        if (request.key === "playlist:normal") ready.resolve()
        return { changed: false } as T
      }
      return null as T
    })
  try {
    provider.warmCollections!()
    await ready.promise
    expect(loaded).toEqual([["normal", 0, 500]])
    expect(roster.map(item => [item.id, item.smart])).toEqual([["all", true], ["normal", false]])
    expect(complete.has("playlist:all")).toBe(false)
    const viewed = await provider.getPlaylistItems("all", 20, 40)
    expect(viewed.total).toBe(381397)
    expect(loaded).toEqual([["normal", 0, 500], ["all", 20, 40]])
  } finally { provider.stopCollectionWarmup!() }
})

test("a playlist that becomes smart stops warming after its current page", async () => {
  let smart = false, rosters = 0
  const started = deferred<void>(), gate = deferred<void>(), updated = deferred<void>()
  const pages: number[] = []
  const raw = {
    cacheScope: "owner", playbackSession: {}, isConnected: () => true,
    getPlaylists: async () => { rosters++; return [{ id: "all", smart, trackCount: 5000, duration: null }] },
    getPlaylistItems: async (_id: string, offset: number) => {
      pages.push(offset)
      started.resolve()
      await gate.promise
      return { items: Array.from({ length: 500 }, () => cached), total: 5000, offset }
    },
  } as unknown as MusicProvider
  const provider = createCollectionCacheProvider(raw, raw, { connectionRevision: 1, cacheScope: "owner" },
    async <T>(_command: string, { request }: any): Promise<T> => {
      if (request.op === "begin") return { generation: 1, offset: 0 } as T
      if (request.op === "commit") return { changed: false } as T
      if (request.op === "maintain" && rosters >= 2) updated.resolve()
      return null as T
    })
  try {
    provider.warmCollections!()
    await started.promise
    smart = true
    provider.warmCollections!()
    await updated.promise
    gate.resolve()
    await Bun.sleep(250)
    expect(pages).toEqual([0])
  } finally { gate.resolve(); provider.stopCollectionWarmup!() }
})

test("clearing library caches retires a collection page still arriving from Plex", async () => {
  const started = deferred<void>(), gate = deferred<void>()
  const writes: string[] = []
  const raw = {
    cacheScope: "owner", playbackSession: {}, isConnected: () => true,
    getPlaylists: async () => [],
    getRatedItemsPage: async () => { started.resolve(); await gate.promise; return { items: [cached], total: 1, offset: 0 } },
  } as unknown as MusicProvider
  const provider = createCollectionCacheProvider(raw, raw, { connectionRevision: 1, cacheScope: "owner" }, async <T>(command: string, args: any): Promise<T> => {
    writes.push(command === "collection_cache" ? args.request.op : command)
    return (args.request?.op === "begin" ? { generation: 1, offset: 0 } : null) as T
  })
  provider.warmCollections!()
  await started.promise
  await provider.clearLibraryCache!()
  const clearedAt = writes.length
  gate.resolve()
  await Bun.sleep(250)
  provider.stopCollectionWarmup!()
  expect(writes).toContain("offline_cache_clear")
  expect(writes.slice(clearedAt)).not.toContain("put")
  expect(writes.slice(clearedAt)).not.toContain("commit")
})

test("mix pages upgrade a linear snapshot once and share its stable full membership with playback", async () => {
  const rows = Array.from(
    { length: 1200 },
    (_, index) =>
      ({
        id: String(index),
        title: `Song ${index}`,
        type: "track",
        artistName: `Artist ${Math.floor(index / 400)}`,
      }) as MusicTrack
  )
  let saved = rows,
    staged: MusicTrack[] = []
  const legacyKey =
    "mix:" +
    Buffer.from(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode("/mix/path")
      )
    ).toString("hex")
  const legacyInfo = {
    complete: true,
    dirty: false,
    refreshing: false,
    stamp: "legacy",
    cachedAt: Date.now(),
  }
  let info: typeof legacyInfo | null = null
  const gate = deferred<void>(),
    started = deferred<void>()
  const pages: number[] = [],
    commands: any[] = []
  const raw = {
    cacheScope: "owner",
    playbackSession: {},
    isConnected: () => true,
    getMixTracksPage: async (_path: string, offset: number, limit: number) => {
      pages.push(offset)
      if (!offset) {
        started.resolve()
        await gate.promise
      }
      return {
        items: rows.slice(offset, offset + limit),
        total: rows.length,
        offset,
      }
    },
  } as unknown as MusicProvider
  const transport = async <T>(_command: string, args: any): Promise<T> => {
    const request = args.request
    commands.push(request)
    switch (request.op) {
      case "info":
        return (request.key === legacyKey ? legacyInfo : info) as T
      case "begin":
        info = {
          ...legacyInfo,
          complete: false,
          stamp: request.stamp,
          refreshing: true,
        }
        return { generation: 1, offset: 0 } as T
      case "put":
        staged.push(...request.items)
        return null as T
      case "commit":
        saved = orderMixTracks(staged)
        info = { ...info!, complete: true, refreshing: false }
        return { changed: true } as T
      case "page":
        return {
          items: saved.slice(request.offset, request.offset + request.limit),
          total: saved.length,
          offset: request.offset,
        } as T
      case "capture":
        return saved.map((track) => [track.id, null]) as T
      case "items":
        return request.ids.map((id: string) =>
          rows.find((track) => track.id === id)
        ) as T
      default:
        return null as T
    }
  }
  const provider = createCollectionCacheProvider(
    raw,
    raw,
    { connectionRevision: 1, cacheScope: "owner" },
    transport
  )
  try {
    let ready = false
    const first = provider.getMixTracksPage!("/mix/path", 0, 30).then(
      (value) => {
        ready = true
        return value
      }
    )
    await started.promise
    const later = provider.getMixTracksPage!("/mix/path", 600, 30)
    const source = provider.getCachedTrackSource!("mix:/mix/path")
    await Bun.sleep(180)
    expect(ready).toBe(false)
    expect(commands.filter((command) => command.op === "page")).toHaveLength(0)
    gate.resolve()
    const [page, secondPage, snapshot] = await Promise.all([
      first,
      later,
      source,
    ])
    expect(pages).toEqual([0, 500, 1000])
    expect(commands.filter((command) => command.op === "begin")).toHaveLength(1)
    expect(commands.every((command) => command.key !== legacyKey)).toBe(true)
    expect(page.items.map((track) => track.id)).toEqual(
      snapshot!.entries!.slice(0, 30).map((track) => track.id)
    )
    expect(secondPage.items.map((track) => track.id)).toEqual(
      snapshot!.entries!.slice(600, 630).map((track) => track.id)
    )
    const original = snapshot!.entries!.map((track) => track.id)
    expect(
      (await provider.getCachedTrackSource!("mix:/mix/path"))!.entries!.map(
        (track) => track.id
      )
    ).toEqual(original)
    saved = [...saved].reverse()
    expect(
      (await snapshot!.loadPage(600, 30)).items.map((track) => track.id)
    ).toEqual(original.slice(600, 630))
    expect(original).not.toEqual(rows.map((track) => track.id))
    ;(raw as any).playbackSession = {}
    await expect(snapshot!.loadPage(0, 1)).rejects.toThrow("superseded")
  } finally {
    gate.resolve()
    provider.stopCollectionWarmup!()
  }
})
function fixture() {
  const commands: any[] = []
  let upstream = 0
  const raw = {
    cacheScope: "owner",
    playbackSession: {},
    isConnected: () => true,
    disconnect: async () => {},
    getPlaylistItems: async () => {
      upstream++
      return { items: [{ ...cached, title: "Fresh song" }], total: 1 }
    },
    getPlaylists: async () => [],
    addToPlaylist: async () => {},
  } as unknown as MusicProvider
  const inner = createOfflineProvider(raw, {
    get: async () => null,
    put: async () => {},
    invalidate: async () => {},
  })
  const transport = async <T>(_command: string, args: any): Promise<T> => {
    commands.push(args.request)
    const op = args.request.op
    return (
      op === "page"
        ? { items: [cached], total: 1, offset: args.request.offset }
        : op === "capture"
          ? [
              ["1", "occurrence-8"],
              ["1", "occurrence-9"],
            ]
          : op === "items"
            ? args.request.ids.map(() => cached)
            : op === "info"
              ? {
                  complete: true,
                  dirty: false,
                  cachedAt: Date.now(),
                  stamp: "cached",
                  refreshing: false,
                }
              : null
    ) as T
  }
  const provider = createCollectionCacheProvider(
    inner,
    raw,
    { connectionRevision: 1, cacheScope: "owner" },
    transport
  )
  return { provider, commands, upstream: () => upstream }
}
test("cached pages do not bypass live playlist verification", async () => {
  const { provider, upstream } = fixture()
  try {
    expect((await provider.getPlaylistItems("8", 0, 200)).items[0].title).toBe(
      "Cached song"
    )
    expect(upstream()).toBe(0)
    expect(
      (await freshPlaylistReads(provider).getPlaylistItems("8", 0, 200))
        .items[0].title
    ).toBe("Fresh song")
    expect(upstream()).toBe(1)
  } finally {
    provider.stopCollectionWarmup!()
  }
})
test("cached shuffle retains repeated playlist occurrences and reads upcoming metadata only", async () => {
  const { provider, commands } = fixture()
  try {
    const source = await provider.getCachedTrackSource!("playlist:8", true)
    expect(source!.total).toBe(2)
    expect(commands.filter((command) => command.op === "items")).toHaveLength(0)
    const page = await source!.loadPage(0, 1)
    expect(page.items).toHaveLength(1)
    expect(["occurrence-8", "occurrence-9"]).toContain(
      page.items[0].playlistItemId
    )
    expect(commands.find((command) => command.op === "items").ids).toHaveLength(
      1
    )
  } finally {
    provider.stopCollectionWarmup!()
  }
})
test("playlist writes invalidate its membership and inventory before returning", async () => {
  const { provider, commands } = fixture()
  try {
    await provider.addToPlaylist("8", ["1"])
    expect(
      commands
        .filter((command) => command.op === "invalidate")
        .map((command) => command.key)
    ).toEqual(["playlists", "playlist:8"])
  } finally {
    provider.stopCollectionWarmup!()
  }
})

test("launch warmup resumes a partial playlist and skips fresh complete contents on the next pass", async () => {
  const pages: number[] = []
  const metadata = new Map<string, any>([
    [
      "playlist:8",
      {
        complete: false,
        dirty: false,
        cachedAt: 0,
        stamp: "[4500,null,null]",
        refreshing: true,
        generation: 4,
        offset: 500,
        total: 4500,
      },
    ],
  ])
  const raw = {
    cacheScope: "owner",
    playbackSession: {},
    isConnected: () => true,
    getPlaylists: async () => [
      { id: "8", title: "Large", trackCount: 4500, duration: null },
    ],
    getPlaylistItems: async (_id: string, offset: number, limit: number) => {
      pages.push(offset)
      return {
        items: Array.from(
          { length: Math.min(limit, 4500 - offset) },
          (_, i) => ({ ...cached, id: String(offset + i + 1) })
        ),
        total: 4500,
        offset,
      }
    },
  } as unknown as MusicProvider
  const transport = async <T>(_command: string, args: any): Promise<T> => {
    const request = args.request,
      current = metadata.get(request.key)
    switch (request.op) {
      case "info":
        return (current as T) ?? (null as T)
      case "begin": {
        if (current?.offset > 0 && current.stamp === request.stamp)
          return { generation: current.generation, offset: current.offset } as T
        const value = {
          complete: current?.complete ?? false,
          dirty: false,
          refreshing: true,
          stamp: request.stamp,
          generation: (current?.generation ?? 0) + 1,
          offset: 0,
          cachedAt: 0,
        }
        metadata.set(request.key, value)
        return { generation: value.generation, offset: 0 } as T
      }
      case "put":
        current.offset += request.items.length
        current.total = request.total
        return null as T
      case "commit":
        current.complete = true
        current.refreshing = false
        current.cachedAt = Date.now()
        current.offset = 0
        return { changed: false } as T
      default:
        return null as T
    }
  }
  const provider = createCollectionCacheProvider(
    raw,
    raw,
    { connectionRevision: 1, cacheScope: "owner" },
    transport
  )
  try {
    provider.warmCollections!()
    for (let i = 0; i < 100 && !metadata.get("playlist:8")?.complete; i++)
      await Bun.sleep(20)
    expect(metadata.get("playlist:8").complete).toBe(true)
    expect(pages).toEqual([500, 1000, 1500, 2000, 2500, 3000, 3500, 4000])
    provider.warmCollections!()
    await Bun.sleep(450)
    expect(pages).toEqual([500, 1000, 1500, 2000, 2500, 3000, 3500, 4000])
  } finally {
    provider.stopCollectionWarmup!()
  }
})

test("rating a song does not inspect unrelated playlist caches", async () => {
  let playlistRosterReads = 0
  const infos: string[] = [],
    upstreamPages: string[] = [],
    dirty = new Set<string>()
  const playlists = Array.from({ length: 50 }, (_, i) => ({
    id: String(i + 1),
    trackCount: 10,
    duration: 10000,
  }))
  const raw: any = {
    cacheScope: "owner",
    playbackSession: {},
    isConnected: () => true,
    rate: async () => {},
    getPlaylists: async () => {
      playlistRosterReads++
      return playlists
    },
    getRatedItemsPage: async (kind: string) => {
      upstreamPages.push(kind)
      return { items: [], total: 0, offset: 0 }
    },
  }
  const transport = async <T>(
    _command: string,
    { request: r }: any
  ): Promise<T> => {
    if (r.op === "invalidate") dirty.add(r.key)
    if (r.op === "info") {
      infos.push(r.key)
      return {
        complete: true,
        dirty: dirty.has(r.key),
        refreshing: false,
        cachedAt: Date.now(),
        stamp: r.key.startsWith("playlist:")
          ? JSON.stringify([10, 10000, undefined])
          : r.key,
      } as T
    }
    if (r.op === "begin") return { generation: 1, offset: 0 } as T
    if (r.op === "commit") {
      dirty.delete(r.key)
      return { changed: false } as T
    }
    return null as T
  }
  const provider = createCollectionCacheProvider(
    raw,
    raw,
    { cacheScope: "owner", connectionRevision: 1 },
    transport
  )
  await provider.rate("1", 8)
  for (let i = 0; i < 30 && upstreamPages.length < 3; i++) await Bun.sleep(50)
  provider.stopCollectionWarmup!()
  const playlistChecks = infos.filter((k) => k.startsWith("playlist:")).length
  expect(playlistRosterReads).toBe(0)
  expect(playlistChecks).toBe(0)
  expect(upstreamPages).toEqual(["track", "album", "artist"])
})

test("foreground preparation stays ahead of background playlists across chunk yields", async () => {
  const log: string[] = [],
    state = new Map<string, any>()
  const playlists = [
    ...Array.from({ length: 8 }, (_, i) => ({
      id: String(i + 1),
      trackCount: 1,
      duration: 1,
    })),
    { id: "99", trackCount: 2500, duration: 2500 },
  ]
  const raw: any = {
    cacheScope: "owner",
    playbackSession: {},
    isConnected: () => true,
    getPlaylists: async () => playlists,
    getPlaylistItems: async (id: string, offset: number, limit: number) => {
      log.push(`${id}:${offset}`)
      const total = id === "99" ? 2500 : 1
      return {
        offset,
        total,
        items: Array.from(
          { length: Math.min(limit, total - offset) },
          (_, i) => ({
            id: String(offset + i + 1),
            type: "track",
            title: "Song",
          })
        ),
      }
    },
  }
  const transport = async <T>(
    _command: string,
    { request: r }: any
  ): Promise<T> => {
    let s = state.get(r.key)
    if (r.op === "info") return (s?.complete ? s : null) as T
    if (r.op === "query")
      return (
        s?.complete ? { items: [], total: s.total, offset: r.offset } : null
      ) as T
    if (r.op === "begin") {
      if (!s) {
        s = { offset: 0 }
        state.set(r.key, s)
      }
      return { generation: 1, offset: s.offset } as T
    }
    if (r.op === "put") {
      s.offset = r.offset + r.items.length
      s.total = r.total
    }
    if (r.op === "commit") {
      s.complete = true
      s.dirty = false
      return { changed: false } as T
    }
    return null as T
  }
  const provider = createCollectionCacheProvider(
    raw,
    raw,
    { cacheScope: "owner", connectionRevision: 1 },
    transport
  )
  provider.warmCollections!()
  const page = provider.getCollectionPage!(
    "playlist:99",
    0,
    20,
    "",
    "title",
    "asc"
  )
  await page
  provider.stopCollectionWarmup!()
  const first = log.indexOf("99:0"),
    last = log.indexOf("99:2000")
  const unrelated = log
    .slice(first, last)
    .filter((row) => !row.startsWith("99:"))
  expect(unrelated).toEqual([])
})
