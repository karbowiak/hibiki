import { expect, test } from "bun:test"
import { youtubeMusicTrack } from "../src/backends/ytmusic/tracks"
import { hydratePlaylist, newOccurrence, snapshotIds, type MixedPlaylist, type RemotePlaylist, type Service } from "../src/mixedPlaylists/model"
import { counterpartCandidates, matchPlaylistBatch } from "../src/mixedPlaylists/matching"
import { retainMixedPlaylist } from "../src/mixedPlaylists/repository"
import { adoptRemote, bindSnapshot, operationIds, projection, reconcileRemoteChanges } from "../src/mixedPlaylists/reconcile"
import { recoverMixedWrite, syncMixedPlaylist } from "../src/mixedPlaylists/sync"
import { mergeMatchingCheckpoint, syncAndMatchPlaylist } from "../src/mixedPlaylists/pipeline"
import type { MixedAdapter } from "../src/mixedPlaylists/adapters"
import { retainLibraryDates } from "../src/mixedPlaylists/libraryDates"
import { deferred, settle } from "./helpers/radioAudioFakes"
import { withTimeout } from "../src/lib/withTimeout"
import { mixedSyncStatus } from "../src/mixedPlaylists/status"

const song = (id: string, title = "Song") => ({ ...youtubeMusicTrack({ videoId: "a1234567890", title, artist: "Artist", album: "Release", duration: "3:00", thumbnail: null }), id })
const snapshot = (service: Service, ids: string[]): RemotePlaylist => ({ service, owner: `${service}-owner`, id: service === "plex" ? "10" : "VLPLtest", title: "Playlist", readOnly: false,
  items: ids.map((id, index) => ({ track: song(id), occurrenceId: `${service}-${index}` })) })
