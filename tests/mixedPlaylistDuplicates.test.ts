import { expect, test } from "bun:test"
import { youtubeMusicTrack } from "../src/backends/ytmusic/tracks"
import { newOccurrence } from "../src/mixedPlaylists/model"
import { deduplicateMergeItems } from "../src/mixedPlaylists/deduplicate"
import { preferredMixedReference } from "../src/mixedPlaylists/preferredTrack"
import { prepareMerge, type MergeSource } from "../src/mixedPlaylists/merge"
const track = (id: string, title = "Warrior", artist = "Remzcore") => ({
  ...youtubeMusicTrack({ videoId: "a1234567890", title, artist, album: "Warrior", duration: "3:02", thumbnail: null }), id,
})
test("loaded Plex and YTM source recordings join before any provider lookup", async () => {
  const plex = newOccurrence({ ...track("42"), codec: "flac", bitDepth: 24, samplingRate: 96000 })
  const youtube = newOccurrence(track("ytmusic:a1234567890"))
  const sources: [MergeSource, MergeSource] = [plex, youtube].map((row, index) => ({ key: String(index), title: "Source", fingerprint: "same", owners: {}, items: [row] })) as any
  let searches = 0
  const preview = await prepareMerge(sources, "mixed", "verified", { owners: { plex: "p", ytmusic: "y" }, current: () => true,
    resolve: async () => { searches++; throw Error("Already present in source data") } })
  expect(searches).toBe(0)
  expect(preview.removed).toBe(1)
  expect(preview.items[0].songs.plex?.track.id).toBe("42")
  expect(preview.items[0].songs.ytmusic?.track.id).toBe("ytmusic:a1234567890")
  expect(preferredMixedReference(preview.items[0]).track.id).toBe("42")
  expect(sources[0].items[0].songs.ytmusic).toBeUndefined()
})
test("same titles by another artist and live/remix/explicit/duration variants remain distinct", () => {
  const plex = newOccurrence(track("42"))
  const variants = [track("ytmusic:a1234567890", "Warrior", "Another Artist"), track("ytmusic:b1234567890", "Warrior (Live)"),
    track("ytmusic:c1234567890", "Warrior (Remix)"), { ...track("ytmusic:d1234567890"), duration: 160000 },
    { ...track("ytmusic:e1234567890"), explicit: false }]
  plex.songs.plex!.track.explicit = true
  const items = [plex, ...variants.map(song => newOccurrence(song))]
  expect(deduplicateMergeItems(items)).toBe(items)
})
test("artist punctuation, collaboration credit placement and close spelling differences can join", () => {
  for (const [left, right, title] of [["Artist, Guest", "Artist & Guest", "Warrior"], ["Artist", "Artist", "Warrior (Original Mix)"],
    ["Remzcore", "Remzcoré", "Warrior"]]) {
    const items = [newOccurrence(track("42", "Warrior", left)), newOccurrence(track("ytmusic:a1234567890", title, right))]
    expect(deduplicateMergeItems(items)).toHaveLength(1)
  }
})
test("a shared-ID bridge retains both service references and the best known copy", () => {
  const first = newOccurrence({ ...track("42"), codec: "mp3", bitrate: 96 })
  const second = newOccurrence(track("ytmusic:a1234567890"))
  const bridge = newOccurrence({ ...track("43"), codec: "flac", bitrate: 1000 })
  bridge.songs.ytmusic = second.songs.ytmusic
  const joined = deduplicateMergeItems([first, second, bridge])
  expect(joined).toHaveLength(1)
  expect(joined[0].id).toBe(first.id)
  expect(joined[0].songs.plex?.track.id).toBe("43")
  expect(joined[0].songs.ytmusic?.track.id).toBe(second.songs.ytmusic?.track.id)
  expect(preferredMixedReference(joined[0]).track.id).toBe("43")
})
test("selection follows known quality, falls back for unavailable Plex audio, and keeps Plex for unknown formats", () => {
  const row = newOccurrence(track("42"))
  row.songs.ytmusic = { track: track("ytmusic:a1234567890") }
  expect(preferredMixedReference(row).track.id).toBe("42")
  row.songs.plex!.track.codec = "mp3"; row.songs.plex!.track.bitrate = 96
  row.songs.ytmusic!.track.codec = "aac"; row.songs.ytmusic!.track.bitrate = 256
  expect(preferredMixedReference(row).track.id).toBe("ytmusic:a1234567890")
  row.songs.plex!.track.codec = "flac"
  expect(preferredMixedReference(row).track.id).toBe("42")
  row.songs.plex!.track.mediaInfo = { hasAudioStream: false } as any
  expect(preferredMixedReference(row).track.id).toBe("ytmusic:a1234567890")
})
