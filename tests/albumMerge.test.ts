import { expect, test, mock } from "bun:test"
import {
  deduplicateAlbums,
  mergeAlbumTracks,
  processArtistAlbums,
} from "../src/lib/dedup"
import { loadAlbumContents } from "../src/lib/albumContents"
import { createMetadataCache } from "../src/stores/metadataCacheCore"
import {
  isAlbumPlayback,
  selectReplayGain,
  preparedReplayGain,
  playbackAlbumKey,
} from "../src/audio/playbackContext"
import { createMediaPlayController } from "../src/lib/mediaPlay"
import type { MusicAlbum, MusicTrack, MusicItem } from "../src/types/music"
import type { MusicProvider } from "../src/providers/types"
import { deferred, settle } from "./helpers/radioAudioFakes"

const album = (
  id: string,
  count: number,
  guid = "release",
  title = "HALO"
): MusicAlbum =>
  ({
    id,
    title,
    artistId: "artist",
    artistName: "Tiffany Day",
    year: 2026,
    trackCount: count,
    guid,
    format: null,
  }) as MusicAlbum
const track = (
  id: string,
  albumId: string,
  position: number,
  codec = "flac",
  disc = 1
): MusicTrack =>
  ({
    id,
    albumId,
    albumName: "HALO",
    title: `Song ${position}`,
    trackNumber: position,
    discNumber: disc,
    duration: 180000,
    codec,
    bitDepth: 16,
    samplingRate: 44100,
    bitrate: codec === "flac" ? 1000 : 320,
    mediaInfo: { hasAudioStream: true },
    gain: -2,
    albumGain: -5,
  }) as MusicTrack
