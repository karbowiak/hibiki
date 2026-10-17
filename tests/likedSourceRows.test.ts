import { expect, test } from "bun:test"
import { mergeLikedTrackSources } from "../src/favorites/sourceRows"
import { youtubeMusicTrack } from "../src/backends/ytmusic/tracks"

test("combined likes retain source identity, versions, video entries and deliberate ratings", () => {
  const song = youtubeMusicTrack({ videoId: "abcdefghijk", title: "Song", artist: "Artist", album: "Album", thumbnail: null, duration: "3:00" })
  const plex = { ...song, id: "42", providerKey: "plex", userRating: 6, likedAt: "2020-01-01T00:00:00Z" }
  const youtube = { ...song, userRating: 8, likedAt: "2021-01-01T00:00:00Z" }
  const live = { ...song, id: "ytmusic:lmnopqrstuv", title: "Song (Live)" }
  const video = { ...song, id: "ytmusic:w1234567890" }
  const onlyYoutube = { ...song, id: "ytmusic:x1234567890", title: "Another Song" }
  const rows = mergeLikedTrackSources([plex, plex], [youtube, live, video, onlyYoutube, youtube])
  expect(rows.map(row => row.id)).toEqual([plex.id, youtube.id, live.id, video.id, onlyYoutube.id])
  expect(rows[0]).toBe(plex)
  expect(rows[1]).toBe(youtube)
  expect(rows[1].userRating).toBe(8)
  expect(rows[1].likedAt).toBe("2021-01-01T00:00:00Z")
  expect(mergeLikedTrackSources([], [youtube, youtube])).toEqual([youtube])
  expect(mergeLikedTrackSources([plex], [])).toEqual([plex])
})
