import { expect, test } from "bun:test"
import { PlexProvider } from "../src/backends/plex/provider"
import { mergeMusicSearchResults } from "../src/lib/musicMatching"
import { linkSearchPlaylists, searchPlaylistHref } from "../src/lib/searchPlaylists"
import { appendSearchSuggestions } from "../src/lib/searchSuggestions"
import type { MusicItem } from "../src/types/music"
import type { MixedPlaylist } from "../src/mixedPlaylists/model"

const row = (id: string, providerKey = "plex"): MusicItem => ({ type: "playlist", id, providerKey, title: "Japanese Music", smart: false,
  trackCount: 12, duration: null, thumbUrl: null, summary: null, addedAt: null })
const linked = { id: "mixed:known", title: "Linked music", owners: { plex: "library", ytmusic: "account" }, aliases: ["123", "ytmusic:VLPL_list"], items: [] } as unknown as MixedPlaylist

test("same-title provider playlists remain distinct unless an explicit current-owner alias links them", () => {
  const results = mergeMusicSearchResults([row("123")], [row("ytmusic:VLPL_list", "ytmusic")])
  expect(results).toHaveLength(2)
  expect(results.map(searchPlaylistHref)).toEqual(["/playlist/123", "/ytmusic/VLPL_list"])
  const mapped = linkSearchPlaylists(results, [linked], linked.owners)
  expect(mapped).toHaveLength(1)
  expect(searchPlaylistHref(mapped[0])).toBe("/mixed-playlist/mixed%3Aknown")
  expect(linkSearchPlaylists(results, [linked], { plex: "other", ytmusic: "account" })).toEqual(results)
  expect(linkSearchPlaylists(results, [linked], { plex: "library" })).toEqual(results)
})

test("dropdown limits use service identities rather than opaque Plex metadata paths", () => {
  const rows = Array.from({ length: 10 }, (_, index) => row(String(index), `/playlists/${index}`))
  expect(appendSearchSuggestions([], rows)).toHaveLength(3)
})

test("Plex title search includes account playlist metadata and never reads playlist contents", async () => {
  const calls: string[] = []
  const provider = new PlexProvider(async (command): Promise<any> => {
    calls.push(command)
    if (command === "search_library") return []
    if (command === "get_playlists") return [{ rating_key: 123, title: "Japanese Music", playlist_type: "audio", smart: false, leaf_count: 12 },
      { rating_key: 456, title: "Movies", playlist_type: "video" }]
    throw Error(`Unexpected command ${command}`)
  })
  await provider.connect({ baseUrl: "http://plex.test", token: "synthetic", sectionId: 1, connectionRevision: 1, cacheScope: `plex-${"a".repeat(64)}` })
  const results = await provider.search("  JAPANESE  ")
  expect(results.map(item => [item.type, item.id, item.title])).toEqual([["playlist", "123", "Japanese Music"]])
  expect(calls.sort()).toEqual(["get_playlists", "search_library"])
  calls.length = 0
  await provider.search("Unknown", "artist")
  expect(calls).toEqual(["search_library"])
})

test("Plex catalog and playlist metadata failures do not discard the other result group", async () => {
  for (const failed of ["search_library", "get_playlists"]) {
    const provider = new PlexProvider(async (command): Promise<any> => {
      if (command === failed) throw Error("Temporary failure")
      return command === "search_library" ? [{ type: "artist", rating_key: 1, title: "Japanese Artist" }]
        : [{ rating_key: 123, title: "Japanese Music", playlist_type: "audio", smart: false, leaf_count: 12 }]
    })
    await provider.connect({ baseUrl: "http://plex.test", token: "synthetic", sectionId: 1, connectionRevision: 1, cacheScope: `plex-${"a".repeat(64)}` })
    expect((await provider.search("Japanese"))).toHaveLength(1)
  }
})
