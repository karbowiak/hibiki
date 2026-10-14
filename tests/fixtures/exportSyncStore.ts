import assert from "node:assert/strict"
import { useProviderStore } from "../../src/stores/providerStore"
import { useListenBrainzStore } from "../../src/metadata/listenbrainz/authStore"
import { useLinkedPlaylistStore } from "../../src/stores/linkedPlaylistStore"
import { nativeListenBrainzPlaylists } from "../../src/playlistSync/listenbrainz"
import {
  syncCreationJournal,
  retainSyncCreation,
} from "../../src/playlistSync/creation"
import {
  linkedPlaylistRepository,
  retainLink,
} from "../../src/playlistSync/linkedJournal"
import type { LinkedPlaylist } from "../../src/playlistSync/linked"
import type { SyncCreationIntent } from "../../src/playlistSync/creation"

const remoteId = "11111111-1111-4111-8111-111111111111"
const otherId = "22222222-2222-4222-8222-222222222222"
const account = { service: "listenbrainz", user: "owner", revision: "lease" }
let intents: SyncCreationIntent[] = [],
  links: LinkedPlaylist[] = [],
  creates = 0,
  reads = 0
let title = "❤️ Tracks",
  loseResponse = false
const provider: any = {
  name: "Plex",
  cacheScope: "scope",
  playbackSession: {},
  isOffline: false,
  capabilities: { playlists: true },
  getPlaylists: async () => [{ id: "local", title: "❤️ Tracks", smart: true }],
  getPlaylistItems: async () => ({
    offset: 0,
    total: 1,
    items: [
      { id: "track", title: "Song", artistName: "Artist", duration: 1000 },
    ],
  }),
  createPlaylist: async () => {
    throw Error("No library creates")
  },
}
useProviderStore.setState({ provider })
useListenBrainzStore.setState({ username: "owner", isAuthenticated: true })
useLinkedPlaylistStore.setState({ error: null })
syncCreationJournal.load = async () => structuredClone(intents)
syncCreationJournal.save = async (intent) => {
  intents = retainSyncCreation(intents, intent)
}
linkedPlaylistRepository.load = async () => structuredClone(links)
linkedPlaylistRepository.save = async (link, revision) => {
  links = retainLink(links, link, revision)
  return structuredClone(links.find((item) => item.id === link.id)!)
}
nativeListenBrainzPlaylists.account = async () => account
nativeListenBrainzPlaylists.create = async (
  _account,
  requestedTitle,
  mbids
) => {
  creates++
  assert.equal(mbids.length, 0)
  title = requestedTitle
  if (loseResponse) throw Error("Lost acknowledgement")
  return { id: remoteId }
}
nativeListenBrainzPlaylists.read = async (_account, id) => {
  reads++
  return {
    playlist: {
      identifier: `https://listenbrainz.org/playlist/${id}`,
      title: id === otherId ? "Unrelated" : title,
      track: [],
    },
  }
}
const summary = {
  account: { service: "library:Plex", user: "scope", revision: "scope-v1" },
  id: "local",
  title,
  items: [],
}
const result = await useLinkedPlaylistStore
  .getState()
  .createSync(summary, title, () => true, undefined, "export")
assert.equal(result.link.direction, "export")
assert.equal(result.link.baseline.library.readOnly, true)
assert.equal(result.link.paused, true)
assert.equal(creates, 1)
assert.equal(useLinkedPlaylistStore.getState().links.length, 1)
assert.equal(
  useLinkedPlaylistStore.getState().creationIntents[0].state,
  "linked"
)

// A fresh isolated recovery fixture: the uncertain request must never be replayed.
links = []
intents = []
useLinkedPlaylistStore.setState({ links: [], creationIntents: [], error: null })
loseResponse = true
await assert.rejects(
  useLinkedPlaylistStore
    .getState()
    .createSync(summary, title, () => true, undefined, "export")
)
const intent = intents[0]
assert.equal(intent.state, "reconcile")
const originalReads = reads
await assert.rejects(
  useLinkedPlaylistStore
    .getState()
    .recoverCreation(intent.id, "typo", () => true, true),
  /identifier/
)
assert.equal(
  reads,
  originalReads,
  "Invalid ID is rejected before a remote read"
)
assert.equal(intents[0].destinationId, undefined)
await assert.rejects(
  useLinkedPlaylistStore
    .getState()
    .recoverCreation(intent.id, otherId, () => true, true),
  /expected empty destination/
)
assert.equal(
  intents[0].destinationId,
  undefined,
  "An unrelated playlist does not permanently pin the receipt"
)
const recovered = await useLinkedPlaylistStore
  .getState()
  .recoverCreation(
    intent.id,
    `https://listenbrainz.org/playlist/${remoteId}`,
    () => true,
    true
  )
assert.equal(recovered.link.direction, "export")
assert.equal(recovered.link.listenbrainzPlaylistId, remoteId)
assert.equal(creates, 2, "Recovery never sends a third create")
assert.equal(intents[0].state, "linked")
