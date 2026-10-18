import { expect, test } from "bun:test"
import { prepareMerge, mergedDraft, readMergeSource, revalidateMerge, type MergeSource, type MergeDestination } from "../src/mixedPlaylists/merge"
import { defaultPlaylistSync } from "../src/mixedPlaylists/drafts"
import { newOccurrence, playlistServices, type MixedPlaylist, type RemotePlaylist, type Service } from "../src/mixedPlaylists/model"
import { youtubeMusicTrack } from "../src/backends/ytmusic/tracks"
import { syncMixedPlaylist } from "../src/mixedPlaylists/sync"
import { operationIds, projection } from "../src/mixedPlaylists/reconcile"
import type { MixedAdapter } from "../src/mixedPlaylists/adapters"
const owners = { plex: "plex-owner", ytmusic: "ytmusic-owner" }
const song = (id: string, title = "Song") => ({ ...youtubeMusicTrack({ videoId: "a1234567890", title, artist: "Artist", album: "Release", duration: "3:00", thumbnail: null }), id })
const source = (key: string, ids: string[]): MergeSource => ({ key, title: key, fingerprint: JSON.stringify(ids), owners, items: ids.map(id => newOccurrence(song(id), 10)) })
const metadata = { title: "Merged", description: "New playlist", artwork: null, external: defaultPlaylistSync() }
const options = { owners, current: () => true, resolve: async () => ({ status: "missing" as const, checkedAt: 1, message: "Unavailable" }) }

test("a throttled merge stops new lookups and retains all songs for later matching", async () => {
  const sources: [MergeSource, MergeSource] = [source("one", Array.from({ length: 150 }, (_, i) => String(i + 1))), source("two", ["200"])]
  let calls = 0
  const preview = await prepareMerge(sources, "mixed", "preserve", { ...options, resolve: async () => {
    calls++; return { status: "failed", checkedAt: Date.now(), message: "YouTube Music is rate limited. Hibiki will retry after the cooldown." }
  } })
  expect(calls).toBeLessThanOrEqual(2)
  expect(preview.items).toHaveLength(151)
  expect(preview.items.every(row => row.match.status === "pending" && row.songs.plex)).toBe(true)
})
test("YTM throttling does not defer independent Plex lookups", async () => {
  let plex = 0
  const preview = await prepareMerge([source("one", ["1"]), source("two", ["ytmusic:b1234567890"])], "mixed", "preserve", {
    ...options, resolve: async (_track, target) => target === "ytmusic"
      ? { status: "failed", checkedAt: Date.now(), message: "YouTube Music is rate limited. Hibiki will retry after the cooldown." }
      : (plex++, { status: "matched", checkedAt: Date.now(), track: song("200"), fingerprint: "proof" }),
  })
  expect(plex).toBe(1)
  expect(preview.items[0].match.status).toBe("pending")
  expect(preview.items[1].songs.plex?.track.id).toBe("200")
})

