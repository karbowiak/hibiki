import assert from "node:assert/strict"
import { mock } from "bun:test"
import { create } from "zustand"
import { JSDOM } from "jsdom"
import { act } from "react"
import { deferred } from "../helpers/radioAudioFakes"
const dom = new JSDOM('<div id="root"></div>', {
  url: "https://synthetic.test/collection/tracks",
})
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  localStorage: dom.window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
})
const scenario = process.argv[2],
  gate = deferred<void>()
const { emptyFavorites } = await import("../../src/favorites/model")
const auth = create(() => ({ username: "listener", isAuthenticated: true }))
mock.module("../../src/metadata/lastfm/authStore", () => ({
  useLastfmStore: auth,
}))
mock.module("../../src/metadata/listenbrainz/authStore", () => ({
  useListenBrainzStore: auth,
}))
let calls = 0,
  resets = 0,
  resetFailure: unknown,
  saves: any[] = [],
  profile = { revision: 0, metadata: emptyFavorites() as any },
  rows: Record<string, any> = {},
  reads = 0
mock.module("../../src/favorites/native", () => ({
  favoritesRemote: {
    account: async (service: string) => ({
      service,
      user: "listener",
      revision: "lease",
    }),
    page: async (_: any, offset: number) => {
      calls++
      return { offset, rows: [], total: 0 }
    },
    peek: async () => false,
    set: async () => {
      calls++
      return true
    },
  },
}))
const native = {
  load: async () => {
    reads++
    if (scenario === "race" || scenario === "retired") await gate.promise
    return { ...structuredClone(profile), total: Object.keys(rows).length }
  },
  page: async (offset: number, limit: number) =>
    Object.values(rows)
      .sort((a: any, b: any) => a.id.localeCompare(b.id))
      .slice(offset, offset + limit)
      .map((payload) => ({
        id: (payload as any).id,
        payload: structuredClone(payload),
      })),
  save: async (expected: number, metadata: any, batch: any[]) => {
    assert.equal(expected, profile.revision)
    saves.push(batch)
    batch.forEach((row) => (rows[row.id] = structuredClone(row.payload)))
    profile = { revision: expected + 1, metadata: structuredClone(metadata) }
    return profile.revision
  },
  reset: async (expected: number) => {
    resets++
    if (resetFailure) throw resetFailure
    assert.equal(expected, profile.revision)
    rows = Object.fromEntries(
      Object.entries(rows)
        .filter(([, row]) => row.explicit)
        .map(([id, row]) => {
          const kept = { ...row, sources: {} }
          delete kept.matchCheckedAt
          return [id, kept]
        })
    )
    const metadata = structuredClone(profile.metadata)
    metadata.ratingsImported = false
    for (const binding of Object.values(metadata.bindings) as any[])
      binding.initialized = false
    profile = { revision: expected + 1, metadata }
    return profile.revision
  },
  plexRead: async () => {
    throw Error("must not access Plex")
  },
  plexMutate: async () => {
    throw Error("must not write Plex")
  },
}
const provider: any = {
  name: "Plex",
  cacheScope: "scope",
  playbackSession: {},
  favorites: native,
  isOffline: false,
  getPlaylists: async () => [
    { id: "old", title: "Existing", smart: false, trackCount: 1 },
  ],
  getTrack: async () => {
    throw Error("not cached")
  },
  capabilities: {},
  rate: async () => {
    throw Error("must not rate Plex")
  },
}
const { useProviderStore } = await import("../../src/stores/providerStore")
useProviderStore.setState({ provider })
const { useFavoritesStore } = await import("../../src/stores/favoritesStore")
const track: any = {
  id: "42",
  title: "Local song",
  artistName: "Artist",
  albumName: "Album",
  duration: 180000,
  userRating: null,
  trackNumber: 1,
  year: 2026,
  playCount: 0,
}
if (
  scenario === "reset" ||
  scenario === "reset_matching" ||
  scenario === "reset_controls"
) {
  const { setFavorite } = await import("../../src/favorites/model")
  await useFavoritesStore.getState().load()
  await useFavoritesStore.getState().update((state) => {
    state = setFavorite(
      state,
      {
        key: "local:42",
        localTrackId: "42",
        title: "Local song",
        artist: "Artist",
      },
      false
    )
    state = setFavorite(
      state,
      { key: "imported", title: "Dear God", artist: "Sefa" },
      true,
      false
    )
    return { ...state, ratingsImported: true }
  })
  if (scenario === "reset_matching") {
    const found = deferred<any[]>()
    provider.search = () => found.promise
    const matching = useFavoritesStore.getState().matchMissing(true)
    await useFavoritesStore.getState().resetSync()
    found.resolve([
      {
        ...track,
        type: "track",
        id: "165297",
        artistName: "Sefa",
        title: "Dear God",
      },
    ])
    await matching
    assert.deepEqual(Object.keys(rows), ["local:42"])
  } else if (scenario === "reset_controls") {
    const { createRoot } = await import("react-dom/client")
    const { LikedSyncControls } =
      await import("../../src/components/Settings/LikedSyncControls")
    const root = createRoot(document.getElementById("root")!)
    const button = (label: string) =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === label
      )!
    await act(async () => root.render(<LikedSyncControls />))
    assert(button("Manage sync"))
    await act(async () => button("Reset liked sync…").click())
    assert.equal(document.activeElement, button("Cancel"))
    assert.equal(resets, 0)
    await act(async () => button("Cancel").click())
    assert.equal(document.activeElement, button("Reset liked sync…"))
    assert.equal(resets, 0)
    await act(async () => useFavoritesStore.setState({ running: true }))
    assert(button("Reset liked sync…").disabled)
    await act(async () => useFavoritesStore.setState({ running: false }))
    resetFailure = "Database is busy. Try again."
    await act(async () => button("Reset liked sync…").click())
    await act(async () => button("Reset and reimport").click())
    assert.equal(
      document.querySelector('[role="alert"]')?.textContent,
      resetFailure
    )
    assert.equal(Object.keys(rows).length, 2)
    resetFailure = undefined
    await act(async () => button("Reset and reimport").click())
    assert(
      document
        .querySelector('[role="status"]')
        ?.textContent?.includes("Liked sync reset")
    )
    await act(async () => root.unmount())
  } else {
    const account = { service: "lastfm", user: "listener", revision: "lease" }
    await useFavoritesStore
      .getState()
      .update((state) => ({
        ...state,
        settings: { ...state.settings, lastfm: true },
        bindings: { lastfm: { account, initialized: true } },
      }))
    useFavoritesStore.setState({ running: true })
    await assert.rejects(useFavoritesStore.getState().resetSync(), /finish/)
    assert.equal(resets, 0)
    useFavoritesStore.setState({ running: false })
    await useFavoritesStore.getState().resetSync()
    assert.deepEqual(useFavoritesStore.getState().collection.bindings.lastfm, {
      account,
      initialized: false,
    })
    assert(useFavoritesStore.getState().collection.settings.lastfm)
  }
  assert.equal(
    useFavoritesStore.getState().collection.entries["local:42"].liked,
    false
  )
  assert.deepEqual(
    useFavoritesStore.getState().collection.entries["local:42"].sources,
    {}
  )
  assert.deepEqual(
    Object.keys(useFavoritesStore.getState().collection.entries),
    ["local:42"]
  )
  assert.equal(useFavoritesStore.getState().collection.ratingsImported, false)
  assert.equal(useFavoritesStore.getState().resetting, false)
  assert.equal(calls, 0)
} else if (scenario === "matching") {
  const { setFavorite } = await import("../../src/favorites/model")
  const remote = (key: string, artist: string, title = "Dear God") => ({
    key,
    artist,
    title,
  })
  await useFavoritesStore.getState().load()
  await useFavoritesStore.getState().update((state) => {
    for (const row of [
      remote("sefa", "Sefa"),
      remote("guest", "Lil Wayne", "Mirror (feat. Bruno Mars)"),
      remote("absent", "Absent Artist"),
      remote("live", "Sefa", "Dear God (Live)"),
    ])
      state = setFavorite(state, row, true, false)
    return state
  })
  const sefa = {
    ...track,
    type: "track",
    id: "165297",
    title: "Dear God",
    artistName: "Sefa",
    duration: 293777,
  }
  const ruben = {
    ...track,
    type: "track",
    id: "275497",
    title: "Dear God",
    artistName: "Ruben",
    duration: 179023,
  }
  const mirror = {
    ...track,
    type: "track",
    id: "339357",
    title: "Mirror",
    artistName: "Various Artists",
    originalTitle: "Lil Wayne feat. Bruno Mars",
  }
  provider.search = async (query: string) =>
    query.includes("Mirror") ? [mirror] : [ruben]
  let discoveries = 0
  provider.findPlaylistCandidates = async () => {
    discoveries++
    return { tracks: [sefa], truncated: false, unavailable: false }
  }
  await useFavoritesStore.getState().matchMissing(true)
  const entries = useFavoritesStore.getState().collection.entries
  assert.deepEqual(entries.sefa.localTrackIds, ["165297"])
  assert.deepEqual(entries.guest.localTrackIds, ["339357"])
  assert.deepEqual(entries.absent.localTrackIds, [])
  assert.deepEqual(entries.live.localTrackIds, [])
  assert.equal(discoveries, 3)
  assert.equal(calls, 0)
  useFavoritesStore.setState({ loaded: false })
  await useFavoritesStore.getState().load()
  assert.deepEqual(
    useFavoritesStore.getState().collection.entries.sefa.localTrackIds,
    ["165297"]
  )
} else if (scenario === "corrupt") {
  rows = { bad: { id: "bad", liked: true, localTrackIds: { bad: "42" } } }
  await assert.rejects(useFavoritesStore.getState().load(), /invalid/)
  assert.equal(useFavoritesStore.getState().loaded, false)
  assert.equal(saves.length, 0)
  assert.equal(calls, 0)
  assert.deepEqual(rows.bad.localTrackIds, { bad: "42" })
} else if (scenario === "race") {
  const first = useFavoritesStore.getState().sync(),
    second = useFavoritesStore.getState().sync()
  gate.resolve()
  await Promise.all([first, second])
  assert.equal(reads, 2)
  assert.equal(calls, 0)
} else if (scenario === "retired") {
  const job = useFavoritesStore.getState().load()
  useProviderStore.setState({
    provider: { ...provider, cacheScope: "other", playbackSession: {} },
  })
  gate.resolve()
  await job
  assert.equal(useFavoritesStore.getState().loaded, false)
  assert.equal(
    Object.keys(useFavoritesStore.getState().collection.entries).length,
    0
  )
} else {
  await useFavoritesStore.getState().load()
  if (scenario === "remote_reload") {
    const { bindFavorites, mergeFavoriteSnapshot } =
      await import("../../src/favorites/model")
    for (const service of ["lastfm", "listenbrainz"] as const) {
      await useFavoritesStore.getState().update((state) => {
        state = { ...state, settings: { ...state.settings, [service]: true } }
        state = bindFavorites(state, service, {
          service,
          user: "listener",
          revision: "lease",
        })
        const id = "11111111-1111-4111-8111-111111111111"
        return mergeFavoriteSnapshot(
          state,
          service,
          [
            {
              key: service === "lastfm" ? "lastfm:remote" : `msid:${id}`,
              title: `Imported from ${service}`,
              artist: "Artist",
              album: "",
              durationMs: null,
              likedAt: 1500000000000,
              localTrackId: null,
              recordingMbid: null,
              recordingMsid: service === "listenbrainz" ? id : null,
            },
          ],
          true
        )
      })
    }
    const saved = structuredClone(rows)
    assert.equal(Object.keys(saved).length, 2)
    assert(Object.values(saved).every((row) => row.durationMs === null))
    useFavoritesStore.setState({ loaded: false })
    await useFavoritesStore.getState().load()
    assert.equal(useFavoritesStore.getState().loaded, true)
    assert.equal(useFavoritesStore.getState().error, null)
    assert.deepEqual(useFavoritesStore.getState().collection.entries, saved)
    assert.deepEqual(rows, saved)
    assert.equal(saves.length, 2)
    assert.equal(calls, 0)
  } else if (scenario === "bulk") {
    const all = Array.from({ length: 2001 }, (_, i) => ({
      ...track,
      id: String(i + 1),
      title: `Track ${i}`,
      userRating: 10,
    }))
    await useFavoritesStore.getState().seedRatings(all)
    assert.deepEqual(
      saves.map((batch) => batch.length),
      [1000, 1000, 1]
    )
    assert.equal(profile.metadata.ratingsImported, true)
    useFavoritesStore.setState({ loaded: false })
    await useFavoritesStore.getState().load()
    assert.equal(
      Object.keys(useFavoritesStore.getState().collection.entries).length,
      2001
    )
    assert(!JSON.stringify(rows).includes("_providerData"))
    await useFavoritesStore.getState().sync()
    assert.equal(calls, 0)
  } else if (scenario === "local") {
    provider.isOffline = true
    await assert.rejects(
      useFavoritesStore.getState().toggle({ ...track, id: "episode:1" }, true),
      /Only library/
    )
    await useFavoritesStore
      .getState()
      .toggle(
        { ...track, streamUrl: "secret", _providerData: { token: "secret" } },
        true
      )
    assert(useFavoritesStore.getState().likedTrackIds.has("42"))
    assert(!JSON.stringify(rows).includes("secret"))
    assert.equal(calls, 0)
    await useFavoritesStore.getState().configure("lastfm", true)
    await useFavoritesStore.getState().sync()
    assert.equal(calls, 0)
    await useFavoritesStore.getState().configure("lastfm", false)
    useFavoritesStore.setState({ loaded: false })
    await useFavoritesStore.getState().load()
    assert(useFavoritesStore.getState().likedTrackIds.has("42"))
    await useFavoritesStore.getState().toggle(track, false)
    await useFavoritesStore
      .getState()
      .ratingChanged("42", track.title, track.artistName, 10)
    assert(!useFavoritesStore.getState().likedTrackIds.has("42"))
    assert.equal(rows["local:42"].liked, false)
    await useFavoritesStore
      .getState()
      .ratingChanged("43", "Rated song", "Artist", 10)
    assert(useFavoritesStore.getState().likedTrackIds.has("43"))
    assert.equal(calls, 0)
    await useFavoritesStore.getState().load(null)
    assert.equal(
      Object.keys(useFavoritesStore.getState().collection.entries).length,
      0
    )
  } else {
    const { createRoot } = await import("react-dom/client")
    const root = createRoot(document.getElementById("root")!)
    if (scenario === "dialog" || scenario === "recording") {
      if (scenario === "recording") {
        await useFavoritesStore.getState().toggle(track, true)
        await useFavoritesStore.getState().configure("listenbrainz", true)
      }
      const { FavoritesSyncDialog } =
        await import("../../src/components/FavoritesSyncDialog")
      await act(async () => {
        root.render(<FavoritesSyncDialog onClose={() => {}} />)
      })
      const toggles = [
        ...document.querySelectorAll<HTMLInputElement>(
          'input[type="checkbox"]'
        ),
      ]
      assert.equal(toggles.length, 3)
      if (scenario === "dialog")
        assert(toggles.every((input) => !input.checked))
      assert(
        document.body.textContent?.includes("Create a new Liked Songs playlist")
      )
      assert(document.body.textContent?.includes("Star ratings stay separate"))
      assert(document.body.textContent?.includes("Sync likes with Last.fm"))
      assert(
        document.body.textContent?.includes("Sync likes with ListenBrainz")
      )
      assert.equal(calls, 0)
      if (scenario === "recording") {
        const choose = [...document.querySelectorAll("button")].find(
          (button) => button.textContent === "Choose recording ID"
        )!
        await act(async () => choose.click())
        const input = document.querySelector<HTMLInputElement>(
          'input[aria-label="MusicBrainz recording ID"]'
        )!
        const id = "11111111-1111-4111-8111-111111111111"
        await act(async () => {
          Object.getOwnPropertyDescriptor(
            dom.window.HTMLInputElement.prototype,
            "value"
          )!.set!.call(input, id)
          input.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
          input.dispatchEvent(new dom.window.Event("change", { bubbles: true }))
        })
        const submit = [...document.querySelectorAll("button")].find(
          (button) => button.textContent === "Use this recording"
        )!
        await act(async () => submit.click())
        assert.equal(rows["local:42"].recordingMbid, id)
        assert.equal(calls, 0)
        await assert.rejects(
          useFavoritesStore.getState().assignRecording("local:42", "not-an-id"),
          /valid/
        )
      }
    } else if (scenario === "heart") {
      const { FavoriteButton } =
        await import("../../src/components/shared/FavoriteButton")
      await act(async () => root.render(<FavoriteButton track={track} />))
      await act(async () =>
        document.querySelector<HTMLButtonElement>("button")!.click()
      )
      assert.equal(rows["local:42"].liked, true)
      assert.equal(calls, 0)
      await act(async () => {
        useFavoritesStore.setState({ loaded: false })
        await useFavoritesStore.getState().load()
      })
      assert.equal(
        document.querySelector("button")!.getAttribute("aria-pressed"),
        "true"
      )
      await act(async () =>
        document.querySelector<HTMLButtonElement>("button")!.click()
      )
      assert.equal(rows["local:42"].liked, false)
      assert.equal(calls, 0)
    } else {
      await useFavoritesStore.getState().toggle(track, true)
      const low = { ...track, id: "44", type: "track", title: "Low rated song", userRating: 2, lastRatedAt: "2019-01-01T00:00:00.000Z" }
      provider.getLikedTracks = async () => [low]
      provider.favorites.cachedTracks = async (ids: string[]) => ids.map(id => ({ ...track, id, title: id === "42" ? "Local song" : id === "46" ? "Older love" : "Unknown love" }))
      const state = useFavoritesStore.getState().collection
      const base = state.entries["local:42"]
      useFavoritesStore.setState({ collection: { ...state, ratingsImported: true, entries: {
        ...state.entries,
        "local:42": { ...base, likedAt: Date.parse("2017-01-01"), changedAt: Date.parse("2017-01-01") },
        "local:46": { ...base, id: "local:46", key: "local:46", title: "Older love", localTrackIds: ["46"], likedAt: Date.parse("2015-01-01"), changedAt: Date.parse("2015-01-01") },
        "local:45": { ...base, id: "local:45", key: "local:45", title: "Unknown love", localTrackIds: ["45"], likedAt: undefined, explicit: false },
      } } })
      mock.module("../../src/stores", () => ({
        usePlayerStore: create(() => ({ playPagedTracks: () => {}, playRadio: () => {}, addToQueue: () => {}, currentTrack: null })),
      }))
      mock.module("../../src/components/shared/TrackTable", () => ({
        TrackTable: ({ paged, onSort, columns }: any) => (
          <div data-testid="tracks">
            {columns.some((column: any) => column.id === "liked_at") && (
              <button onClick={() => onSort("liked_at")}>Date Liked</button>
            )}
            {Array.from({ length: paged.total }, (_, index) => paged.getItem(index)).filter(Boolean).map((track: any) => (
              <span key={track.id}>{track.title}</span>
            ))}
          </div>
        ),
      }))
      const { Liked } = await import("../../src/components/Pages/Liked")
      await act(async () => {
        root.render(<Liked />)
      })
      assert(
        document
          .querySelector('[data-testid="tracks"]')
          ?.textContent?.includes("Local song")
      )
      assert(
        !document
          .querySelector('[data-testid="tracks"]')
          ?.textContent?.includes("Low rated")
      )
      const all = [...document.querySelectorAll("button")].find(
        (button) => button.textContent === "All"
      )!
      await act(async () => all.click())
      const titles = () =>
        [...document.querySelectorAll('[data-testid="tracks"] span')].map(
          (node) => node.textContent
        )
      assert.deepEqual(titles(), [
        "Low rated song",
        "Local song",
        "Older love",
        "Unknown love",
      ])
      const date = [...document.querySelectorAll("button")].find(
        (button) => button.textContent === "Date Liked"
      )!
      await act(async () => date.click())
      assert.deepEqual(titles(), [
        "Local song",
        "Older love",
        "Low rated song",
        "Unknown love",
      ])
      await act(async () => date.click())
      assert.deepEqual(titles(), [
        "Older love",
        "Local song",
        "Low rated song",
        "Unknown love",
      ])
      const rated = [...document.querySelectorAll("button")].find(
        (button) => button.textContent === "Rated"
      )!
      await act(async () => {
        rated.click()
      })
      assert(
        document
          .querySelector('[data-testid="tracks"]')
          ?.textContent?.includes("Low rated")
      )
    }
    await act(async () => {
      root.unmount()
    })
  }
}
