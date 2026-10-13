import { test, expect } from "bun:test"
import { resolveSelectedPlaylistRecordings } from "../src/playlistSync/recordingResolver"
import { useProviderStore } from "../src/stores/providerStore"
import type {
  MusicProvider,
  PlaylistRecordingResolution,
} from "../src/providers/types"
const track = { id: "1", title: "Song", artist: "Artist", durationMs: 180000 }
const verified: PlaylistRecordingResolution = {
  status: "verified",
  recordingMbid: "11111111-1111-4111-8111-111111111111",
  proof: "release-track-relationship",
  metadataFingerprint: "a".repeat(64),
}
const provider = (resolve: MusicProvider["resolvePlaylistRecording"]) =>
  ({
    cacheScope: "scope",
    playbackSession: 1,
    resolvePlaylistRecording: resolve,
  }) as MusicProvider
test("explicit selected run dedupes occurrences and injects only validated proof", async () => {
  let calls = 0
  const p = provider(async () => {
    calls++
    return verified
  })
  const updates: any[] = []
  const result = await resolveSelectedPlaylistRecordings(
    p,
    [track, { ...track }],
    { current: () => p, onProgress: (u) => updates.push(u) }
  )
  expect(calls).toBe(1)
  expect(updates.length).toBe(1)
  expect(result.verifiedMbid(track)).toBe(verified.recordingMbid)
  expect(result.verifiedMbid({ ...track, title: "Changed" })).toBeNull()
  const invalid = provider(async () => ({
    ...verified,
    recordingMbid: "unverified",
  }))
  expect(
    (
      await resolveSelectedPlaylistRecordings(invalid, [track], {
        current: () => invalid,
      })
    ).verifiedMbid(track)
  ).toBeNull()
})
test("cancellation stops later rows and does not admit or publish late result", async () => {
  let release!: () => void,
    calls = 0
  const controller = new AbortController()
  const p = provider(async () => {
    calls++
    await new Promise<void>((r) => (release = r))
    return verified
  })
  const work = resolveSelectedPlaylistRecordings(
    p,
    [track, { ...track, id: "2" }],
    { current: () => p, signal: controller.signal }
  )
  controller.abort()
  release()
  const result = await work
  expect(result.status).toBe("cancelled")
  expect(calls).toBe(1)
  expect(result.results.size).toBe(0)
})
test("provider A-B-A and same-object session retirement cannot inject late proof", async () => {
  for (const aba of [true, false]) {
    const previous = useProviderStore.getState()
    let release!: () => void
    const p = provider(async () => {
      await new Promise<void>((r) => (release = r))
      return verified
    })
    useProviderStore.setState({ provider: p })
    const work = resolveSelectedPlaylistRecordings(p, [track])
    if (aba) {
      useProviderStore.setState({ provider: provider(async () => verified) })
      useProviderStore.setState({ provider: p })
    } else {
      ;(p as any).playbackSession = 2
    }
    release()
    const result = await work
    expect(result.status).toBe("retired")
    expect(result.verifiedMbid(track)).toBeNull()
    useProviderStore.setState(previous)
  }
})
test("mutable source row and heuristic/unavailable responses cannot become verified mappings", async () => {
  const row = { ...track }
  const p = provider(async () => {
    row.artist = "Changed"
    return verified
  })
  const result = await resolveSelectedPlaylistRecordings(p, [row], {
    current: () => p,
  })
  expect(result.verifiedMbid(row)).toBeNull()
  expect(result.results.get(row.id)?.result).toMatchObject({
    status: "unmatched",
    reason: "metadata-changed",
  })
  const unavailable = provider(async () => ({
    status: "unmatched",
    reason: "missing-reference",
  }))
  expect(
    (
      await resolveSelectedPlaylistRecordings(unavailable, [track], {
        current: () => unavailable,
      })
    ).verifiedMbid(track)
  ).toBeNull()
})
