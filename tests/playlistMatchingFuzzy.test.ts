import { expect, test } from "bun:test"
import {
  matchTrack,
  playlistCandidateScore,
} from "../src/playlistSync/matching"
import type { PlaylistTrack } from "../src/playlistSync/types"
const base: PlaylistTrack = {
  id: "source",
  title: "Bumble Bee",
  artist: "Yoshiko",
  album: "Single",
  durationMs: 180000,
}
const candidate = (patch: Partial<PlaylistTrack> = {}): PlaylistTrack => ({
  ...base,
  id: "local",
  ...patch,
})
test("punctuation, Latin accents, neutral original labels and compilation releases do not block reliable matching", () => {
  expect(
    matchTrack(base, [
      candidate({
        title: "Bumble-Bee",
        album: "Compilation",
        durationMs: 181000,
      }),
    ])
  ).toMatchObject({ status: "matched", by: "metadata" })
  expect(
    matchTrack(base, [candidate({ title: "Bumble Bee (Original Mix)" })]).status
  ).toBe("matched")
  expect(
    matchTrack({ ...base, artist: "Beyoncé", title: "Déjà Vu" }, [
      candidate({ artist: "Beyonce", title: "Deja Vu" }),
    ]).status
  ).toBe("matched")
})
test("small typos on descriptive labels may match above 95 percent, with scores never presented as probabilities", () => {
  const source = {
      ...base,
      title: "A Familiar Favorite From A Beautiful Summer Evening",
    },
    local = candidate({
      title: "A Familiar Favourite From A Beautiful Summer Evening",
    })
  expect(playlistCandidateScore(source, local)).toBeGreaterThan(0.95)
  expect(matchTrack(source, [local])).toMatchObject({
    status: "matched",
    by: "metadata",
  })
  expect(
    matchTrack({ ...base, title: "Honey" }, [candidate({ title: "Money" })])
      .status
  ).toBe("missing")
})
test("known recording conflicts, protective version words and truncated durations cannot become fuzzy automatic matches", () => {
  for (const title of [
    "Bumble Bee (Live)",
    "Bumble Bee (Remix)",
    "Bumble Bee (Radio Edit)",
    "Bumble Bee (Slowed)",
  ])
    expect(matchTrack(base, [candidate({ title })]).status).toBe("missing")
  expect(
    matchTrack({ ...base, title: "Bumble Bee (Live in Tokyo)" }, [
      candidate({ title: "Bumble Bee (Live in Kyoto)" }),
    ]).status
  ).toBe("missing")
  expect(matchTrack(base, [candidate({ durationMs: 30000 })]).status).toBe(
    "missing"
  )
  const a = "00000000-0000-4000-8000-000000000001",
    b = "00000000-0000-4000-8000-000000000002"
  expect(
    matchTrack({ ...base, recordingMbid: a }, [candidate({ recordingMbid: b })])
      .status
  ).toBe("missing")
  expect(
    matchTrack({ ...base, recordingMbid: a }, [
      candidate({ recordingMbid: a, title: "Canonical title" }),
    ])
  ).toMatchObject({ status: "matched", by: "mbid" })
})
test("near ties need later review; exact album evidence can disambiguate a compilation duplicate", () => {
  expect(
    matchTrack({ ...base, album: null }, [
      candidate(),
      candidate({ id: "second", durationMs: 182000 }),
    ]).status
  ).toBe("ambiguous")
  expect(
    matchTrack(base, [
      candidate(),
      candidate({ id: "second", album: "Compilation" }),
    ])
  ).toMatchObject({ status: "matched", track: { id: "local" } })
  expect(matchTrack(base, [candidate(), candidate()]).status).toBe("matched")
})
test("credited collaborators match Plex's primary artist when title and duration agree", () => {
  expect(
    matchTrack({ ...base, artist: "Yoshiko & Tatsunoshin" }, [candidate()])
  ).toMatchObject({ status: "matched" })
  expect(
    matchTrack(
      {
        ...base,
        artist:
          "HUNTR/X (EJAE, AUDREY NUNA & REI AMI) & KPop Demon Hunters Cast",
        title: "Golden",
      },
      [candidate({ artist: "HUNTR/X", title: "Golden" })]
    )
  ).toMatchObject({ status: "matched" })
  expect(
    matchTrack(
      {
        ...base,
        artist: "Yoshiko & Tatsunoshin",
        album: null,
        durationMs: null,
      },
      [candidate()]
    ).status
  ).toBe("missing")
  expect(
    matchTrack({ ...base, artist: "Yoshiko & Tatsunoshin" }, [
      candidate({ artist: "Unrelated" }),
    ]).status
  ).toBe("missing")
})
test("a version in a same-named single's release label still protects the recording", () => {
  expect(
    matchTrack(
      {
        ...base,
        title: "Dracula",
        artist: "Tame Impala with JENNIE",
        album: "Dracula (remix)",
      },
      [
        candidate({
          title: "Dracula",
          artist: "Tame Impala",
          album: "Deadbeat",
        }),
      ]
    ).status
  ).toBe("missing")
})
test("equivalent library copies are chosen consistently without forcing a review", () => {
  const copies = [candidate({ id: "20" }), candidate({ id: "3" })]
  expect(matchTrack(base, copies)).toMatchObject({
    status: "matched",
    track: { id: "3" },
  })
  expect(matchTrack(base, [...copies].reverse())).toMatchObject({
    status: "matched",
    track: { id: "3" },
  })
  expect(
    matchTrack({ ...base, recordingMbid: null }, [
      candidate({
        id: "3",
        recordingMbid: "00000000-0000-4000-8000-000000000001",
      }),
      candidate({
        id: "20",
        recordingMbid: "00000000-0000-4000-8000-000000000002",
      }),
    ]).status
  ).toBe("ambiguous")
})
test("Japanese voicing marks remain distinct and long near-matching inputs have bounded work", () => {
  expect(
    matchTrack({ ...base, title: "が" }, [candidate({ title: "か" })]).status
  ).toBe("missing")
  expect(
    playlistCandidateScore(
      { ...base, title: "a".repeat(1000) },
      candidate({ title: "a".repeat(999) + "b" })
    )
  ).toBe(0)
})
