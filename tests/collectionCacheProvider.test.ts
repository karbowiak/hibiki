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
const cached = { id: "1", title: "Cached song", type: "track" }

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
      case "refs":
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
        : op === "refs"
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
