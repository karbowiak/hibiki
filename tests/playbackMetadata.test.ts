import { expect, mock, test } from "bun:test"
import { PlaybackMetadata } from "../src/audio/playbackMetadata"
import type { MusicProvider, TrackPlaybackInfo } from "../src/providers/types"
import type { MusicTrack } from "../src/types/music"
import { deferred } from "./helpers/radioAudioFakes"
const track = (
  id: string,
  gain: number | null = null,
  albumGain: number | null = null,
  streamId: number | null = null
) =>
  ({
    id,
    title: id,
    albumId: "album",
    gain,
    albumGain,
    mediaInfo: { audioStreamId: streamId },
  }) as MusicTrack
const info = (url: string) =>
  ({
    url,
    trackKey: 1,
    partId: 1,
    parentKey: "album",
    startRamp: null,
    endRamp: null,
  }) as TrackPlaybackInfo
function provider(scope: string, extra: Partial<MusicProvider> = {}) {
  return {
    cacheScope: scope,
    getTrack: mock(async (id) => track(id, -3, -5, 12)),
    getPlaybackInfo: mock(async () => info(`https://${scope}.test/track`)),
    ...extra,
  } as unknown as MusicProvider
}

test("local audio never asks Plex for missing gain or waveform metadata", async () => {
  const cache = new PlaybackMetadata(),
    backend = provider("local")
  const local = track("42")
  local.mediaInfo = { localAudio: true, metadataComplete: true }
  expect(await cache.gain(backend, local, null)).toBeNull()
  expect(await cache.streamId(backend, local)).toBeNull()
  expect(backend.getTrack).not.toHaveBeenCalled()
})

test("prefetched missing Plex gain is refreshed when later server analysis becomes available", async () => {
  const cache = new PlaybackMetadata()
  let gain: number | null = null
  const fetch = mock(async () => ({
    ...info("https://fixture.test/track"),
    plexContext: { cacheScope: "scope", connectionRevision: 1 },
    trackGain: gain,
    albumGain: null,
  }))
  const backend = provider("scope", { getPlaybackInfo: fetch })
  expect((await cache.playbackInfo(backend, track("1"))).trackGain).toBeNull()
  gain = -4
  expect((await cache.playbackInfo(backend, track("1"))).trackGain).toBe(-4)
  expect((await cache.playbackInfo(backend, track("1"))).trackGain).toBe(-4)
  expect(fetch).toHaveBeenCalledTimes(2)
})

test("local playback restores native saved waveforms without a server metadata lookup", async () => {
  const levels = [{ loudness: -40 }, { loudness: -6 }],
    cache = new PlaybackMetadata()
  const backend = provider("local", {
    getTrackLevels: mock(async () => levels),
    getStreamLevels: mock(async () => {
      throw new Error("Network access")
    }),
  })
  const local = track("42")
  local.mediaInfo = { localAudio: true }
  expect(await cache.levels(backend, local)).toEqual(levels)
  expect(backend.getTrackLevels).toHaveBeenCalledWith(local)
  expect(backend.getTrack).not.toHaveBeenCalled()
  expect(backend.getStreamLevels).not.toHaveBeenCalled()
})

test("retired waveform responses cannot cross a playback session", async () => {
  const pending = deferred<{ loudness: number }[]>(),
    cache = new PlaybackMetadata()
  const backend = provider("a", { getTrackLevels: () => pending.promise })
  const request = cache.levels(backend, track("42")).catch((error) => error)
  ;(backend as any).playbackSession = {}
  pending.resolve([{ loudness: -10 }])
  expect(await request).toBeInstanceOf(Error)
})

test("the same track ID on different providers cannot share gain, waveform or playback URLs", async () => {
  const cache = new PlaybackMetadata(),
    a = provider("a"),
    b = provider("b", { getTrack: async (id) => track(id, -8, -10, 99) })
  expect(await cache.gain(a, track("1"), null)).toBe(-3)
  expect(await cache.gain(b, track("1"), null)).toBe(-8)
  expect(await cache.streamId(a, track("1"))).toBe(12)
  expect(await cache.streamId(b, track("1"))).toBe(99)
  expect((await cache.playbackInfo(a, track("1"))).url).toContain("a.test")
  expect((await cache.playbackInfo(b, track("1"))).url).toContain("b.test")
})

test("gain, waveform and enrichment share one full metadata request", async () => {
  const pending = deferred<MusicTrack>(),
    cache = new PlaybackMetadata(),
    p = provider("a", { getTrack: mock(() => pending.promise) })
  const full = cache.fullTrack(p, "1"),
    gain = cache.gain(p, track("1"), "album"),
    stream = cache.streamId(p, track("1"))
  expect(p.getTrack).toHaveBeenCalledTimes(1)
  pending.resolve(track("1", -3, -5, 12))
  expect(await gain).toBe(-5)
  expect(await stream).toBe(12)
  await full
})

