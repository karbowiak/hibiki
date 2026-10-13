import { expect, test } from "bun:test"
import {
  resumeInitialMatching,
  canRematchIncomplete,
  revalidateAutomaticMappings,
  matchInitialSync,
} from "../src/playlistSync/initialMatching"
import { providerPlaylistAccount } from "../src/playlistSync/provider"
import {
  applySequenceOperation,
  type LinkedPlaylist,
  playlistContentHash,
} from "../src/playlistSync/linked"
import {
  retainWeeklyEdition,
  retainLink,
} from "../src/playlistSync/linkedJournal"
import type { MusicProvider } from "../src/providers/types"
import type { PlaylistSnapshot } from "../src/playlistSync/types"
function harness(count = 40, repeats = false) {
  let active = 0,
    maxActive = 0,
    calls = 0,
    current = true,
    writes = 0
  const remote = { service: "listenbrainz", user: "owner", revision: "remote" }
  const provider = {
    name: "Plex",
    cacheScope: "scope",
    capabilities: { search: true },
    search: async (query: string) => {
      active++
      maxActive = Math.max(active, maxActive)
      calls++
      await new Promise((resolve) => setTimeout(resolve, 1))
      active--
      const number = Number(query.split(" ").at(-1))
      if (number === count - 1) return []
      const item = {
        type: "track",
        id: String(number),
        title: `Song ${number}`,
        artistName: "Artist",
        albumName: "Album",
        duration: 180000,
      }
      return [item, item]
    },
  } as unknown as MusicProvider
  const localAccount = providerPlaylistAccount(provider)
  const mbid = (i: number) =>
    `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`
  const source: PlaylistSnapshot = {
    id: "11111111-1111-4111-8111-111111111111",
    account: remote,
    title: "Source",
    items: Array.from({ length: count }, (_, i) => ({
      occurrenceId: String(i),
      track: {
        id: mbid(i),
        recordingMbid: mbid(i),
        artist: "Artist",
        title: `Song ${i}`,
        durationMs: 180000,
      },
    })),
  }
  if (repeats)
    source.items = [
      ...source.items,
      { ...source.items[0], occurrenceId: "repeat" },
    ]
  let local: PlaylistSnapshot = {
    id: "local",
    account: localAccount,
    title: "Destination",
    items: [],
  }
  let rows: LinkedPlaylist[] = [
    {
      version: 1,
      revision: 0,
      id: "link",
      library: localAccount,
      listenbrainz: remote,
      libraryPlaylistId: "local",
      listenbrainzPlaylistId: source.id,
      enabled: true,
      paused: false,
      direction: "import",
      automatic: false,
      state: "ready",
      mappings: [],
      baseline: { library: structuredClone(local), listenbrainz: source },
      incomplete: {
        sourceSnapshot: source,
        total: source.items.length,
        matchedCount: 0,
        missingOccurrenceIds: source.items.map((x) => x.occurrenceId),
        matchingCursor: 0,
        matchingDone: false,
      },
    },
  ]
  const repository = {
    load: async () => structuredClone(rows),
    save: async (link: LinkedPlaylist, revision: number | null) => {
      rows = retainLink(rows, link, revision)
      return structuredClone(rows[0])
    },
  }
  const services = async () => ({
    current: () => current,
    repository,
    library: {
      preservesDuplicateOccurrences: false,
      account: async () => localAccount,
      read: async () => structuredClone(local),
      describe: async (_before: PlaylistSnapshot, description: string) => {
        local = { ...local, description }
        return structuredClone(local)
      },
      mutate: async (before: PlaylistSnapshot, operation: any) => {
        writes++
        const ids = applySequenceOperation(
          before.items.map((x) => x.track.id),
          operation
        )
        local = {
          ...local,
          items: ids.map((id, index) => ({
            occurrenceId: String(index),
            track: { id, title: `Song ${id}`, artist: "Artist" },
          })),
        }
        return structuredClone(local)
      },
    },
    listenbrainz: {
      account: async () => remote,
      read: async () => structuredClone(source),
      mutate: async () => {
        throw Error("No remote writes")
      },
    },
  })
  return {
    provider,
    repository,
    services,
    current: () => current,
    retire: () => {
      current = false
    },
    link: () => rows[0],
    local: () => local,
    source,
    setLocal: (value: PlaylistSnapshot) => {
      local = value
    },
    replace: (value: LinkedPlaylist) => {
      rows = [value]
    },
    calls: () => calls,
    maxActive: () => maxActive,
    writes: () => writes,
  }
}
test("selected forty-song imports continue through batches, bound concurrency, and retain unmatched songs", async () => {
  const h = harness()
  await matchInitialSync(
    "link",
    h.provider,
    h.repository,
    h.current,
    h.services
  )
  expect(h.calls()).toBe(41)
  expect(h.maxActive()).toBeLessThanOrEqual(3)
  expect(h.local().items).toHaveLength(39)
  expect(h.link().incomplete?.matchingDone).toBe(true)
  expect(h.link().incomplete?.matchingCursor).toBe(40)
  expect(h.link().incomplete?.missingOccurrenceIds).toEqual(["39"])
  expect(h.link().paused).toBe(true)
  expect(h.link().incomplete?.sourceSnapshot.items).toHaveLength(40)
})
test("Plex fills reliable distinct occurrences while retaining repeats as unsupported review rows", async () => {
  const h = harness(3, true)
  await matchInitialSync(
    "link",
    h.provider,
    h.repository,
    h.current,
    h.services
  )
  expect(h.local().items.map((x) => x.track.id)).toEqual(["0", "1"])
  expect(h.link().incomplete?.missingOccurrenceIds).toEqual(["2", "repeat"])
  expect(h.link().incomplete?.unsupportedRepeatOccurrenceIds).toEqual([
    "repeat",
  ])
  expect(h.link().incomplete?.matchedCount).toBe(2)
  expect(h.link().paused).toBe(true)
})
test("late search responses from a retired owner cannot retain mappings or issue writes", async () => {
  const h = harness(3),
    original = h.provider.search
  h.provider.search = async (...args) => {
    const response = await original(...args)
    h.retire()
    return response
  }
  await expect(
    matchInitialSync("link", h.provider, h.repository, h.current, h.services)
  ).rejects.toThrow("owner changed")
  expect(h.link().mappings).toHaveLength(0)
  expect(h.writes()).toBe(0)
})
test("a new forty-song weekly edition retains its full source and receives background matching without claiming completion", async () => {
  const h = harness(),
    oldId = "22222222-2222-4222-8222-222222222222"
  const oldEdition = {
    family: "weekly-jams" as const,
    recipient: "owner",
    playlistId: oldId,
    createdAt: "2026-10-05T05:00:00Z",
    weekOf: "2026-10-05",
  }
  const previous = {
    ...h.link(),
    incomplete: undefined,
    baseline: {
      ...h.link().baseline,
      listenbrainz: { ...h.source, id: oldId, items: [] },
    },
    listenbrainzPlaylistId: oldId,
    weeklySource: {
      family: oldEdition.family,
      recipient: "owner",
      edition: oldEdition,
      lastSyncedEditionId: oldId,
    },
  }
  const edition = {
    ...oldEdition,
    playlistId: h.source.id,
    createdAt: "2026-10-12T05:00:00Z",
    weekOf: "2026-10-12",
  }
  const rebound = retainWeeklyEdition(
    [previous],
    previous.id,
    previous.revision,
    edition,
    h.source,
    h.local(),
    await playlistContentHash(previous.baseline.listenbrainz)
  )[0]
  expect(rebound.incomplete?.matchingDone).toBe(false)
  h.replace(rebound)
  await matchInitialSync(
    "link",
    h.provider,
    h.repository,
    h.current,
    h.services
  )
  expect(h.calls()).toBe(41)
  expect(h.local().items).toHaveLength(39)
  expect(h.link().incomplete?.sourceSnapshot.items).toHaveLength(40)
  expect(h.link().weeklySource?.lastSyncedEditionId).toBe(oldId)
  expect(h.local().description).toContain("Incomplete: 39 of 40")
  expect(h.link().weeklySource?.previousEditions).toHaveLength(1)
})
test("a failed lookup cannot prevent reliable matches in its batch from being filled", async () => {
  const h = harness(4),
    original = h.provider.search
  h.provider.search = async (...args) => {
    if (args[0].endsWith(" 1")) throw Error("Temporary search failure")
    return original(...args)
  }
  await matchInitialSync(
    "link",
    h.provider,
    h.repository,
    h.current,
    h.services
  )
  expect(h.local().items.map((item) => item.track.id)).toEqual(["0", "2"])
  expect(h.link().incomplete?.missingOccurrenceIds).toEqual(["1", "3"])
  expect(h.link().incomplete?.matchingCursor).toBe(0)
  expect(h.link().incomplete?.matchingDone).toBe(false)
  expect(h.link().paused).toBe(true)
  expect(h.link().state).toBe("error")
})
test("title fallback finds a reliable track when combined search returns unrelated nonempty results", async () => {
  const h = harness(2),
    original = h.provider.search
  h.provider.search = async (...args) =>
    args[0].startsWith("Artist ")
      ? [
          {
            type: "track",
            id: "unrelated",
            title: "Something else",
            artistName: "Another artist",
            duration: 180000,
          } as any,
        ]
      : original(...args)
  await matchInitialSync(
    "link",
    h.provider,
    h.repository,
    h.current,
    h.services
  )
  expect(h.local().items.map((item) => item.track.id)).toEqual(["0"])
  expect(h.link().incomplete?.missingOccurrenceIds).toEqual(["1"])
})

