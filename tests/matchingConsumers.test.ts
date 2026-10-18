import { expect, test } from "bun:test"
import { createMatchingConsumer } from "../src/matching/consumerQueue"
import { associateMusicItems } from "../src/matching/associations"
import type { MatchingUpdate } from "../src/matching/updates"
import type { MatchingResolution } from "../src/matching/resolverTypes"
import type { MusicProvider } from "../src/providers/types"
import { youtubeMusicTrack } from "../src/backends/ytmusic/tracks"
import { hydratePlaylist, songReference, verifiedSongReference, type MixedPlaylist, type RemotePlaylist } from "../src/mixedPlaylists/model"
import { verifyPlaylistIdentity } from "../src/mixedPlaylists/identity"
import { syncMixedPlaylist } from "../src/mixedPlaylists/sync"
import { matchPlaylistBatch } from "../src/mixedPlaylists/matching"
import { createMusicLinkResolver } from "../src/lib/musicLinkResolver"
import { mergeMusicSearchResults } from "../src/lib/musicMatching"
import { deferred } from "./helpers/radioAudioFakes"

const song = (id: string, title = "Song") => ({ ...youtubeMusicTrack({ videoId: "a1234567890", title, artist: "Artist", album: "Release", duration: "3:00", thumbnail: null }), id })
const baseline: RemotePlaylist = { service: "plex", owner: "scope", id: "10", title: "List", readOnly: false,
  items: ["1", "1", "2"].map((id, index) => ({ occurrenceId: `occurrence-${index}`, track: song(id) })) }
const playlist = () => ({ ...hydratePlaylist(structuredClone(baseline)), owners: { plex: "scope", ytmusic: "account" } })
const update = (id: number): MatchingUpdate => ({ provider: {} as MusicProvider, coverageChanged: false, coverage: "complete", reset: false,
  revision: id, cursor: id, changes: [{ sequence: id, kind: "track", id }] })

test("slow consumers coalesce changes, bound backlog and retain a later pass", async () => {
  const gate = deferred<void>(), seen: (MatchingUpdate | undefined)[] = []
  const lane = createMatchingConsumer(async change => { seen.push(change); if (seen.length === 1) await gate.promise }, 0)
  const first = update(1)
  lane.offer(first); await Bun.sleep(5)
  for (let id = 2; id < 1200; id++) lane.offer({ ...update(id), provider: first.provider })
  expect(seen.length).toBe(1)
  gate.resolve(); await Bun.sleep(20); lane.stop()
  expect(seen.length).toBe(2)
  expect(seen[1]?.reset).toBe(true)
  expect(seen[1]?.changes.length).toBe(1000)
})

test("consumer disposal cancels a queued retry and an unfiltered pass covers all pending intent", async () => {
  let calls = 0
  const stopped = createMatchingConsumer(async () => { calls++ }, 0)
  stopped.offer(update(1)); stopped.stop(); await Bun.sleep(5)
  expect(calls).toBe(0)
  const lane = createMatchingConsumer(async change => { calls++; expect(change).toBeUndefined() }, 0)
  lane.offer(update(1)); lane.offer(); await Bun.sleep(5); lane.stop()
  expect(calls).toBe(1)
})

test("native proofs remove only the selected Plex duplicate and preserve ambiguous YTM editions", async () => {
  const local = { ...song("1"), type: "track" as const }, remote = { ...song("ytmusic:a1234567890"), type: "track" as const }
  const partial = { sourceId: remote.id, status: "ambiguous", selected: null, candidates: [], coverage: "complete", cached: false, limited: false, revision: 1, recordingIdentity: null } as MatchingResolution
  let calls = 0
  let associations = await associateMusicItems([remote, remote], () => true, async () => { calls++; return partial })
  expect(calls).toBe(1)
  expect(mergeMusicSearchResults([local], [remote], associations)).toHaveLength(2)
  associations = await associateMusicItems([remote], () => true, async () => ({ ...partial, status: "matched", selected: 1 }))
  expect(mergeMusicSearchResults([local], [remote], associations)).toEqual([local])
  expect(mergeMusicSearchResults([{ ...local, id: "2" }], [remote], associations)).toHaveLength(2)
})

test("departed views discard late associations and passive visible batches never hydrate metadata", async () => {
  let current = true, calls = 0
  const rows = Array.from({ length: 400 }, (_, index) => ({ ...song(`ytmusic:${index}`), type: "track" as const }))
  const found = await associateMusicItems(rows, () => current, async () => { calls++; if (calls === 16) current = false; return null })
  expect(calls).toBe(16)
  expect(found.size).toBe(0)
})

test("link clicks revalidate shared identity before old view cache, including a new match and removal", async () => {
  let href = "/ytmusic/UC_artist", searches = 0
  const resolve = createMusicLinkResolver({ current: () => true, indexed: async () => ({ handled: true, href }),
    searchPlex: async () => { searches++; return [] }, searchYoutube: async () => [] })
  const ref = { kind: "artist" as const, id: "ytmusic:UC_artist", name: "Artist" }
  expect(await resolve(ref)).toBe(href)
  href = "/artist/1"
  for (let index = 0; index < 30; index++) expect(await resolve(ref)).toBe(href)
  href = "/ytmusic/UC_artist"
  expect(await resolve(ref)).toBe(href)
  expect(searches).toBe(0)
})

