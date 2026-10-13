import { expect, test } from "bun:test"
import { deduplicateAlbums } from "../src/lib/dedup"
import { projectMediaVersions } from "../src/backends/plex/mappers"
import { sanitizeOfflineData } from "../src/offline/providerCache"
import type { MusicAlbum } from "../src/types/music"
import type { Media } from "../src/backends/plex/types"
const album = (id: string, aliases: string[] = []) =>
  ({
    id,
    title: "Same album",
    artistName: "Artist",
    year: 2025,
    trackCount: 10,
    guid: "release-id",
    _alternateIds: aliases,
  }) as MusicAlbum
const media = (id: number, codec = "mp3") =>
  ({
    id,
    audio_codec: codec,
    bitrate: 320,
    container: codec,
    parts: [
      {
        id: id + 100,
        key: "/library/parts/private?X-Plex-Token=secret",
        file: "/private/music/file",
        size: 1048576,
        streams: [
          {
            stream_type: 2,
            codec,
            bit_depth: 16,
            sampling_rate: 44100,
            channels: 2,
            bitrate: 320,
          },
        ],
      },
    ],
  }) as Media
test("regrouping deduplicated albums preserves every physical alternate without mutating inputs", () => {
  const first = album("1", ["2"])
  const second = album("3", ["4", "1"])
  const result = deduplicateAlbums([first, second])
  expect(result).toHaveLength(1)
  expect(new Set([result[0].id, ...result[0]._alternateIds!])).toEqual(
    new Set(["1", "2", "3", "4"])
  )
  expect(first._alternateIds).toEqual(["2"])
  expect(second._alternateIds).toEqual(["4", "1"])
  expect(deduplicateAlbums(result)[0]._alternateIds).toEqual(
    result[0]._alternateIds
  )
})
test("media version review projects bounded technical metadata without private URLs or paths", () => {
  const result = projectMediaVersions([media(1), media(2, "flac")])
  expect(result).toHaveLength(2)
  expect(result[1].selected).toBe(true)
  expect(result[0].mediaId).toBe("1")
  expect(result[0].partId).toBe("101")
  expect(result[0].fileSize).toBe(1048576)
  const stored = JSON.stringify(
    sanitizeOfflineData({ mediaInfo: { versions: result } })
  )
  expect(stored).not.toContain("private")
  expect(stored).not.toContain("secret")
  expect(stored).not.toContain("key")
  expect(stored).toContain("mp3")
  expect(stored).toContain("flac")
})
test("bounded projection keeps the actual automatic choice even outside first32 and rejects corrupt scalar details", () => {
  const entries = Array.from({ length: 40 }, (_, index) => media(index + 1))
  entries[39] = media(40, "flac")
  const versions = projectMediaVersions(entries)
  expect(versions).toHaveLength(32)
  expect(versions.find((version) => version.selected)?.mediaId).toBe("40")
  expect(versions.find((version) => version.selected)?.versionNumber).toBe(40)
  const corrupt = media(1)
  corrupt.parts[0].size = Infinity
  corrupt.audio_codec = "https://private.test/?token=secret"
  corrupt.parts[0].streams[0].codec = corrupt.audio_codec
  corrupt.parts[0].streams[0].bit_depth = NaN
  const version = projectMediaVersions([corrupt])[0]
  expect(version.fileSize).toBeNull()
  expect(version.codec).toBeNull()
  expect(version.bitDepth).toBeNull()
})
