import { expect, test } from "bun:test"
import { createYoutubeCatalogMatcher } from "../src/mixedPlaylists/youtubeCatalogMatching"
import { youtubeCounterpartCandidates } from "../src/mixedPlaylists/youtubeMatching"
import { matchPlaylistBatch, selectPlaylistCounterpart } from "../src/mixedPlaylists/matching"
import { hydratePlaylist } from "../src/mixedPlaylists/model"
import { youtubeMusicTrack } from "../src/backends/ytmusic/tracks"
import { normalizeArtistCredits } from "../src/lib/artistCredits"
import type { YoutubeMusicBrowsePage, YoutubeMusicDestination, YoutubeMusicHub, YoutubeMusicItem } from "../src/backends/ytmusic/discovery"

const item = (id: string, kind: YoutubeMusicItem["kind"], title: string, patch: Partial<YoutubeMusicItem> = {}): YoutubeMusicItem => ({
  id, kind, title, artist: "Re-Style", artistCredits: [{ name: "Re-Style" }], duration: "3:00", album: "Release",
  thumbnail: null, year: 2026, ...patch,
})
const page = (patch: Partial<YoutubeMusicBrowsePage> = {}): YoutubeMusicBrowsePage => ({ title: "", items: [], hubs: [], continuation: null, ...patch })
const shelf = (category: YoutubeMusicHub["category"], items: YoutubeMusicItem[], destination: YoutubeMusicDestination | null = null): YoutubeMusicHub =>
  ({ id: category, title: category, category, items, destination, continuation: null })
const artist = (hubs: YoutubeMusicHub[] = [], items: YoutubeMusicItem[] = [], name = "Re-Style") => page({ title: name, hubs, items,
  artist: { id: "UC_artist", name, thumbnail: null, background: null, description: null, monthlyListeners: null, subscribers: null, songs: null, shuffle: null } })
const toTrack = (value: YoutubeMusicItem) => ({
  ...youtubeMusicTrack({ videoId: value.id, title: value.title, artist: value.artist, album: value.album, duration: value.duration, thumbnail: value.thumbnail }),
  artistCredits: normalizeArtistCredits(value.artist, null, value.artistCredits),
  albumId: value.albumId ? `ytmusic:${value.albumId}` : null, artistId: value.artistId ? `ytmusic:${value.artistId}` : null,
})
const source = (id: number, title: string, album = "Release", name = "Re-Style") => ({
  ...toTrack(item(`a${String(id).padStart(10, "0")}`, "song", title, { album, artist: name, artistCredits: [{ name }] })), id: String(id),
})

test("twenty songs share one artist lookup and one album read, including concurrent callers", async () => {
  const tracks = Array.from({ length: 20 }, (_, index) => source(index + 1, `Song ${index + 1}`))
  const songs = tracks.map((track, index) => item(`a${String(index + 1).padStart(10, "0")}`, "song", track.title))
  const calls: string[] = []
  const candidates = createYoutubeCatalogMatcher(tracks, { current: () => true, toTrack, browse: async destination => {
    calls.push(destination.browseId)
    if (destination.browseId === "hibiki_artist_search") return page({ items: [item("UC_artist", "artist", "Re-Style")] })
    if (destination.browseId === "UC_artist") return artist([shelf("albums", [item("MPRE_release", "album", "Release")])])
    if (destination.browseId === "MPRE_release") return page({ title: "Release", items: songs })
    throw Error("Unexpected catalog lookup")
  } })
  const results = await Promise.all(tracks.map(async track => selectPlaylistCounterpart(track, await candidates(track))))
  expect(results.every((result, index) => result?.track.title === tracks[index].title)).toBe(true)
  expect(calls).toEqual(["hibiki_artist_search", "UC_artist", "MPRE_release"])
  expect(selectPlaylistCounterpart(tracks[0], await candidates(tracks[0]))?.track.title).toBe("Song 1")
  expect(calls).toHaveLength(3)
})

test("hidden singles and EPs paginate once, then all album track pages are reused", async () => {
  const tracks = [source(1, "First song", "Forgotten EP"), source(2, "Second song", "Forgotten EP")]
  const calls: string[] = []
  const candidates = createYoutubeCatalogMatcher(tracks, { current: () => true, toTrack, browse: async (destination, cursor) => {
    calls.push(`${destination.browseId}:${destination.params ?? ""}:${cursor ?? ""}`)
    if (destination.browseId === "hibiki_artist_search") return page({ items: [item("UC_artist", "artist", "Re-Style")] })
    if (destination.browseId === "UC_artist" && !destination.params) return artist([
      shelf("singles", [item("MPRE_other", "album", "Unrelated")], { browseId: "UC_artist", params: "singles" }),
    ])
    if (destination.params === "singles") return cursor
      ? page({ items: [item("MPRE_ep", "album", "Forgotten EP")] })
      : page({ items: [item("MPRE_other", "album", "Unrelated")], continuation: "older-singles" })
    if (destination.browseId === "MPRE_ep") return cursor
      ? page({ items: [item("a0000000002", "song", "Second song", { album: null, artist: "", artistCredits: [] })] })
      : page({ title: "Forgotten EP", items: [item("a0000000001", "song", "First song", { album: null })], continuation: "album-next" })
    throw Error("Unrelated releases should not be opened")
  } })
  const results = await Promise.all(tracks.map(async track => selectPlaylistCounterpart(track, await candidates(track))))
  expect(results.map(result => result?.track.title)).toEqual(["First song", "Second song"])
  expect(results[1]?.track.albumName).toBe("Forgotten EP")
  expect(results[1]?.track.artistName).toBe("Re-Style")
  expect(results[1]?.track.albumId).toBe("ytmusic:MPRE_ep")
  expect(calls).toEqual(["hibiki_artist_search:Re-Style:", "UC_artist::", "UC_artist:singles:", "UC_artist:singles:older-singles", "MPRE_ep::", "MPRE_ep::album-next"])
})

