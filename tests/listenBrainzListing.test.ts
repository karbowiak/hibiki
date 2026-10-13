import { test, expect } from "bun:test"
import {
  listenBrainzPlaylistAdapter,
  type ListenBrainzListingSource,
  type ListenBrainzPlaylistTransport,
} from "../src/playlistSync/listenbrainz"
const account = {
  service: "listenbrainz",
  user: "fixture-user",
  revision: "fixture-revision",
}
const id = (n: number) =>
  `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`
const summary = (n: number, creator = "fixture-user") => ({
  playlist: {
    identifier: `https://listenbrainz.org/playlist/${id(n)}`,
    title: `Playlist ${n}`,
    creator,
    track: [],
  },
})
function transport(
  list: ListenBrainzPlaylistTransport["list"],
  current = () => account
): ListenBrainzPlaylistTransport {
  return {
    account: async () => current(),
    list,
    read: async () => {
      throw Error("Summary listing must not fetch tracks")
    },
    create: async () => {
      throw Error("Summary listing must not write")
    },
  }
}
test("all visible feeds paginate independently, dedupe IDs and retain generated read-only origin", async () => {
  const calls: { source: ListenBrainzListingSource; offset: number }[] = []
  const feeds = {
    created: Array.from({ length: 101 }, (_, i) => summary(i + 1)),
    createdfor: [summary(102, "weekly-bot"), summary(103, "jams-bot")],
    collaborator: [summary(1), summary(104, "friend")],
  }
  const adapter = listenBrainzPlaylistAdapter(
    account,
    transport(async (_expected, offset, count, source = "created") => {
      calls.push({ source, offset })
      const feed = feeds[source]
      return {
        playlists: feed.slice(offset, offset + count),
        listing_source: source,
        playlist_count: feed.length,
        offset,
        count,
      }
    })
  )
  const result = await adapter.listAll()
  expect(result.complete).toBe(true)
  expect(result.truncated).toBe(false)
  expect(result.total).toBe(104)
  expect(calls).toEqual([
    { source: "created", offset: 0 },
    { source: "created", offset: 100 },
    { source: "createdfor", offset: 0 },
    { source: "collaborator", offset: 0 },
  ])
  expect(result.items.find((i) => i.id === id(1))!.access.origins).toEqual([
    "created",
    "collaborator",
  ])
  expect(result.items.find((i) => i.id === id(1))!.access.writable).toBe(true)
  expect(result.items.find((i) => i.id === id(102))!.access).toMatchObject({
    generated: true,
    owned: false,
    writable: false,
  })
  expect(result.items.find((i) => i.id === id(104))!.access).toMatchObject({
    owned: false,
    writable: false,
  })
  expect(result.items.every((i) => i.items.length === 0)).toBe(true)
})
test("retired account cannot publish a late generated page", async () => {
  let current = account
  const adapter = listenBrainzPlaylistAdapter(
    account,
    transport(
      async (_e, offset, count, source = "created") => {
        if (source === "createdfor")
          current = { ...account, user: "replacement" }
        return { playlists: [], playlist_count: 0, offset, count }
      },
      () => current
    )
  )
  await expect(adapter.listAll()).rejects.toThrow("account changed")
})
test("repeated pages and changed feed totals fail rather than silently omitting generated lists", async () => {
  for (const change of [false, true]) {
    const adapter = listenBrainzPlaylistAdapter(
      account,
      transport(async (_e, offset, count) => ({
        playlists: Array.from({ length: offset ? 1 : 100 }, (_, i) =>
          summary(offset ? 1 : i + 1)
        ),
        playlist_count: offset && change ? 102 : 101,
        offset,
        count,
      }))
    )
    await expect(adapter.listAll()).rejects.toThrow(
      change ? "changed" : "Repeated"
    )
  }
})
test("large collections report explicit truncation at the bounded metadata budget", async () => {
  let requests = 0
  const adapter = listenBrainzPlaylistAdapter(
    account,
    transport(async (_e, offset, count) => {
      requests++
      return {
        playlists: Array.from({ length: 100 }, (_, i) =>
          summary(offset + i + 1)
        ),
        playlist_count: 2100,
        offset,
        count,
      }
    })
  )
  const result = await adapter.listAll()
  expect(result.items.length).toBe(2000)
  expect(result.complete).toBe(false)
  expect(result.truncated).toBe(true)
  expect(requests).toBe(20)
})
test("metadata-only listing rejects embedded recordings and never promotes generated creator identity to writable", async () => {
  const adapter = listenBrainzPlaylistAdapter(
    account,
    transport(async (_e, offset, count, source = "created") => ({
      playlists: source === "createdfor" ? [summary(1)] : [],
      listing_source: source,
      playlist_count: source === "createdfor" ? 1 : 0,
      offset,
      count,
    }))
  )
  expect((await adapter.listAll()).items[0].access).toMatchObject({
    owned: false,
    writable: false,
    generated: true,
  })
  const bad = summary(2) as any
  bad.playlist.track = [
    { identifier: [`https://musicbrainz.org/recording/${id(3)}`] },
  ]
  await expect(
    listenBrainzPlaylistAdapter(
      account,
      transport(async (_e, offset, count) => ({
        playlists: [bad],
        playlist_count: 1,
        offset,
        count,
      }))
    ).listAll()
  ).rejects.toThrow("recordings")
})

