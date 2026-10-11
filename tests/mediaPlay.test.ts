import { expect, test } from "bun:test"
import { createMediaPlayController } from "../src/lib/mediaPlay"
import type { MusicItem } from "../src/types/music"
import { deferred } from "./helpers/radioAudioFakes"
function fixture() {
  const tracks = deferred<any[]>()
  const plays: unknown[][] = []
  const errors: string[] = []
  let version = 0
  const provider: any = {
    getAlbumTracks: () => tracks.promise,
    getArtistPopularTracks: () => tracks.promise,
  }
  let currentProvider = provider
  const make = createMediaPlayController({
    getProvider: () => currentProvider,
    captureSelection: () => {
      const captured = version
      return () => captured === version
    },
    reportError: (message, current) => {
      if (current()) errors.push(message)
    },
  })
  const store = {
    provider,
    playTrack: async (...args: unknown[]) => {
      version++
      plays.push(args)
    },
    playFromUri: async (...args: unknown[]) => {
      version++
      plays.push(args)
    },
    playPlaylist: async (...args: unknown[]) => {
      version++
      plays.push(args)
    },
  }
  const item = (type: string, title = type): MusicItem =>
    ({
      id: `${type}-id`,
      type,
      title,
      artistName: "Artist",
      trackCount: 1,
    }) as any
  return {
    tracks,
    plays,
    errors,
    provider,
    store,
    make,
    item,
    replaceProvider: () => {
      currentProvider = {}
    },
    selectElsewhere: () => {
      version++
    },
  }
}
async function tick() {
  for (let count = 0; count < 8; count++) await Promise.resolve()
}
test("an album fallback is cancelled when another player selection starts before its tracks resolve", async () => {
  const f = fixture()
  f.make(f.item("album"), f.store)!()
  await tick()
  f.selectElsewhere()
  f.tracks.resolve([{ id: "old" }])
  await tick()
  expect(f.plays).toEqual([])
  expect(f.errors).toEqual([])
})
test("newer card intent wins across different callbacks", async () => {
  const f = fixture()
  f.make(f.item("artist"), f.store)!()
  await tick()
  f.make(f.item("track"), f.store)!()
  f.tracks.resolve([{ id: "old" }])
  await tick()
  expect(f.plays.length).toBe(1)
  expect((f.plays[0][0] as any).id).toBe("track-id")
})
test("provider replacement retires track lookups, errors and old callback invocation", async () => {
  const f = fixture()
  const action = f.make(f.item("album"), f.store)!
  action()
  await tick()
  f.replaceProvider()
  f.tracks.reject(new Error("https://private.test/?token=secret"))
  action()
  await tick()
  expect(f.plays).toEqual([])
  expect(f.errors).toEqual([])
})
test("a current empty lookup reports a visible retryable outcome without starting playback", async () => {
  const f = fixture()
  f.make(f.item("album", "Album"), f.store)!()
  await tick()
  f.tracks.resolve([])
  await tick()
  expect(f.errors).toEqual(["No playable tracks were found for Album."])
  expect(f.plays).toEqual([])
})
test("current lookup rejection and synchronous provider failure are contained without raw error details", async () => {
  for (const sync of [false, true]) {
    const f = fixture()
    if (sync)
      f.provider.getArtistPopularTracks = () => {
        throw new Error("private token")
      }
    f.make(f.item("artist", "Artist"), f.store)!()
    await tick()
    if (!sync) f.tracks.reject(new Error("private token"))
    await tick()
    expect(f.errors).toEqual(["Could not play Artist. Please try again."])
  }
})
test("accepted fallback preserves deliberate album playback normalization", async () => {
  const f = fixture()
  f.make(f.item("album", "Album"), f.store)!()
  await tick()
  f.tracks.resolve([{ id: "first" }, { id: "second" }])
  await tick()
  expect(f.plays[0].slice(2)).toEqual(["Album", "/album/album-id", "album-id"])
  expect(f.errors).toEqual([])
})
test("direct native playback failures are contained and retire when a new queue selection starts", async () => {
  for (const retire of [false, true]) {
    const f = fixture()
    const pending = deferred<void>()
    f.provider.buildItemUri = () => "synthetic-library-uri"
    f.store.playFromUri = () => {
      f.selectElsewhere()
      return pending.promise
    }
    f.make(f.item("album", "Album"), f.store)!()
    if (retire) f.selectElsewhere()
    pending.reject(new Error("private token"))
    await tick()
    expect(f.errors).toEqual(
      retire ? [] : ["Could not play Album. Please try again."]
    )
  }
})
test("track and playlist callbacks contain rejected player actions", async () => {
  for (const type of ["track", "playlist"]) {
    const f = fixture()
    f.store.playTrack = f.store.playPlaylist = async () => {
      throw new Error("synthetic")
    }
    f.make(f.item(type), f.store)!()
    await tick()
    expect(f.errors).toEqual([`Could not play ${type}. Please try again.`])
  }
})
