import { expect, test } from "bun:test"
import {
  weeklySourceChannels,
  retainWeeklyHistory,
  WeeklyArchiveCapacityError,
  weeklySourceDescription,
  type WeeklyEdition,
  type WeeklySummary,
} from "../src/playlistSync/weekly"
import {
  retainWeeklyEdition,
  retainLink,
} from "../src/playlistSync/linkedJournal"
import {
  applySequenceOperation,
  canAdvancePartialWeekly,
  playlistContentHash,
  type LinkedPlaylist,
} from "../src/playlistSync/linked"
import {
  checkLinkedPlaylist,
  reconcileLinkedStep,
  type LinkedSyncServices,
} from "../src/playlistSync/linkedExecution"
import type { PlaylistSnapshot } from "../src/playlistSync/types"
const E1 = "11111111-1111-4111-8111-111111111111",
  E2 = "22222222-2222-4222-8222-222222222222",
  A = "33333333-3333-4333-8333-333333333333",
  B = "44444444-4444-4444-8444-444444444444"
const account = { service: "listenbrainz", user: "owner", revision: "lease" },
  libraryAccount = {
    service: "library:Plex",
    user: "scope",
    revision: "library",
  }
const edition = (
  playlistId = E1,
  createdAt = "2026-10-05T05:44:05.503913Z"
): WeeklyEdition => ({
  playlistId,
  family: "weekly-jams",
  recipient: "owner",
  weekOf: "2026-10-05",
  createdAt,
})
const snap = (
  remote: boolean,
  id: string,
  ids: string[],
  description = ""
): PlaylistSnapshot => ({
  account: remote ? account : libraryAccount,
  id,
  title: remote ? "Dated weekly edition" : "My stable weekly playlist",
  description,
  items: ids.map((id, index) => ({
    occurrenceId: String(index),
    track: {
      id,
      title: id,
      artist: "Artist",
      recordingMbid: remote ? id : null,
    },
  })),
})
const summary = (ed: WeeklyEdition): WeeklySummary => ({
  ...snap(true, ed.playlistId, []),
  title: "Identical title",
  weekly: ed,
  access: {
    origins: ["createdfor"],
    creator: "listenbrainz",
    generated: true,
    writable: false,
  },
})
test("two stable weekly families select unique precise timestamps, retain ambiguous editions and never guess from titles", () => {
  const older = edition(E1, "2026-10-05T05:44:05.503912Z"),
    newer = edition(E2)
  const channels = weeklySourceChannels(
    { items: [summary(older), summary(newer)], complete: true },
    account
  )
  expect(channels).toHaveLength(2)
  expect(channels[1].latest?.playlistId).toBe(E2)
  expect(channels[1].editions).toHaveLength(2)
  expect(
    weeklySourceChannels(
      { items: [summary(edition()), summary(edition(E2))], complete: true },
      account
    )[1].status
  ).toBe("ambiguous")
  expect(
    weeklySourceChannels(
      { items: [summary(newer)], complete: false },
      account
    )[1].latest
  ).toBeNull()
  expect(
    weeklySourceChannels(
      {
        items: [
          {
            ...summary(newer),
            access: { ...summary(newer).access, origins: ["created"] },
          },
        ],
        complete: true,
      },
      account
    )[1].status
  ).toBe("unavailable")
  expect(
    weeklySourceChannels(
      { items: [summary(newer)], complete: true },
      { ...account, user: "other" }
    )[1].status
  ).toBe("unavailable")
  expect(weeklySourceDescription({ ...newer, weekOf: null })).toContain(
    "generated 2026-10-05"
  )
})
function harness() {
  let local = snap(false, "local", ["a"]),
    remote = snap(true, E1, [A, B]),
    writes = 0,
    descriptions = 0,
    unknown = false
  const initial: LinkedPlaylist = {
    version: 1,
    revision: 0,
    id: "link",
    library: libraryAccount,
    listenbrainz: account,
    libraryPlaylistId: "local",
    listenbrainzPlaylistId: E1,
    enabled: true,
    paused: false,
    direction: "import",
    automatic: true,
    state: "ready",
    baseline: {
      library: structuredClone(local),
      listenbrainz: snap(true, E1, [A]),
    },
    mappings: [
      {
        libraryTrack: { id: "a", artist: "Artist", title: "A" },
        recordingMbid: A,
        verifiedBy: "reviewed",
      },
      {
        libraryTrack: { id: "b", artist: "Artist", title: "B" },
        recordingMbid: B,
        verifiedBy: "reviewed",
      },
    ],
    weeklySource: {
      family: "weekly-jams",
      recipient: "owner",
      edition: edition(),
    },
  }
  let rows = [initial]
  const services: LinkedSyncServices = {
    current: () => true,
    id: () => "step",
    now: () => 1,
    repository: {
      load: async () => structuredClone(rows),
      save: async (link, revision) => {
        rows = retainLink(rows, link, revision)
        return structuredClone(rows[0])
      },
    },
    library: {
      account: async () => libraryAccount,
      read: async () => structuredClone(local),
      mutate: async (before, operation) => {
        writes++
        local = snap(
          false,
          "local",
          applySequenceOperation(
            before.items.map((item) => item.track.id),
            operation
          ),
          local.description
        )
        return structuredClone(local)
      },
      describe: async (_before, description) => {
        descriptions++
        local = { ...local, description }
        if (unknown) throw Error("Synthetic lost response")
        return structuredClone(local)
      },
    },
    listenbrainz: {
      account: async () => account,
      read: async () => structuredClone(remote),
      mutate: async () => {
        throw Error("Weekly source must never be written")
      },
    },
  }
  return {
    initial,
    services,
    local: () => local,
    rows: () => rows,
    writes: () => writes,
    descriptions: () => descriptions,
    unknown: () => {
      unknown = true
    },
    setRemote: (value: PlaylistSnapshot) => {
      remote = value
    },
    replace: (value: LinkedPlaylist) => {
      rows = [value]
    },
  }
}
test("weekly success requires ordered and description proof; same edition cannot trigger repeat writes", async () => {
  const h = harness(),
    result = await checkLinkedPlaylist(h.initial, h.services)
  expect(result.weeklySource?.lastSyncedEditionId).toBe(E1)
  expect(h.writes()).toBe(1)
  expect(h.descriptions()).toBe(1)
  expect(h.local().title).toBe("My stable weekly playlist")
  expect(h.local().description).toContain("week of 2026-10-05")
  await checkLinkedPlaylist(result, h.services)
  expect(h.writes()).toBe(1)
  expect(h.descriptions()).toBe(1)
})
test("unknown date update blocks completion/rebinding and is only recovered by reads", async () => {
  const h = harness()
  h.unknown()
  const uncertain = await checkLinkedPlaylist(h.initial, h.services)
  expect(uncertain.state).toBe("unknown")
  expect(uncertain.job?.descriptionStep).toBeDefined()
  expect(uncertain.weeklySource?.lastSyncedEditionId).toBeUndefined()
  const hash = await playlistContentHash(uncertain.baseline.listenbrainz)
  expect(() =>
    retainWeeklyEdition(
      [uncertain],
      uncertain.id,
      uncertain.revision,
      edition(E2, "2026-10-12T05:00:00Z"),
      snap(true, E2, [A]),
      h.local(),
      hash
    )
  ).toThrow("progress")
  const recovered = await reconcileLinkedStep(uncertain, h.services)
  expect(recovered.descriptionHistory?.at(-1)?.state).toBe("verified")
  expect(h.descriptions()).toBe(1)
  const resumed = await h.services.repository.save(
    { ...recovered, paused: false },
    recovered.revision
  )
  expect(
    (await checkLinkedPlaylist(resumed, h.services)).weeklySource
      ?.lastSyncedEditionId
  ).toBe(E1)
  expect(h.descriptions()).toBe(1)
})
test("new source binding retains old immutable hash/date and cannot bypass unfinished jobs or target edits", async () => {
  const h = harness(),
    complete = await checkLinkedPlaylist(h.initial, h.services),
    hash = await playlistContentHash(complete.baseline.listenbrainz)
  const next = edition(E2, "2026-10-12T05:00:00Z"),
    source = snap(true, E2, [A])
  const bound = retainWeeklyEdition(
    [complete],
    complete.id,
    complete.revision,
    next,
    source,
    h.local(),
    hash
  )[0]
  expect(bound.libraryPlaylistId).toBe("local")
  expect(bound.weeklySource?.previousEditions?.[0]).toEqual({
    edition: edition(),
    sourceHash: hash,
    syncedAt: 1,
  })
  expect(bound.weeklySource?.pendingSourceSnapshot?.id).toBe(E2)
  expect(complete.listenbrainzPlaylistId).toBe(E1)
  expect(() =>
    retainWeeklyEdition(
      [complete],
      complete.id,
      complete.revision,
      next,
      source,
      { ...h.local(), title: "Edited" },
      hash
    )
  ).toThrow("library changes")
  h.replace(bound)
  h.setRemote(source)
  const applied = await checkLinkedPlaylist(bound, h.services)
  expect(applied.weeklySource?.lastSyncedEditionId).toBe(E2)
  expect(applied.weeklySource?.pendingSourceSnapshot).toBeUndefined()
  expect(applied.history?.[0].weeklyEditionId).toBe(E1)
})
test("unmatched or empty new editions pause without dropping songs or writing dates", async () => {
  for (const ids of [[A, E2], []]) {
    const h = harness()
    h.setRemote(snap(true, E1, ids))
    const result = await checkLinkedPlaylist(h.initial, h.services)
    expect(result.paused).toBe(true)
    expect(h.writes()).toBe(0)
    expect(h.descriptions()).toBe(0)
    expect(h.local().items.map((item) => item.track.id)).toEqual(["a"])
  }
})

