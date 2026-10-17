import { expect, test } from "bun:test"
import { createCollectionCacheProvider } from "../src/offline/collectionCache"
import { collectionPlaybackSource, selectCollectionTrack } from "../src/lib/collectionPlayback"
import { QueueSession } from "../src/lib/queueSession"
import type { MusicProvider } from "../src/providers/types"
import type { MusicTrack } from "../src/types/music"

test("filtered queues capture all identities and occurrences before later metadata hydration", async () => {
  let rows = Array.from({ length: 650 }, (_, index) => ({
    id: String(Math.floor(index / 2) + 1), playlistItemId: String(index),
    title: `Song ${Math.floor(index / 2)}`, type: "track",
  })) as MusicTrack[]
  const details = new Map(rows.map(track => [track.id, track]))
  const requests: any[] = []
  const raw = { cacheScope: "scope", playbackSession: {}, isConnected: () => true } as MusicProvider
  const provider = createCollectionCacheProvider(raw, raw, { cacheScope: "scope", connectionRevision: 1 }, async (_command, args: any) => {
    const request = args.request
    requests.push(request)
    return (request.op === "info" ? { complete: true, dirty: false }
      : request.op === "queryRefs" ? rows.map(track => [track.id, track.playlistItemId])
      : request.op === "items" ? request.ids.map(id => details.get(id)) : null) as any
  })
  try {
    const query = { key: "playlist:8", filter: "song", sort: "title", dir: "desc" as const }
    const source = collectionPlaybackSource(provider, query, 650)
    const frozen = await selectCollectionTrack(source, rows[600], 600).prepare!()
    expect(frozen!.restoreQuery).toEqual(query)
    expect(requests.find(request => request.op === "queryRefs")).toEqual({ op: "queryRefs", ...query })
    expect(requests.filter(request => request.op === "items")).toHaveLength(0)
    const queue = new QueueSession(frozen!)
    const expected = rows.map(track => [track.id, track.playlistItemId])
    rows = rows.toReversed()
    await queue.ensure(queue.entries, 600, 603)
    const hydrated = queue.project(queue.entries, 600)
    expect(hydrated.slice(600, 603).map(track => [track.id, track.playlistItemId])).toEqual(expected.slice(600, 603))
    expect(queue.snapshot(hydrated).map(track => [track.id, track.playlistItemId])).toEqual(expected)
    expect(requests.filter(request => request.op === "queryRefs")).toHaveLength(1)
    await expect(selectCollectionTrack(source, hydrated[600], 600).prepare!()).rejects.toThrow("collection changed")
  } finally { provider.stopCollectionWarmup!() }
})

test("an unavailable snapshot cannot silently fall back to a mutable query", async () => {
  const provider = { getCachedTrackSource: async () => null } as unknown as MusicProvider
  const source = collectionPlaybackSource(provider, { key: "playlist:1", filter: "", sort: "title", dir: "asc" }, 300)
  await expect(source.prepare!()).rejects.toThrow("collection changed")
})
