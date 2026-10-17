import { mock } from "bun:test"
import assert from "node:assert/strict"
import { create } from "zustand"
mock.module("@tauri-apps/api/core", () => ({ invoke: () => { throw Error("Unexpected native call") }, isTauri: () => false }))
mock.module("../../src/backends/ytmusic/discovery", () => ({
  useYoutubeMusicDiscoveryStore: create(() => ({ connected: false })),
  browseYoutubeMusic: () => { throw Error("Unexpected YTM search") }, youtubeMusicItemTrack: () => { throw Error("Unexpected mapping") },
}))
const { syncDraftListenBrainz, draftListenBrainzSnapshot } = await import("../../src/mixedPlaylists/listenbrainz")
const { newDraft, appendDraftSongs } = await import("../../src/mixedPlaylists/drafts")
const { youtubeMusicTrack } = await import("../../src/backends/ytmusic/tracks")
const { retainSyncCreation } = await import("../../src/playlistSync/creation")
const { operationIds } = await import("../../src/mixedPlaylists/reconcile")
const scenario = process.argv[2]
const account = { service: "listenbrainz", user: "fixture", revision: "1" }
const remoteId = "11111111-1111-4111-8111-111111111111"
const mbids = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "cccccccc-cccc-4ccc-8ccc-cccccccccccc"]
const songs = mbids.map((_, index) => youtubeMusicTrack({ videoId: `${String.fromCharCode(97 + index)}1234567890`, title: `Song ${index}`, artist: "Artist", album: "Album", duration: "3:00", thumbnail: null }))
let playlist = newDraft({ title: "Local", description: "Keep this description", artwork: null,
  external: { listenbrainz: { enabled: true, automatic: true, direction: "two-way" } } })
let attempts: import("../../src/playlistSync/creation").SyncCreationIntent[] = [], current = true, partial = scenario === "partial"
let creates = 0, mutations = 0, calls = 0, uncertainCreate = ["uncertain-create", "review-not-created"].includes(scenario), uncertainWrite = scenario === "uncertain-write"
let remote = { title: "Local", description: "", ids: [] as string[] }
const raw = () => ({ playlist: { identifier: `https://listenbrainz.org/playlist/${remoteId}`, title: remote.title, annotation: remote.description,
  creator: "fixture", extension: { "https://musicbrainz.org/doc/jspf#playlist": { public: false, collaborators: [] } },
  track: remote.ids.map(mbid => ({ identifier: [`https://musicbrainz.org/recording/${mbid}`], title: songs[mbids.indexOf(mbid)]?.title ?? "Unknown", creator: "Artist", duration: 180000 })) } })
