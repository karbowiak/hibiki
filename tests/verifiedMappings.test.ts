import { expect, test } from "bun:test"
import { verifiedRecordingLookup } from "../src/playlistSync/verifiedMappings"
import type { LinkedTrackMapping } from "../src/playlistSync/linked"

test("repeated occurrences share verified identities while conflicting mappings stay unresolved", () => {
  const row = (id: string, recordingMbid: string) =>
    ({ libraryTrack: { id }, recordingMbid }) as LinkedTrackMapping
  const lookup = verifiedRecordingLookup([
    row("1", "a"),
    row("1", "a"),
    row("2", "a"),
    row("2", "b"),
    row("2", "a"),
  ])
  expect(lookup("1")).toBe("a")
  expect(lookup("2")).toBeNull()
  expect(lookup("3")).toBeNull()
  expect(verifiedRecordingLookup()("1")).toBeNull()
})
