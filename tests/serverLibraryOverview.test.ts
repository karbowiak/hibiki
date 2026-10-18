import { expect, test } from "bun:test"
import { loadServerOverview, SERVER_OVERVIEW_LIMIT } from "../src/lib/serverLibraryOverview"
import type { MusicProvider } from "../src/providers/types"
const fake = (offline = false) => {
  const calls: unknown[][] = []
  const read = (kind: string) => async (...args: unknown[]) => { calls.push([kind, ...args]); return { items: [{ id: kind, title: kind }], total: 400000, localCoverageComplete: !offline, serverTotal: 900000 } }
  return { calls, provider: { isOffline: offline, getAllArtists: read("artists"), getAllAlbums: read("albums"), getAllTracks: read("songs"),
    getRecentlyAdded: async (...args: unknown[]) => { calls.push(["recent", ...args]); return [{ id: "recent", title: "New", type: args[0] }] },
  } as unknown as MusicProvider }
}
test("server overview uses only bounded pages and recent shelves independent of library size", async () => {
  const { provider, calls } = fake()
  const sections = await loadServerOverview(provider)
  expect(calls).toHaveLength(5)
  for (const call of calls) expect(call.at(-1)).toBe(SERVER_OVERVIEW_LIMIT)
  expect(sections.map(section => section.page?.total)).toEqual([400000, 400000, 400000])
  expect(sections.map(section => section.title)).toEqual(["Explore artists", "Recently added releases", "Recently added songs"])
})
test("offline overview preserves partial coverage and avoids live shelves", async () => {
  const { provider, calls } = fake(true)
  const sections = await loadServerOverview(provider)
  expect(calls).toHaveLength(3)
  expect(sections[1].page?.localCoverageComplete).toBe(false)
  expect(sections[1].page?.serverTotal).toBe(900000)
})
test("failed categories and optional shelves leave other categories usable", async () => {
  const { provider } = fake()
  provider.getAllAlbums = async () => { throw Error("Saved releases unavailable") }
  provider.getRecentlyAdded = async () => { throw Error("Offline") }
  const sections = await loadServerOverview(provider)
  expect(sections[1].error).toContain("Saved releases unavailable")
  expect(sections[0].page?.items).toHaveLength(1)
  expect(sections[2].title).toBe("Explore songs")
  expect(sections[2].page?.items).toHaveLength(1)
})