test("automatic weekly rollover archives nineteen unmatched occurrences without claiming full success or replaying unknown writes", async () => {
  const h = harness(),
    source = snap(
      true,
      E1,
      Array.from(
        { length: 50 },
        (_, index) =>
          `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`
      )
    )
  const missing = source.items.slice(31).map((item) => item.occurrenceId)
  const partial: LinkedPlaylist = {
    ...h.initial,
    job: undefined,
    paused: true,
    pauseReason: "unmatched",
    state: "conflict",
    message:
      "31 of 50 songs matched. Review unmatched songs; every original occurrence is retained.",
    baseline: {
      ...h.initial.baseline,
      library: h.local(),
      listenbrainz: source,
    },
    incomplete: {
      sourceSnapshot: source,
      matchingDone: true,
      matchingCursor: 50,
      total: 50,
      matchedCount: 31,
      missingOccurrenceIds: missing,
    },
  }
  expect(canAdvancePartialWeekly(partial)).toBe(true)
  expect(
    canAdvancePartialWeekly({
      ...partial,
      paused: false,
      state: "ready",
      pauseReason: undefined,
    })
  ).toBe(true)
  expect(
    canAdvancePartialWeekly({
      ...partial,
      message: "Destination changed during sync. Review both versions.",
    })
  ).toBe(false)
  const nextSource = snap(true, E2, [A, B]),
    nextEdition = edition(E2, "2026-10-12T05:00:00Z")
  const next = retainWeeklyEdition(
    [partial],
    partial.id,
    partial.revision,
    nextEdition,
    nextSource,
    h.local(),
    await playlistContentHash(source)
  )[0]
  expect(next.paused).toBe(false)
  expect(next.weeklySource?.lastSyncedEditionId).toBeUndefined()
  expect(next.weeklySource?.previousEditions?.[0].syncedAt).toBeUndefined()
  expect(
    next.weeklySource?.previousEditions?.[0].missingOccurrences?.map(
      (item) => item.occurrenceId
    )
  ).toEqual(missing)
  expect(next.weeklySource?.previousEditions?.[0].matchedCount).toBe(31)
  expect(next.weeklySource?.previousEditions?.[0].total).toBe(50)
  expect(next.incomplete?.sourceSnapshot.id).toBe(E2)
  expect(canAdvancePartialWeekly({ ...partial, pauseReason: "manual" })).toBe(
    false
  )
  expect(canAdvancePartialWeekly({ ...partial, automatic: false })).toBe(false)
  expect(
    canAdvancePartialWeekly({
      ...partial,
      job: { step: { state: "unknown" } } as any,
    })
  ).toBe(false)
  expect(() =>
    retainWeeklyEdition(
      [
        {
          ...partial,
          job: {
            id: "unknown",
            source: "listenbrainz",
            sourceSnapshot: source,
            destinationSnapshot: h.local(),
            desired: [],
            completedSteps: 0,
            step: { state: "unknown", afterIds: [] },
          } as any,
        },
      ],
      partial.id,
      partial.revision,
      nextEdition,
      nextSource,
      h.local(),
      "0".repeat(64)
    )
  ).toThrow("Review")
  expect(h.writes()).toBe(0)
})