const options: Parameters<typeof syncDraftListenBrainz>[1] = {
  current: () => current, owners: { ytmusic: "yt-owner" },
  save: async next => { playlist = structuredClone({ ...next, revision: playlist.revision + 1 }); return playlist },
  resolveRecording: async song => partial && song.id === songs[1].id ? null : mbids[songs.findIndex(row => row.id === song.id)],
  resolveImported: async row => songs[mbids.indexOf(row.recordingMbid!)],
  journal: { load: async () => structuredClone(attempts), save: async intent => { attempts = retainSyncCreation(attempts, intent) } },
  transport: { account: async () => { calls++; return account }, list: async () => { throw Error("Unexpected listing") },
    read: async () => { calls++; return raw() },
    create: async (_, title, ids) => {
      assert.equal(attempts.filter(attempt => !["linked", "cancelled"].includes(attempt.state)).at(-1)?.state, "admitting"); assert.deepEqual(ids, []); creates++; remote.title = title
      if (scenario === "retired") current = false
      if (uncertainCreate) { uncertainCreate = false; throw Error("Lost creation response") }
      return { id: remoteId }
    },
    mutate: async (_, __, before, operation) => {
      assert.deepEqual(before, { title: remote.title, mbids: remote.ids }); mutations++
      remote.ids = operationIds(remote.ids, operation)
      if (uncertainWrite) { uncertainWrite = false; throw Error("Lost mutation response") }
      return raw()
    },
    describe: async (_, before, title, description) => {
      assert.deepEqual(before.items.map(row => row.track.recordingMbid), remote.ids)
      assert(playlist.listenbrainz?.detailsWrite)
      remote = { ...remote, title, description }; return raw()
    },
  },
}
if (scenario === "empty") {
  await syncDraftListenBrainz(playlist, options)
  assert.equal(calls, 0); assert.equal(creates, 0); assert.equal(attempts.length, 0)
} else {
  playlist = appendDraftSongs(playlist, songs.slice(0, 2), { ytmusic: "yt-owner" }, "first")
  if (["uncertain-create", "review-not-created", "retired"].includes(scenario)) {
    await assert.rejects(() => syncDraftListenBrainz(playlist, options))
    assert.equal(creates, 1)
    current = true
    if (["uncertain-create", "review-not-created"].includes(scenario)) {
      assert.equal(playlist.listenbrainz?.creationPending, true)
      await assert.rejects(() => syncDraftListenBrainz(playlist, options))
      assert.equal(creates, 1)
      if (scenario === "review-not-created") {
        await syncDraftListenBrainz(playlist, { ...options, manual: true, reviewNoCreation: true })
        assert.equal(attempts[0].state, "cancelled")
      } else await syncDraftListenBrainz(playlist, { ...options, manual: true, recoveryId: remoteId })
    } else await syncDraftListenBrainz(playlist, options)
    assert.equal(creates, scenario === "review-not-created" ? 2 : 1); assert(playlist.listenbrainz?.link)
    assert.equal(playlist.listenbrainz?.creationPending, false)
  } else {
    await syncDraftListenBrainz(playlist, options)
    assert.equal(creates, 1)
    if (scenario === "uncertain-write") {
      assert.equal(playlist.listenbrainz?.link?.state, "unknown")
      const writes = mutations
      await syncDraftListenBrainz(playlist, { ...options, manual: true })
      assert.deepEqual(remote.ids, mbids.slice(0, 2)); assert.equal(mutations, writes + 1)
    } else if (scenario === "partial") {
      assert.deepEqual(remote.ids, [mbids[0]]); assert.equal(playlist.items.length, 2)
      assert.match(playlist.listenbrainz!.message!, /1 songs awaiting/)
      partial = false
      await syncDraftListenBrainz(structuredClone(playlist), { ...options, manual: true })
      assert.deepEqual(remote.ids, mbids.slice(0, 2)); assert.equal(creates, 1)
    } else if (scenario === "edits") {
      const occurrences = playlist.items.map(row => row.id)
      remote.ids.reverse()
      await syncDraftListenBrainz(playlist, options)
      assert.deepEqual(playlist.items.map(row => row.id), occurrences.reverse())
      const writes = mutations
      await syncDraftListenBrainz(structuredClone(playlist), options)
      assert.equal(mutations, writes)
      playlist = { ...playlist, items: [] }
      await syncDraftListenBrainz(playlist, options)
      assert.deepEqual(remote.ids, []); assert.equal(creates, 1)
    } else if (scenario === "import") {
      remote.ids.push(mbids[2])
      await syncDraftListenBrainz(playlist, options)
      assert.deepEqual(playlist.items.map(row => row.songs[row.original]!.track.id), songs.map(row => row.id))
      assert.equal(new Set(playlist.items.map(row => row.id)).size, 3)
    } else if (scenario === "conflict") {
      playlist = { ...playlist, items: [...playlist.items].reverse() }
      remote.ids.pop()
      const before = JSON.stringify(playlist.items), ids = [...remote.ids]
      await syncDraftListenBrainz(playlist, options)
      assert.equal(playlist.listenbrainz?.link?.state, "conflict")
      assert.equal(JSON.stringify(playlist.items), before); assert.deepEqual(remote.ids, ids)
      await syncDraftListenBrainz(playlist, { ...options, manual: true, prefer: "hibiki" })
      assert.deepEqual(remote.ids, [...mbids.slice(0, 2)].reverse())
    }
    assert(playlist.listenbrainz?.link)
    assert.equal(remote.description, "Keep this description")
    assert.equal(draftListenBrainzSnapshot(playlist).items.length, playlist.items.length)
  }
}