test("failed combined queries recover with title lookups and continue every selected batch", async () => {
  const h = harness(40),
    original = h.provider.search
  h.provider.search = async (...args) => {
    if (args[0].startsWith("Artist ")) throw Error("Combined query unavailable")
    return original(...args)
  }
  await matchInitialSync(
    "link",
    h.provider,
    h.repository,
    h.current,
    h.services
  )
  expect(h.local().items).toHaveLength(39)
  expect(h.link().incomplete?.matchingCursor).toBe(40)
  expect(h.link().incomplete?.matchingDone).toBe(true)
  expect(h.link().state).toBe("conflict")
  expect(h.link().incomplete?.missingOccurrenceIds).toEqual(["39"])
})
test("retry lookup preserves cursor and never resumes unknown writes or content conflicts", () => {
  const h = harness(3),
    link = { ...h.link(), paused: true, state: "error" as const }
  const resumed = resumeInitialMatching(link)
  expect(resumed.paused).toBe(false)
  expect(resumed.incomplete).toEqual(link.incomplete)
  expect(() => resumeInitialMatching({ ...link, state: "conflict" })).toThrow(
    "Review"
  )
  expect(() =>
    resumeInitialMatching({
      ...link,
      incomplete: { ...link.incomplete!, matchingDone: true },
    })
  ).toThrow("Review")
  expect(() =>
    resumeInitialMatching({
      ...link,
      job: { step: { state: "unknown" } } as any,
    })
  ).toThrow("Review")
  expect(() =>
    resumeInitialMatching({
      ...link,
      job: { descriptionStep: { state: "unknown" } } as any,
    })
  ).toThrow("Review")
})

