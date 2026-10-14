import { expect, test } from "bun:test"
import {
  emptyFavorites,
  setFavorite,
  mergeFavoriteSnapshot,
  bindFavorites,
  acknowledgeFavorite,
  findFavorite,
  seedFavoriteRatings,
  lastfmFavoriteKey,
  favoriteLikedAt,
} from "../src/favorites/model"
import {
  readFavoriteRoster,
  syncFavorites,
  type FavoriteSyncServices,
} from "../src/favorites/sync"
import { favoriteTracks, sortLikedTracks } from "../src/favorites/collection"
import {
  validFavorite,
  validFavoriteMetadata,
} from "../src/favorites/validation"
import type {
  FavoriteState,
  FavoriteService,
  FavoriteRecording,
  FavoritePlexSnapshot,
} from "../src/favorites/types"
import type { MusicTrack } from "../src/types/music"
const account = (service: string, user = "listener", revision = "lease") => ({
  service,
  user,
  revision,
})
const row = (
  n: number,
  extra: Partial<FavoriteRecording> = {}
): FavoriteRecording => ({
  key: `local:${n}`,
  localTrackId: String(n),
  artist: "Artist",
  title: `Song ${n}`,
  ...extra,
})
function connected(service: FavoriteService, initialized = false) {
  let state = emptyFavorites()
  state.settings[service] = true
  state = bindFavorites(state, service, account(service))
  state.bindings[service]!.initialized = initialized
  if (service === "plex") state.bindings.plex!.playlistId = "9"
  return state
}
function fixture(initial: FavoriteState) {
  let state = initial,
    roster: FavoriteRecording[] = [],
    ids: string[] = [],
    writes = 0,
    creates = 0,
    active = true
  const repository = {
    read: () => state,
    update: async (change: (state: FavoriteState) => FavoriteState) => {
      state = change(state)
      return state
    },
  }
  const plex = (): FavoritePlexSnapshot => ({
    title: "Liked Songs",
    items: ids.map((id, index) => ({
      trackId: id,
      occurrenceId: String(index + 1),
    })),
    rows: [...new Set(ids)].map((id) => row(Number(id))),
    total: new Set(ids).size,
    offset: 0,
  })
  const services: FavoriteSyncServices = {
    account: async (side) => account(side),
    page: async (_, offset) => ({
      rows: roster.slice(offset, offset + 100),
      offset,
      total: roster.length,
    }),
    peek: async (_, record) =>
      roster.some(
        (item) =>
          item.key === record.key ||
          lastfmFavoriteKey(item) === lastfmFavoriteKey(record)
      ),
    set: async (_, record, liked) => {
      writes++
      roster = roster.filter(
        (item) =>
          item.key !== record.key &&
          lastfmFavoriteKey(item) !== lastfmFavoriteKey(record)
      )
      if (liked) roster.push({ ...record, key: lastfmFavoriteKey(record) })
      return liked
    },
    plexRead: async () => plex(),
    plexCreate: async () => {
      creates++
      return "9"
    },
    plexMutate: async (_, hash, operation) => {
      writes++
      if (operation.kind === "append") ids.push(...operation.ids)
      else ids.splice(operation.index, 1)
      return plex()
    },
  }
  return {
    repository,
    services,
    get state() {
      return state
    },
    get writes() {
      return writes
    },
    get creates() {
      return creates
    },
    get ids() {
      return ids
    },
    set ids(next: string[]) {
      ids = next
    },
    set roster(next: FavoriteRecording[]) {
      roster = next
    },
    current: () => active,
    retire: () => {
      active = false
    },
  }
}
test("favorites are local by default and explicit hearts remain independent of ratings", () => {
  let state = emptyFavorites()
  expect(state.settings).toEqual({
    plex: false,
    lastfm: false,
    listenbrainz: false,
    ratingThreshold: 6,
  })
  state = setFavorite(state, row(1), true)
  state = setFavorite(state, row(1), false, false)
  expect(state.entries["local:1"].liked).toBe(true)
  state = setFavorite(state, row(1), false)
  state = seedFavoriteRatings(state, [row(1), row(2)])
  expect(state.entries["local:1"].liked).toBe(false)
  expect(state.entries["local:2"].liked).toBe(true)
})
test("native nullable recordings survive saved favorites and pending receipt validation", () => {
  const record = row(1, {
    key: "lastfm:remote",
    album: "",
    localTrackId: null,
    durationMs: null,
    recordingMbid: null,
    recordingMsid: null,
  })
  const state = mergeFavoriteSnapshot(
    connected("lastfm"),
    "lastfm",
    [record],
    true
  )
  const saved = JSON.parse(JSON.stringify(state.entries[record.key]))
  expect(validFavorite(saved)).toBe(true)
  expect(validFavorite({ ...saved, durationMs: undefined })).toBe(true)
  expect(validFavorite({ ...saved, durationMs: 180000 })).toBe(true)
  expect(validFavorite({ ...saved, likedAt: 1500000000000 })).toBe(true)
  expect(validFavorite({ ...saved, likedAt: null })).toBe(true)
  for (const likedAt of [
    "1500000000000",
    -1,
    0,
    NaN,
    Infinity,
    1.5,
    8640000000000001,
  ])
    expect(validFavorite({ ...saved, likedAt })).toBe(false)
  for (const durationMs of ["180000", {}, -1, NaN, Infinity])
    expect(validFavorite({ ...saved, durationMs })).toBe(false)
  state.bindings.lastfm!.pending = {
    id: "pending",
    entryId: record.key,
    recording: record,
    liked: true,
    before: false,
    state: "unknown",
  }
  expect(validFavoriteMetadata(JSON.parse(JSON.stringify(state)))).toBe(true)
  state.bindings.lastfm!.pending.recording = { ...record, durationMs: -1 }
  expect(validFavoriteMetadata(state)).toBe(false)
})
test("original service like dates backfill old imports and survive repeated syncs and mirrors", () => {
  const imported = row(1, { key: "lastfm:old", localTrackId: null })
  let state = mergeFavoriteSnapshot(
    connected("lastfm"),
    "lastfm",
    [imported],
    true
  )
  expect(favoriteLikedAt(state.entries[imported.key])).toBeUndefined()
  const changedAt = state.entries[imported.key].changedAt
  const date = 1500000000000
  state = mergeFavoriteSnapshot(
    state,
    "lastfm",
    [{ ...imported, likedAt: date }],
    true
  )
  expect(state.entries[imported.key].likedAt).toBe(date)
  expect(state.entries[imported.key].changedAt).toBe(changedAt)
  expect(state.entries[imported.key].sources.lastfm!.likedAt).toBe(date)
  state.settings.listenbrainz = true
  state = bindFavorites(state, "listenbrainz", account("listenbrainz"))
  state = mergeFavoriteSnapshot(
    state,
    "listenbrainz",
    [{ ...imported, key: "listenbrainz:new", likedAt: date + 100000 }],
    true
  )
  expect(state.entries[imported.key].likedAt).toBe(date)
  state = acknowledgeFavorite(state, "lastfm", imported.key, true, imported.key)
  expect(state.entries[imported.key].sources.lastfm!.likedAt).toBe(date)
  const repeated = mergeFavoriteSnapshot(
    state,
    "lastfm",
    [{ ...imported, likedAt: date }],
    true
  )
  expect(repeated.entries[imported.key]).toBe(state.entries[imported.key])
  state = mergeFavoriteSnapshot(state, "lastfm", [], true)
  state = mergeFavoriteSnapshot(
    state,
    "lastfm",
    [{ ...imported, likedAt: date + 200000 }],
    true
  )
  expect(state.entries[imported.key].likedAt).toBe(date + 200000)
})
test("local relikes get their actual new time while unchanged hearts retain their date", () => {
  let state = setFavorite(emptyFavorites(), row(1), true)
  const first = state.entries["local:1"].likedAt!
  state = setFavorite(state, row(1), true)
  expect(state.entries["local:1"].likedAt).toBe(first)
  state.entries["local:1"] = {
    ...state.entries["local:1"],
    likedAt: 1500000000000,
  }
  state = setFavorite(state, row(1), false)
  state = setFavorite(state, state.entries["local:1"], true)
  expect(state.entries["local:1"].likedAt!).toBeGreaterThan(1500000000000)
  const reliked = state.entries["local:1"].likedAt
  state.settings.lastfm = true
  state = bindFavorites(state, "lastfm", account("lastfm"))
  state = mergeFavoriteSnapshot(
    state,
    "lastfm",
    [row(1, { likedAt: 1500000000000 })],
    true
  )
  expect(state.entries["local:1"].likedAt).toBe(reliked)
})
test("favorites and the All view sort by love or rating date, retaining unknown dates at the end", () => {
  let state = connected("lastfm")
  state = mergeFavoriteSnapshot(
    state,
    "lastfm",
    [
      row(1, { likedAt: 1500000000000 }),
      row(2, { likedAt: 1600000000000 }),
      row(3),
    ],
    true
  )
  const available = new Map(
    [1, 2, 3].map((id) => [
      String(id),
      {
        id: String(id),
        addedAt: "2026-01-01",
        lastRatedAt: null,
      } as MusicTrack,
    ])
  )
  const tracks = favoriteTracks(state, available)
  expect(tracks.map((track) => track.id)).toEqual(["2", "1", "3"])
  expect(tracks[0].likedAt).toBe(new Date(1600000000000).toISOString())
  expect(tracks[2].likedAt).toBeNull()
  const rated = {
    id: "4",
    lastRatedAt: new Date(1550000000000).toISOString(),
  } as MusicTrack
  expect(sortLikedTracks([...tracks, rated]).map((track) => track.id)).toEqual([
    "2",
    "4",
    "1",
    "3",
  ])
  expect(available.get("2")?.likedAt).toBeUndefined()
})
test("native string rejections expose the service failure and keep other sync services running", async () => {
  const state = connected("lastfm")
  state.settings.listenbrainz = true
  const f = fixture(state)
  f.services.page = async (account, offset) => {
    if (account.service === "listenbrainz") throw "Favorite service unavailable"
    return { rows: [], offset, total: 0 }
  }
  const issues: Record<string, string> = {}
  await syncFavorites(f.repository, f.services, f.current, {
    onIssue: (service, message) => {
      issues[service] = message
    },
  })
  expect(issues.listenbrainz).toBe("Favorite service unavailable")
  expect(f.state.bindings.lastfm!.initialized).toBe(true)
  expect(f.writes).toBe(0)
})
test("first connection is an additive merge, preserving explicit local unlikes", () => {
  let state = setFavorite(connected("lastfm"), row(1), false)
  state = mergeFavoriteSnapshot(
    state,
    "lastfm",
    [
      row(1, { key: lastfmFavoriteKey(row(1)), localTrackId: undefined }),
      row(2, { key: lastfmFavoriteKey(row(2)), localTrackId: undefined }),
    ],
    true
  )
  expect(state.entries["local:1"].liked).toBe(false)
  expect(
    Object.values(state.entries).filter((item) => item.liked)
  ).toHaveLength(1)
  expect(state.bindings.lastfm!.initialized).toBe(true)
})
test("full rosters accept remote unlikes; partial reads cannot remove local favorites", () => {
  let state = mergeFavoriteSnapshot(connected("plex"), "plex", [row(1)], true)
  const partial = mergeFavoriteSnapshot(state, "plex", [], false)
  expect(partial.entries["local:1"].liked).toBe(true)
  state = mergeFavoriteSnapshot(state, "plex", [], true)
  expect(state.entries["local:1"].liked).toBe(false)
  state = mergeFavoriteSnapshot(state, "plex", [row(1)], true)
  expect(state.entries["local:1"].liked).toBe(true)
})
test("a local edit after acknowledgment wins over an unchanged remote roster", () => {
  let state = mergeFavoriteSnapshot(connected("plex"), "plex", [row(1)], true)
  state = setFavorite(state, row(1), false)
  state = mergeFavoriteSnapshot(state, "plex", [row(1)], true)
  expect(state.entries["local:1"].liked).toBe(false)
  state = acknowledgeFavorite(state, "plex", "local:1", false, "local:1")
  state = setFavorite(state, row(1), true)
  state = mergeFavoriteSnapshot(state, "plex", [], true)
  expect(state.entries["local:1"].liked).toBe(true)
})
test("renewed auth is allowed for the same account, account replacement is rejected", () => {
  const state = connected("lastfm")
  expect(
    bindFavorites(state, "lastfm", account("lastfm", "listener", "new"))
      .bindings.lastfm!.account.revision
  ).toBe("new")
  expect(() =>
    bindFavorites(state, "lastfm", account("lastfm", "another"))
  ).toThrow("original")
})
test("empty labels and ambiguous recording variants are never merged by guesswork", () => {
  let state = connected("listenbrainz")
  state = mergeFavoriteSnapshot(
    state,
    "listenbrainz",
    [
      row(1, {
        key: "mbid:11111111-1111-4111-8111-111111111111",
        title: "",
        artist: "",
        localTrackId: undefined,
        recordingMbid: "11111111-1111-4111-8111-111111111111",
      }),
      row(2, {
        key: "mbid:22222222-2222-4222-8222-222222222222",
        title: "",
        artist: "",
        localTrackId: undefined,
        recordingMbid: "22222222-2222-4222-8222-222222222222",
      }),
    ],
    true
  )
  expect(Object.keys(state.entries)).toHaveLength(2)
  state = setFavorite(
    state,
    row(3, {
      title: "Song",
      recordingMbid: "33333333-3333-4333-8333-333333333333",
    }),
    true
  )
  state = setFavorite(
    state,
    row(4, {
      title: "Song",
      recordingMbid: "44444444-4444-4444-8444-444444444444",
    }),
    true
  )
  expect(
    findFavorite(
      state,
      row(5, { key: "lastfm:song", title: "Song", localTrackId: undefined })
    )
  ).toBeUndefined()
  expect(
    findFavorite(
      state,
      row(5, { title: "Song (Live)", localTrackId: undefined })
    )
  ).toBeUndefined()
})
test("unchanged complete rosters reuse entry objects instead of rewriting every favorite", () => {
  const first = mergeFavoriteSnapshot(connected("plex"), "plex", [row(1)], true)
  const next = mergeFavoriteSnapshot(first, "plex", [row(1)], true)
  expect(next.entries["local:1"]).toBe(first.entries["local:1"])
})
test("large roster imports use indexed identities and preserve every record", () => {
  const start = performance.now(),
    rows = Array.from({ length: 12000 }, (_, i) => row(i + 1))
  const state = mergeFavoriteSnapshot(connected("plex"), "plex", rows, true)
  expect(Object.keys(state.entries)).toHaveLength(12000)
  expect(performance.now() - start).toBeLessThan(3000)
})
test("disabled favorites sync never calls external services", async () => {
  const f = fixture(setFavorite(emptyFavorites(), row(1), true))
  f.services.account = async () => {
    throw Error("must not call")
  }
  await syncFavorites(f.repository, f.services, f.current)
  expect(f.writes).toBe(0)
  expect(f.creates).toBe(0)
})
test("favorite pagination retains lists larger than 1000 and rejects repeated/incomplete pages", async () => {
  const f = fixture(connected("lastfm"))
  f.roster = Array.from({ length: 1251 }, (_, i) => row(i + 1))
  expect(
    await readFavoriteRoster(account("lastfm"), f.services, f.current)
  ).toHaveLength(1251)
  f.services.page = async (_, offset) => ({
    offset,
    total: 150,
    rows: Array.from({ length: 100 }, (_, i) => row(i + 1)),
  })
  await expect(
    readFavoriteRoster(account("lastfm"), f.services, f.current)
  ).rejects.toThrow()
  f.services.page = async (_, offset) => ({ offset, total: 150, rows: [] })
  await expect(
    readFavoriteRoster(account("lastfm"), f.services, f.current)
  ).rejects.toThrow("Incomplete")
})
test("unstable or incomplete remote lists preserve existing likes without publishing removals", async () => {
  const f = fixture(
    mergeFavoriteSnapshot(connected("lastfm"), "lastfm", [row(1)], true)
  )
  let calls = 0
  f.services.page = async (_, offset) => ({
    offset,
    total: ++calls === 1 ? 0 : 1,
    rows: calls === 1 ? [] : [row(2)],
  })
  await syncFavorites(f.repository, f.services, f.current)
  expect(f.state.entries["local:1"].liked).toBe(true)
  expect(f.writes).toBe(0)
})
test("Plex batches additions and removes every repeated occurrence of an unliked song", async () => {
  let state = connected("plex", true)
  for (let n = 1; n <= 125; n++) state = setFavorite(state, row(n), true)
  const f = fixture(state)
  await syncFavorites(f.repository, f.services, f.current)
  expect(f.ids).toHaveLength(125)
  expect(f.writes).toBe(2)
  f.ids = ["1", "1", ...f.ids.slice(1)]
  await f.repository.update((state) => setFavorite(state, row(1), false))
  await syncFavorites(f.repository, f.services, f.current)
  expect(f.ids).not.toContain("1")
  expect(f.state.entries["local:1"].liked).toBe(false)
})
test("new Plex mirror creates once and retains its identity", async () => {
  const state = setFavorite(connected("plex"), row(1), true)
  delete state.bindings.plex!.playlistId
  const f = fixture(state)
  await syncFavorites(f.repository, f.services, f.current)
  await syncFavorites(f.repository, f.services, f.current)
  expect(f.creates).toBe(1)
  expect(f.ids).toEqual(["1"])
  expect(f.state.bindings.plex!.playlistId).toBe("9")
})
test("an unknown Plex create is retained and never blindly replayed", async () => {
  const state = connected("plex")
  delete state.bindings.plex!.playlistId
  const f = fixture(state)
  let calls = 0
  f.services.plexCreate = async () => {
    calls++
    throw Error("response lost")
  }
  await syncFavorites(f.repository, f.services, f.current)
  await syncFavorites(f.repository, f.services, f.current, {
    retryUnknown: true,
  })
  expect(calls).toBe(1)
  expect(f.state.bindings.plex!.creation!.state).toBe("unknown")
})
test("unknown remote write recovers by reads, preserving a local edit during the write", async () => {
  const f = fixture(setFavorite(connected("lastfm", true), row(1), true))
  const write = f.services.set
  f.services.set = async (...args) => {
    await write(...args)
    await f.repository.update((state) => setFavorite(state, row(1), false))
    throw Error("lost acknowledgment")
  }
  await syncFavorites(f.repository, f.services, f.current)
  expect(f.state.bindings.lastfm!.pending!.state).toBe("unknown")
  expect(f.state.entries["local:1"].liked).toBe(false)
  f.services.set = write
  await syncFavorites(f.repository, f.services, f.current)
  expect(f.state.bindings.lastfm!.pending).toBeUndefined()
  expect(f.state.entries["local:1"].liked).toBe(false)
  expect(f.writes).toBe(2)
})
test("unchanged unknown writes require explicit retry before resubmission", async () => {
  const f = fixture(setFavorite(connected("lastfm", true), row(1), true))
  let calls = 0
  f.services.set = async () => {
    calls++
    throw Error("offline")
  }
  await syncFavorites(f.repository, f.services, f.current)
  await syncFavorites(f.repository, f.services, f.current)
  expect(calls).toBe(1)
  await syncFavorites(f.repository, f.services, f.current, {
    retryUnknown: true,
  })
  expect(calls).toBe(2)
})
test("retirement and disabling during admission prevent a new external verb", async () => {
  const f = fixture(setFavorite(connected("lastfm", true), row(1), true))
  const update = f.repository.update
  f.repository.update = async (change) => {
    const state = await update(change)
    if (state.bindings.lastfm?.pending) state.settings.lastfm = false
    return state
  }
  await syncFavorites(f.repository, f.services, f.current)
  expect(f.writes).toBe(0)
  expect(f.state.bindings.lastfm!.pending).toBeUndefined()
  const g = fixture(setFavorite(connected("lastfm", true), row(1), true))
  g.services.peek = async () => {
    g.retire()
    return false
  }
  await expect(
    syncFavorites(g.repository, g.services, g.current)
  ).rejects.toThrow("owner changed")
  expect(g.writes).toBe(0)
})
test("unknown Plex append is acknowledged by membership without another append", async () => {
  const f = fixture(setFavorite(connected("plex", true), row(1), true))
  const mutate = f.services.plexMutate
  f.services.plexMutate = async (...args) => {
    await mutate(...args)
    throw Error("response lost")
  }
  await syncFavorites(f.repository, f.services, f.current)
  expect(f.state.bindings.plex!.pending).toBeDefined()
  f.services.plexMutate = mutate
  await syncFavorites(f.repository, f.services, f.current)
  expect(f.writes).toBe(1)
  expect(f.ids).toEqual(["1"])
  expect(f.state.bindings.plex!.pending).toBeUndefined()
})
test("unresolved ListenBrainz identities stay local without guessed feedback writes", async () => {
  const f = fixture(setFavorite(connected("listenbrainz", true), row(1), true))
  await syncFavorites(f.repository, f.services, f.current)
  expect(f.writes).toBe(0)
  expect(f.state.entries["local:1"].liked).toBe(true)
})
test("favorite playback chooses quality while preferring available audio offline", () => {
  let state = setFavorite(emptyFavorites(), row(1), true)
  state = setFavorite(state, row(2, { title: "Song 1" }), true)
  const tracks = new Map<string, MusicTrack>([
    [
      "1",
      {
        id: "1",
        codec: "mp3",
        bitrate: 320,
        mediaInfo: { offlineAvailable: true },
      } as MusicTrack,
    ],
    [
      "2",
      {
        id: "2",
        codec: "flac",
        bitrate: 900,
        mediaInfo: { offlineAvailable: false },
      } as MusicTrack,
    ],
  ])
  expect(favoriteTracks(state, tracks)[0].id).toBe("2")
  expect(favoriteTracks(state, tracks, true)[0].id).toBe("1")
})