function fixture() {
  const albums = [album("small", 2), album("large", 7)]
  const copies: Record<string, MusicTrack[]> = {
    small: [2, 7].map((i) => track(`small-${i}`, "small", i)),
    large: [1, 3, 5, 6, 10, 12, 13].map((i) => track(`large-${i}`, "large", i)),
  }
  const provider = {
    cacheScope: "library",
    playbackSession: {},
    getAlbum: mock(async (id: string) => albums.find((a) => a.id === id)!),
    getAlbumTracks: mock(async (id: string) => copies[id]),
    getArtistAlbums: mock(async () => albums),
    getRelatedHubs: async () => [],
  } as unknown as MusicProvider
  return { provider, albums, copies }
}
test("partial copies of one release merge regardless of counts and format misclassification", () => {
  const small = { ...album("small", 2), format: "Single" },
    large = album("large", 7)
  const groups = deduplicateAlbums([small, large])
  expect(groups).toHaveLength(1)
  expect(groups[0]._alternateIds).toEqual(["small"])
  const lists = processArtistAlbums([small, large], [small], true)
  expect(lists.albums).toHaveLength(1)
  expect(lists.singles).toHaveLength(0)
  expect(
    processArtistAlbums([small, large], [small], false).albums
  ).toHaveLength(1)
  expect(
    processArtistAlbums([small, large], [small], false).singles
  ).toHaveLength(1)
})
test("same release titles can merge physical GUID variants but retain distinct artists editions and years", () => {
  const a = album("one", 2, "guid1"),
    b = album("two", 7, "guid2")
  expect(deduplicateAlbums([a, b])).toHaveLength(1)
  expect(
    deduplicateAlbums([
      a,
      { ...b, artistName: "Other artist", artistId: "other" },
    ])
  ).toHaveLength(2)
  expect(deduplicateAlbums([a,{...b,artistId:"another-artist-with-the-same-name"}])).toHaveLength(2)
  expect(deduplicateAlbums([a, { ...b, year: 2024 }])).toHaveLength(2)
  expect(deduplicateAlbums([a, { ...b, title: "HALO (Live)" }])).toHaveLength(2)
})
test("both physical HALO links expose all nine available songs in original album order", async () => {
  const h = fixture()
  for (const id of ["small", "large"]) {
    const result = await loadAlbumContents(h.provider, id, true)
    expect(result.album.id).toBe(id)
    expect(result.album.trackCount).toBe(9)
    expect(result.tracks.map((t) => t.trackNumber)).toEqual([
      1, 2, 3, 5, 6, 7, 10, 12, 13,
    ])
    expect(new Set(result.tracks.flatMap((t) => t._albumGroupIds!))).toEqual(
      new Set(["small", "large"])
    )
    expect(result.tracks.find((t) => t.trackNumber === 2)?.albumId).toBe(
      "small"
    )
  }
  expect(h.albums.map((a) => a.trackCount)).toEqual([2, 7])
  expect(h.copies.small[0]._albumGroupIds).toBeUndefined()
  const physical = await loadAlbumContents(h.provider, "small", false)
  expect(physical.tracks).toHaveLength(2)
  expect(physical.album._alternateIds).toBeUndefined()
})
test("overlapping songs choose lossless then bit depth and sample rate while preserving discs and named versions", () => {
  const low = track("low", "one", 1, "mp3"),
    lossless = track("flac", "two", 1),
    high = { ...lossless, id: "high", bitDepth: 24, bitrate: 500 },
    higher = { ...high, id: "higher", samplingRate: 96000, bitrate: 400 }
  const unavailable = {
    ...higher,
    id: "missing",
    samplingRate: 192000,
    mediaInfo: { hasAudioStream: false },
  }
  const otherDisc = track("disc2", "one", 1, "flac", 2),
    repeat = {
      ...track("repeat", "one", 8),
      title: low.title,
      guid: "same-recording",
    }
  const remix = { ...track("remix", "one", 1), title: "Song 1 (Remix)" }
  const result = mergeAlbumTracks(
    [low, lossless, high, higher, unavailable, otherDisc, repeat, remix],
    ["one", "two"]
  )
  expect(result.map((t) => t.id)).toEqual([
    "higher",
    "remix",
    "repeat",
    "disc2",
  ])
  const offline = mergeAlbumTracks(
    [
      { ...higher, mediaInfo: { offlineAvailable: false } },
      { ...low, mediaInfo: { offlineAvailable: true } },
    ],
    ["one", "two"],
    true
  )
  expect(offline[0].id).toBe("low")
})
test("merged copies retain explicit album gain and gapless intent without applying it to mixes", () => {
  const merged = mergeAlbumTracks(
    [track("track", "physical", 1)],
    ["physical", "logical"]
  )[0]
  expect(isAlbumPlayback(merged, "logical")).toBe(true)
  expect(selectReplayGain(merged, "logical")).toBe(-5)
  expect(
    preparedReplayGain(
      merged,
      { albumGain: -7, trackGain: -2 },
      "logical",
      null
    )
  ).toBe(-7)
  expect(isAlbumPlayback(merged, null)).toBe(false)
  expect(selectReplayGain(merged, null)).toBe(-2)
  expect(playbackAlbumKey(merged, "physical-key", "logical")).toBe(
    "hibiki-album:logical"
  )
  expect(playbackAlbumKey(merged, "physical-key", null)).toBe("physical-key")
})
test("album card play uses combined tracks rather than a server queue for just one copy", async () => {
  const h = fixture(),
    playTrack = mock(async () => {}),
    playFromUri = mock(async () => {})
  h.provider.buildItemUri = () => "physical URI"
  const controller = createMediaPlayController({
    getProvider: () => h.provider,
    captureSelection: () => () => true,
    reportError: () => {},
  })
  controller({ ...h.albums[0], type: "album" } as MusicItem, {
    provider: h.provider,
    playTrack,
    playFromUri,
    playPlaylist: async () => {},
  })!()
  await settle()
  expect(playFromUri).not.toHaveBeenCalled()
  expect(playTrack).toHaveBeenCalledTimes(1)
  const args = playTrack.mock.calls[0] as unknown as [
    MusicTrack,
    MusicTrack[],
    string,
    string,
    string,
  ]
  expect(args[1]).toHaveLength(9)
  expect(args[4]).toBe("small")
})
test("retired provider reads and failed alternate copies cannot publish a silently partial album", async () => {
  const h = fixture(),
    pending = deferred<MusicTrack[]>()
  h.provider.getAlbumTracks = async (id) =>
    id === "large" ? pending.promise : h.copies.small
  const result = loadAlbumContents(h.provider, "small", true).catch((e) => e)
  await settle()
  Object.assign(h.provider, { cacheScope: "different" })
  pending.resolve(h.copies.large)
  expect(await result).toBeInstanceOf(Error)
  const failed = fixture()
  failed.provider.getAlbumTracks = async (id) => {
    if (id === "large") throw new Error("Unavailable")
    return failed.copies.small
  }
  await expect(
    loadAlbumContents(failed.provider, "small", true)
  ).rejects.toThrow("Unavailable")
})
test("album cache keeps combined contents through raw refreshes and invalidates all aliases after editing", async () => {
  const h = fixture(),
    cache = createMetadataCache({
      getProvider: () => h.provider,
      deduplicate: () => true,
    })
  await cache.activate(h.provider)
  await cache.loadAlbum("small")
  await cache.loadAlbum("large")
  expect(cache.getAlbum("small")?.tracks).toHaveLength(9)
  cache.refresh("getAlbumTracks", ["small"], h.copies.small)
  expect(cache.getAlbum("small")?.invalidated).toBe(true)
  expect(cache.getAlbum("small")?.tracks).toHaveLength(9)
  await cache.loadAlbum("small")
  cache.invalidate("album", "large")
  expect(cache.getAlbum("small")).toBeUndefined()
  expect(cache.getAlbum("large")).toBeUndefined()
})
test("changing deduplication during a prefetch cannot replace a newer physical-album view", async () => {
  const h = fixture(),
    oldTracks = deferred<MusicTrack[]>()
  let enabled = true,
    reads = 0
  h.provider.getAlbumTracks = async (id) =>
    id === "small" && ++reads === 1 ? oldTracks.promise : h.copies[id]
  const cache = createMetadataCache({
    getProvider: () => h.provider,
    deduplicate: () => enabled,
  })
  await cache.activate(h.provider)
  const old = cache.loadAlbum("small").catch((error) => error)
  enabled = false
  const fresh = await cache.loadAlbum("small")
  expect(fresh.tracks).toHaveLength(2)
  oldTracks.resolve(h.copies.small)
  expect(await old).toBeInstanceOf(Error)
  expect(cache.getAlbum("small")?.tracks).toHaveLength(2)
})