test("stale automatic remix mappings are researched and corrected through the journaled import", async () => {
  const h = harness(2),
    source = h.source.items[0].track
  const wrong = {
    id: "remix",
    recordingMbid: source.recordingMbid,
    title: source.title,
    artist: source.artist,
    album: `${source.title} (Remix)`,
    durationMs: source.durationMs,
  }
  const local = {
    ...h.local(),
    items: [{ occurrenceId: "existing", track: wrong }],
  }
  h.setLocal(local)
  h.replace({
    ...h.link(),
    baseline: { ...h.link().baseline, library: structuredClone(local) },
    mappings: [
      {
        recordingMbid: source.recordingMbid!,
        libraryTrack: wrong,
        verifiedBy: "metadata",
        score: 1,
      },
    ],
  })
  await matchInitialSync(
    "link",
    h.provider,
    h.repository,
    h.current,
    h.services
  )
  expect(h.local().items.map((item) => item.track.id)).toEqual(["0"])
  expect(
    h.link().mappings.some((mapping) => mapping.libraryTrack.id === "remix")
  ).toBe(false)
  expect(h.link().mappings[0].libraryTrack.id).toBe("0")
  expect(h.writes()).toBeGreaterThan(0)
  expect(h.link().history?.every((step) => step.state === "verified")).toBe(
    true
  )
  expect(h.link().incomplete?.missingOccurrenceIds).toEqual(["1"])
})
test("automatic revalidation preserves reviewed/provider identities and admitted immutable jobs", () => {
  const h = harness(2),
    source = h.source.items[0].track
  const stale = {
    recordingMbid: source.recordingMbid!,
    libraryTrack: {
      id: "remix",
      title: source.title,
      artist: source.artist,
      album: `${source.title} (Remix)`,
      durationMs: source.durationMs,
    },
    verifiedBy: "metadata" as const,
  }
  const mappings = [
    stale,
    {
      ...stale,
      libraryTrack: { ...stale.libraryTrack, id: "reviewed" },
      verifiedBy: "reviewed" as const,
    },
    {
      ...stale,
      libraryTrack: { ...stale.libraryTrack, id: "mbid" },
      verifiedBy: "provider-mbid" as const,
    },
  ]
  const link = { ...h.link(), mappings }
  expect(
    revalidateAutomaticMappings(link).map((mapping) => mapping.libraryTrack.id)
  ).toEqual(["reviewed", "mbid"])
  expect(revalidateAutomaticMappings({ ...link, job: {} as any })).toBe(
    mappings
  )
})

