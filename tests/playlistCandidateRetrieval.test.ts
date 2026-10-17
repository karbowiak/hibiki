import { test, expect } from "bun:test"
import type { MusicProvider } from "../src/providers/types"
import {
  retrievePlaylistCandidates,
  candidateQueryKey,
} from "../src/playlistSync/candidateRetrieval"
import { matchTrack } from "../src/playlistSync/matching"
const mbid = "11111111-1111-4111-8111-111111111111"
const source = {
  id: mbid,
  title: "Shared Title",
  artist: "Correct Artist",
  durationMs: 180000,
  recordingMbid: mbid,
}
const row = (
  id: string,
  artistName = "Correct Artist",
  title = "Shared Title",
  duration = 180000
) => ({
  id,
  type: "track",
  title,
  artistName,
  albumName: "Album",
  duration,
  guid: `mbid://${mbid}`,
})
const provider = (overrides: any = {}) =>
  ({
    cacheScope: "scope",
    playbackSession: "session",
    search: async () => [row("1", "Other Artist")],
    ...overrides,
  }) as unknown as MusicProvider

test("bounded artist discovery recovers a track absent from crowded broad search without promoting raw GUIDs", async () => {
  const calls: any[] = []
  const p = provider({
    findPlaylistCandidates: async (s: any) => {
      calls.push(s)
      return {
        tracks: [row("10"), row("11", "Correct Artist", "Shared Title (Live)")],
        truncated: false,
        unavailable: false,
      }
    },
  })
  const candidates = await retrievePlaylistCandidates(p, source, () => true)
  expect(calls).toHaveLength(1)
  expect(calls[0].recordingMbid).toBe(mbid)
  expect(candidates.every((c) => c.recordingMbid === null)).toBe(true)
  const match = matchTrack(source, candidates)
  expect(match.status).toBe("matched")
  if (match.status === "matched") {
    expect(match.track.id).toBe("10")
    expect(match.by).toBe("metadata")
  }
})
test("scoped version and duration mismatches stay unmatched", async () => {
  const p = provider({
    findPlaylistCandidates: async () => ({
      tracks: [
        row("10", "Correct Artist", "Shared Title (Remix)"),
        row("11", "Correct Artist", "Shared Title", 300000),
      ],
      truncated: false,
      unavailable: false,
    }),
  })
  expect(
    matchTrack(source, await retrievePlaylistCandidates(p, source, () => true))
      .status
  ).toBe("missing")
})
test("truncated, partially unavailable and excessive catalogues cannot confer automatic selection", async () => {
  for (const result of [
    { tracks: [row("10")], truncated: true, unavailable: false },
    { tracks: [row("10")], truncated: false, unavailable: true },
    {
      tracks: Array.from({ length: 201 }, (_, i) => row(String(i + 10))),
      truncated: false,
      unavailable: false,
    },
  ]) {
    const candidates = await retrievePlaylistCandidates(
      provider({ findPlaylistCandidates: async () => result }),
      source,
      () => true
    )
    expect(candidates.map((c) => c.id)).toEqual(["1"])
  }
})
test("an owned usable scoped lookup recovers both failed broad requests; no fallback when broad evidence already matches", async () => {
  let calls = 0
  const p = provider({
    search: async () => {
      throw Error("unavailable")
    },
    findPlaylistCandidates: async () => {
      calls++
      return { tracks: [row("10")], truncated: false, unavailable: false }
    },
  })
  expect(
    matchTrack(source, await retrievePlaylistCandidates(p, source, () => true))
      .status
  ).toBe("matched")
  expect(calls).toBe(1)
  await retrievePlaylistCandidates(
    provider({
      search: async () => [row("1")],
      findPlaylistCandidates: async () => {
        throw Error("must not run")
      },
    }),
    source,
    () => true
  )
})
test("late scoped response is retired after provider/session replacement", async () => {
  let done!: (value: any) => void
  const p = provider({
    findPlaylistCandidates: () =>
      new Promise((r) => {
        done = r
      }),
  })
  let current = true
  const pending = retrievePlaylistCandidates(p, source, () => current)
  await new Promise((r) => setTimeout(r, 0))
  current = false
  done({ tracks: [row("10")], truncated: false, unavailable: false })
  await expect(pending).rejects.toThrow("owner changed")
})
test("distinct recording references never share a discovery query key", () => {
  expect(candidateQueryKey(source)).not.toBe(
    candidateQueryKey({
      ...source,
      recordingMbid: "22222222-2222-4222-8222-222222222222",
    })
  )
})
test("artist-prefixed titles and feature credits produce usable bounded discovery queries", async () => {
  const calls: string[] = []
  const p = provider({
    search: async (query: string) => {
      calls.push(query)
      return query === "Mirror"
        ? [row("10", "Lil Wayne feat. Bruno Mars", "Mirror")]
        : []
    },
  })
  const recording = {
    ...source,
    title: "Lil Wayne - Mirror (feat. Bruno Mars)",
    artist: "Lil Wayne",
    durationMs: null,
  }
  const candidates = await retrievePlaylistCandidates(p, recording, () => true)
  expect(calls).toEqual(["Lil Wayne Mirror", "Mirror"])
  expect(matchTrack(recording, candidates)).toMatchObject({
    status: "matched",
    track: { id: "10" },
  })
})
