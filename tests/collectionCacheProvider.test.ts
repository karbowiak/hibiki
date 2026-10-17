import { expect, test } from "bun:test"
import { createCollectionCacheProvider } from "../src/offline/collectionCache"
import {
  createOfflineProvider,
  freshPlaylistReads,
} from "../src/offline/providerCache"
import type { MusicProvider } from "../src/providers/types"
const cached = { id: "1", title: "Cached song", type: "track" }
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
