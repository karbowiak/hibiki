import assert from "node:assert/strict"
import { mock } from "bun:test"
import { hydratePlaylist, snapshotIds, type MixedPlaylist, type RemotePlaylist, type Service } from "../../src/mixedPlaylists/model"
import { COUNTERPART_POLICY, recordingFingerprint } from "../../src/mixedPlaylists/matching"
import { nextPlaylistSyncAt, PLAYLIST_CHECK_INTERVAL, PLAYLIST_CONTINUATION_INTERVAL } from "../../src/mixedPlaylists/schedule"
import { operationIds } from "../../src/mixedPlaylists/reconcile"
import type { MusicTrack } from "../../src/types/music"

const song = (id: string) => ({ id, title: `Song ${id}`, artistName: "Artist", albumName: "Album", duration: 180000 } as MusicTrack)
const snapshot = (service: Service, ids: string[]): RemotePlaylist => ({ service, id: service === "plex" ? "10" : "VLtest",
  owner: service === "plex" ? "scope" : "account", title: "List", description: "", readOnly: false,
  items: ids.map(id => ({ occurrenceId: `handle-${id}`, track: song(id) })) })
const remote = { plex: snapshot("plex", ["1", "2"]), ytmusic: snapshot("ytmusic", ["ytmusic:aaaaaaaaaa1"]) }
let saved = hydratePlaylist(remote.plex), reads = 0, catalogs = 0, failWrite = false
const matched: string[] = []
saved = { ...saved, owners: { plex: "scope", ytmusic: "account" }, local: true, automatic: true,
  providers: { ...saved.providers, ytmusic: { id: remote.ytmusic.id, readOnly: false } },
  baseline: { ...saved.baseline, ytmusic: remote.ytmusic }, baselineOrder: saved.items.map(row => row.id), baselineTitle: saved.title,
  items: saved.items.map((row, index) => index === 0 ? { ...row,
    songs: { ...row.songs, ytmusic: { track: song("ytmusic:aaaaaaaaaa1") } },
    remote: { ...row.remote, ytmusic: { occurrenceId: "handle-ytmusic:aaaaaaaaaa1" } }, match: { status: "matched", policy: COUNTERPART_POLICY } } :
    { ...row, match: { status: "missing", policy: COUNTERPART_POLICY, checkedAt: Date.now() - 7200000, fingerprint: recordingFingerprint(row.songs.plex!.track) } }) }
mock.module("../../src/mixedPlaylists/repository", () => ({ mixedPlaylistRepository: {
  load: async () => [structuredClone(saved)],
  save: async (playlist: MixedPlaylist) => {
    assert.equal(playlist.revision, saved.revision)
    saved = structuredClone({ ...playlist, revision: saved.revision + 1 }); return saved
  },
} }))
const provider = { cacheScope: "scope", isOffline: false }
mock.module("../../src/mixedPlaylists/counterparts", () => ({
  captureMusicOwner: () => ({ owners: { plex: "scope", ytmusic: "account" }, provider, current: () => true }),
  createPlaylistCounterpartResolver: () => {
    catalogs++
    return async (track: MusicTrack) => { matched.push(track.id); return { status: "missing", checkedAt: Date.now(), message: "No match" } }
  },
  resolvePlaylistCounterpart: () => { throw Error("unexpected individual lookup") },
} ))
mock.module("../../src/mixedPlaylists/adapters", () => ({ mixedAdapters: () => Object.fromEntries(
  (["plex", "ytmusic"] as const).map(service => [service, { service, owner: remote[service].owner,
    read: async () => { reads++; return structuredClone(remote[service]) },
    create: async () => { throw Error("unexpected creation") },
    mutate: async (before: RemotePlaylist, operation: Parameters<typeof operationIds>[1]) => {
      if (failWrite) throw Error("Unconfirmed provider change")
      remote[service] = snapshot(service, operationIds(snapshotIds(before), operation))
    },
  }])) }))
mock.module("../../src/metadata/listenbrainz/authStore", () => ({ useListenBrainzStore: { getState: () => ({ isAuthenticated: false }) } }))
mock.module("../../src/matching/service", () => ({ queryIndexedMusic: () => { throw Error("unexpected index lookup") } }))
mock.module("../../src/mixedPlaylists/listenbrainz", () => ({ syncDraftListenBrainz: async (playlist: MixedPlaylist) => playlist }))
const { useMixedPlaylistStore } = await import("../../src/stores/mixedPlaylistStore")
const store = useMixedPlaylistStore.getState()

await store.sync(saved.id, true)
await store.sync(saved.id, true)
assert.ok(reads >= 4, "manual Sync must read both upstream playlists")
assert.equal(catalogs, 0, "manual/periodic reconciliation must not reopen settled misses")
assert.deepEqual(matched, [])
assert.ok(saved.syncCheckedAt)
assert.equal(nextPlaylistSyncAt(saved), saved.syncCheckedAt! + PLAYLIST_CHECK_INTERVAL)

remote.plex = snapshot("plex", ["1", "2", "3"])
await store.sync(saved.id, true)
assert.equal(saved.items.length, 3)
assert.equal(nextPlaylistSyncAt(saved), saved.syncCheckedAt! + PLAYLIST_CONTINUATION_INTERVAL)
await store.sync(saved.id)
assert.deepEqual(matched, ["3"], "only the new upstream song needs matching")
await store.sync(saved.id, true)
assert.deepEqual(matched, ["3"], "unchanged misses must stay settled on subsequent checks")
assert.equal(nextPlaylistSyncAt(saved), saved.syncCheckedAt! + PLAYLIST_CHECK_INTERVAL)

await store.sync(saved.id, true, true)
assert.deepEqual(matched, ["3", "2", "3"], "the dedicated retry action can rematch both misses")

saved.items = [saved.items[1], saved.items[0], saved.items[2]]
failWrite = true
await assert.rejects(store.sync(saved.id), /Unconfirmed provider change/)
assert.ok(saved.write)
assert.ok(saved.syncCheckedAt, "failed verification attempts must retain their check time too")
assert.equal(nextPlaylistSyncAt(saved), saved.syncCheckedAt! + PLAYLIST_CHECK_INTERVAL)
