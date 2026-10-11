import { expect, test } from "bun:test"
import { buildExternalImageUrl, buildImageUrl } from "../src/lib/imageUrl"
import { buildPlexImageUrl } from "../src/backends/plex/imageUrl"

test("cards and detail pages share the same explicit artwork URL", () => {
  const source = "https://images.example.test/art.jpg?signature=a%2Bb&size=1000"
  const card = buildImageUrl("artist", "artist-name", source, "Artist")
  const page = buildImageUrl("artist", "1234", source, "ARTIST")
  const album = buildImageUrl("album", "5678", source, "Album", "Artist")
  expect(card).toBe(page)
  expect(card).toBe(album)
  expect(card).toBe(buildExternalImageUrl(source))
  expect(new URL(card!).searchParams.get("src")).toBe(source)
})

test("Plex artwork keeps account scope and removes tokens from the shared URL", () => {
  const card = buildPlexImageUrl("https://plex.example.test", "private-token", "album", "1", "/library/metadata/1/thumb", "Album", "Artist", "scope-a")
  const track = buildPlexImageUrl("https://plex.example.test", "private-token", "track", "2", "/library/metadata/1/thumb", "Track", "Artist", "scope-a")
  const otherAccount = buildPlexImageUrl("https://plex.example.test", "other-token", "track", "2", "/library/metadata/1/thumb", "Track", "Artist", "scope-b")
  expect(card).toBe(track)
  expect(card).not.toBe(otherAccount)
  expect(card).not.toContain("private-token")
  expect(new URL(card!).searchParams.get("scope")).toBe("scope-a")
})

test("metadata-only fallback preserves entity names and identity", () => {
  const album = buildImageUrl("album", "id/with spaces", null, "Album", "Artist", "library")
  expect(new URL(album!).pathname).toBe("/album/id%2Fwith%20spaces")
  expect(new URL(album!).searchParams.get("name")).toBe("Album")
  expect(new URL(album!).searchParams.get("artist")).toBe("Artist")
  expect(album).not.toBe(buildImageUrl("album", "another", null, "Other", "Artist", "library"))
  expect(buildImageUrl("album", "id", null)).toBeNull()
  expect(buildImageUrl("album", "", "https://images.example.test/art.jpg")).toBeNull()
})
