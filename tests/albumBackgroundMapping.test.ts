import { expect, test } from "bun:test"
import {
  plexAlbumToMusicAlbum,
  plexArtistToMusicArtist,
} from "../src/backends/plex/mappers"
import { buildPlexImageUrl } from "../src/backends/plex/imageUrl"
test("artist and album thumbs/art map to distinct valid scoped source protocol URLs", () => {
  const img = (path, kind, id, name, artist) =>
    buildPlexImageUrl(
      "https://plex.test/proxy",
      "private-not-in-url",
      kind,
      id,
      path,
      name,
      artist,
      "opaque-account"
    )!
  const raw = {
    rating_key: 123,
    title: "Album",
    parent_title: "Artist",
    parent_key: "/library/metadata/100",
    thumb: "/library/metadata/123/thumb/1",
    art: "/library/metadata/123/art/2",
  } as any
  const album = plexAlbumToMusicAlbum(raw, img)
  const artist = plexArtistToMusicArtist({ ...raw, title: "Artist" }, img)
  for (const item of [album, artist]) {
    expect(item.artUrl).not.toBe(item.thumbUrl)
    expect(new URL(item.artUrl!).searchParams.get("src")).toBe(
      "https://plex.test/proxy/library/metadata/123/art/2"
    )
    expect(new URL(item.thumbUrl!).searchParams.get("src")).toBe(
      "https://plex.test/proxy/library/metadata/123/thumb/1"
    )
    expect(new URL(item.artUrl!).searchParams.get("scope")).toBe(
      "opaque-account"
    )
    expect(item.artUrl!).not.toContain("private-not-in-url")
  }
  expect(
    plexAlbumToMusicAlbum({ ...raw, art: undefined }, img).artUrl
  ).toBeNull()
})
