import type { LinkedTrackMapping } from "./linked"

/** Conflicting occurrence mappings cannot confer a recording identity. */
export function verifiedRecordingLookup(
  mappings: readonly LinkedTrackMapping[] = []
) {
  const recordings = new Map<string, string | null>()
  for (const mapping of mappings) {
    const id = mapping.libraryTrack.id
    if (!recordings.has(id)) recordings.set(id, mapping.recordingMbid)
    else if (recordings.get(id) !== mapping.recordingMbid)
      recordings.set(id, null)
  }
  return (id: string) => recordings.get(id) ?? null
}
