import { expect, test } from "bun:test"
import { selectSearchDiscovery } from "../src/lib/searchDiscovery"
import type { MusicHub } from "../src/types/music"
const artist = (id: string) => ({ type: "artist", id, title: id }) as any
const album = (id: string) => ({ type: "album", id, title: id }) as any
const hub = (
  identifier: string,
  items: any[],
  title = identifier
): MusicHub => ({
  identifier,
  title,
  items,
  style: null,
  layout: "grid" as any,
})
test("discovery bounds distinct mix keys despite shared Plex placeholder IDs", () => {
  const mixes = Array.from(
    { length: 8 },
    (_, i) =>
      ({
        type: "playlist",
        id: "0",
        providerKey: `mix-${i}`,
        title: `Mix ${i}`,
      }) as any
  )
  const selected = selectSearchDiscovery([
    hub("music.mixes.5", [...mixes, mixes[0]]),
  ])
  expect(selected.mixes.map((x: any) => x.providerKey)).toEqual(
    mixes.slice(0, 6).map((x) => x.providerKey)
  )
})
test("discovery prioritizes original personalized titles and deduplicates typed entities", () => {
  const selected = selectSearchDiscovery([
    hub("music.popular.5", [album("popular")]),
    hub(
      "music.recent.artist.5",
      [album("same"), artist("same")],
      "More by Original Artist"
    ),
    hub(
      "music.vault.5",
      [artist("same"), artist("vault")],
      "Haven’t played in 11 months"
    ),
    hub("music.recent.played.5", [
      artist("same"),
      ...Array.from({ length: 12 }, (_, i) => artist(`${i}`)),
    ]),
    hub("music.recentlyAdded.5", [album("excluded")]),
    hub("music.recent.genre.5", [album("genre")]),
  ])
  expect(selected.recent.length).toBe(8)
  expect(selected.recommendations.map((h) => h.title)).toEqual([
    "More by Original Artist",
    "Haven’t played in 11 months",
  ])
  expect(selected.recommendations[0].items.map((i) => [i.type, i.id])).toEqual([
    ["album", "same"],
  ])
  expect(selected.recommendations[1].items.map((i) => i.id)).toEqual(["vault"])
})
test("empty and duplicate-only hubs do not displace useful recommendations", () => {
  const selected = selectSearchDiscovery([
    hub("music.recent.played", [artist("a")]),
    hub("music.recent.artist", [artist("a")]),
    hub("music.vault", []),
    hub("music.recent.genre", [album("b")], "Original genre"),
  ])
  expect(selected.recommendations.map((h) => h.title)).toEqual([
    "Original genre",
  ])
  expect(selectSearchDiscovery([])).toEqual({
    recent: [],
    mixes: [],
    recommendations: [],
  })
})
