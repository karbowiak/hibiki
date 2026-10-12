import { strict as assert } from "node:assert"
import { mock } from "bun:test"
let artist: any = {
  name: "Artist",
  mbid: "12345678-1234-1234-1234-123456789abc",
  wikidata_url: "https://www.wikidata.org/wiki/Q123",
}
let album: any = {
  artist: "Artist",
  title: "Album",
  mbid: "22345678-1234-1234-1234-123456789abc",
}
const calls: any[] = []
const invalidatedArtists: string[] = []
mock.module("../../src/metadata/musicbrainz/store", () => ({
  useMusicBrainzMetadataStore: {
    getState: () => ({
      getArtist: async () => artist,
      invalidateArtist: (name: string) => {
        invalidatedArtists.push(name)
        artist = {
          ...artist,
          wikidata_url: "https://www.wikidata.org/wiki/Q123",
        }
      },
      getAlbum: async () => album,
    }),
  },
}))
mock.module("../../src/stores/createMetadataStore", () => ({
  createMetadataStore: (options: any) => ({
    getState: () => ({
      getArtist: options.fetchArtist,
      getAlbum: options.fetchAlbum,
      invalidateArtist: () => {},
      invalidateAlbum: () => {},
    }),
  }),
}))
mock.module("@tauri-apps/api/core", () => ({
  invoke: async (name: string, args: any) => {
    calls.push({ name, args })
    return name === "wikidata_get_artist"
      ? { qid: "Q123", description: "Artist description", wikipedia_url: null }
      : { cover_url: "https://archive.org/cover" }
  },
}))
const { publicMetadataProviders } =
  await import("../../src/metadata/core/publicProviders")
const { verifiedWikidataQid } =
  await import("../../src/metadata/wikidata/store")
const [wiki, caa] = publicMetadataProviders()
const identity = {
  kind: "artist" as const,
  artist: "Artist",
  scope: "account/library",
}
assert.equal(verifiedWikidataQid("https://www.wikidata.org/wiki/Q123"), "Q123")
for (const invalid of [
  "https://evil.test/wiki/Q123",
  "http://www.wikidata.org/wiki/Q123",
  "https://www.wikidata.org/wiki/Q123?token=x",
  "https://www.wikidata.org/wiki/Q0",
])
  assert.equal(verifiedWikidataQid(invalid), null)
const ready = await wiki.lookup(identity)
assert.equal(ready.status, "ready")
if (ready.status === "ready") {
  assert.equal(ready.snapshot.fields.description, "Artist description")
  assert.equal(ready.snapshot.fields.biography, undefined)
  assert.equal(ready.snapshot.identity.scope, "account/library")
}
assert.deepEqual(calls.pop(), {
  name: "wikidata_get_artist",
  args: { qid: "Q123", artistMbid: artist.mbid },
})
artist = { ...artist, wikidata_url: "https://evil.test/wiki/Q123" }
assert.equal((await wiki.lookup(identity)).status, "unavailable")
assert.equal(calls.length, 0)
const albumIdentity = { ...identity, kind: "album" as const, title: "Album" }
assert.equal((await caa.lookup(albumIdentity)).status, "ready")
assert.deepEqual(calls.pop(), {
  name: "coverartarchive_get_album",
  args: { releaseGroupMbid: album.mbid },
})
for (const invalid of [
  { title: "Album", mbid: album.mbid },
  { ...album, artist: "Other" },
  { ...album, title: "Other" },
]) {
  album = invalid
  assert.equal((await caa.lookup(albumIdentity)).status, "unavailable")
  assert.equal(calls.length, 0)
}
assert.equal((await caa.lookup(identity)).status, "unsupported")
assert.equal((await wiki.lookup(albumIdentity)).status, "unsupported")

artist = { name: "Artist", mbid: "12345678-1234-1234-1234-123456789abc" }
assert.equal((await wiki.lookup(identity)).status, "ready")
assert.deepEqual(invalidatedArtists, ["Artist"])
assert.equal(calls.pop().name, "wikidata_get_artist")
