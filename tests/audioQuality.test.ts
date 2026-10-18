import { expect, test } from "bun:test"
import {
  formatAudioQuality,
  playbackAudioQuality,
  clearlyBetterAudio,
  preferVerifiedYoutubeAudio,
} from "../src/lib/audioQuality"
import type { MusicTrack, MusicMediaVersion } from "../src/types/music"

test("source preference requires verified audio, codec-specific margins and every usable Plex version", () => {
  const now = Date.now()
  const plex = { codec: "mp3", bitrate: 96 } as MusicTrack
  const youtube = {
    mediaInfo: {
      verifiedAudio: {
        codec: "opus",
        bitrate: 256,
        formatId: "251",
        checkedAt: now,
      },
    },
  } as MusicTrack
  expect(preferVerifiedYoutubeAudio(plex, youtube, now)).toBe(true)
  for (const audio of [
    { codec: "flac", bitrate: 900 },
    { codec: "aac", bitrate: 256 },
    { codec: "aac", bitrate: 192 },
    { codec: null, bitrate: 64 },
    { codec: "mp3", bitrate: null },
  ])
    expect(clearlyBetterAudio(audio, { codec: "opus", bitrate: 256 })).toBe(
      false
    )
  expect(
    preferVerifiedYoutubeAudio(plex, { ...youtube, mediaInfo: undefined }, now)
  ).toBe(false)
  expect(preferVerifiedYoutubeAudio(plex, youtube, now + 31 * 60_000)).toBe(
    false
  )
  const version = (codec: string, bitrate: number, partCount = 1) =>
    ({ codec, bitrate, partId: "1", partCount }) as MusicMediaVersion
  expect(
    preferVerifiedYoutubeAudio(
      {
        ...plex,
        mediaInfo: { versions: [version("mp3", 96), version("flac", 900)] },
      },
      youtube,
      now
    )
  ).toBe(false)
  expect(
    preferVerifiedYoutubeAudio(
      {
        ...plex,
        mediaInfo: { versions: [version("mp3", 96), version("flac", 900, 2)] },
      },
      youtube,
      now
    )
  ).toBe(true)
  expect(
    preferVerifiedYoutubeAudio(
      { ...plex, mediaInfo: { versionsTruncated: true } },
      youtube,
      now
    )
  ).toBe(false)
})

test("lossless quality keeps source depth and exact useful sample-rate precision", () => {
  expect(
    formatAudioQuality({
      codec: "flac",
      bitDepth: 16,
      samplingRate: 44100,
      bitrate: 930,
    })
  ).toBe("FLAC 16bit/44.1kHz")
  expect(
    formatAudioQuality({ codec: "ALAC", bitDepth: 24, samplingRate: 96000 })
  ).toBe("ALAC 24bit/96kHz")
  expect(formatAudioQuality({ codec: "flac", samplingRate: 44056 })).toBe(
    "FLAC 44.056kHz"
  )
  expect(
    formatAudioQuality({ codec: "wav", bitDepth: 32, samplingRate: 192000 })
  ).toBe("WAV 32bit/192kHz")
})

test("lossy quality uses bitrate without inventing source bit depth from decoded PCM", () => {
  expect(
    formatAudioQuality({
      codec: "mp3",
      bitDepth: 32,
      samplingRate: 48000,
      bitrate: 320,
    })
  ).toBe("MP3 320kbps/48kHz")
  expect(formatAudioQuality({ codec: "aac", bitrate: 256 })).toBe("AAC 256kbps")
})

test("missing or invalid audio fields leave a useful fallback", () => {
  expect(formatAudioQuality({})).toBe(null)
  expect(
    formatAudioQuality({
      codec: " FLAC ",
      bitDepth: 0,
      samplingRate: NaN,
      bitrate: Infinity,
    })
  ).toBe("FLAC")
  expect(formatAudioQuality({ samplingRate: 44100 })).toBe("44.1kHz")
})

test("a native transcode never inherits the original file's codec, depth or bitrate", () => {
  const original = {
    codec: "FLAC",
    bitDepth: 24,
    samplingRate: 96000,
    bitrate: 2400,
  }
  expect(
    formatAudioQuality(
      playbackAudioQuality(original, {
        codec: "MP3",
        bit_depth: 32,
        sample_rate: 44100,
        channels: 2,
      })
    )
  ).toBe("MP3 44.1kHz")
  expect(
    formatAudioQuality(
      playbackAudioQuality(original, {
        codec: "FLAC",
        bit_depth: 16,
        sample_rate: 48000,
        channels: 2,
      })
    )
  ).toBe("FLAC 16bit/48kHz")
  expect(
    formatAudioQuality(
      playbackAudioQuality(
        { codec: "MP3", bitrate: 320 },
        { codec: "MP3", bit_depth: 32, sample_rate: 48000, channels: 2 }
      )
    )
  ).toBe("MP3 320kbps/48kHz")
  expect(playbackAudioQuality(original, null)).toBe(original)
})