test("explicit completed-partial rematch preserves manual mappings, resets lookup progress, and refuses drift/unknown/manual pauses", async () => {
  const h = harness(3),
    partial = {
      ...h.link().incomplete!,
      matchingDone: true,
      matchingCursor: 3,
      matchedCount: 0,
    }
  const complete = {
    ...h.link(),
    paused: true,
    state: "conflict" as const,
    incomplete: partial,
    message:
      "0 of 3 songs matched. Review unmatched songs; every original occurrence is retained.",
  }
  expect(canRematchIncomplete(complete)).toBe(true)
  const resumed = resumeInitialMatching(complete)
  expect(resumed.incomplete?.matchingCursor).toBe(0)
  expect(resumed.incomplete?.matchingDone).toBe(false)
  expect(resumed.mappings).toBe(complete.mappings)
  expect(() =>
    resumeInitialMatching({ ...complete, pauseReason: "manual" })
  ).toThrow("Review")
  expect(() =>
    resumeInitialMatching({
      ...complete,
      message: "Source changed during sync",
    })
  ).toThrow("Review")
  expect(() =>
    resumeInitialMatching({
      ...complete,
      job: { step: { state: "unknown" } } as any,
    })
  ).toThrow("Review")
  h.replace(resumed)
  await matchInitialSync(
    "link",
    h.provider,
    h.repository,
    h.current,
    h.services
  )
  expect(h.local().items).toHaveLength(2)
  expect(h.link().pauseReason).toBe("unmatched")
})
test("explicit rematch never writes when the fresh source differs from the admitted edition", async () => {
  const h = harness(3),
    partial = {
      ...h.link().incomplete!,
      matchingDone: true,
      matchingCursor: 3,
      matchedCount: 0,
    }
  const complete = {
    ...h.link(),
    paused: true,
    state: "conflict" as const,
    incomplete: partial,
    message:
      "0 of 3 songs matched. Review unmatched songs; every original occurrence is retained.",
  }
  h.replace(resumeInitialMatching(complete))
  const services = async () => {
    const service = await h.services()
    service.listenbrainz.read = async () => ({
      ...h.source,
      items: h.source.items.slice(0, 1),
    })
    return service
  }
  await matchInitialSync("link", h.provider, h.repository, h.current, services)
  expect(h.writes()).toBe(0)
  expect(h.link().state).toBe("conflict")
  expect(h.link().message).toContain("admitted source changed")
  expect(canRematchIncomplete(h.link())).toBe(false)
})
