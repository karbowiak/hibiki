import { expect, test } from "bun:test"
import { createAmbientArtworkController } from "../src/stores/ambientArtworkStore"
import {
  collectAmbientCandidates,
  eligibleAmbientUrl,
} from "../src/lib/ambientArtwork"
import type { MusicProvider } from "../src/providers/types"
const image = (id: string, scope = "a") =>
  `image://localhost/ext/img?src=${encodeURIComponent(`https://synthetic.test/${id}`)}&scope=${scope}`
function harness() {
  let provider = { cacheScope: "a" } as MusicProvider
  const controller = createAmbientArtworkController(() => ({
    provider,
    scope: provider.cacheScope ?? undefined,
  }))
  return {
    controller,
    get provider() {
      return provider
    },
    replace: () => {
      provider = { cacheScope: "a" } as MusicProvider
      controller.syncContext()
    },
    rescope: () => {
      ;(provider as any).cacheScope = "b"
      controller.syncContext()
    },
  }
}
test("newest detail owner wins without older geometry updates stealing ownership, and route filters precede cleanup", () => {
  const h = harness(),
    a = h.controller.acquire("a", h.provider, "a"),
    b = h.controller.acquire("b", h.provider, "a")
  a.update({ src: image("a"), route: "/artist/a" })
  b.update({ src: image("b"), route: "/artist/a", position: "30% 20%" })
  a.update({
    src: image("a"),
    route: "/artist/a",
    align: {
      heroW: 400,
      heroH: 300,
      heroTop: 50,
      heroLeft: 240,
      scrollTop: 120,
    },
  })
  expect(h.controller.getWinner("/artist/a", h.provider, "a")?.owner).toBe("b")
  expect(h.controller.getWinner("/search", h.provider, "a")).toBeNull()
  b.release()
  expect(h.controller.getWinner("/artist/a", h.provider, "a")?.owner).toBe("a")
  a.release()
  a.update({ src: image("late"), route: "/search" })
  expect(h.controller.getWinner("/search", h.provider, "a")).toBeNull()
})
test("account identity and mutable library scope retire leases, failure callbacks and source publication", () => {
  const h = harness(),
    old = h.controller.acquire("old", h.provider, "a")
  old.update({ src: image("old"), route: "/album/a" })
  h.replace()
  old.update({ src: image("late"), route: "/album/a" })
  expect(h.controller.getWinner("/album/a", h.provider, "a")).toBeNull()
  const next = h.controller.acquire("new", h.provider, "a")
  next.update({ src: image("new"), route: "/album/a" })
  h.rescope()
  next.update({ src: image("late", "b"), route: "/album/a" })
  expect(h.controller.getWinner("/album/a", h.provider, "b")).toBeNull()
  const scoped = h.controller.acquire("scoped", h.provider, "b")
  scoped.update({ src: image("wrong", "a"), route: "/album/a" })
  expect(h.controller.getWinner("/album/a", h.provider, "b")).toBeNull()
})
test("detail failure dispatches only current source callback, rejects failed pixels and permits revised retry", () => {
  const h = harness(),
    lease = h.controller.acquire("detail", h.provider, "a"),
    failures: string[] = []
  lease.update({
    src: image("cover"),
    route: "/album/a",
    onFailure: (src) => failures.push(src),
  })
  expect(
    h.controller.failCurrent(image("late"), "/album/a", h.provider, "a")
  ).toBe(false)
  expect(failures).toEqual([])
  expect(
    h.controller.failCurrent(image("cover"), "/album/a", h.provider, "a")
  ).toBe(true)
  expect(failures).toEqual([image("cover")])
  expect(h.controller.getWinner("/album/a", h.provider, "a")).toBeNull()
  lease.update({ src: `${image("cover")}&revision=fresh`, route: "/album/a" })
  expect(h.controller.getWinner("/album/a", h.provider, "a")?.src).toContain(
    "revision=fresh"
  )
})
test("claim storage and failures stay bounded and identical measurements do not republish", () => {
  const h = harness()
  for (let i = 0; i < 20; i++)
    h.controller
      .acquire(`${i}`, h.provider, "a")
      .update({ src: image(`${i}`), route: "/album/a" })
  expect(h.controller.store.getState().claims.length).toBe(8)
  const lease = h.controller.acquire("same", h.provider, "a")
  lease.update({ src: image("same"), route: "/album/a" })
  const before = h.controller.store.getState()
  lease.update({ src: image("same"), route: "/album/a", position: "50% 50%" })
  expect(h.controller.store.getState()).toBe(before)
  for (let i = 0; i < 100; i++)
    h.controller.fail(image(`${i}`), h.provider, "a")
  expect(h.controller.store.getState().failed.length).toBe(64)
})
test("candidate pool prefers known wide artist art, deduplicates sources and never drains playlist caches", () => {
  const library: any = {
    likedArtists: [
      {
        id: "artist",
        title: "Artist",
        thumbUrl: image("portrait"),
        artUrl: image("wide"),
      },
    ],
    latestReleases: [
      {
        id: "album",
        title: "Album",
        artistName: "Artist",
        thumbUrl: image("album"),
      },
    ],
    likedAlbums: [],
    recentlyAdded: [
      {
        type: "album",
        id: "duplicate",
        title: "Album",
        artistName: "Artist",
        thumbUrl: image("album"),
      },
    ],
    hubs: [],
    likedTracks: [],
    playlists: [],
  }
  Object.defineProperty(library, "playlistItemsCache", {
    get() {
      throw new Error("Must not inspect full playlist items")
    },
  })
  const pool = collectAmbientCandidates(library, "a")
  expect(pool.map((c) => c.src)).toEqual([image("wide"), image("album")])
  library.latestReleases = Array.from({ length: 5000 }, (_, i) => ({
    id: `${i}`,
    title: `${i}`,
    artistName: "Artist",
    thumbUrl: image(`${i}`),
  }))
  library.hubs = Array.from({ length: 100 }, (_, i) => ({
    items: Array.from({ length: 100 }, (_, j) => ({
      type: "artist",
      id: `${i}-${j}`,
      title: "Artist",
      thumbUrl: image(`${i}-${j}`),
    })),
  }))
  expect(collectAmbientCandidates(library, "a").length).toBeLessThanOrEqual(96)
})
test("pool excludes absent, foreign-scope and metadata-only URLs instead of initiating source discovery", () => {
  expect(eligibleAmbientUrl(null, "a")).toBe(false)
  expect(eligibleAmbientUrl(image("old", "b"), "a")).toBe(false)
  expect(
    eligibleAmbientUrl("image://localhost/artist/1?name=Artist", "a")
  ).toBe(false)
  expect(
    eligibleAmbientUrl("https://user:password@synthetic.test/a", "a")
  ).toBe(false)
  expect(
    eligibleAmbientUrl("image://localhost/ext/img?src=not-a-url&scope=a", "a")
  ).toBe(false)
  expect(eligibleAmbientUrl(image("good"), "a")).toBe(true)
})
