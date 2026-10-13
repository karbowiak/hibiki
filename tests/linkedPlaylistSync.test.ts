import { expect, test } from "bun:test"
import {
  applySequenceOperation,
  nextSequenceOperation,
  decideLinkedSync,
  mapLinkedTracks,
  playlistContentHash,
  type LinkedPlaylist,
} from "../src/playlistSync/linked"
import type { PlaylistSnapshot } from "../src/playlistSync/types"
const mbid = "11111111-1111-4111-8111-111111111111"
const account = (service: string, user = "user", revision = "lease-one") => ({
  service,
  user,
  revision,
})
const snapshot = (service: string, ids: string[]): PlaylistSnapshot => ({
  account: account(service),
  id: service,
  title: "Playlist",
  items: ids.map((id, index) => ({
    occurrenceId: String(index),
    track: {
      id,
      title: id,
      artist: "Artist",
      recordingMbid: service === "listenbrainz" ? id : null,
    },
  })),
})
const link = (): LinkedPlaylist => ({
  version: 1,
  revision: 0,
  id: "link",
  library: account("library"),
  listenbrainz: account("listenbrainz"),
  libraryPlaylistId: "library",
  listenbrainzPlaylistId: "listenbrainz",
  enabled: true,
  paused: false,
  baseline: {
    library: snapshot("library", ["a", "a"]),
    listenbrainz: snapshot("listenbrainz", [mbid, mbid]),
  },
  mappings: [
    {
      libraryTrack: { id: "a", title: "A", artist: "Artist" },
      recordingMbid: mbid,
      verifiedBy: "reviewed",
    },
  ],
  state: "ready",
})
test("one-step transformations preserve duplicate occurrence order without clearing playlists", () => {
  for (const [before, target] of [
    [
      ["a", "b", "a"],
      ["a", "a", "b", "a"],
    ],
    [
      ["x", "y"],
      ["a", "b"],
    ],
    [
      ["a", "a", "b"],
      ["b", "a"],
    ],
    [["a"], []],
  ]) {
    let current = before
    for (let count = 0; count < 30; count++) {
      const step = nextSequenceOperation(current, target)
      if (!step) break
      current = applySequenceOperation(current, step)
    }
    expect(current).toEqual(target)
  }
  const full = Array.from({ length: 1000 }, (_, i) => String(i)),
    target = ["new", ...full.slice(0, 999)]
  const operation = nextSequenceOperation(full, target)!
  expect(operation).toEqual({ kind: "delete", index: 999 })
  expect(applySequenceOperation(full, operation)).toHaveLength(999)
})
test("durable ownership allows fresh same-account leases but retires changed identities and conflicts", () => {
  const l = link(),
    local = snapshot("library", ["a", "a"]),
    remote = snapshot("listenbrainz", [mbid, mbid])
  remote.account.revision = "rotated"
  expect(decideLinkedSync(l, local, remote).status).toBe("idle")
  remote.items.pop()
  expect(decideLinkedSync(l, local, remote)).toMatchObject({
    status: "update",
    source: "listenbrainz",
    desired: [{ id: "a" }],
  })
  local.items.pop()
  expect(decideLinkedSync(l, local, remote).status).toBe("conflict")
  remote.account.user = "another"
  expect(decideLinkedSync(l, local, remote).status).toBe("retired")
})
test("ambiguous duplicate recording-to-library mappings require review, never arbitrary first matches", () => {
  const mappings = [
    ...link().mappings,
    {
      libraryTrack: { id: "alternate", title: "A", artist: "Artist" },
      recordingMbid: mbid,
      verifiedBy: "reviewed" as const,
    },
  ]
  expect(
    mapLinkedTracks(
      "listenbrainz",
      snapshot("listenbrainz", [mbid, mbid]),
      mappings
    ).missing
  ).toEqual([0, 1])
  expect(
    mapLinkedTracks(
      "library",
      snapshot("library", ["a", "a"]),
      mappings
    ).desired.map((t) => t.id)
  ).toEqual([mbid, mbid])
})
test("content hashes preserve duplicates/order and ignore transient occurrence handles", async () => {
  const a = snapshot("library", ["a", "a", "b"]),
    b = structuredClone(a)
  b.items[0].occurrenceId = "fresh-server-id"
  expect(await playlistContentHash(a)).toBe(await playlistContentHash(b))
  b.items.reverse()
  expect(await playlistContentHash(a)).not.toBe(await playlistContentHash(b))
})
test("explicit connection rebind retains provenance and cannot steal an already linked destination", async () => {
  const { retainReboundLink } =
    await import("../src/playlistSync/linkedJournal")
  const original = link(),
    nextAccount = account("library", "new-connection")
  const rebound = retainReboundLink([original], original.id, 0, nextAccount)[0]
  expect(rebound.library.user).toBe("new-connection")
  expect(rebound.previousLibraryOwners).toEqual([original.library])
  expect(rebound.paused).toBe(true)
  const competing = {
    ...link(),
    id: "other",
    library: nextAccount,
    listenbrainzPlaylistId: "other-remote",
  }
  expect(() =>
    retainReboundLink([original, competing], original.id, 0, nextAccount)
  ).toThrow("already linked")
  expect(() =>
    retainReboundLink([original], original.id, 1, nextAccount)
  ).toThrow("original connection")
})
