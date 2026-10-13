import { expect, test } from "bun:test"
import { downloadMedia, localAudioTrack } from "../src/offline/audio"
import { createSavedLibraryProvider } from "../src/offline/offlineProvider"
import type { MusicProvider } from "../src/providers/types"
import { PlexProvider } from "../src/backends/plex/provider"

const scope = "plex-" + "a".repeat(64)
test("real Plex provider download paging uses offset then limit and keeps native context", async () => {
  const offsets: number[] = []
  const batches: number[][] = []
  const provider = new PlexProvider(async (command, args: any) => {
    expect(args.context).toEqual({ connectionRevision: 7, cacheScope: scope })
    if (command === "get_playlist_items_page") {
      expect(args.limit).toBe(100)
      offsets.push(args.offset)
      const count = args.offset === 0 ? 100 : 1
      return {
        items: Array.from({ length: count }, (_, i) => ({
          rating_key: args.offset + i + 1,
          title: "Fixture",
          media: [],
        })),
        total: 101,
        offset: args.offset,
      } as any
    }
    if (command === "audio_download_enqueue") {
      batches.push(args.trackIds)
      return undefined as any
    }
    throw Error("Unexpected command")
  })
  await provider.connect({
    baseUrl: "https://plex.test",
    token: "fixture",
    sectionId: 1,
    connectionRevision: 7,
    cacheScope: scope,
  })
  expect(await downloadMedia(provider, "playlist", "42")).toBe(101)
  expect(offsets).toEqual([0, 100])
  expect(batches.map((batch) => batch.length)).toEqual([100, 1])
})
test("playlist downloads preserve paging, collapse repeated audio and avoid stale browsing reads", async () => {
  const queued: string[][] = []
  const offsets: number[] = []
  const provider = {
    getPlaylists: async () => [],
    getPlaylistItems: async (_id: string, offset: number, limit: number) => {
      expect(limit).toBe(100)
      offsets.push(offset)
      return offset === 0
        ? {
            items: [{ id: "1" }, { id: "1" }, { id: "2" }],
            total: 5,
            offset: 0,
          }
        : { items: [{ id: "3" }, { id: "2" }], total: 5, offset: 3 }
    },
    downloadTracks: async (ids: string[]) => {
      queued.push(ids)
    },
  } as unknown as MusicProvider
  expect(await downloadMedia(provider, "playlist", "42")).toBe(3)
  expect(offsets).toEqual([0, 3])
  expect(queued).toEqual([["1", "2"], ["3"]])
})
test("album download admission is bounded and stops after provider retirement", async () => {
  const queued: string[][] = []
  let owns = true
  const provider = {
    getAlbumTracks: async () =>
      Array.from({ length: 600 }, (_, i) => ({ id: String(i + 1) })),
    downloadTracks: async (ids: string[]) => {
      queued.push(ids)
      owns = false
    },
  } as unknown as MusicProvider
  await expect(
    downloadMedia(provider, "album", "42", () => owns)
  ).rejects.toThrow("selection changed")
  expect(queued).toHaveLength(1)
  expect(queued[0]).toHaveLength(256)
  await expect(
    downloadMedia({ ...provider, isOffline: true }, "track", "1")
  ).rejects.toThrow("Reconnect")
})
test("download paging refuses wrong offsets and reports partial admission failures", async () => {
  let queued = 0
  const provider = {
    getPlaylists: async () => [],
    getPlaylistItems: async () => ({
      items: [{ id: "1" }],
      total: 3,
      offset: 5,
    }),
    downloadTracks: async () => {
      queued++
    },
  } as unknown as MusicProvider
  await expect(downloadMedia(provider, "playlist", "42")).rejects.toThrow(
    "unexpected playlist page"
  )
  expect(queued).toBe(0)
})
test("local audio resolves token-free owned artwork without turning files into stream URLs", () => {
  const track = localAudioTrack(
    {
      id: "42",
      title: "Saved song",
      artistName: "Artist",
      albumName: "Album",
      rawThumbPath: "/library/metadata/42/thumb",
      albumId: "2",
      localAlbumThumbPath: "/library/metadata/2/thumb",
    } as any,
    "https://plex.test",
    scope
  )
  expect(track.thumbUrl).toContain(
    encodeURIComponent("https://plex.test/library/metadata/42/thumb")
  )
  expect(track.thumbUrl).toContain(scope)
  expect(track.thumbUrl).not.toContain("native-owned")
  expect(track.streamUrl).toBeNull()
})
test("saved provider permits verified local playback and removal but never remote edits", async () => {
  let owns = true,
    removed = 0
  const track: any = { id: "42", title: "Offline song", streamUrl: null }
  const playback: any = {
    url: "hibiki-local://track/42",
    trackKey: 42,
    partId: 10,
    parentKey: "",
    startRamp: null,
    endRamp: null,
    plexContext: { connectionRevision: 3, cacheScope: scope },
  }
  const provider = createSavedLibraryProvider(
    scope,
    { get: async () => null, put: async () => {} },
    () => owns,
    {
      track: async (id) => (id === "42" ? track : null),
      playback: async (id) => {
        if (id !== "42") throw Error("not available offline")
        return playback
      },
      list: async () => ({ items: [], total: 0, downloadedBytes: 0 }),
      remove: async () => {
        removed++
      },
    }
  )
  expect(await provider.getTrack("42")).toBe(track)
  expect(await provider.getPlaybackInfo(track)).toBe(playback)
  await expect(provider.getPlaybackInfo({ id: "43" } as any)).rejects.toThrow(
    "not available offline"
  )
  await expect(provider.addToPlaylist("1", ["42"])).rejects.toThrow("Reconnect")
  await expect(
    provider.editAdvancedMetadata!("album", "2", {})
  ).rejects.toThrow("Reconnect")
  await provider.removeDownload!("42")
  expect(removed).toBe(1)
  owns = false
  await expect(provider.getPlaybackInfo(track)).rejects.toThrow("superseded")
  await expect(provider.getLocalAudio!()).rejects.toThrow("superseded")
})
