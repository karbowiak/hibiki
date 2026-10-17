import { expect, test } from "bun:test"
import type { MusicTrack } from "../src/types/music"
import { musicEntityHref, trackEntity, type MusicEntityRef } from "../src/lib/musicEntity"
import { createMusicLinkResolver } from "../src/lib/musicLinkResolver"

const album: MusicEntityRef = { kind: "album", id: "ytmusic:MPRE_halo", name: "HALO", artist: "Tiffany Day", year: 2026 }

test("known Plex IDs remain direct and remote artist/album IDs use YTM routes", () => {
  expect(musicEntityHref("artist", "123")).toBe("/artist/123")
  expect(musicEntityHref("album", "ytmusic:MPRE_halo")).toBe("/ytmusic/MPRE_halo")
  const track = { albumName: "HALO", artistName: "Tiffany Day", albumId: "plex-album", artistId: "plex-artist",
    _providerData: { youtubeMusic: { albumId: "MPRE_halo", artistId: "UC_artist" } } } as MusicTrack
  expect(trackEntity(track, "album")?.id).toBe("plex-album")
  expect(trackEntity({ ...track, artistId: null }, "artist")?.id).toBe("ytmusic:UC_artist")
})

test("a matching Plex album takes priority and concurrent link clicks share one lookup", async () => {
  let calls = 0
  const resolve = createMusicLinkResolver({ current: () => true,
    searchPlex: async () => { calls++; return [{ id: "123", name: "HALO", artist: "Tiffany Day", year: 2026 }] },
    searchYoutube: async () => { throw Error("Known YTM destination should not need another query") },
  })
  const results = await Promise.all(Array.from({ length: 20 }, () => resolve(album)))
  expect(results.every(href => href === "/album/123")).toBe(true)
  expect(calls).toBe(1)
})

test("wrong performers, editions and ambiguous Plex albums retain the YTM destination", async () => {
  for (const candidates of [
    [{ id: "wrong", name: "HALO", artist: "Other Artist", year: 2026 }],
    [{ id: "deluxe", name: "HALO (Deluxe)", artist: "Tiffany Day", year: 2026 }],
    [{ id: "old", name: "HALO", artist: "Tiffany Day", year: 2001 }],
    ["first", "second"].map(id => ({ id, name: "HALO", artist: "Tiffany Day", year: 2026 })),
  ]) {
    const resolve = createMusicLinkResolver({ current: () => true, searchPlex: async () => candidates, searchYoutube: async () => [] })
    expect(await resolve(album)).toBe("/ytmusic/MPRE_halo")
  }
})

test("metadata-only credits resolve YTM when Plex has no match", async () => {
  const resolve = createMusicLinkResolver({ current: () => true, searchPlex: async () => [],
    searchYoutube: async () => [{ id: "ytmusic:UC_winking_owl", name: "The Winking Owl" }],
  })
  expect(await resolve({ kind: "artist", name: "The Winking Owl" })).toBe("/ytmusic/UC_winking_owl")
})

test("playbar album navigation recovers missing release identity from the exact playback song", async () => {
  let hydrations = 0
  const resolve = createMusicLinkResolver({ current: () => true,
    hydrate: async ref => { hydrations++; return { ...ref, id: "actual-album", name: "HALO" } },
    searchPlex: async () => { throw Error("Recovered Plex IDs should navigate directly") }, searchYoutube: async () => [],
  })
  const ref = trackEntity({ id: "playing-song", albumId: null, albumName: "", artistName: "Tiffany Day" } as MusicTrack, "album")!
  expect(ref.trackId).toBe("playing-song")
  expect(await resolve(ref)).toBe("/album/actual-album")
  expect(hydrations).toBe(1)
})

test("retired song metadata cannot navigate and missing albums never search by the song title", async () => {
  let current = true, finish!: (ref: MusicEntityRef) => void
  const resolve = createMusicLinkResolver({ current: () => current,
    hydrate: () => new Promise(done => { finish = done }),
    searchPlex: async () => { throw Error("No album name is known") }, searchYoutube: async () => [],
  })
  const request = resolve({ kind: "album", name: "", trackId: "old-song" })
  current = false
  finish({ kind: "album", name: "Old album", id: "old-album" })
  expect(await request).toBeNull()
  const empty = createMusicLinkResolver({ current: () => true, hydrate: async () => null,
    searchPlex: async () => { throw Error("No album name is known") }, searchYoutube: async () => { throw Error("No album name is known") },
  })
  expect(await empty({ kind: "album", name: "", trackId: "song" })).toBeNull()
})

test("missing links expire quickly and an account change rejects an in-flight lookup", async () => {
  let time = 0, calls = 0
  const resolve = createMusicLinkResolver({ current: () => true, now: () => time,
    searchPlex: async () => { calls++; return [] }, searchYoutube: async () => [],
  })
  const artist: MusicEntityRef = { kind: "artist", name: "Unknown Artist" }
  expect(await resolve(artist)).toBeNull()
  time = 59_000
  expect(await resolve(artist)).toBeNull()
  expect(calls).toBe(1)
  time = 61_000
  expect(await resolve(artist)).toBeNull()
  expect(calls).toBe(2)

  let owns = true, finish!: (items: { id: string; name: string }[]) => void
  const retiring = createMusicLinkResolver({ current: () => owns,
    searchPlex: () => new Promise(done => { finish = done }), searchYoutube: async () => [],
  })
  const pending = retiring(artist)
  owns = false
  finish([{ id: "123", name: artist.name }])
  expect(await pending).toBeNull()
})
