import { expect, test } from "bun:test"
import { mergeMusicSearchResults, sameRecording, supplementAlbumTracks } from "../src/lib/musicMatching"
import type { MusicTrack, MusicItem } from "../src/types/music"

const track = (id: string, title: string, patch: Partial<MusicTrack> = {}) => ({
  id, title, artistName: "Tiffany Day", albumName: "HALO", duration: 180_000, trackNumber: 1, ...patch,
}) as MusicTrack

test("album gaps use YTM positions and retain the actual Plex track objects", () => {
  const first = track("plex1", "First"), third = track("plex3", "Third", { trackNumber: 3 })
  const missing = track("ytmusic:missing", "Missing", { trackNumber: 2 })
  const result = supplementAlbumTracks([first, third], [track("ytmusic:first", "First"), missing, track("ytmusic:third", "Third")])
  expect(result.map(item => item.id)).toEqual([first.id, missing.id, third.id])
  expect(result[0]).toBe(first)
  expect(result[2]).toBe(third)
})

test("search matches performers and recordings while retaining other versions", () => {
  const local = { ...track("plex", "HALO"), type: "track" } as MusicItem
  const duplicate = { ...track("ytmusic:duplicate", "HALO"), type: "track" } as MusicItem
  const other = { ...track("ytmusic:other", "Another song"), type: "track" } as MusicItem
  expect(mergeMusicSearchResults([local], [duplicate, other]).map(item => item.id)).toEqual(["plex", "ytmusic:other"])
  expect(sameRecording(track("one", "HALO"), track("two", "HALO (Live)"))).toBe(false)
  expect(sameRecording(track("one", "HALO"), track("two", "HALO", { artistName: "Another Artist" }))).toBe(false)
  expect(sameRecording(track("one", "HALO", { explicit: true }), track("two", "HALO", { explicit: false }))).toBe(false)
})

test("individual collaboration credits match independently of separator or order", () => {
  const local = track("plex", "Song", { artistName: "NEEDY GIRL OVERDOSE; Aiobahn +81" })
  const remote = track("ytmusic", "Song", { artistName: "Aiobahn +81 x NEEDY GIRL OVERDOSE" })
  expect(sameRecording(local, remote)).toBe(true)
  expect(sameRecording(local, { ...remote, artistName: "Aiobahn +81; Another Artist" })).toBe(false)
  expect(sameRecording(local, { ...remote, title: "Song (Live)" })).toBe(false)
})
