import { expect, test } from "bun:test"
import {
  checkLinkedPlaylist,
  reconcileLinkedStep,
  archiveReviewedLinkedStep,
  type LinkedPlaylistAdapter,
} from "../src/playlistSync/linkedExecution"
import {
  retainLink,
  type LinkedPlaylistRepository,
} from "../src/playlistSync/linkedJournal"
import {
  applySequenceOperation,
  type LinkedPlaylist,
} from "../src/playlistSync/linked"
import type { PlaylistSnapshot } from "../src/playlistSync/types"
const A = "11111111-1111-4111-8111-111111111111",
  B = "22222222-2222-4222-8222-222222222222"
const account = (service: string) => ({
  service,
  user: "owner",
  revision: "current-lease",
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
function harness() {
  let local = snapshot("library", ["a", "b", "a"]),
    remote = snapshot("listenbrainz", [A]),
    calls = 0,
    failSave = false,
    unknown = false,
    current = true
  const initial: LinkedPlaylist = {
    version: 1,
    revision: 0,
    id: "link",
    library: account("library"),
    listenbrainz: account("listenbrainz"),
    libraryPlaylistId: "library",
    listenbrainzPlaylistId: "listenbrainz",
    enabled: true,
    direction: "bidirectional",
    paused: false,
    state: "ready",
    baseline: {
      library: snapshot("library", ["a"]),
      listenbrainz: structuredClone(remote),
    },
    mappings: [
      {
        libraryTrack: { id: "a", title: "A", artist: "Artist" },
        recordingMbid: A,
        verifiedBy: "reviewed",
      },
      {
        libraryTrack: { id: "b", title: "B", artist: "Artist" },
        recordingMbid: B,
        verifiedBy: "reviewed",
      },
    ],
  }
  let rows = [initial]
  const repository: LinkedPlaylistRepository = {
    load: async () => structuredClone(rows),
    save: async (link, revision) => {
      if (failSave) throw Error("Synthetic durability failure")
      rows = retainLink(rows, link, revision)
      return structuredClone(rows[0])
    },
  }
  const adapter = (
    side: "library" | "listenbrainz"
  ): LinkedPlaylistAdapter => ({
    account: async () => account(side),
    read: async () => structuredClone(side === "library" ? local : remote),
    mutate: async (before, operation) => {
      calls++
      const after = applySequenceOperation(
        before.items.map((item) => item.track.id),
        operation
      )
      if (side === "library") local = snapshot(side, after)
      else remote = snapshot(side, after)
      if (unknown) throw Error("Synthetic lost response")
      return structuredClone(side === "library" ? local : remote)
    },
  })
  return {
    initial,
    services: {
      repository,
      library: adapter("library"),
      listenbrainz: adapter("listenbrainz"),
      current: () => current,
      id: () => `id-${calls}`,
      now: () => 1,
    },
    rows: () => rows,
    calls: () => calls,
    remote: () => remote,
    local: () => local,
    failSave: () => {
      failSave = true
    },
    unknown: () => {
      unknown = true
    },
    retire: () => {
      current = false
    },
    changeRemote: (ids: string[]) => {
      remote = snapshot("listenbrainz", ids)
    },
  }
}
test("linked execution propagates one-side duplicate additions and only advances baseline after proof", async () => {
  const h = harness()
  const result = await checkLinkedPlaylist(h.initial, h.services)
  expect(h.remote().items.map((item) => item.track.id)).toEqual([A, B, A])
  expect(h.calls()).toBe(2)
  expect(result.job).toBeUndefined()
  expect(result.lastSyncAt).toBe(1)
  // Remote deletion then flows back to library without deduplicating remaining occurrences.
  h.changeRemote([A, A])
  const imported = await checkLinkedPlaylist(result, h.services)
  expect(h.local().items.map((item) => item.track.id)).toEqual(["a", "a"])
  expect(imported.job).toBeUndefined()
})
test("Plex duplicate limitation pauses before writes and preserves existing occurrences", async () => {
  const h = harness()
  h.initial.baseline.library = structuredClone(h.local())
  h.services.library.preservesDuplicateOccurrences = false
  h.changeRemote([A, B, A, A])
  const result = await checkLinkedPlaylist(h.initial, h.services)
  expect(result.state).toBe("conflict")
  expect(result.paused).toBe(true)
  expect(result.message).toContain("Plex cannot safely apply repeated songs")
  expect(h.calls()).toBe(0)
  expect(h.local().items.map((item) => item.track.id)).toEqual(["a", "b", "a"])
})
test("default export never downsyncs remote edits and legacy import job cannot write into Plex", async () => {
  const h = harness()
  delete h.initial.direction
  h.initial.baseline.library = structuredClone(h.local())
  h.changeRemote([A, B])
  const conflict = await checkLinkedPlaylist(h.initial, h.services)
  expect(conflict.paused).toBe(true)
  expect(conflict.state).toBe("conflict")
  expect(h.calls()).toBe(0)
  const other = harness()
  delete other.initial.direction
  other.initial.job = {
    id: "old-import",
    source: "listenbrainz",
    sourceSnapshot: structuredClone(other.remote()),
    destinationSnapshot: structuredClone(other.local()),
    desired: [other.local().items[0].track],
    completedSteps: 0,
  }
  const stopped = await checkLinkedPlaylist(other.initial, other.services)
  expect(stopped.paused).toBe(true)
  expect(stopped.message).toContain("configured direction")
  expect(other.calls()).toBe(0)
})
test("explicit import applies remote-only changes while default export retains read-only old-step recovery", async () => {
  const h = harness()
  h.initial.direction = "import"
  h.initial.baseline.library = structuredClone(h.local())
  h.changeRemote([A, B])
  const result = await checkLinkedPlaylist(h.initial, h.services)
  expect(result.state).toBe("ready")
  expect(h.calls()).toBe(1)
  expect(h.local().items.map((item) => item.track.id)).toEqual(["a", "b"])
  expect(h.remote().items.map((item) => item.track.id)).toEqual([A, B])
  const recovery = harness()
  delete recovery.initial.direction
  const before = snapshot("library", ["a", "b"])
  recovery.initial.job = {
    id: "old",
    source: "listenbrainz",
    sourceSnapshot: structuredClone(recovery.remote()),
    destinationSnapshot: before,
    desired: recovery.local().items.map((item) => item.track),
    completedSteps: 0,
    step: {
      id: "old-step",
      before,
      afterIds: ["a", "b", "a"],
      operation: { kind: "append", trackId: "a" },
      state: "unknown",
    },
  }
  const recovered = await checkLinkedPlaylist(
    recovery.initial,
    recovery.services
  )
  expect(recovered.history?.[0].state).toBe("verified")
  expect(recovered.job).toBeUndefined()
  expect(recovery.calls()).toBe(0)
})
test("already identical duplicate target is read-only verified even with Plex limitation", async () => {
  const h = harness()
  h.initial.baseline.library = structuredClone(h.local())
  h.services.library.preservesDuplicateOccurrences = false
  h.changeRemote([A, B, A])
  const result = await checkLinkedPlaylist(h.initial, h.services)
  expect(result.state).toBe("ready")
  expect(result.paused).toBe(false)
  expect(result.job).toBeUndefined()
  expect(h.calls()).toBe(0)
})
test("durability failure before admission sends no mutations", async () => {
  const h = harness()
  h.failSave()
  await expect(checkLinkedPlaylist(h.initial, h.services)).rejects.toThrow(
    "durability"
  )
  expect(h.calls()).toBe(0)
})
test("unknown applied mutation remains retained and paused; repeated checks never retry", async () => {
  const h = harness()
  h.unknown()
  const result = await checkLinkedPlaylist(h.initial, h.services)
  expect(result.state).toBe("unknown")
  expect(result.paused).toBe(true)
  expect(result.job?.step?.state).toBe("unknown")
  expect(h.calls()).toBe(1)
  await checkLinkedPlaylist(result, h.services)
  expect(h.calls()).toBe(1)
  expect(h.rows()[0].job?.step?.afterIds).toEqual([A, B])
})
test("both-side edits stop without destination writes, and stale repository revisions reject parallel owners", async () => {
  const h = harness()
  h.changeRemote([B])
  const result = await checkLinkedPlaylist(h.initial, h.services)
  expect(result.state).toBe("conflict")
  expect(h.calls()).toBe(0)
  await expect(h.services.repository.save(h.initial, 0)).rejects.toThrow(
    "changed"
  )
})
test("retired runtime cannot admit or retain a mutation", async () => {
  const h = harness()
  h.retire()
  await expect(checkLinkedPlaylist(h.initial, h.services)).rejects.toThrow(
    "session changed"
  )
  expect(h.calls()).toBe(0)
})

test("unknown applied update reconciles by read proof without replaying the mutation", async () => {
  const h = harness()
  h.unknown()
  const uncertain = await checkLinkedPlaylist(h.initial, h.services)
  const recovered = await reconcileLinkedStep(uncertain, h.services)
  expect(h.calls()).toBe(1)
  expect(recovered.paused).toBe(true)
  expect(recovered.job?.step).toBeUndefined()
  expect(recovered.history?.at(-1)?.state).toBe("verified")
})
test("diverged recovery requires reviewed current data and rejects a stale review without writes", async () => {
  const h = harness()
  h.unknown()
  const uncertain = await checkLinkedPlaylist(h.initial, h.services)
  h.changeRemote([B, A, B])
  await expect(reconcileLinkedStep(uncertain, h.services)).rejects.toThrow(
    "differs"
  )
  const reviewed = h.remote()
  h.changeRemote([B, B])
  await expect(
    archiveReviewedLinkedStep(uncertain, h.services, reviewed)
  ).rejects.toThrow("changed")
  const archived = await archiveReviewedLinkedStep(
    uncertain,
    h.services,
    h.remote()
  )
  expect(archived.paused).toBe(true)
  expect(archived.job?.step).toBeUndefined()
  expect(archived.history?.at(-1)?.state).toBe("reviewed-current")
  expect(h.calls()).toBe(1)
})
test("bounded work retains a resumable cursor and does not advance baseline prematurely", async () => {
  const h = harness()
  const partial = await checkLinkedPlaylist(h.initial, h.services, 1)
  expect(h.calls()).toBe(1)
  expect(partial.job?.completedSteps).toBe(1)
  expect(partial.lastSyncAt).toBeUndefined()
  const complete = await checkLinkedPlaylist(partial, h.services, 1)
  expect(h.calls()).toBe(2)
  expect(complete.job?.completedSteps).toBe(2)
  const finalized = await checkLinkedPlaylist(complete, h.services, 1)
  expect(finalized.job).toBeUndefined()
  expect(h.calls()).toBe(2)
  expect(h.remote().items.map((item) => item.track.id)).toEqual([A, B, A])
})

test("smart library snapshots export dynamic duplicate occurrences without any local write", async () => {
  const h = harness()
  h.initial.direction = "export"
  h.local().readOnly = true
  h.services.library.mutate = async () => {
    throw Error("Smart source must never be changed")
  }
  const result = await checkLinkedPlaylist(h.initial, h.services)
  expect(h.remote().items.map((item) => item.track.id)).toEqual([A, B, A])
  expect(h.local().items.map((item) => item.track.id)).toEqual(["a", "b", "a"])
  expect(result.baseline.library.readOnly).toBe(true)
  expect(result.job).toBeUndefined()
})
test("fresh smart flag retires an existing ordinary import or two-way link before any mutation", async () => {
  for (const direction of ["import", "bidirectional"] as const) {
    const h = harness()
    h.initial.direction = direction
    h.initial.baseline.library = structuredClone(h.local())
    h.changeRemote([A, B])
    h.local().readOnly = true
    const result = await checkLinkedPlaylist(h.initial, h.services)
    expect(result.paused).toBe(true)
    expect(result.message).toContain("Smart playlists support")
    expect(h.calls()).toBe(0)
    expect(h.local().items.map((item) => item.track.id)).toEqual([
      "a",
      "b",
      "a",
    ])
  }
})