function linked(ids = ["1", "2"]): MixedPlaylist {
  const local = snapshot("plex", ids), initial = hydratePlaylist(local, undefined, 100)
  const playlist = { ...initial, owners: { plex: "plex-owner", ytmusic: "ytmusic-owner" },
    items: initial.items.map(row => ({ ...row, songs: { ...row.songs, ytmusic: { track: song(`ytmusic:${row.songs.plex!.track.id.padStart(11, "a")}`) } }, match: { status: "matched" as const } })) }
  return { ...playlist, baselineOrder: playlist.items.map(row => row.id), baselineTitle: playlist.title }
}
test("hydration preserves repeated occurrences, local identity and stable dates", () => {
  const source = snapshot("plex", ["1", "1"])
  source.items[0].track.addedAt = "2020-01-01T00:00:00Z"
  source.items[0].added = { at: 50, provenance: "provider" }
  const first = hydratePlaylist(source, undefined, 100), restarted = hydratePlaylist(source, structuredClone(first), 999)
  expect(restarted.id).toBe(first.id)
  expect(restarted.items.map(row => row.id)).toEqual(first.items.map(row => row.id))
  expect(new Set(first.items.map(row => row.id)).size).toBe(2)
  expect(restarted.items[0].added).toEqual({ at: 50, provenance: "provider" })
  expect(restarted.items[1].added.at).toBe(100)
  expect(restarted.items[0].songs.plex?.libraryAdded?.at).toBe(Date.parse("2020-01-01T00:00:00Z"))
  expect(() => hydratePlaylist({ ...source, owner: "other-account" }, first)).toThrow("account changed")
})
test("durable saves reject stale revisions and account reassignment", () => {
  const first = linked(), saved = retainMixedPlaylist([], first, 0)[0]
  expect(saved.revision).toBe(1)
  expect(() => retainMixedPlaylist([saved], saved, 0)).toThrow("changed")
  expect(() => retainMixedPlaylist([saved], { ...saved, owners: { ...saved.owners, plex: "other" } }, 1)).toThrow("accounts")
})
test("library observations survive removal, repeat additions and authoritative date discovery", () => {
  const original = hydratePlaylist(snapshot("ytmusic", ["ytmusic:a1234567890"]), undefined, 100)
  const first = retainLibraryDates(original, {})
  expect(first.playlist.items[0].songs.ytmusic?.libraryAdded).toEqual({ at: 100, provenance: "observed" })
  const empty = retainLibraryDates({ ...original, items: [] }, structuredClone(first.dates))
  const readded = hydratePlaylist(snapshot("ytmusic", ["ytmusic:a1234567890", "ytmusic:a1234567890"]), undefined, 900)
  const again = retainLibraryDates(readded, empty.dates)
  expect(again.playlist.items.map(row => row.songs.ytmusic?.libraryAdded?.at)).toEqual([100, 100])
  expect(again.playlist.items.map(row => row.added.at)).toEqual([900, 900])
  const enriched = structuredClone(again.playlist)
  enriched.items[0].songs.ytmusic!.track.addedAt = "2020-01-01T00:00:00Z"
  const native = retainLibraryDates(enriched, again.dates)
  expect(native.playlist.items[1].songs.ytmusic?.libraryAdded).toEqual({ at: Date.parse("2020-01-01T00:00:00Z"), provenance: "provider" })
  expect(native.playlist.items[0].songs.ytmusic?.libraryObservedAt).toBe(100)
  const other = retainLibraryDates({ ...readded, owners: { ytmusic: "another-account" } }, native.dates)
  expect(other.playlist.items[0].songs.ytmusic?.libraryAdded).toEqual({ at: 900, provenance: "observed" })
  const copied = newOccurrence({ ...song("ytmusic:a1234567890"), libraryObservedAt: new Date(100).toISOString() }, 999)
  expect(copied.songs.ytmusic?.libraryAdded).toEqual({ at: 100, provenance: "observed" })
  expect(copied.added).toEqual({ at: 999, provenance: "hibiki" })
})
test("recording matches require credits, version and duration evidence", () => {
  const source = song("1"), exact = song("ytmusic:a1234567890")
  expect(counterpartCandidates(source, [exact])).toHaveLength(1)
  expect(counterpartCandidates(source, [{ ...exact, title: "Song (Live)" }])).toHaveLength(0)
  expect(counterpartCandidates(source, [{ ...exact, duration: 0 }])).toHaveLength(0)
  expect(counterpartCandidates(source, [{ ...exact, duration: 190000 }])).toHaveLength(0)
  expect(counterpartCandidates(source, [{ ...exact, artistName: "Other", artistCredits: [{ name: "Other" }] }])).toHaveLength(0)
  expect(counterpartCandidates(source, [exact, { ...exact, id: "ytmusic:b1234567890" }])).toHaveLength(2)
})
test("matching is bounded, checkpointed, resumable and retains every repeated source", async () => {
  const initial = hydratePlaylist(snapshot("plex", ["1", "1", "2"]))
  let calls = 0, writes = 0
  const options = { current: () => true, limit: 2, save: async (value: MixedPlaylist) => { writes++; return value },
    resolve: async (track: ReturnType<typeof song>) => { calls++; return { status: "matched" as const, track: song(`ytmusic:${track.id.padStart(11, "a")}`), checkedAt: 1, fingerprint: "proof" } } }
  const first = await matchPlaylistBatch(initial, "ytmusic", options)
  expect(first.completed).toBe(2); expect(calls).toBe(1); expect(writes).toBe(2)
  const rest = await matchPlaylistBatch(first.playlist, "ytmusic", options)
  expect(rest.completed).toBe(1)
  expect(rest.playlist.items.map(row => row.id)).toEqual(initial.items.map(row => row.id))
  expect(rest.playlist.items.every(row => row.songs.ytmusic)).toBe(true)
})
test("a retired matching run cannot retain its late result", async () => {
  let current = true, saves = 0
  const result = await matchPlaylistBatch(hydratePlaylist(snapshot("plex", ["1", "2"])), "ytmusic", {
    current: () => current, save: async value => { saves++; return value },
    resolve: async () => { current = false; return { status: "missing", checkedAt: 1, message: "Missing" } },
  })
  expect(result.completed).toBe(0); expect(saves).toBe(0)
})
test("one-sided provider removals and reorder preserve hidden unmatched rows", () => {
  const base = linked(["1", "2", "3"]), hidden = newOccurrence(song("ytmusic:xxxxxxxxxxx"), 3)
  base.items.splice(1, 0, hidden)
  const remote = { ...base.baseline.plex!, items: [base.baseline.plex!.items[2], base.baseline.plex!.items[0]] }
  const result = adoptRemote(base, remote)
  expect(result.items.map(row => row.songs[row.original]!.track.id)).toEqual(["ytmusic:xxxxxxxxxxx", "3", "1"])
  expect(result.items.find(row => row.id === hidden.id)?.added.at).toBe(3)
})
test("concurrent local and remote edits stop for review", () => {
  const playlist = linked(), remote = { ...playlist.baseline.plex!, items: [...playlist.baseline.plex!.items].reverse() }
  playlist.items.push(newOccurrence(song("3")))
  expect(reconcileRemoteChanges(playlist, [remote]).status).toBe("conflict")
})
test("Plex limitations never remove local or YTM duplicate occurrences", () => {
  const playlist = linked(["1", "1"])
  // A provider that already retained distinct handles keeps those copies.
  expect(projection(playlist, "plex")).toHaveLength(2)
  playlist.items.forEach(row => { row.remote = {} })
  expect(playlist.items).toHaveLength(2)
  expect(projection(playlist, "plex")).toHaveLength(1)
  expect(projection(playlist, "ytmusic")).toHaveLength(2)
})
function harness(initial = linked(), batched = false) {
  let saved = initial, sequence = 0, mutations = 0, creates = 0, failPostRead = false, pendingRead = false
  const batchSizes: number[] = []
  const remote: Partial<Record<Service, RemotePlaylist>> = { plex: structuredClone(initial.baseline.plex) }
  const adapters: Partial<Record<Service, MixedAdapter>> = {}
  for (const service of ["plex", "ytmusic"] as const) adapters[service] = {
    service, owner: `${service}-owner`,
    create: async title => { expect(saved.write?.kind).toBe("create"); creates++; remote[service] = { ...snapshot(service, []), title }; return remote[service]!.id },
    read: async () => { if (failPostRead && pendingRead) { failPostRead = false; pendingRead = false; throw Error("Lost read") } return structuredClone(remote[service]!) },
    mutate: async (before, operation) => {
      expect(saved.write?.before).toEqual(before)
      mutations++
      const ids = operationIds(snapshotIds(before), operation)
      const rows = [...before.items]
      if (operation.kind === "append") rows.push({ track: song(operation.trackId), occurrenceId: `new-${++sequence}` })
      else if (operation.kind === "delete") rows.splice(operation.index, 1)
      else { const [row] = rows.splice(operation.from, 1); rows.splice(operation.to, 0, row) }
      expect(rows.map(row => row.track.id)).toEqual(ids)
      remote[service] = { ...before, items: rows }; pendingRead = true
    },
    ...(batched ? { appendMany: async (before: RemotePlaylist, ids: string[]) => {
      expect(saved.write?.before).toEqual(before)
      expect(saved.write?.afterIds).toEqual([...snapshotIds(before), ...ids])
      batchSizes.push(ids.length); mutations++
      remote[service] = { ...before, items: [...before.items, ...ids.map(id => ({ track: song(id), occurrenceId: `new-${++sequence}` }))] }
      pendingRead = true
    } } : {}),
  }
  const options = { adapters, current: () => true, save: async (value: MixedPlaylist) => { saved = structuredClone({ ...value, revision: saved.revision + 1 }); return saved } }
  return { options, remote, batchSizes, saved: () => saved, writes: () => mutations, creates: () => creates, failReads: () => { failPostRead = true } }
}
test("a 307-song merge appends its known Plex remainder in one batch, independently of unmatched YTM songs", async () => {
  const playlist = linked(Array.from({ length: 307 }, (_, index) => String(index + 1)))
  playlist.merge = { sources: [], duplicates: "verified", reviewedAt: 1 }
  playlist.baseline.plex!.items = playlist.baseline.plex!.items.slice(0, 14)
  playlist.items.forEach((row, index) => { if (index >= 14) row.remote = {}; if (index >= 3) delete row.songs.ytmusic })
  const h = harness(playlist, true)
  const result = await syncMixedPlaylist(playlist, h.options)
  expect(result.status).toBe("ready")
  expect(h.batchSizes).toEqual([293, 3])
  expect(h.writes()).toBe(2)
  expect(snapshotIds(h.remote.plex!)).toEqual(playlist.items.map(row => row.songs.plex!.track.id))
  expect(h.remote.ytmusic!.items).toHaveLength(3)
  expect(result.items.map(row => row.id)).toEqual(playlist.items.map(row => row.id))
  expect(result.items).toHaveLength(307)
})
test("large appends checkpoint bounded batches and continue with the remaining ordered suffix", async () => {
  const playlist = linked(Array.from({ length: 650 }, (_, index) => String(index + 1)))
  delete playlist.owners.ytmusic
  playlist.items.forEach(row => { row.remote = {} })
  playlist.baseline.plex!.items = []
  const h = harness(playlist, true)
  await syncMixedPlaylist(playlist, { ...h.options, maxWrites: 1 })
  expect(h.batchSizes).toEqual([500])
  const resumed = await syncMixedPlaylist(structuredClone(h.saved()), h.options)
  expect(h.batchSizes).toEqual([500, 150])
  expect(resumed.status).toBe("ready")
  expect(h.remote.plex!.items).toHaveLength(650)
})
test("interrupted batches recover by fresh reads and append only the missing remainder", async () => {
  const playlist = linked(["1", "2", "3"]), h = harness(playlist, true)
  h.failReads()
  await expect(syncMixedPlaylist(playlist, h.options)).rejects.toThrow("Lost read")
  expect(h.saved().write?.afterIds).toHaveLength(3)
  expect(h.saved().write?.state).toBe("unknown")
  const recovered = await syncMixedPlaylist(structuredClone(h.saved()), h.options)
  expect(recovered.status).toBe("ready")
  expect(h.batchSizes).toEqual([3])
  const partial = harness(playlist, true)
  partial.failReads()
  await expect(syncMixedPlaylist(playlist, partial.options)).rejects.toThrow()
  partial.remote.ytmusic!.items.pop()
  const resumed = await syncMixedPlaylist(structuredClone(partial.saved()), partial.options)
  expect(resumed.status).toBe("ready")
  expect(resumed.write).toBeUndefined()
  expect(snapshotIds(partial.remote.ytmusic!)).toEqual(playlist.items.map(row => row.songs.ytmusic!.track.id))
  expect(partial.writes()).toBe(2)
  expect(partial.batchSizes).toEqual([3])
})
test("the 22-song unchanged YTM receipt resumes its 258 available songs without duplicating the original prefix", async () => {
  const playlist = linked(Array.from({ length: 307 }, (_, index) => String(index + 1)))
  playlist.merge = { sources: [], duplicates: "verified", reviewedAt: 1 }
  playlist.items.forEach((row, index) => { if (index >= 258) delete row.songs.ytmusic })
  const desired = projection(playlist, "ytmusic").map(row => row.songs.ytmusic!.track.id)
  const before = snapshot("ytmusic", desired.slice(0, 22))
  playlist.providers.ytmusic = { id: before.id, readOnly: false }
  playlist.baseline.ytmusic = before
  playlist.write = { id: "old-interrupted-write", service: "ytmusic", kind: "append", state: "unknown", before, afterIds: [...snapshotIds(before), desired[22]] }
  playlist.status = "error"
  const h = harness(playlist, true)
  h.remote.ytmusic = structuredClone(before)
  const result = await syncMixedPlaylist(playlist, h.options)
  expect(result.write).toBeUndefined()
  expect(result.status).toBe("ready")
  expect(snapshotIds(h.remote.ytmusic!)).toEqual(desired)
  expect(h.batchSizes).toEqual([100, 100, 36])
  expect(h.creates()).toBe(0)
  expect(result.items).toHaveLength(307)
})
test("recovery uses replacement occurrence handles when planning the remaining write", async () => {
  const playlist = linked(["1", "2"]), before = snapshot("ytmusic", [playlist.items[0].songs.ytmusic!.track.id])
  playlist.providers.ytmusic = { id: before.id, readOnly: false }; playlist.baseline.ytmusic = before
  playlist.write = { id: "pending", service: "ytmusic", kind: "append", state: "unknown", before,
    afterIds: playlist.items.map(row => row.songs.ytmusic!.track.id) }
  const h = harness(playlist, true)
  h.remote.ytmusic = { ...before, items: before.items.map(row => ({ ...row, occurrenceId: "replaced-handle" })) }
  const recovered = await syncMixedPlaylist(playlist, h.options)
  expect(recovered.status).toBe("ready")
  expect(h.writes()).toBe(1)
  expect(h.saved().write).toBeUndefined()
  expect(h.remote.ytmusic!.items[0].occurrenceId).toBe("replaced-handle")
  expect(snapshotIds(h.remote.ytmusic!)).toEqual(playlist.items.map(row => row.songs.ytmusic!.track.id))
})
test("playlist controls distinguish queued recovery from an unidentified creation", () => {
  const playlist = linked()
  expect(mixedSyncStatus(playlist, false, true).button).toBe("Queued…")
  expect(mixedSyncStatus(playlist, true, true, { kind: "matching", syncing: true }).button).toBe("Matching…")
  expect(mixedSyncStatus(playlist, true, false, { kind: "syncing" }).button).toBe("Syncing…")
  playlist.write = { id: "pending", service: "ytmusic", kind: "create", afterIds: [], state: "unknown" }
  expect(mixedSyncStatus(playlist, false, false)).toMatchObject({ button: "Review sync", label: "Sync paused", busy: false, review: true })
  playlist.write.destinationId = "VLPLtest"
  expect(mixedSyncStatus(playlist, false, false)).toMatchObject({ button: "Sync", label: "Verification queued", queued: true, review: false })
})
test("a partially settled Plex move resumes against current order and preserves new remote additions", async () => {
  const playlist = linked(["1", "2", "3", "4"])
  const before = playlist.baseline.plex!
  playlist.items = [playlist.items[3], ...playlist.items.slice(0, 3)]
  playlist.write = { id: "pending-move", service: "plex", kind: "move", state: "unknown", before,
    afterIds: ["4", "1", "2", "3"] }
  playlist.status = "error"
  const h = harness(playlist, true)
  h.remote.plex = snapshot("plex", ["1", "4", "2", "3", "5"])
  h.remote.plex.items.forEach((row, index) => { row.occurrenceId = `current-${index}` })
  const recovered = await syncMixedPlaylist(playlist, h.options)
  expect(recovered.status).toBe("ready")
  expect(recovered.write).toBeUndefined()
  expect(snapshotIds(h.remote.plex!)).toEqual(["4", "1", "2", "3", "5"])
  expect(recovered.items).toHaveLength(5)
  expect(recovered.items[4].songs.plex?.track.id).toBe("5")
  expect(h.remote.plex.items[0].occurrenceId).toBe("current-1")
  expect(snapshotIds(h.remote.ytmusic!)).toEqual(playlist.items.map(row => row.songs.ytmusic!.track.id))
})
test("recovery can settle a partial delete without writes, then resume the retained order", async () => {
  const playlist = linked(["1", "2", "3"]), before = playlist.baseline.plex!
  delete playlist.owners.ytmusic
  playlist.items = [playlist.items[2]]
  playlist.write = { id: "pending-delete", service: "plex", kind: "delete", state: "unknown", before, afterIds: ["2", "3"] }
  const h = harness(playlist)
  h.remote.plex = snapshot("plex", ["1", "3"])
  const settled = await syncMixedPlaylist(playlist, { ...h.options, maxWrites: 0 })
  expect(settled.write).toBeUndefined()
  expect(settled.items).toHaveLength(1)
  expect(h.writes()).toBe(0)
  const completed = await syncMixedPlaylist(settled, h.options)
  expect(completed.status).toBe("ready")
  expect(snapshotIds(h.remote.plex!)).toEqual(["3"])
})
test("automatic recovery rejects a changed destination, account or read-only playlist", () => {
  const playlist = linked()
  playlist.write = { id: "receipt", service: "plex", kind: "move", state: "unknown",
    before: playlist.baseline.plex!, afterIds: ["2", "1"] }
  const actual = snapshot("plex", ["1", "2"])
  for (const change of [{ owner: "other-owner" }, { id: "other-playlist" }, { readOnly: true }])
    expect(() => recoverMixedWrite(playlist, { ...actual, ...change })).toThrow("account or destination changed")
})
test("an uncertain provider write does not stop local matching or replay the mutation", async () => {
  const initial = linked(["1", "2", "3"])
  delete initial.items[2].songs.ytmusic
  const h = harness(initial, true)
  h.failReads()
  let matches = 0
  await expect(syncAndMatchPlaylist(initial, { current: () => true, save: h.options.save,
    sync: (playlist, save) => syncMixedPlaylist(playlist, { ...h.options, save }), match: async (playlist, save) => {
      matches++
      const saved = await save({ ...playlist, items: playlist.items.map(row => ({ ...row,
        songs: { ...row.songs, ytmusic: row.songs.ytmusic ?? { track: song("ytmusic:aaaaaaaaaa3") } },
        match: { status: "matched", confidence: 0.91 } })) })
      expect(saved.write?.state).toBe("unknown")
      return saved
    } })).rejects.toThrow("Lost read")
  expect(matches).toBe(1)
  expect(h.writes()).toBe(1)
  expect(h.saved().items[0].match.confidence).toBe(0.91)
  expect(h.saved().items[2].songs.ytmusic?.track.id).toBe("ytmusic:aaaaaaaaaa3")
  expect(h.saved().write?.afterIds).toHaveLength(2)
  expect(h.saved().write?.state).toBe("unknown")
})
test("new matches sync while a later lookup is still pending, and checkpoints preserve in-flight receipts and fresh revisions", async () => {
  const initial = linked(["1", "2", "3"])
  initial.items.forEach(row => { delete row.songs.ytmusic })
  const h = harness(initial, true), adapter = h.options.adapters.ytmusic!, append = adapter.appendMany!, mutate = adapter.mutate
  const startedWrite = deferred(), releaseWrite = deferred(), startedSecond = deferred(), releaseSecond = deferred()
  let first = true, secondResolved = false
  const gateWrite = async () => { if (first) { first = false; startedWrite.resolve(); await releaseWrite.promise } }
  adapter.appendMany = async (before, ids) => { await gateWrite(); await append(before, ids) }
  adapter.mutate = async (before, operation) => { await gateWrite(); await mutate(before, operation) }
  const job = syncAndMatchPlaylist(initial, { current: () => true, flushDelayMs: 0,
    save: async value => { expect(value.revision).toBe(h.saved().revision); return h.options.save(value) },
    sync: (playlist, save) => syncMixedPlaylist(playlist, { ...h.options, save }),
    match: async (playlist, save) => (await matchPlaylistBatch(playlist, "ytmusic", { current: () => true, save,
      resolve: async track => {
        if (track.id === "2") { startedSecond.resolve(); await releaseSecond.promise; secondResolved = true }
        return { status: "matched", track: song(`ytmusic:${track.id.padStart(11, "a")}`), checkedAt: 1, fingerprint: "proof", confidence: 0.93 }
      } })).playlist,
  })
  try {
    await withTimeout(startedSecond.promise, 1000, "Second lookup did not start")
    await withTimeout(startedWrite.promise, 1000, "First match waited for the slow lookup")
    expect(secondResolved).toBe(false)
    expect(h.saved().write?.afterIds).toEqual(["ytmusic:aaaaaaaaaa1"])
    releaseSecond.resolve(); await settle()
    expect(secondResolved).toBe(true)
    expect(h.saved().write?.afterIds).toEqual(["ytmusic:aaaaaaaaaa1"])
    releaseWrite.resolve()
    const result = await job
    expect(result.write).toBeUndefined()
    expect(result.items.every(row => row.match.confidence === 0.93 && row.remote.ytmusic)).toBe(true)
    expect(result.items.map(row => row.id)).toEqual(initial.items.map(row => row.id))
    expect(snapshotIds(h.remote.ytmusic!)).toEqual(initial.items.map(row => `ytmusic:${row.songs.plex!.track.id.padStart(11, "a")}`))
  } finally { releaseSecond.resolve(); releaseWrite.resolve(); await job.catch(() => {}) }
})
test("fast match checkpoints coalesce into a batch instead of one provider write per song", async () => {
  const initial = linked(Array.from({ length: 30 }, (_, index) => String(index + 1)))
  initial.items.forEach(row => { delete row.songs.ytmusic })
  const h = harness(initial, true)
  const result = await syncAndMatchPlaylist(initial, { current: () => true, save: h.options.save,
    sync: (playlist, save) => syncMixedPlaylist(playlist, { ...h.options, save }),
    match: async (playlist, save) => (await matchPlaylistBatch(playlist, "ytmusic", { current: () => true, save, limit: 30,
      resolve: async track => ({ status: "matched", track: song(`ytmusic:${track.id.padStart(11, "a")}`), checkedAt: 1, fingerprint: "proof" }) })).playlist,
  })
  expect(h.batchSizes).toEqual([30])
  expect(result.baseline.ytmusic?.items).toHaveLength(30)
  expect(result.items.every(row => !!row.remote.ytmusic)).toBe(true)
})
test("late matching checkpoints keep provider edits, removals and pending-write state", () => {
  const before = linked(["1", "2", "3"])
  before.items.forEach(row => { delete row.songs.ytmusic })
  const next = { ...before, items: before.items.map(row => ({ ...row, songs: { ...row.songs, ytmusic: { track: song(`ytmusic:${row.songs.plex!.track.id.padStart(11, "a")}`) } }, match: { status: "matched" as const, confidence: 0.9 } })) }
  const latest = structuredClone(before)
  latest.revision = 42
  latest.items = [latest.items[2], latest.items[0]]
  latest.items[0].songs.plex!.track.title = "Changed recording"
  latest.items[0].songs.plex!.stale = true
  latest.status = "conflict"
  latest.write = { id: "pending-write", service: "ytmusic", kind: "append", afterIds: [], state: "unknown" }
  const merged = mergeMatchingCheckpoint(latest, before, next).playlist
  expect(merged.revision).toBe(42)
  expect(merged.write).toEqual(latest.write)
  expect(merged.status).toBe("conflict")
  expect(merged.items.map(row => row.id)).toEqual(latest.items.map(row => row.id))
  expect(merged.items[0].songs.ytmusic).toBeUndefined()
  expect(merged.items[0].songs.plex?.track.title).toBe("Changed recording")
  expect(merged.items[1].songs.ytmusic?.track.id).toBe("ytmusic:aaaaaaaaaa1")
})
test("one stale YTM post-read is confirmed without repeating the write", async () => {
  const initial = linked(["1", "2"]), h = harness(initial, true)
  const adapter = h.options.adapters.ytmusic!, read = adapter.read, append = adapter.appendMany!
  let stale = false, confirmationReads = 0
  adapter.appendMany = async (before, ids) => {
    await append(before, ids)
    stale = true
  }
  adapter.read = async id => {
    if (stale) { stale = false; confirmationReads++; return structuredClone(h.saved().write!.before!) }
    return read(id)
  }
  const result = await syncMixedPlaylist(initial, h.options)
  expect(confirmationReads).toBe(1)
  expect(h.writes()).toBe(1)
  expect(result.write).toBeUndefined()
  expect(result.status).toBe("ready")
})
test("YTM batches retain repeated occurrences and respect the 100-action limit", async () => {
  const playlist = linked(Array.from({ length: 205 }, () => "1")), h = harness(playlist, true)
  const result = await syncMixedPlaylist(playlist, h.options)
  expect(h.batchSizes).toEqual([100, 100, 5])
  expect(h.remote.ytmusic!.items).toHaveLength(205)
  expect(new Set(h.remote.ytmusic!.items.map(row => row.occurrenceId)).size).toBe(205)
  expect(result.status).toBe("ready")
})
test("conversion creates one counterpart and verifies all its original songs", async () => {
  const playlist = linked(), h = harness(playlist)
  const completed = await syncMixedPlaylist(playlist, h.options)
  expect(completed.status).toBe("ready")
  expect(h.creates()).toBe(1); expect(h.writes()).toBe(2)
  expect(snapshotIds(h.remote.ytmusic!)).toEqual(playlist.items.map(row => row.songs.ytmusic!.track.id))
  expect(completed.items.every(row => row.remote.ytmusic?.occurrenceId)).toBe(true)
  expect(completed.items.map(row => row.added)).toEqual(playlist.items.map(row => row.added))
})
test("bounded writes resume after restart without creating another playlist", async () => {
  const playlist = linked(["1", "2", "3"]), h = harness(playlist)
  await syncMixedPlaylist(playlist, { ...h.options, maxWrites: 2 })
  const result = await syncMixedPlaylist(structuredClone(h.saved()), h.options)
  expect(result.status).toBe("ready"); expect(h.creates()).toBe(1)
  expect(snapshotIds(h.remote.ytmusic!)).toHaveLength(3)
})
test("an interrupted write settles from its exact post-read without repeating the mutation", async () => {
  const playlist = linked(["1"]), h = harness(playlist)
  h.failReads()
  await expect(syncMixedPlaylist(playlist, h.options)).rejects.toThrow("Lost read")
  expect(h.saved().write?.state).toBe("unknown")
  const writes = h.writes()
  const recovered = await syncMixedPlaylist(structuredClone(h.saved()), h.options)
  expect(recovered.status).toBe("ready"); expect(h.writes()).toBe(writes)
})
test("an unknown creation never creates another remote playlist", async () => {
  const playlist = linked(), h = harness(playlist)
  playlist.write = { id: "unknown", service: "ytmusic", kind: "create", afterIds: [], state: "unknown" }
  await expect(syncMixedPlaylist(playlist, h.options)).rejects.toThrow("unknown outcome")
  expect(h.creates()).toBe(0)
})
test("provider baseline binding retains the canonical occurrence IDs", () => {
  const playlist = linked(), remote = snapshot("ytmusic", playlist.items.map(row => row.songs.ytmusic!.track.id))
  const bound = bindSnapshot(playlist, remote)
  expect(bound.items.map(row => row.id)).toEqual(playlist.items.map(row => row.id))
  expect(bound.items.map(row => row.remote.ytmusic?.occurrenceId)).toEqual(remote.items.map(row => row.occurrenceId))
})

