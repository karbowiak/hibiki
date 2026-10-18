import { expect, test } from "bun:test"
import {
  mergeMusicSearchResults,
  sameRecording,
  supplementAlbumTracks,
} from "../src/lib/musicMatching"
import type { MusicTrack, MusicItem } from "../src/types/music"

const track = (id: string, title: string, patch: Partial<MusicTrack> = {}) =>
  ({
    id,
    title,
    artistName: "Tiffany Day",
    albumName: "HALO",
    duration: 180_000,
    trackNumber: 1,
    ...patch,
  }) as MusicTrack

test("album gaps use YTM positions and retain the actual Plex track objects", () => {
  const first = track("plex1", "First"),
    third = track("plex3", "Third", { trackNumber: 3 })
  const missing = track("ytmusic:missing", "Missing", { trackNumber: 2 })
  const result = supplementAlbumTracks(
    [first, third],
    [track("ytmusic:first", "First"), missing, track("ytmusic:third", "Third")]
  )
  expect(result.map((item) => item.id)).toEqual([
    first.id,
    missing.id,
    third.id,
  ])
  expect(result[0]).toBe(first)
  expect(result[2]).toBe(third)
})

test("search matches performers and recordings while retaining other versions", () => {
  const local = { ...track("plex", "HALO"), type: "track" } as MusicItem
  const duplicate = {
    ...track("ytmusic:duplicate", "HALO"),
    type: "track",
  } as MusicItem
  const other = {
    ...track("ytmusic:other", "Another song"),
    type: "track",
  } as MusicItem
  expect(
    mergeMusicSearchResults([local], [duplicate, other]).map((item) => item.id)
  ).toEqual(["plex", "ytmusic:other"])
  expect(sameRecording(track("one", "HALO"), track("two", "HALO (Live)"))).toBe(
    false
  )
  expect(
    sameRecording(
      track("one", "HALO"),
      track("two", "HALO", { artistName: "Another Artist" })
    )
  ).toBe(false)
  expect(
    sameRecording(
      track("one", "HALO", { explicit: true }),
      track("two", "HALO", { explicit: false })
    )
  ).toBe(false)
})

test("individual collaboration credits match independently of separator or order", () => {
  const local = track("plex", "Song", {
    artistName: "NEEDY GIRL OVERDOSE; Aiobahn +81",
  })
  const remote = track("ytmusic", "Song", {
    artistName: "Aiobahn +81 x NEEDY GIRL OVERDOSE",
  })
  expect(sameRecording(local, remote)).toBe(true)
  expect(
    sameRecording(local, {
      ...remote,
      artistName: "Aiobahn +81; Another Artist",
    })
  ).toBe(false)
  expect(sameRecording(local, { ...remote, title: "Song (Live)" })).toBe(false)
})

test("artist and release identities need proof and retain both source references", () => {
  const artist = { id: "1", title: "Same Name", type: "artist" } as MusicItem
  const remote = { ...artist, id: "ytmusic:UC_one", providerKey: "ytmusic" }
  expect(mergeMusicSearchResults([artist], [remote])).toHaveLength(2)
  const merged = mergeMusicSearchResults(
    [artist],
    [remote],
    new Map([[remote.id, artist.id]])
  )
  expect(merged.map((item) => item.id)).toEqual([artist.id])
  expect(merged[0]).toMatchObject({
    counterparts: { plex: artist.id, ytmusic: remote.id },
  })
  const album = {
    id: "2",
    title: "Release",
    artistName: "Artist",
    year: 2020,
    type: "album",
  } as MusicItem
  const deluxe = { ...album, id: "ytmusic:MPRE_one", title: "Release (Deluxe)" }
  expect(
    mergeMusicSearchResults([album], [deluxe], new Map([[deluxe.id, album.id]]))
  ).toHaveLength(2)
})

test("one preferred recording retains actual source and never collapses mastering or explicitness differences", () => {
  const local = {
    ...track("1", "Song", { codec: "mp3", bitrate: 96 }),
    type: "track",
  } as MusicItem
  const remote = {
    ...track("ytmusic:abcdefghijk", "Song", {
      providerKey: "ytmusic",
      mediaInfo: {
        verifiedAudio: {
          codec: "opus",
          bitrate: 256,
          formatId: "251",
          checkedAt: Date.now(),
        },
      },
    }),
    type: "track",
  } as MusicItem
  const match = new Map([[remote.id, local.id]])
  expect(mergeMusicSearchResults([local], [remote], match)[0]).toMatchObject({
    id: remote.id,
    providerKey: "ytmusic",
    counterparts: { plex: local.id, ytmusic: remote.id },
  })
  expect(
    mergeMusicSearchResults(
      [{ ...local, codec: "flac" } as MusicItem],
      [remote],
      match
    )[0].id
  ).toBe(local.id)
  expect(
    sameRecording(
      track("one", "Song", { albumName: "Album" }),
      track("two", "Song", { albumName: "Album (2009 Remaster)" })
    )
  ).toBe(false)
  expect(
    sameRecording(
      track("one", "Song", { albumName: "Album (2009 Remaster)" }),
      track("two", "Song", { albumName: "Album (2020 Remaster)" })
    )
  ).toBe(false)
})