test("distinct legacy ListenBrainz MSIDs stay addressable and a local unlike removes all linked loves", async () => {
  const first = "11111111-1111-4111-8111-111111111111",
    second = "22222222-2222-4222-8222-222222222222"
  const rows = [first, second].map((id) =>
    row(1, { key: `msid:${id}`, localTrackId: undefined, recordingMsid: id })
  )
  let state = mergeFavoriteSnapshot(
    connected("listenbrainz"),
    "listenbrainz",
    rows,
    true
  )
  expect(Object.keys(state.entries)).toHaveLength(2)
  for (const item of Object.values(state.entries)) item.localTrackIds = ["1"]
  const f = fixture(setFavorite(state, row(1), false))
  f.roster = rows
  let remote = [...rows]
  f.services.peek = async (_, record) =>
    remote.some((item) => item.recordingMsid === record.recordingMsid)
  f.services.set = async (_, record, liked) => {
    remote = remote.filter(
      (item) => item.recordingMsid !== record.recordingMsid
    )
    return liked
  }
  await syncFavorites(f.repository, f.services, f.current)
  expect(remote).toHaveLength(0)
  expect(Object.values(f.state.entries).every((item) => !item.liked)).toBe(true)
  const upgraded = mergeFavoriteSnapshot(
    state,
    "listenbrainz",
    [{ ...rows[0], key: `mbid:${second}`, recordingMbid: second }],
    false
  )
  expect(Object.keys(upgraded.entries)).toHaveLength(2)
})

test("a Plex song remains loved while another retained feedback identity still loves that local song", async () => {
  const state = connected("plex", true)
  const first = {
    ...row(1),
    id: "first",
    liked: false,
    explicit: false,
    localTrackIds: ["1"],
    changedAt: 1,
    sources: { plex: { key: "local:1", liked: true, desired: true } },
  }
  const second = {
    ...row(1),
    id: "second",
    liked: true,
    explicit: false,
    localTrackIds: ["1"],
    changedAt: 2,
    sources: { plex: { key: "local:1", liked: true, desired: true } },
  }
  state.entries = { first, second }
  const f = fixture(state)
  f.ids = ["1"]
  await syncFavorites(f.repository, f.services, f.current)
  expect(f.ids).toEqual(["1"])
  expect(f.writes).toBe(0)
  await f.repository.update((state) => setFavorite(state, row(1), false))
  await syncFavorites(f.repository, f.services, f.current)
  expect(f.ids).toEqual([])
})
