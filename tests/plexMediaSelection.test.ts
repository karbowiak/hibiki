import { expect, test } from "bun:test"
import { PlexProvider } from "../src/backends/plex/provider"
import { plexTrackToMusicTrack } from "../src/backends/plex/mappers"
import { pickBestMediaIndex } from "../src/lib/dedup"
import { PlaybackMetadata } from "../src/audio/playbackMetadata"
import type { Track } from "../src/backends/plex/types"
import type { PlexTransport } from "../src/backends/plex/scopedApi"

function rawTrack(): Track {
  return {
    rating_key: 7,
    title: "Different copies",
    duration: 180000,
    parent_key: "/library/metadata/1",
    parent_title: "Album",
    start_ramp: "track start",
    end_ramp: "track end",
    media: [
      {
        id: 1,
        container: "mp3",
        audio_codec: "mp3",
        bitrate: 128,
        parts: [
          {
            id: 10,
            key: "/library/parts/10/file.mp3",
            size: 1000,
            streams: [
              {
                id: 101,
                stream_type: 2,
                codec: "mp3",
                bitrate: 128,
                channels: 2,
                bit_depth: 16,
                sampling_rate: 44100,
                gain: -3,
                album_gain: -4,
                peak: 0.5,
                loudness: -13,
                start_ramp: "mp3 start",
                end_ramp: "mp3 end",
              },
            ],
          },
        ],
      },
      {
        id: 2,
        container: "flac",
        audio_codec: "flac",
        bitrate: 2000,
        parts: [
          {
            id: 20,
            key: "/library/parts/20/file.flac",
            size: 2000,
            streams: [
              {
                id: 202,
                stream_type: 2,
                codec: "flac",
                bitrate: 2000,
                channels: 2,
                bit_depth: 24,
                sampling_rate: 96000,
                gain: -9,
                album_gain: -11,
                peak: 0.9,
                loudness: -7,
                start_ramp: "flac start",
                end_ramp: "flac end",
              },
            ],
          },
        ],
      },
    ],
  } as Track
}

test("gain, quality, waveform and ramps describe the media variant selected for actual playback", async () => {
  const source = rawTrack()
  const calls: { command: string; args: any }[] = []
  const provider = new PlexProvider((async (command, args) => {
    calls.push({ command, args })
    if (command === "get_track") return source
    if (command === "get_stream_url")
      return `https://server.test${(args as any).partKey}`
  }) as PlexTransport)
  await provider.connect({
    baseUrl: "https://server.test",
    token: "dummy",
    sectionId: 1,
    connectionRevision: 1,
    cacheScope: `plex-${"a".repeat(64)}`,
  })
  const mapped = await provider.getTrack("7")
  const cache = new PlaybackMetadata()
  expect(mapped.codec).toBe("flac")
  expect(mapped.bitDepth).toBe(24)
  expect(mapped.samplingRate).toBe(96000)
  expect(mapped.bitrate).toBe(2000)
  expect(mapped.peak).toBe(0.9)
  expect(mapped.loudness).toBe(-7)
  expect(mapped.mediaInfo?.fileSize).toBe(2000)
  expect(mapped.mediaInfo?.container).toBe("flac")
  expect(await cache.gain(provider, mapped, null)).toBe(-9)
  expect(await cache.gain(provider, mapped, mapped.albumId)).toBe(-11)
  expect(await cache.streamId(provider, mapped)).toBe(202)
  const playback = await cache.playbackInfo(provider, mapped)
  expect(playback.url).toContain("/parts/20/file.flac")
  expect(playback.partId).toBe(20)
  expect(playback.startRamp).toBe(mapped.startRamp)
  expect(playback.endRamp).toBe(mapped.endRamp)
  expect(playback.startRamp).toBe("flac start")
  expect(calls.map((call) => call.command)).toEqual([
    "get_track",
    "get_stream_url",
  ])
  await provider.disconnect()
})

test("the selected variant does not borrow missing stream metadata from a different file", () => {
  const source = rawTrack()
  source.media[1].parts[0].streams = []
  const mapped = plexTrackToMusicTrack(source, () => "")
  expect(mapped.codec).toBe("flac")
  expect(mapped.gain).toBeNull()
  expect(mapped.mediaInfo?.audioStreamId).toBeNull()
  expect(mapped.bitDepth).toBeNull()
  expect(mapped.startRamp).toBe("track start")
})

test("an unavailable high-quality file cannot displace an existing playable media part", () => {
  const source = rawTrack()
  source.media[1].parts = []
  expect(pickBestMediaIndex(source.media)).toBe(0)
  const mapped = plexTrackToMusicTrack(source, () => "")
  expect(mapped.codec).toBe("mp3")
  expect(mapped.gain).toBe(-3)
  expect(mapped.mediaInfo?.hasAudioStream).toBe(true)
  expect(pickBestMediaIndex([])).toBe(0)
})
