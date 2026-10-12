import { expect, test } from "bun:test"
import { createMetadataClient } from "../src/metadata/core/client"
import {
  createExistingMetadataAdapters,
  libraryMetadataSnapshot,
} from "../src/metadata/core/adapters"
import {
  metadataIdentityKey,
  resolveMetadataField,
} from "../src/metadata/core/resolve"
import type {
  MetadataAdapter,
  MetadataIdentity,
  MetadataResult,
  MetadataSnapshot,
} from "../src/metadata/core/types"
const identity: MetadataIdentity = {
  kind: "album",
  artist: "Artist",
  title: "Album Deluxe",
  entityId: "1",
  scope: "account/library",
}
function snapshot(
  source: MetadataSnapshot["source"],
  fields: MetadataSnapshot["fields"],
  overrides: Partial<MetadataSnapshot> = {}
): MetadataSnapshot {
  return {
    source,
    identity,
    fields,
    match: { kind: "exact-name", reason: "synthetic exact names" },
    observedAt: 1,
    ...overrides,
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { resolve, promise }
}
test("field selection preserves library names, scope, priority, zero values and explicit-source fallback", () => {
  const entries = [
    snapshot("plex", { title: "Library title", genres: ["Library"], fans: 0 }),
    snapshot("deezer", { title: "Public title", genres: ["Public"] }),
    snapshot(
      "musicbrainz",
      { genres: ["Unverified"] },
      { match: { kind: "candidate", reason: "artist missing" } }
    ),
  ]
  expect(
    resolveMetadataField("title", identity, entries, ["deezer", "plex"])?.value
  ).toBe("Library title")
  expect(
    resolveMetadataField("genres", identity, entries, [
      "musicbrainz",
      "plex",
      "deezer",
    ])?.source
  ).toBe("plex")
  const selection = {
    scope: identity.scope,
    identityKey: metadataIdentityKey(identity),
    source: "apple" as const,
    fields: { genres: "deezer" as const },
  }
  expect(
    resolveMetadataField("genres", identity, entries, ["plex"], selection)
      ?.source
  ).toBe("deezer")
  expect(
    resolveMetadataField("fans", identity, entries, ["plex"], selection)
  ).toMatchObject({ value: 0, source: "plex", fallback: true })
  expect(
    resolveMetadataField("genres", identity, entries, ["plex"], {
      ...selection,
      scope: "other",
    })?.source
  ).toBe("plex")
  expect(
    resolveMetadataField("genres", { ...identity, scope: "other" }, entries, [
      "plex",
    ])
  ).toBeNull()
})
test("existing provider adapters report actual fields and reject incorrect artist/edition matches", async () => {
  const readers: any = {
    deezer: {
      artist: async () => ({
        name: "Other",
        image_url: "https://wrong.test",
        fans: 1,
      }),
      album: async () => ({
        artist: "Artist",
        title: "Album",
        cover_url: "https://wrong.test",
      }),
    },
    apple: {
      artist: async () => ({
        name: "Artist",
        genre: "Pop",
        apple_music_url: "https://music.apple.com/artist/1",
      }),
      album: async () => ({
        artist: "Artist",
        title: "Album Deluxe",
        genre: "Pop",
        cover_url: "https://cover.test",
        release_date: "2020-01-01",
        track_count: 10,
        apple_music_url: "https://music.apple.com/album/1",
      }),
    },
    lastfm: {
      artist: async () => null,
      album: async () => ({
        artist: "Artist",
        name: "Album Deluxe",
        tags: ["tag"],
        wiki: null,
      }),
      track: async () => ({ artist: "Other", name: "Song" }),
    },
    musicbrainz: {
      artist: async () => null,
      album: async () => ({
        title: "Album Deluxe",
        mbid: "release-group",
        tags: ["tag"],
        first_release_date: "2020",
      }),
    },
  }
  const adapters = createExistingMetadataAdapters(readers)
  expect(adapters.find((a) => a.id === "deezer")!.fields.artist).not.toContain(
    "biography"
  )
  expect(adapters.find((a) => a.id === "apple")!.fields.artist).not.toContain(
    "artwork"
  )
  expect(await adapters[0].lookup(identity)).toEqual({ status: "unavailable" })
  expect(await adapters[0].lookup({ ...identity, kind: "artist" })).toEqual({
    status: "unavailable",
  })
  const apple = await adapters[1].lookup(identity)
  expect(apple.status).toBe("ready")
  const mb = await adapters[3].lookup(identity)
  expect(mb).toEqual({ status: "unavailable" })
  readers.musicbrainz.album = async () => ({
    artist: "Artist",
    title: "Album Deluxe",
    mbid: "release-group",
    tags: ["tag"],
    first_release_date: "2020",
  })
  const verifiedMb = await adapters[3].lookup(identity)
  expect(verifiedMb.status === "ready" && verifiedMb.snapshot.match.kind).toBe(
    "exact-name"
  )
  expect(await adapters[1].lookup({ ...identity, kind: "track" })).toEqual({
    status: "unsupported",
  })
  expect(await adapters[2].lookup(identity)).toMatchObject({
    status: "ready",
    snapshot: { fields: { tags: ["tag"] } },
  })
  expect(
    await adapters[2].lookup({ ...identity, kind: "track", title: "Song" })
  ).toEqual({ status: "unavailable" })
})
test("bounded coordinator deduplicates, serializes, retires old leases and exposes retryable failure", async () => {
  let owner: any = { scope: identity.scope, token: {} },
    calls = 0
  const first = deferred<MetadataResult>()
  const adapter: MetadataAdapter = {
    id: "apple",
    fields: { album: ["genres"] },
    transportPolicy: "synthetic",
    async lookup(request) {
      calls++
      if (calls === 1) return first.promise
      if (calls === 2) throw Error("private credential details")
      return {
        status: "ready",
        snapshot: snapshot("apple", { genres: ["Pop"] }, { identity: request }),
      }
    },
  }
  const client = createMetadataClient([adapter], () => owner, {
    maxPending: 2,
    maxEntries: 1,
  })
  const a = client.lookup("apple", identity)
  expect(client.lookup("apple", identity)).toBe(a)
  const b = client.lookup("apple", { ...identity, entityId: "2" })
  expect(
    await client.lookup("apple", { ...identity, entityId: "3" })
  ).toMatchObject({ status: "error", code: "queue-full" })
  await Promise.resolve()
  await Promise.resolve()
  expect(calls).toBe(1)
  owner = { scope: identity.scope, token: {} }
  client.retire()
  first.resolve({
    status: "ready",
    snapshot: snapshot("apple", { genres: ["Old"] }),
  })
  expect(await a).toEqual({ status: "retired" })
  expect(await b).toEqual({ status: "retired" })
  expect(await client.lookup("apple", identity)).toEqual({
    status: "error",
    code: "lookup-failed",
    retryable: true,
  })
  expect(await client.lookup("apple", identity)).toMatchObject({
    status: "ready",
  })
  expect(client.stats()).toEqual({ pending: 0, cached: 1 })
  await client.lookup("apple", { ...identity, entityId: "2" })
  expect(client.stats().cached).toBe(1)
})
test("coordinator expiry and targeted invalidation never cache unknown failures or invalidate foreign scope", async () => {
  let now = 0,
    calls = 0,
    invalidations = 0
  const adapter: MetadataAdapter = {
    id: "deezer",
    fields: { album: ["genres"] },
    transportPolicy: "synthetic",
    async lookup(request) {
      calls++
      return {
        status: "ready",
        snapshot: snapshot(
          "deezer",
          { genres: ["Pop"] },
          { identity: request }
        ),
      }
    },
    invalidate() {
      invalidations++
    },
  }
  const client = createMetadataClient(
    [adapter],
    () => ({ scope: identity.scope, token: "stable" }),
    { now: () => now, ttlMs: 10 }
  )
  await client.lookup("deezer", identity)
  await client.lookup("deezer", identity)
  expect(calls).toBe(1)
  now = 11
  await client.lookup("deezer", identity)
  expect(calls).toBe(2)
  expect(client.invalidate("deezer", { ...identity, scope: "other" })).toBe(
    false
  )
  expect(client.invalidate("deezer", identity)).toBe(true)
  expect(invalidations).toBe(1)
  await client.lookup("deezer", identity)
  expect(calls).toBe(3)
  expect(libraryMetadataSnapshot(identity, { id: "other" } as any)).toEqual({
    status: "unavailable",
  })
})
test("Plex artist summary contributes biography and wins the default biography priority", () => {
  const artistIdentity = {
    ...identity,
    kind: "artist" as const,
    artist: "Artist",
    title: undefined,
  }
  const library = libraryMetadataSnapshot(artistIdentity, {
    id: "1",
    title: "Artist",
    summary: "Library biography",
    thumbUrl: null,
  } as any)
  expect(library.status).toBe("ready")
  if (library.status !== "ready") throw Error("missing library snapshot")
  const publicInfo = snapshot(
    "lastfm",
    { biography: "Public biography" },
    { identity: artistIdentity }
  )
  expect(
    resolveMetadataField(
      "biography",
      artistIdentity,
      [library.snapshot, publicInfo],
      ["plex", "lastfm"]
    )?.value
  ).toBe("Library biography")
})
test("Plex album tags preserve typed styles and moods, while absent Deezer label stays absent", async () => {
  const album = libraryMetadataSnapshot(identity, {
    id: "1",
    title: "Album Deluxe",
    artistName: "Artist",
    genres: ["Pop"],
    styles: ["Dance", "Shared"],
    moods: ["Shared", "Bright"],
    summary: null,
    thumbUrl: null,
  } as any)
  expect(album.status === "ready" && album.snapshot.fields.tags).toEqual([
    "Dance",
    "Shared",
    "Bright",
  ])
  const adapters = createExistingMetadataAdapters({
    deezer: {
      artist: async () => null,
      album: async () => ({
        title: identity.title,
        artist: identity.artist,
        label: "[no label]",
        genres: [],
      }),
    },
  } as any)
  const result = await adapters[0].lookup(identity)
  expect(
    result.status === "ready" && result.snapshot.fields.label
  ).toBeUndefined()
})
