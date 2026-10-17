import { expect, test } from "bun:test"
import { artistCreditsKey, itemArtistCredits, normalizeArtistCredits, plexArtistCredits, splitArtistCredit } from "../src/lib/artistCredits"

test("separates collaboration credits without giving every artist the combined Plex identity", () => {
  expect(normalizeArtistCredits("NEEDY GIRL OVERDOSE, Aiobahn +81", "combined")).toEqual([
    { name: "NEEDY GIRL OVERDOSE", id: null }, { name: "Aiobahn +81", id: null },
  ])
  expect(splitArtistCredit(" A ; B x C feat. D ; A ")).toEqual(["A", "B", "C", "D", "A"])
  expect(normalizeArtistCredits("A; A; B").map(artist => artist.name)).toEqual(["A", "B"])
  expect(splitArtistCredit("The xx")).toEqual(["The xx"])
  expect(splitArtistCredit("Aiobahn +81")).toEqual(["Aiobahn +81"])
})

test("live Plex response shapes distinguish local collaboration credits from canonical artist names", () => {
  expect(plexArtistCredits("Al Storm, Alaguan, 247 Hardcore", "combined", "local://combined").map(credit => credit.name))
    .toEqual(["Al Storm", "Alaguan", "247 Hardcore"])
  expect(plexArtistCredits("Yeico X Toni", "duo", "plex://artist/canonical"))
    .toEqual([{ name: "Yeico X Toni", id: "duo" }])
})

test("structured provider names and IDs survive punctuation and missing legacy credits", () => {
  expect(normalizeArtistCredits("A, B", "combined", [{ name: "A, B", id: "real-name" }]))
    .toEqual([{ name: "A, B", id: "real-name" }])
  expect(splitArtistCredit("Tyler, The Creator")).toEqual(["Tyler, The Creator"])
  expect(splitArtistCredit('"Artist, Name"; Other')).toEqual(["Artist, Name", "Other"])
  expect(splitArtistCredit("Earth, Wind & Fire")).toEqual(["Earth, Wind & Fire"])
  expect(itemArtistCredits({ artistName: "Various Artists", artistId: "various", originalTitle: "A; B" }))
    .toEqual([{ name: "A", id: null }, { name: "B", id: null }])
  expect(artistCreditsKey("A; B")).toBe(artistCreditsKey("B x A"))
})