test("YTM-origin conversion retains its identity, dates and unmatched occurrences", async () => {
  const remote = snapshot("ytmusic", ["ytmusic:a1234567890", "ytmusic:b1234567890", "ytmusic:c1234567890"])
  let playlist = hydratePlaylist(remote, undefined, 123)
  playlist = { ...playlist, owners: { plex: "plex-owner", ytmusic: "ytmusic-owner" },
    items: playlist.items.map((row, index) => index === 1 ? row : { ...row,
      songs: { ...row.songs, plex: { track: song(String(index + 1)) } }, match: { status: "matched" } }),
    baselineOrder: playlist.items.map(row => row.id), baselineTitle: playlist.title }
  const h = harness(playlist)
  delete h.remote.plex
  h.remote.ytmusic = structuredClone(remote)
  const complete = await syncMixedPlaylist(playlist, h.options)
  expect(complete.id).toBe(playlist.id)
  expect(complete.items.map(row => [row.id, row.added])).toEqual(playlist.items.map(row => [row.id, row.added]))
  expect(snapshotIds(h.remote.plex!)).toEqual(["1", "3"])
  expect(snapshotIds(h.remote.ytmusic!)).toEqual(snapshotIds(remote))
  expect(complete.message).toContain("1 unmatched")
  const restarted = await syncMixedPlaylist(structuredClone(complete), h.options)
  expect(restarted.id).toBe(playlist.id)
  expect(h.creates()).toBe(1)
})