test("removed known Plex links and complete native misses go directly to YTM discovery", async () => {
  let searches = 0
  const resolve = createMusicLinkResolver({ current: () => true, knownPlex: async () => false,
    indexed: async () => ({ handled: false, href: null, plexChecked: true }),
    searchPlex: async () => { searches++; throw Error("shared index already checked Plex") },
    searchYoutube: async () => [{ id: "ytmusic:UC_artist", name: "Artist" }] })
  expect(await resolve({ kind: "artist", id: "42", name: "Artist" })).toBe("/ytmusic/UC_artist")
  expect(searches).toBe(0)
})

test("Plex disappearance retains all local occurrences and cannot propagate deletions to YTM", async () => {
  const original = playlist(), absent = { ...baseline, items: [] }
  const checked = await verifyPlaylistIdentity(original, { provider: { cacheScope: "scope", getTrack: async () => { throw Error("not found") } } as unknown as MusicProvider,
    current: () => true, snapshots: [absent] })
  expect(checked.items.map(row => row.id)).toEqual(original.items.map(row => row.id))
  expect(checked.items.every(row => row.songs.plex?.stale)).toBe(true)
  let writes = 0
  const result = await syncMixedPlaylist(checked, { current: () => true, save: async value => value,
    adapters: { plex: { owner: "scope", read: async () => absent }, ytmusic: { owner: "account", create: async () => { writes++; return "new" } } } as any })
  expect(result.items).toHaveLength(3)
  expect(result.status).toBe("error")
  expect(writes).toBe(0)
})

test("a real playlist removal is still allowed when fresh library metadata proves the same recording", async () => {
  const original = playlist()
  const checked = await verifyPlaylistIdentity(original, { provider: { cacheScope: "scope", getTrack: async id => song(id) } as MusicProvider,
    current: () => true, snapshots: [{ ...baseline, items: [] }] })
  expect(checked).toBe(original)
})

test("rematched metadata preserves original intent through hydration and archives its retired target on explicit rematching", async () => {
  const original = playlist(), changed = { ...baseline, items: baseline.items.map(item => ({ ...item, track: song(item.track.id, "Unrelated recording") })) }
  const checked = await verifyPlaylistIdentity(original, { provider: { cacheScope: "scope" } as MusicProvider, current: () => true, snapshots: [changed] })
  expect(checked.items[0].songs.plex?.track.title).toBe("Song")
  expect(checked.items[0].songs.plex?.observed?.title).toBe("Unrelated recording")
  const restarted = hydratePlaylist(changed, structuredClone(checked))
  expect(restarted.items[0].songs.plex?.track.title).toBe("Song")
  const next = await matchPlaylistBatch(restarted, "plex", { current: () => true, save: async value => value, retry: true,
    resolve: async () => ({ status: "matched", track: song("9"), checkedAt: 1, fingerprint: "proof" }) })
  expect(next.playlist.items.map(row => row.id)).toEqual(original.items.map(row => row.id))
  expect(next.playlist.items[0].songs.plex?.stale).toBeUndefined()
  expect(next.playlist.items[0].remote.plex).toBeUndefined()
  expect(next.playlist.items[0].songs.plex?.retired?.[0].track.id).toBe("1")
  expect(songReference(song("9"), next.playlist.items[0].songs.plex).retired).toHaveLength(1)
  expect(verifiedSongReference(song("10"), next.playlist.items[0].songs.plex).retired).toHaveLength(1)
})

test("unchanged labels cannot authorize a playlist deletion after a typed Plex recording rematch", async () => {
  const original = playlist()
  original.items[0].songs.plex!.track.guid = "plex://track/original"
  const checked = await verifyPlaylistIdentity(original, { provider: { cacheScope: "scope", getTrack: async id => ({ ...song(id), guid: "plex://track/replacement" }) } as MusicProvider,
    current: () => true, snapshots: [{ ...baseline, items: [] }] })
  expect(checked.items[0].songs.plex?.stale).toBe(true)
  expect(checked.items[0].songs.plex?.track.guid).toBe("plex://track/original")
})

test("a scope retirement during library verification cannot save stale flags or authorize a removal", async () => {
  let current = true
  await expect(verifyPlaylistIdentity(playlist(), { provider: { cacheScope: "scope", getTrack: async id => { current = false; return song(id) } } as MusicProvider,
    current: () => current, snapshots: [{ ...baseline, items: [] }] })).rejects.toThrow("accounts changed")
})

test("changed index parents invalidate retained recording proofs without fetching full browse objects", async () => {
  const original = playlist()
  let reads = 0
  const checked = await verifyPlaylistIdentity(original, { provider: { cacheScope: "scope", matchingRows: async (_, ids) => {
    reads++; return ids.map(id => ({ id, state: "removed", row: null })) }, getTrack: async () => { throw Error("must not hydrate index evidence") } } as MusicProvider,
    current: () => true, ids: new Set(["1"]) })
  expect(reads).toBe(1)
  expect(checked.items.slice(0, 2).every(row => row.songs.plex?.stale)).toBe(true)
  expect(checked.items[2].songs.plex?.stale).toBeUndefined()
})
