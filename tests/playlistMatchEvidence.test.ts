import { test, expect } from "bun:test"
import { linkedMatchEvidenceLabel } from "../src/components/PlaylistSync/matchEvidence"
import type { LinkedTrackMapping } from "../src/playlistSync/linked"
import type { PlaylistPlan } from "../src/playlistSync/types"
const mbid = "11111111-1111-4111-8111-111111111111"
const local = {
  id: "local",
  title: "Song",
  artist: "Artist",
  recordingMbid: mbid,
}
const row: PlaylistPlan["rows"][number] = {
  occurrenceId: "one",
  source: { ...local, id: mbid },
  match: { status: "matched", by: "mbid", track: local },
}
const mapping = (
  verifiedBy: LinkedTrackMapping["verifiedBy"],
  sourceOccurrenceId?: string
): LinkedTrackMapping => ({
  libraryTrack: local,
  recordingMbid: mbid,
  verifiedBy,
  sourceOccurrenceId,
})
test("saved mapping provenance determines review evidence rather than injected recording IDs", () => {
  expect(
    linkedMatchEvidenceLabel(row, "listenbrainz", [mapping("metadata")])
  ).toBe("Matched by metadata")
  expect(
    linkedMatchEvidenceLabel(row, "listenbrainz", [mapping("reviewed")])
  ).toBe("Saved choice")
  expect(
    linkedMatchEvidenceLabel(row, "listenbrainz", [mapping("provider-mbid")])
  ).toBe("Verified recording match")
  expect(linkedMatchEvidenceLabel(row, "listenbrainz", [])).toBeUndefined()
})
test("exact reviewed occurrence wins and unrelated mappings cannot claim proof", () => {
  expect(
    linkedMatchEvidenceLabel(row, "listenbrainz", [
      mapping("metadata"),
      mapping("reviewed", "one"),
    ])
  ).toBe("Saved choice")
  expect(
    linkedMatchEvidenceLabel(row, "listenbrainz", [
      mapping("reviewed", "different"),
    ])
  ).toBeUndefined()
  expect(
    linkedMatchEvidenceLabel(row, "listenbrainz", [
      { ...mapping("provider-mbid"), libraryTrack: { ...local, id: "other" } },
    ])
  ).toBeUndefined()
  expect(
    linkedMatchEvidenceLabel(
      { ...row, match: { status: "matched", by: "manual", track: local } },
      "listenbrainz",
      [mapping("metadata")]
    )
  ).toBeUndefined()
})
test("export review preserves the originating local mapping evidence too", () => {
  const exported = {
    ...row,
    source: local,
    match: {
      status: "matched" as const,
      by: "mbid" as const,
      track: { ...local, id: mbid },
    },
  }
  expect(
    linkedMatchEvidenceLabel(exported, "library", [mapping("metadata")])
  ).toBe("Matched by metadata")
})