test("an old native binary cannot silently relabel owned pages as generated", async () => {
  const adapter = listenBrainzPlaylistAdapter(
    account,
    transport(async (_e, offset, count) => ({
      playlists: [],
      playlist_count: 0,
      offset,
      count,
    }))
  )
  await expect(adapter.listAll()).rejects.toThrow("Restart Hibiki")
})

test("weekly channels use authoritative bot metadata; week suffix is display only", async () => {
  const { weeklyPlaylistMetadata } =
    await import("../src/playlistSync/listenbrainz")
  const row = {
    playlist: {
      creator: "listenbrainz",
      title: "Anything, week of 2026-10-05 Mon",
      date: "2026-10-05T05:49:37.471329+00:00",
      extension: {
        "https://musicbrainz.org/doc/jspf#playlist": {
          created_for: account.user,
          additional_metadata: {
            algorithm_metadata: { source_patch: "weekly-exploration" },
          },
        },
      },
    },
  }
  expect(weeklyPlaylistMetadata(row, "createdfor", account)).toEqual({
    family: "weekly-exploration",
    recipient: account.user,
    createdAt: row.playlist.date,
    weekOf: "2026-10-05",
  })
  const noTitle = structuredClone(row)
  noTitle.playlist.title = "Source title changed"
  expect(
    weeklyPlaylistMetadata(noTitle, "createdfor", account)?.weekOf
  ).toBeNull()
  const invalidMonday = structuredClone(row)
  invalidMonday.playlist.title = "Weekly Exploration, week of 2026-10-06 Mon"
  expect(
    weeklyPlaylistMetadata(invalidMonday, "createdfor", account)?.weekOf
  ).toBeNull()
  expect(weeklyPlaylistMetadata(row, "created", account)).toBeUndefined()
  for (const wrong of ["creator", "recipient", "patch"]) {
    const altered = structuredClone(row)
    if (wrong === "creator") altered.playlist.creator = "unverified-bot"
    if (wrong === "recipient")
      altered.playlist.extension[
        "https://musicbrainz.org/doc/jspf#playlist"
      ].created_for = "other-user"
    if (wrong === "patch")
      altered.playlist.extension[
        "https://musicbrainz.org/doc/jspf#playlist"
      ].additional_metadata.algorithm_metadata.source_patch =
        "weekly-exploration-untrusted"
    expect(
      weeklyPlaylistMetadata(altered, "createdfor", account)
    ).toBeUndefined()
  }
})
