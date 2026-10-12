import { expect, test } from "bun:test"
import { metadataSourceAvailable } from "../src/metadata/core/availability"

test("public sources remain available without optional service configuration", () => {
  for (const source of [
    "plex",
    "deezer",
    "apple",
    "musicbrainz",
    "wikidata",
    "coverartarchive",
  ] as const)
    expect(metadataSourceAvailable(source, {})).toBe(true)
  expect(metadataSourceAvailable("lastfm", {})).toBe(false)
  expect(metadataSourceAvailable("lastfm", { lastfmApiKey: true })).toBe(true)
})

test("optional services only appear once configured and enabled", () => {
  for (const source of ["fanart", "heya", "soulsync"] as const) {
    expect(metadataSourceAvailable(source, {})).toBe(false)
    expect(metadataSourceAvailable(source, { [source]: null })).toBe(false)
    for (const [configured, enabled] of [
      [false, false],
      [false, true],
      [true, false],
    ])
      expect(
        metadataSourceAvailable(source, { [source]: { configured, enabled } })
      ).toBe(false)
    expect(
      metadataSourceAvailable(source, {
        [source]: { configured: true, enabled: true },
      })
    ).toBe(true)
  }
})
