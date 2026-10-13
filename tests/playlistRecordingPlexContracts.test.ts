import { test, expect } from "bun:test"
import {
  createPlexApi,
  type PlexTransport,
} from "../src/backends/plex/scopedApi"
import { PlexProvider } from "../src/backends/plex/provider"
const context = { connectionRevision: 7, cacheScope: `plex-${"a".repeat(64)}` }
const track = { id: "42", title: "Song", artist: "Artist", durationMs: 180000 }
test("readonly recording RPC and verified description RPC carry captured context and exact row state", async () => {
  const calls: { command: string; args: any }[] = []
  const transport: PlexTransport = async (command, args) => {
    calls.push({ command, args })
    return (
      command === "playlist_sync_plex_describe"
        ? "Verified description"
        : { status: "unmatched", reason: "missing-reference" }
    ) as any
  }
  const api = createPlexApi(context, transport)
  await api.resolvePlaylistRecording(5, track)
  const expected = {
    title: "Playlist",
    items: [{ trackId: "42", occurrenceId: "8" }],
  }
  expect(
    await api.describePlaylist(
      7,
      5,
      expected,
      "Original",
      "Verified description"
    )
  ).toBe("Verified description")
  expect(calls).toEqual([
    {
      command: "playlist_sync_resolve_recording",
      args: {
        context,
        sectionId: 5,
        trackId: 42,
        expected: { title: "Song", artist: "Artist", durationMs: 180000 },
      },
    },
    {
      command: "playlist_sync_plex_describe",
      args: {
        context,
        playlistId: 7,
        sectionId: 5,
        expected,
        expectedDescription: "Original",
        description: "Verified description",
      },
    },
  ])
  const count = calls.length
  expect(
    (await api.resolvePlaylistRecording(5, { ...track, id: "1e3" })).status
  ).toBe("unmatched")
  expect(() =>
    api.describePlaylist(7, 5, expected, "", "x".repeat(5001))
  ).toThrow("too long")
  expect(calls.length).toBe(count)
})
test("provider resolution cannot publish a response from a replaced native connection", async () => {
  let release!: (v: any) => void
  const transport: PlexTransport = async () =>
    new Promise((r) => (release = r)) as any
  const p = new PlexProvider(transport)
  await p.connect({
    ...context,
    baseUrl: "https://server.test",
    token: "fixture",
    sectionId: 5,
    sectionUuid: "music",
    machineIdentifier: "fixture",
  })
  const work = p.resolvePlaylistRecording(track)
  await p.disconnect()
  release({
    status: "verified",
    recordingMbid: "11111111-1111-4111-8111-111111111111",
    proof: "explicit-recording-guid",
    metadataFingerprint: "a".repeat(64),
  })
  await expect(work).rejects.toThrow("superseded")
})
