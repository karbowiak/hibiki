import { TrackQueuePager } from "../src/lib/pagedPlayback"
import { describe, expect, test } from "bun:test"
import { homeDiscoverySections, isRecentlyPlayedHub, mergeDiscoveryItems, mixDiscoveryItems, plexDiscoveryItems, recentDiscoveryItems, sortLatestReleases, youtubeDiscoveryItems } from "../src/lib/discovery"
import type { MusicHub, MusicItem } from "../src/types/music"
import type { YoutubeMusicHub, YoutubeMusicItem } from "../src/backends/ytmusic/discovery"

const album = (id: string, title: string, releaseDate = "2026-10-01") => ({ type: "album", id, title, artistName: "f5ve", year: Number(releaseDate.slice(0, 4)), releaseDate }) as MusicItem
const remote = (id: string, title: string, year = 2026, releaseDate: string | null = null): YoutubeMusicItem => ({ id, title, kind: "album", artist: "f5ve", year, releaseDate, thumbnail: null, album: null, duration: null })
const hub = (id: string, title: string): MusicHub => ({ identifier: id, title, items: [album(id, title)], style: null, layout: "scroller" })
const yhub = (id: string, title: string, category: YoutubeMusicHub["category"] = "music"): YoutubeMusicHub => ({ id, title, category, items: [{ ...remote(id, title), kind: category === "mixes" ? "playlist" : "album" }], destination: null, continuation: null })

describe("mixed home discovery", () => {
  test("similar artists alternate services and keep Plex when spelling differs only in formatting", () => {
    const plex = [{ type: "artist", id: "plex1", title: "Beyoncé" }, { type: "artist", id: "plex2", title: "AronChupa" }] as MusicItem[]
    const youtube = [{ ...remote("duplicate", "Beyonce"), kind: "artist" as const }, { ...remote("new", "Tiffany Day"), kind: "artist" as const }]
    expect(mergeDiscoveryItems(plexDiscoveryItems(plex), youtubeDiscoveryItems(youtube)).map(entry => entry.item.id)).toEqual(["plex1", "new", "plex2"])
  })
  test("Plex wins matching releases; unrelated albums still alternate between sources", () => {
    const items = mergeDiscoveryItems(plexDiscoveryItems([album("1", "I Choose You"), album("2", "Album Two")]),
      youtubeDiscoveryItems([remote("remote1", "I Choose You"), remote("remote2", "Other release")]))
    expect(items.map(entry => entry.item.id)).toEqual(["1", "remote2", "2"])
  })
  test("latest releases sort known dates and mix year-only releases within their year", () => {
    const items = mergeDiscoveryItems(plexDiscoveryItems([album("old", "Old", "2025-12-25"), album("plex", "Plex", "2026-10-15")]),
      youtubeDiscoveryItems([remote("year", "Year only"), remote("yt", "New", 2026, "2026-10-16"), remote("unknown", "Unknown", 0)]))
    expect(sortLatestReleases(items, 2026).map(entry => entry.item.id)).toEqual(["yt", "year", "plex", "unknown", "old"])
  })
  test("Mixed for You leads the mix shelf and other YouTube mixes follow it", () => {
    const items = mixDiscoveryItems([album("plex", "Library Mix")], [yhub("daily", "Your Daily Discover", "mixes"), yhub("priority", "Mixed for You", "mixes")])
    expect(items.map(entry => entry.item.id)).toEqual(["priority", "plex", "daily"])
  })
  test("individual songs never enter the mix shelf", () => {
    const mixed = yhub("mixed", "Mixed for You", "mixes")
    mixed.items.push({ ...remote("song", "Everything is romantic"), kind: "song" })
    expect(mixDiscoveryItems([], [mixed]).map(entry => entry.item.id)).toEqual(["mixed"])
  })
  test("a newer YTM play keeps its recency when Plex supplies the matching song", () => {
    const library = { ...album("plex-song", "I Choose You"), type: "track", lastPlayedAt: "2026-10-01T00:00:00Z" } as MusicItem
    const local = { ...remote("yt-song", "I Choose You"), kind: "song" as const, playedAt: Date.parse("2026-10-17T12:00:00Z") }
    const other = { ...remote("other", "Another song"), kind: "song" as const, playedAt: Date.parse("2026-10-16T12:00:00Z") }
    const items = recentDiscoveryItems([library], [local, other])
    expect(items.map(entry => entry.item.id)).toEqual(["plex-song", "other"])
    expect("lastPlayedAt" in library && library.lastPlayedAt).toBe("2026-10-01T00:00:00Z")
  })
  test("reserve compatible shelves for later Plex partners while weaving standalone hubs", () => {
    const favorite = yhub("yf", "Your favorites")
    favorite.items[0].title = "Another favorite album"
    const sections = homeDiscoverySections([hub("anniversary", "On This Day"), hub("favorite", "Your Favorites")],
      [favorite, yhub("hits", "Today's biggest hits")])
    expect(sections.map(section => section.id)).toEqual(["anniversary", "hits", "favorite"])
    expect(sections[2].items.map(entry => entry.source)).toEqual(["plex", "ytmusic"])
  })
  test("cursor playlists start audio from small pages without changing Plex paging", async () => {
    const calls: [number, number][] = []
    const pager = new TrackQueuePager({ key: "ytmusic:mix", pageSize: 50, loadPage: async (offset, limit) => {
      calls.push([offset, limit])
      return { items: Array.from({ length: 50 }, (_, i) => ({ id: `track-${offset + i}` } as any)), total: offset + 51, offset }
    } }, false)
    await pager.next(); await pager.next()
    expect(calls).toEqual([[0, 50], [50, 50]])
    expect(new TrackQueuePager({ key: "plex", loadPage: async () => ({ items: [], total: 0 }) }, false).pageSize).toBe(500)
  })
  test("Recent Playlists stays separate from Recently Played Music", () => {
    expect(isRecentlyPlayedHub(hub("music.recentlyplayed", "Recently Played Music"))).toBe(true)
    expect(isRecentlyPlayedHub(hub("music.recentPlaylists", "Recent Playlists"))).toBe(false)
  })
})