test("merge retains ordered occurrences, source dates and provenance with fresh sync identities", async () => {
  const sources: [MergeSource, MergeSource] = [source("one", ["1", "1"]), source("two", ["ytmusic:b1234567890"])]
  sources[0].items[0].remote.plex = { occurrenceId: "source-handle" }
  sources[0].items[0].added = { at: 5, provenance: "provider" }
  const original = structuredClone(sources)
  const preview = await prepareMerge(sources, "mixed", "preserve", options)
  const playlist = mergedDraft(preview, metadata, owners, "mixed:new")
  expect(sources).toEqual(original)
  expect(playlist.items.map(row => row.songs[row.original]?.track.id)).toEqual(["1", "1", "ytmusic:b1234567890"])
  expect(playlist.items[0].added).toEqual({ at: 5, provenance: "provider" })
  expect(playlist.createdAt).toBeGreaterThan(10)
  expect(playlist.items[0].copiedFrom).toEqual({ playlist: "one", occurrence: original[0].items[0].id })
  expect(playlist.items.every(row => Object.keys(row.remote).length === 0)).toBe(true)
  expect(playlist.aliases).toEqual([]); expect(playlist.providers).toEqual({}); expect(playlist.baseline).toEqual({})
  expect(playlist.items[0].id).not.toBe(sources[0].items[0].id)
})
test("verified duplicate removal needs common recording IDs and retains version and ambiguous matches", async () => {
  const sources: [MergeSource, MergeSource] = [source("one", ["1", "1"]), source("two", ["ytmusic:b1234567890", "ytmusic:c1234567890", "ytmusic:d1234567890"])]
  sources[1].items[1].songs.ytmusic!.track.title = "Song (Live)"
  const preview = await prepareMerge(sources, "plex", "verified", { ...options, resolve: async track => track.id === "ytmusic:b1234567890"
    ? { status: "matched", track: song("1"), fingerprint: "proof", checkedAt: 1 }
    : { status: "ambiguous", checkedAt: 1, message: "More than one recording" } })
  expect(preview.removed).toBe(2)
  expect(preview.items.map(row => row.songs[row.original]!.track.id)).toEqual(["1", "ytmusic:c1234567890", "ytmusic:d1234567890"])
  expect(projection(mergedDraft(preview, metadata, owners, "new"), "plex")).toHaveLength(1)
})
for (const destination of ["plex", "ytmusic", "mixed"] as MergeDestination[]) test(`${destination} writes only its destinations, retaining unavailable occurrences and recovering receipts`, async () => {
  const preview = await prepareMerge([source("one", ["1"]), source("two", ["ytmusic:b1234567890"])], destination, "preserve", options)
  let saved = mergedDraft(preview, metadata, owners, `mixed:${destination}`), creates: Service[] = []
  const snapshots: Partial<Record<Service, RemotePlaylist>> = {}
  const adapters: Partial<Record<Service, MixedAdapter>> = {}
  for (const service of ["plex", "ytmusic"] as const) adapters[service] = { service, owner: owners[service],
    create: async title => {
      expect(saved.merge).toBeDefined(); expect(saved.destinations).toEqual(playlistServices(saved)); expect(saved.write?.kind).toBe("create")
      creates.push(service)
      snapshots[service] = { id: `${service}-new`, service, owner: owners[service], title, readOnly: false, items: [] }
      return snapshots[service]!.id
    }, read: async () => structuredClone(snapshots[service]!), mutate: async (before, operation) => {
      expect(saved.write?.kind).toBe(operation.kind)
      snapshots[service] = { ...before, items: operationIds(before.items.map(item => item.track.id), operation).map((id, index) => ({ occurrenceId: String(index), track: song(id) })) }
    } }
  const sync = { adapters, current: () => true, save: async (next: MixedPlaylist) => saved = structuredClone({ ...next, revision: saved.revision + 1 }) }
  saved = await syncMixedPlaylist(saved, sync)
  expect(creates).toEqual(destination === "mixed" ? ["plex", "ytmusic"] : [destination])
  expect(saved.items).toHaveLength(2)
  expect(saved.message).toContain("unmatched")
  const before = [...creates]
  saved = await syncMixedPlaylist(JSON.parse(JSON.stringify(saved)), sync)
  expect(creates).toEqual(before)
})
test("source changes, owner changes, partial failures and cancellation stop admission", async () => {
  const sources: [MergeSource, MergeSource] = [source("one", ["1"]), source("two", ["2"])]
  const preview = await prepareMerge(sources, "plex", "preserve", options)
  await expect(revalidateMerge(preview, async key => ({ ...sources.find(source => source.key === key)!, fingerprint: "changed" }))).rejects.toThrow("changed since review")
  expect(() => mergedDraft(preview, metadata, { ...owners, plex: "other" }, "new")).toThrow("account changed")
  await expect(prepareMerge(sources, "mixed", "preserve", { ...options, current: () => false })).rejects.toThrow("cancelled")
  await expect(readMergeSource("1", { ...options, adapters: { plex: { owner: owners.plex, read: async () => { throw Error("Incomplete paged source") } } as any }, local: async () => [] })).rejects.toThrow("Incomplete")
})
test("read source never binds original remote handles to a new destination and preserves full reader order", async () => {
  const snapshot: RemotePlaylist = { service: "plex", owner: owners.plex, id: "1", title: "Source", readOnly: false,
    items: Array.from({ length: 250 }, (_, index) => ({ occurrenceId: `handle-${index}`, track: song(String(index)), added: { at: index, provenance: "provider" } })) }
  const loaded = await readMergeSource("1", { ...options, local: async () => [], adapters: { plex: { owner: owners.plex, read: async () => snapshot } as any } })
  expect(loaded.items).toHaveLength(250)
  expect(loaded.items[249].copiedFrom?.occurrence).toBe("handle-249")
  expect(loaded.items[249].added.at).toBe(249)
  expect(loaded.items.every(row => Object.keys(row.remote).length === 0)).toBe(true)
  const again = await readMergeSource("1", { ...options, local: async () => [], adapters: { plex: { owner: owners.plex, read: async () => snapshot } as any } })
  expect(again.fingerprint).toBe(loaded.fingerprint)
})
test("empty merges retain explicit creation intent unlike ordinary empty drafts", async () => {
  const preview = await prepareMerge([source("one", []), source("two", [])], "plex", "preserve", options)
  let saved = mergedDraft(preview, metadata, owners, "mixed:empty"), creates = 0
  const remote: RemotePlaylist = { service: "plex", owner: owners.plex, id: "empty", title: metadata.title, readOnly: false, items: [] }
  saved = await syncMixedPlaylist(saved, { current: () => true, save: async next => saved = next,
    adapters: { plex: { owner: owners.plex, service: "plex", create: async () => { creates++; return "empty" }, read: async () => remote, mutate: async () => {} } } })
  expect(creates).toBe(1)
  expect(saved.providers.plex?.id).toBe("empty")
})

test("an unavailable source recording cannot block verified portions of a new mixed merge", async () => {
  const sources: [MergeSource, MergeSource] = [source("one", ["1"]), source("two", ["ytmusic:b1234567890"])]
  sources[0].items[0].songs.plex!.stale = true
  sources[0].items[0].songs.ytmusic = { track: song("ytmusic:a1234567890") }
  const preview = await prepareMerge(sources, "mixed", "preserve", options)
  let saved = mergedDraft(preview, metadata, owners, "mixed:partial")
  const remote: Partial<Record<Service, RemotePlaylist>> = {}
  const adapters = Object.fromEntries((["plex", "ytmusic"] as const).map(service => [service, { service, owner: owners[service],
    create: async title => { remote[service] = { service, owner: owners[service], id: `${service}-new`, title, readOnly: false, items: [] }; return `${service}-new` },
    read: async () => structuredClone(remote[service]!),
    mutate: async (before, operation) => { remote[service] = { ...before, items: operationIds(before.items.map(row => row.track.id), operation).map((id, index) => ({ occurrenceId: String(index), track: song(id) })) } },
  } satisfies MixedAdapter]))
  saved = await syncMixedPlaylist(saved, { adapters, current: () => true, save: async next => saved = structuredClone(next) })
  expect(saved.items).toHaveLength(2)
  expect(remote.plex!.items).toHaveLength(0)
  expect(remote.ytmusic!.items.map(row => row.track.id)).toEqual(["ytmusic:a1234567890", "ytmusic:b1234567890"])
  expect(saved.items[0].songs.plex?.stale).toBe(true)
})
