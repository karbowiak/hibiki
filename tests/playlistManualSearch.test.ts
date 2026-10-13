import { expect, test } from "bun:test"
import {
  filterPlaylistCandidates,
  playlistSearchQuery,
} from "../src/playlistSync/manualSearch"
import type { PlaylistTrack } from "../src/playlistSync/types"
const candidates: PlaylistTrack[] = [
  { id: "1", artist: "Yoshiko", title: "Bumble Bee" },
  { id: "2", artist: "Yoshiko", title: "Bumble Bee (Live)" },
  { id: "3", artist: "あの", title: "A+B [mix]" },
]
test("manual wildcard searches send ordinary bounded text and reject empty broad scans", () => {
  expect(playlistSearchQuery(" *Yoshiko*  Bumble B?? ")).toBe(
    "Yoshiko Bumble B"
  )
  expect(playlistSearchQuery("** ??")).toBeNull()
  expect(playlistSearchQuery("[.*]")).toBeNull()
  expect(playlistSearchQuery("あの")).toBe("あの")
  expect(playlistSearchQuery("a".repeat(257))).toBeNull()
})
test("wildcards filter suggestions without discarding versions or promoting a match", () => {
  expect(
    filterPlaylistCandidates(candidates, "yoshiko - Bumble B??").map(
      (t) => t.id
    )
  ).toEqual(["1"])
  expect(
    filterPlaylistCandidates(candidates, "*Bumble Bee*").map((t) => t.id)
  ).toEqual(["1", "2"])
  expect(
    filterPlaylistCandidates(candidates, "*Bumble Bee").map((t) => t.id)
  ).toEqual(["1"])
  expect(
    filterPlaylistCandidates(candidates, "*A+B [mix]*").map((t) => t.id)
  ).toEqual(["3"])
  expect(filterPlaylistCandidates(candidates, "***")).toEqual([])
  expect(filterPlaylistCandidates(candidates, "ordinary text")).toEqual(
    candidates
  )
})
test("wildcard metacharacters use literal punctuation and bounded work", () => {
  const long: PlaylistTrack = {
    id: "x",
    artist: "a".repeat(1000),
    title: "a".repeat(1000) + "!",
  }
  expect(filterPlaylistCandidates([long], "*a".repeat(100) + "b")).toEqual([])
  expect(filterPlaylistCandidates(candidates, "*".repeat(257))).toEqual([])
})
