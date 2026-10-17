import { expect, test } from "bun:test"
import {
  matchTrack,
  playlistCandidateScore,
} from "../src/playlistSync/matching"
import { playlistTrackFromMusic } from "../src/playlistSync/provider"
import { favoriteReference } from "../src/favorites/types"
import plex from "./fixtures/dearGodPlex.json"
import liveCases from "./fixtures/favoritePlexCases.json"
import type { PlaylistTrack } from "../src/playlistSync/types"
import type { MusicTrack } from "../src/types/music"

const source = (patch: Partial<PlaylistTrack> = {}): PlaylistTrack => ({
  id: "remote",
  title: "Dear God",
  artist: "Sefa",
  durationMs: null,
  ...patch,
})
const local = (patch: Partial<PlaylistTrack> = {}): PlaylistTrack => ({
  ...source(),
  id: "local",
  ...patch,
})

// Only public track metadata from a read-only Plex query on 2026-10-16.
// Service credentials, account names and personal love dates are excluded.
test("Dear God by Sefa selects Sefa in the real crowded Plex results, never Ruben", () => {
  expect(
    matchTrack(
      source({
        album: "Klaagzang",
        recordingMbid: "29bf9ea3-0864-4239-bf0e-44853f39f2b7",
      }),
      plex
    )
  ).toMatchObject({
    status: "matched",
    track: { id: "165297", artist: "Sefa" },
  })
  expect(
    matchTrack(
      source(),
      plex.filter((track) => track.artist !== "Sefa")
    ).status
  ).toBe("missing")
  expect(matchTrack(source({ artist: "Ruben" }), plex)).toMatchObject({
    status: "matched",
    track: { id: "275497" },
  })
})
test("live Plex examples recover feature and title differences while retaining a genuine edition ambiguity", () => {
  for (const row of liveCases) {
    for (const tracks of [row.tracks, [...row.tracks].reverse()]) {
      const result = matchTrack(row.source, tracks)
      if (row.expectedId)
        expect(result).toMatchObject({
          status: "matched",
          track: { id: row.expectedId },
        })
      else expect(result.status).toBe("ambiguous")
    }
  }
})
test("similar artist spellings and long titles cannot overpower performer or numeric identity", () => {
  for (const [artist, wrong] of [
    ["John Newman", "Joan Newman"],
    ["Sefa", "Sera"],
    ["Artist (US)", "Artist (UK)"],
  ]) {
    expect(
      matchTrack(source({ artist }), [local({ artist: wrong })]).status
    ).toBe("missing")
  }
  expect(
    matchTrack(
      source({ artist: "Ludovico Einaudi", title: "Day 1: Gravity" }),
      [local({ artist: "Ludovico Einaudi", title: "Day 3: Gravity" })]
    ).status
  ).toBe("missing")
})
test("Last.fm likes without duration match featured credits moved between title and artist", () => {
  for (const [artist, title, otherArtist, otherTitle] of [
    ["Lil Wayne feat. Drake", "She Will", "Lil Wayne", "She Will"],
    [
      "Major Lazer Feat. Amber Of Dirty Projectors",
      "Get Free",
      "Major Lazer",
      "Get Free",
    ],
    ["Fivio Foreign", "Love Songs", "Fivio Foreign feat. Ne‐Yo", "Love Songs"],
    [
      "Lil Wayne",
      "Mirror (feat. Bruno Mars)",
      "Lil Wayne feat. Bruno Mars",
      "Mirror",
    ],
    [
      "Lil Wayne",
      "Mirror ft. Bruno Mars",
      "Lil Wayne feat. Bruno Mars",
      "Mirror",
    ],
    ["Lil Wayne, Bruno Mars", "Mirror", "Lil Wayne & Bruno Mars", "Mirror"],
    ["Bruno Mars & Lil Wayne", "Mirror", "Lil Wayne, Bruno Mars", "Mirror"],
  ]) {
    expect(
      matchTrack(source({ artist, title }), [
        local({ artist: otherArtist, title: otherTitle }),
      ])
    ).toMatchObject({ status: "matched", by: "metadata" })
  }
})
test("shared guests do not establish identity and conflicting collaborators require review", () => {
  for (const [artist, otherArtist] of [
    ["A feat. Guest", "B feat. Guest"],
    ["A feat. Guest", "Guest"],
    ["A feat. B", "A feat. C"],
    ["A & B", "B & C"],
  ]) {
    expect(
      playlistCandidateScore(
        source({ artist, durationMs: 180000 }),
        local({ artist: otherArtist, durationMs: 180000 })
      )
    ).toBe(0)
  }
  expect(
    matchTrack(source({ artist: "A", title: "Song (feat. B)" }), [
      local({ artist: "A", title: "Song (feat. C)" }),
    ]).status
  ).toBe("missing")
  expect(
    matchTrack(source({ artist: "A & B" }), [local({ artist: "A" })]).status
  ).toBe("missing")
  expect(
    matchTrack(source({ artist: "A x B", album: "Single" }), [
      local({ artist: "A", album: "Single" }),
    ]).status
  ).toBe("matched")
})
test("artist prefixes and neutral mix labels can vary but named versions and live releases stay distinct", () => {
  expect(
    matchTrack(
      source({
        artist: "Little Sis Nora",
        title: "Little Sis Nora - COOL LIKE THAT",
      }),
      [local({ artist: "Little Sis Nora", title: "COOL LIKE THAT" })]
    ).status
  ).toBe("matched")
  expect(
    matchTrack(source(), [local({ title: "Dear God - Original Mix" })]).status
  ).toBe("matched")
  for (const patch of [
    { title: "Dear God (Japanese Version)" },
    { title: "Dear God (VIP)" },
    { title: "Dear God (2024 Remaster)" },
    { album: "Klaagzang (Live at the Arena)" },
    { album: "Klaagzang - Live Edition" },
    { album: "Klaagzang (Remixes)" },
  ])
    expect(matchTrack(source(), [local(patch)]).status).toBe("missing")
  expect(
    matchTrack(source({ title: "Other Artist - Dear God" }), [local()]).status
  ).toBe("missing")
})
test("distinct guests and local editions stay ambiguous when the remote metadata omits that evidence", () => {
  expect(
    matchTrack(source({ artist: "A" }), [
      local({ id: "b", artist: "A feat. B" }),
      local({ id: "c", artist: "A feat. C" }),
    ]).status
  ).toBe("ambiguous")
  expect(
    matchTrack(source(), [
      local({ id: "a", durationMs: 180000 }),
      local({ id: "b", durationMs: 185000 }),
    ]).status
  ).toBe("ambiguous")
})
test("same-named single versions retain remixer and venue identity when the qualifier moves between fields", () => {
  const remix = source({ album: "Dear God (Alice Remix)" })
  expect(
    matchTrack(remix, [local({ album: "Dear God (Bob Remix)" })]).status
  ).toBe("missing")
  expect(
    matchTrack(remix, [
      local({ title: "Dear God (Alice Remix)", album: "Compilation" }),
    ]).status
  ).toBe("matched")
  expect(
    matchTrack(source({ album: "Dear God (Live in Tokyo)" }), [
      local({ album: "Dear God (Live in Kyoto)" }),
    ]).status
  ).toBe("missing")
})
test("compilation track artists supply identity rather than the album's Various Artists label", () => {
  const track = {
    id: "compilation",
    title: "Dear God",
    artistName: "Various Artists",
    originalTitle: "Sefa",
    albumName: "Compilation",
    duration: 293777,
  } as MusicTrack
  expect(playlistTrackFromMusic(track).artist).toBe("Sefa")
  expect(favoriteReference(track).artist).toBe("Sefa")
  expect(matchTrack(source(), [playlistTrackFromMusic(track)]).status).toBe(
    "matched"
  )
  expect(favoriteReference({ ...track, originalTitle: "  " }).artist).toBe(
    "Various Artists"
  )
})