test("known artist mappings and top songs avoid both artist search and unnecessary release reads", async () => {
  const track = source(1, "Top song"), calls: string[] = []
  let reverse = 0
  const candidates = createYoutubeCatalogMatcher([track], { current: () => true, toTrack,
    knownArtists: async () => { reverse++; return ["ytmusic:UC_artist"] }, browse: async destination => {
      calls.push(destination.browseId)
      if (destination.browseId === "UC_artist") return artist([], [item("a0000000001", "song", "Top song")])
      throw Error("Unnecessary lookup")
    } })
  expect(selectPlaylistCounterpart(track, await candidates(track))?.track.title).toBe("Top song")
  expect(calls).toEqual(["UC_artist"])
  expect(reverse).toBe(1)
})

test("playlist resolution searches individual songs only when the artist/release pass cannot match", async () => {
  const track = source(1, "First song"), remote = toTrack(item("a0000000001", "song", "First song"))
  let searches = 0
  const options = { current: () => true, fuzzy: true, search: async () => { searches++; return [remote] } }
  const catalogHit = await youtubeCounterpartCandidates(track, { ...options, catalog: async () => [remote] })
  expect(selectPlaylistCounterpart(track, catalogHit)?.track.id).toBe(remote.id)
  expect(searches).toBe(0)
  const catalogMiss = await youtubeCounterpartCandidates(track, { ...options, catalog: async () => [] })
  expect(selectPlaylistCounterpart(track, catalogMiss)?.track.id).toBe(remote.id)
  expect(searches).toBe(1)
})

test("catalog evidence disambiguates same-name artists while performer spelling may be fuzzy", async () => {
  const track = source(1, "First song", "Release", "Re-Stile")
  const candidates = createYoutubeCatalogMatcher([track], { current: () => true, toTrack, browse: async destination => {
    if (destination.browseId === "hibiki_artist_search") return page({ items: [item("UC_other", "artist", "Re-Style"), item("UC_artist", "artist", "Re-Style")] })
    if (destination.browseId === "UC_other") return artist([shelf("albums", [item("MPRE_wrong", "album", "Wrong release")])])
    if (destination.browseId === "UC_artist") return artist([shelf("albums", [item("MPRE_release", "album", "Release")])])
    if (destination.browseId === "MPRE_release") return page({ items: [item("a0000000001", "song", "First song")] })
    throw Error("Wrong artist's release opened")
  } })
  expect(selectPlaylistCounterpart(track, await candidates(track))?.track.title).toBe("First song")
})

test("account changes retire pending catalog pages before matching or admitting more calls", async () => {
  const track = source(1, "Song"), calls: string[] = []
  let current = true
  const candidates = createYoutubeCatalogMatcher([track], { current: () => current, toTrack, browse: async destination => {
    calls.push(destination.browseId); current = false
    return page({ items: [item("UC_artist", "artist", "Re-Style")] })
  } })
  await expect(candidates(track)).rejects.toThrow("accounts changed")
  expect(calls).toEqual(["hibiki_artist_search"])
})

test("native rate-limit strings stop the catalog pass and are never mistaken for catalog misses", async () => {
  const track = source(1, "Song"), message = "YouTube Music is rate limited. Hibiki will retry after the cooldown."
  let calls = 0
  const candidates = createYoutubeCatalogMatcher([track], { current: () => true, toTrack, browse: async () => { calls++; throw message } })
  await expect(candidates(track)).rejects.toEqual(message)
  await expect(candidates(track)).rejects.toEqual(message)
  expect(calls).toBe(1)
})

test("repeated release cursors stop and a catalog miss remains eligible for song search", async () => {
  const track = source(1, "Missing song", "Missing release")
  let calls = 0
  const candidates = createYoutubeCatalogMatcher([track], { current: () => true, toTrack, browse: async destination => {
    calls++
    if (destination.browseId === "hibiki_artist_search") return page({ items: [item("UC_artist", "artist", "Re-Style")] })
    if (!destination.params) return artist([shelf("albums", [], { browseId: "UC_artist", params: "albums" })])
    return page({ continuation: "same-cursor" })
  } })
  expect(await candidates(track)).toEqual([])
  expect(calls).toBe(4)
})

test("artist-grouped lookup work preserves original playlist order and occurrences", async () => {
  const tracks = [source(1, "First"), source(2, "Middle", "Release", "Remzcore"), source(3, "Last")]
  const playlist = hydratePlaylist({ service: "plex", owner: "owner", id: "10", title: "List", readOnly: false,
    items: tracks.map(track => ({ occurrenceId: track.id, track })) })
  const calls: string[] = []
  const result = await matchPlaylistBatch(playlist, "ytmusic", { current: () => true, save: async value => value, resolve: async track => {
    calls.push(track.id); return { status: "missing", message: "No suitable result", checkedAt: Date.now() }
  } })
  expect(calls).toEqual(["1", "3", "2"])
  expect(result.playlist.items.map(row => row.songs.plex!.track.id)).toEqual(["1", "2", "3"])
  expect(result.playlist.items.map(row => row.id)).toEqual(playlist.items.map(row => row.id))
})
