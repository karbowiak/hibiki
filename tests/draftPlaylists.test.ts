import { expect, test } from "bun:test"
import { appendDraftSongs, defaultPlaylistSync, newDraft, reviewUnappliedCreation, validateDraftMetadata } from "../src/mixedPlaylists/drafts"
import { syncMixedPlaylist } from "../src/mixedPlaylists/sync"
import { syncDraftDetails } from "../src/mixedPlaylists/details"
import type { MixedPlaylist, RemotePlaylist, Service } from "../src/mixedPlaylists/model"
import { operationIds } from "../src/mixedPlaylists/reconcile"
import { retainMixedPlaylist } from "../src/mixedPlaylists/repository"
import { youtubeMusicTrack } from "../src/backends/ytmusic/tracks"
import type { MixedAdapter } from "../src/mixedPlaylists/adapters"

const metadata = () => ({ title: "My draft", description: "Songs for later", artwork: "data:image/png;base64,YQ==", external: defaultPlaylistSync() })
const song = (id: string) => ({ ...youtubeMusicTrack({ videoId: "a1234567890", title: "Song", artist: "Artist", album: "Release", duration: "3:00", thumbnail: null }), id })
function harness(initial: MixedPlaylist) {
  let saved = structuredClone(initial), creates = 0, writes = 0, descriptions = 0
  const remote: Partial<Record<Service, RemotePlaylist>> = {}
  const adapters: Partial<Record<Service, MixedAdapter>> = {}
  for (const service of ["plex", "ytmusic"] as const) adapters[service] = { service, owner: `${service}-owner`,
    read: async () => structuredClone(remote[service]!),
    create: async title => {
      expect(saved.write?.kind).toBe("create"); creates++
      remote[service] = { service, owner: `${service}-owner`, id: `${service}-list`, title, description: "", readOnly: false, items: [] }
      return remote[service]!.id
    },
    mutate: async (before, operation) => {
      expect(saved.write?.before).toEqual(before); writes++
      remote[service] = { ...before, items: operationIds(before.items.map(row => row.track.id), operation).map((id, index) => ({ occurrenceId: `${id}:${index}`, track: song(id) })) }
    },
    describe: async (before, title, description) => {
      expect(saved.detailsWrite?.before).toEqual(before); descriptions++
      remote[service] = { ...before, title, description }
    },
  }
  const options = { adapters, current: () => true, save: async (next: MixedPlaylist) => { saved = { ...structuredClone(next), revision: saved.revision + 1 }; return saved } }
  return { options, remote, saved: () => saved, creates: () => creates, writes: () => writes, descriptions: () => descriptions }
}
test("empty drafts retain metadata and preferences across durable saves without creating remote resources", async () => {
  const initial = newDraft(metadata(), "mixed:durable", 123), h = harness(initial)
  const saved = retainMixedPlaylist([], initial, 0)[0]
  expect(JSON.parse(JSON.stringify(saved))).toMatchObject({ id: initial.id, title: initial.title, description: initial.description, artwork: initial.artwork, owners: {}, external: metadata().external })
  expect(await syncMixedPlaylist(saved, h.options)).toEqual(saved)
  expect(await syncDraftDetails(saved, h.options)).toEqual(saved)
  expect(h.creates()).toBe(0); expect(h.writes()).toBe(0); expect(h.descriptions()).toBe(0)
})
for (const first of ["plex", "ytmusic"] as const) test(`first ${first} song creates only its service, then evolves without replacing identity`, async () => {
  const draft = newDraft(metadata()), owners = { plex: "plex-owner", ytmusic: "ytmusic-owner" }
  const source = first === "plex" ? song("1") : song("ytmusic:a1234567890")
  let playlist = appendDraftSongs(draft, [source, source], owners, "first")
  expect(Object.keys(playlist.owners)).toEqual([first])
  const h = harness(playlist)
  playlist = await syncMixedPlaylist(playlist, h.options)
  expect(h.creates()).toBe(1); expect(playlist.providers[first]).toBeDefined()
  const other = first === "plex" ? "ytmusic" : "plex"
  expect(playlist.providers[other]).toBeUndefined()
  expect(playlist.items).toHaveLength(2)
  const identities = playlist.items.map(row => row.id), dates = playlist.items.map(row => row.added)
  playlist = await syncDraftDetails(playlist, h.options)
  expect(h.remote[first]?.description).toBe(metadata().description)
  const second = other === "plex" ? song("2") : song("ytmusic:b1234567890")
  playlist = appendDraftSongs(playlist, [second], owners, "other")
  playlist = await syncMixedPlaylist(playlist, h.options)
  expect(h.creates()).toBe(2); expect(playlist.id).toBe(draft.id)
  expect(playlist.items.slice(0, 2).map(row => row.id)).toEqual(identities)
  expect(playlist.items.slice(0, 2).map(row => row.added)).toEqual(dates)
  expect(playlist.artwork).toBe(draft.artwork)
  await syncMixedPlaylist(structuredClone(playlist), h.options)
  expect(h.creates()).toBe(2)
})
test("offline additions and repeated admissions remain local without binding a later account", () => {
  const draft = newDraft(metadata()), first = appendDraftSongs(draft, [song("ytmusic:a1234567890")], {}, "drop")
  expect(first.owners).toEqual({})
  expect(appendDraftSongs(first, [song("1")], { plex: "other" }, "drop")).toEqual(first)
  const owned = appendDraftSongs(draft, [song("1")], { plex: "original" }, "owned")
  expect(() => appendDraftSongs(owned, [song("2")], { plex: "other" }, "new")).toThrow("original account")
})
test("emptying a materialized playlist keeps its identity and counterpart without create/delete churn", async () => {
  let playlist = appendDraftSongs(newDraft(metadata()), [song("ytmusic:a1234567890")], { ytmusic: "ytmusic-owner" }, "first")
  const h = harness(playlist)
  playlist = await syncMixedPlaylist(playlist, h.options)
  const id = playlist.id, provider = playlist.providers.ytmusic
  playlist = await syncMixedPlaylist({ ...playlist, items: [] }, h.options)
  expect(playlist.id).toBe(id); expect(playlist.providers.ytmusic).toEqual(provider)
  expect(h.remote.ytmusic?.items).toHaveLength(0); expect(h.creates()).toBe(1)
})
test("uncertain details save settles from readback without repeating the write", async () => {
  let playlist = appendDraftSongs(newDraft(metadata()), [song("ytmusic:a1234567890")], { ytmusic: "ytmusic-owner" }, "first")
  const h = harness(playlist)
  playlist = await syncMixedPlaylist(playlist, h.options)
  const describe = h.options.adapters.ytmusic!.describe!
  h.options.adapters.ytmusic!.describe = async (...args) => { await describe(...args); throw Error("Lost response") }
  await expect(syncDraftDetails(playlist, h.options)).rejects.toThrow("Lost response")
  expect(h.saved().detailsWrite).toBeDefined()
  const recovered = await syncDraftDetails(h.saved(), h.options)
  expect(recovered.detailsWrite).toBeUndefined(); expect(h.descriptions()).toBe(1)
})
test("invalid metadata cannot retain active markup artwork or oversized descriptions", () => {
  expect(() => validateDraftMetadata({ ...metadata(), title: " " })).toThrow("playlist name")
  expect(() => validateDraftMetadata({ ...metadata(), description: "x".repeat(5001) })).toThrow("description")
  expect(() => validateDraftMetadata({ ...metadata(), artwork: "data:image/svg+xml;base64,AAAA" })).toThrow("JPEG")
})
test("explicit not-created review archives an unknown receipt but cannot retry a known destination", () => {
  const playlist = newDraft(metadata())
  playlist.write = { id: "unknown", service: "plex", kind: "create", state: "unknown", afterIds: [] }
  const reviewed = reviewUnappliedCreation(playlist)
  expect(reviewed.write).toBeUndefined()
  expect(reviewed.reviewedCreations?.[0].receipt).toEqual(playlist.write)
  playlist.write.destinationId = "known"
  expect(() => reviewUnappliedCreation(playlist)).toThrow("recovered by its ID")
})
