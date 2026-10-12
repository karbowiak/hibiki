import { expect, test } from "bun:test"
import {
  verifiedFanartCandidates,
  verifiedHeyaCandidates,
  resolveArtworkCandidates,
  selectedArtworkCandidate,
} from "../src/lib/artworkCandidates"
import {
  createArtworkPreferenceStore,
  artworkPreferenceKey,
} from "../src/stores/artworkPreferenceStore"
test("saved candidates must reappear in current verified provider response", () => {
  const images = [
    { id: "one", url: "image://verified-one" },
    { id: "two", url: "image://verified-two" },
  ]
  expect(
    selectedArtworkCandidate(images, "plex", { source: "plex", id: "two" })?.url
  ).toBe("image://verified-two")
  expect(
    selectedArtworkCandidate(images, "plex", {
      source: "plex",
      id: "https://untrusted.test/secret",
    })
  ).toBeNull()
  expect(
    selectedArtworkCandidate(images, "plex", { source: "deezer", id: "two" })
      ?.id
  ).toBe("one")
  expect(selectedArtworkCandidate([], "plex", null)).toBeNull()
})
test("specific selections retain legacy source intent and separate poster/background/account keys", () => {
  const store = createArtworkPreferenceStore(((creator: any) => creator) as any)
  const poster = artworkPreferenceKey("a", "album", "Artist", "Album")!
  const background = artworkPreferenceKey(
    "a",
    "album",
    "Artist",
    "Album",
    "background"
  )!
  store.getState().setCandidate(poster, "fanart", "poster-2")
  store.getState().setCandidate(background, "heya", "background-1")
  expect(store.getState().choices[poster]).toBe("fanart")
  expect(store.getState().candidateChoices[poster]?.id).toBe("poster-2")
  expect(store.getState().candidateChoices[background]?.id).toBe("background-1")
  expect(
    store.getState().candidateChoices[
      artworkPreferenceKey("b", "album", "Artist", "Album")!
    ]
  ).toBeUndefined()
  store.getState().setChoice(poster, null)
  expect(store.getState().candidateChoices[poster]).toBeNull()
  expect(store.getState().candidateChoices[background]?.id).toBe("background-1")
})

test("removed selected image falls back without requesting saved URL or choosing a different same-source image", () => {
  const images = {
    fanart: [{ id: "new", url: "image://new" }],
    plex: [{ id: "default", url: "image://plex" }],
  }
  const result = resolveArtworkCandidates(
    images,
    ["fanart", "plex"],
    "fanart",
    { source: "fanart", id: "removed" }
  )
  expect(result.url).toBe("image://plex")
  expect(result.fallback).toBe(true)
  expect(result.refreshTargets.fanart).toBeNull()
  expect(
    resolveArtworkCandidates(images, ["fanart", "plex"], null, null, [
      "image://new",
    ]).url
  ).toBe("image://plex")
})

test("Fanart candidate arrays are bounded and reject credential-bearing or foreign URLs", () => {
  const values = [
    { id: "valid", url: "https://assets.fanart.tv/image.jpg" },
    { id: "credential", url: "https://user:secret@assets.fanart.tv/image.jpg" },
    { id: "foreign", url: "https://assets.fanart.tv.evil.test/image.jpg" },
    { id: "http", url: "http://assets.fanart.tv/image.jpg" },
  ]
  expect(verifiedFanartCandidates(values).map((x) => x.id)).toEqual(["valid"])
  expect(
    verifiedFanartCandidates(
      Array.from({ length: 100 }, (_, i) => ({
        id: String(i),
        url: `https://assets.fanart.tv/${i}.jpg`,
      }))
    )
  ).toHaveLength(12)
})

test("Heya candidates require matching opaque image ID and current service revision", () => {
  const id = "11111111-1111-4111-8111-111111111111",
    revision = "22222222-2222-4222-8222-222222222222"
  const url = `heyametadata://image/${id}?serviceRevision=${revision}`
  expect(verifiedHeyaCandidates([{ id, url }], revision)).toHaveLength(1)
  expect(
    verifiedHeyaCandidates(
      [{ id, url }],
      "33333333-3333-4333-8333-333333333333"
    )
  ).toHaveLength(0)
  expect(
    verifiedHeyaCandidates(
      [{ id, url: `https://private.test/api/v2/images/${id}` }],
      revision
    )
  ).toHaveLength(0)
  expect(
    verifiedHeyaCandidates(
      [{ id, url: `${url}&serviceRevision=${revision}` }],
      revision
    )
  ).toHaveLength(0)
  expect(
    verifiedHeyaCandidates([{ id, url: `${url}&token=secret` }], revision)
  ).toHaveLength(0)
  expect(
    verifiedHeyaCandidates(
      [{ id: "44444444-4444-4444-8444-444444444444", url }],
      revision
    )
  ).toHaveLength(0)
})
