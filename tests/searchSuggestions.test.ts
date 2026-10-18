import { expect, test } from "bun:test"
import { presentSearchSuggestions, searchItemKey } from "../src/lib/searchSuggestions"
import type { MusicItem } from "../src/types/music"
const rows = (source: string, counts = [4, 2, 1, 3]) => ["artist", "album", "track", "playlist"].flatMap((type, kind) =>
  Array.from({ length: counts[kind] }, (_, index) => ({ type, providerKey: source, id: `${source}:${type}:${index}`, title: `${source} ${index}` }) as MusicItem))

test("canonical categories interleave unequal provider results with bounded representation", () => {
  const plex = rows("plex"), youtube = rows("ytmusic", [1, 4, 0, 2])
  const combined = presentSearchSuggestions([...youtube, ...plex])
  expect(combined.filter(row => row.type === "artist").map(row => row.providerKey)).toEqual(["plex", "ytmusic", "plex", "plex"])
  expect(combined.filter(row => row.type === "album").map(row => row.providerKey)).toEqual(["plex", "ytmusic", "plex", "ytmusic", "ytmusic"])
  expect(combined.filter(row => row.type === "track")).toHaveLength(1)
  expect(combined.filter(row => row.type === "playlist")).toHaveLength(5)
  expect(combined.map(searchItemKey)).toEqual(presentSearchSuggestions([...plex, ...youtube]).map(searchItemKey))
  expect(presentSearchSuggestions([...plex, ...plex])).toHaveLength(9)
})

test("refreshed data replaces stale metadata and removed rows rather than retaining history", () => {
  const first = rows("ytmusic")
  const refreshed = [{ ...first[0], title: "Fresh title" }]
  expect(presentSearchSuggestions(refreshed)).toEqual(refreshed)
  expect(presentSearchSuggestions([])).toEqual([])
})