test("a pending full lookup supplies playback preparation with fresh media data", async () => {
  const pending = deferred<MusicTrack>(),
    cache = new PlaybackMetadata()
  const p = provider("a", {
    getTrack: () => pending.promise,
    getPlaybackInfo: mock(async (full) =>
      info(`https://a.test/${full.mediaInfo?.audioStreamId}`)
    ),
  })
  const full = cache.fullTrack(p, "1"),
    playback = cache.playbackInfo(p, track("1"))
  expect(p.getPlaybackInfo).toHaveBeenCalledTimes(0)
  pending.resolve(track("1", -3, -5, 42))
  await full
  expect((await playback).url).toBe("https://a.test/42")
})

test("changing the scope of a reused provider retires pending data and cached values", async () => {
  const pending = deferred<MusicTrack>(),
    cache = new PlaybackMetadata(),
    p = provider("a", { getTrack: mock(() => pending.promise) })
  const old = cache.fullTrack(p, "1").catch((error) => error)
  ;(p as any).cacheScope = "b"
  ;(p as any).getTrack = async (id) => track(id, -9, -11, 99)
  expect(await cache.gain(p, track("1"), null)).toBe(-9)
  pending.resolve(track("1", -3, -5, 12))
  expect(await old).toBeInstanceOf(Error)
  expect(await cache.streamId(p, track("1"))).toBe(99)
})

test("transient failures remain retryable and do not become permanent unknown-gain cache entries", async () => {
  let calls = 0
  const cache = new PlaybackMetadata(),
    p = provider("a", {
      getTrack: async (id) => {
        if (++calls === 1) throw new Error("Temporary failure")
        return track(id, -6, -8, 21)
      },
    })
  expect(await cache.gain(p, track("1"), null)).toBeNull()
  expect(await cache.gain(p, track("1"), null)).toBe(-6)
  expect(calls).toBe(2)
})

test("metadata edits invalidate shared full tracks and pending pre-edit responses", async () => {
  const cache = new PlaybackMetadata(), pending = deferred<MusicTrack>()
  const p = provider("edited", { getTrack: mock(() => pending.promise) })
  const stale = cache.fullTrack(p, "1").catch(error => error)
  cache.invalidate(p)
  p.getTrack = mock(async id => track(id, -8, -10, 99))
  expect(await cache.streamId(p, track("1"))).toBe(99)
  pending.resolve(track("1", -3, -5, 12))
  expect(await stale).toBeInstanceOf(Error)
  expect(await cache.streamId(p, track("1"))).toBe(99)
})

test("hover URL resolution shares requests and retries failures rather than poisoning a permanent dedup set", async () => {
  let calls = 0
  const cache = new PlaybackMetadata(),
    p = provider("a", {
      getPlaybackInfo: async () => {
        if (++calls === 1) throw new Error("Temporary failure")
        return info("https://a.test/ready")
      },
    })
  await expect(cache.playbackInfo(p, track("1"))).rejects.toThrow(
    "Temporary failure"
  )
  const [a, b] = await Promise.all([
    cache.playbackInfo(p, track("1")),
    cache.playbackInfo(p, track("1")),
  ])
  expect(a).toBe(b)
  expect(calls).toBe(2)
})

test("inline metadata honors explicit album intent and avoids lookups", async () => {
  const cache = new PlaybackMetadata(),
    p = provider("a"),
    source = track("1", -3, -5, 10)
  expect(await cache.gain(p, source, null)).toBe(-3)
  expect(await cache.gain(p, source, "album")).toBe(-5)
  expect(await cache.streamId(p, source)).toBe(10)
  expect(p.getTrack).toHaveBeenCalledTimes(0)
})

test("invalid gains and stream identifiers cannot reach native playback controls", async () => {
  const cache = new PlaybackMetadata(),
    p = provider("a", { getTrack: async (id) => track(id, NaN, Infinity, -4) })
  expect(await cache.gain(p, track("1", NaN, Infinity), null)).toBeNull()
  expect(await cache.streamId(p, track("1", null, null, Infinity))).toBeNull()
})

test("different media variants of one track do not reuse a previously resolved URL", async () => {
  const cache = new PlaybackMetadata(),
    p = provider("a", {
      getPlaybackInfo: mock(async (source) =>
        info(`https://a.test/${source.mediaInfo?.audioStreamId}`)
      ),
    })
  expect((await cache.playbackInfo(p, track("1", -3, -5, 10))).url).toBe(
    "https://a.test/10"
  )
  expect((await cache.playbackInfo(p, track("1", -3, -5, 20))).url).toBe(
    "https://a.test/20"
  )
  expect(p.getPlaybackInfo).toHaveBeenCalledTimes(2)
})

test("reconnecting the same provider and scope cannot reuse old native audio ownership", async () => {
  const cache = new PlaybackMetadata()
  let revision = 1
  const p = provider("a", {
    playbackSession: {},
    getPlaybackInfo: mock(async () => ({
      ...info("https://a.test/track"),
      plexContext: { connectionRevision: revision, cacheScope: "a" },
    })),
  })
  expect(
    (await cache.playbackInfo(p, track("1"))).plexContext?.connectionRevision
  ).toBe(1)
  revision = 2
  ;(p as any).playbackSession = {}
  expect(
    (await cache.playbackInfo(p, track("1"))).plexContext?.connectionRevision
  ).toBe(2)
  expect(p.getPlaybackInfo).toHaveBeenCalledTimes(2)
})