test("a thirty-third unresolved weekly archive refuses rebinding without discarding any prior occurrence", async () => {
  const h = harness(),
    source = snap(true, E1, [A, B])
  const receipts = Array.from({ length: 32 }, (_, index) => ({
    edition: edition(
      `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`
    ),
    sourceHash: "0".repeat(64),
    total: 2,
    matchedCount: 1,
    missingOccurrences: [source.items[1]],
  }))
  const partial: LinkedPlaylist = {
    ...h.initial,
    paused: true,
    pauseReason: "unmatched",
    state: "conflict",
    message:
      "1 of 2 songs matched. Review unmatched songs; every original occurrence is retained.",
    baseline: { library: h.local(), listenbrainz: source },
    weeklySource: { ...h.initial.weeklySource!, previousEditions: receipts },
    incomplete: {
      sourceSnapshot: source,
      matchingDone: true,
      matchingCursor: 2,
      total: 2,
      matchedCount: 1,
      missingOccurrenceIds: [source.items[1].occurrenceId],
    },
  }
  const previous = [partial],
    before = structuredClone(previous)
  expect(() =>
    retainWeeklyEdition(
      previous,
      partial.id,
      partial.revision,
      edition(E2, "2026-10-12T05:00:00Z"),
      snap(true, E2, [A, B]),
      h.local(),
      "0".repeat(64)
    )
  ).toThrow(WeeklyArchiveCapacityError)
  expect(previous).toEqual(before)
  expect(previous[0].weeklySource?.previousEditions).toHaveLength(32)
  expect(previous[0].listenbrainzPlaylistId).toBe(E1)
  expect(h.writes()).toBe(0)
  const settled = Array.from({ length: 32 }, (_, index) => ({
    edition: edition(
      `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`
    ),
    sourceHash: "0".repeat(64),
    syncedAt: 1,
  }))
  const retained = retainWeeklyHistory([receipts[0], ...settled])
  expect(retained).toHaveLength(32)
  expect(retained).toContain(receipts[0])
  expect(retained).not.toContain(settled[0])
})