for (const origin of ["plex", "ytmusic"] as const) test(`external ${origin} edits propagate once without an echo loop`, async () => {
  const h = harness(linked(["1", "2", "3"]))
  let playlist = await syncMixedPlaylist(h.saved(), h.options)
  const initial = h.remote[origin]!
  h.remote[origin] = { ...initial, items: [initial.items[2], initial.items[0]] }
  const ordered = [playlist.items[2].id, playlist.items[0].id]
  playlist = await syncMixedPlaylist(playlist, h.options)
  expect(playlist.status).toBe("ready")
  expect(playlist.items.map(row => row.id)).toEqual(ordered)
  for (const side of ["plex", "ytmusic"] as const)
    expect(snapshotIds(h.remote[side]!)).toEqual(playlist.items.map(row => row.songs[side]!.track.id))
  const writes = h.writes()
  await syncMixedPlaylist(structuredClone(playlist), h.options)
  expect(h.writes()).toBe(writes)
})

test("ownership changes after remote creation retain the creation receipt for the original account", async () => {
  const playlist = linked(), h = harness(playlist)
  let current = true
  const create = h.options.adapters.ytmusic!.create
  h.options.adapters.ytmusic!.create = async title => { const id = await create(title); current = false; return id }
  await expect(syncMixedPlaylist(playlist, { ...h.options, current: () => current })).rejects.toThrow("accounts changed")
  expect(h.creates()).toBe(1)
  expect(h.saved().write).toMatchObject({ service: "ytmusic", kind: "create", state: "admitted" })
  expect(h.saved().providers.ytmusic).toBeUndefined()
  await expect(syncMixedPlaylist(h.saved(), h.options)).rejects.toThrow("unknown outcome")
  expect(h.creates()).toBe(1)
})
