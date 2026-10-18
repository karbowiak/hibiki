import type { MusicTrack } from "../types/music"
import type { MatchingRow } from "./resolverTypes"
import { trackMatchingSource } from "./sources"
import { playlistCandidateScore } from "../playlistSync/matching"

const label = (value: string) => value.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ")
/** Compare identity metadata without constructing a playback or browse DTO. */
export function indexedRecordingMatches(expected: MusicTrack, actual: MatchingRow) {
  if (actual.kind !== "track" || !expected.duration || !actual.duration) return false
  const source = trackMatchingSource(expected)
  const credits = (values: string[]) => [...new Set(values.map(label))].sort()
  if (JSON.stringify(credits(source.artists)) !== JSON.stringify(credits(actual.artists))) return false
  if (typeof expected.explicit === "boolean" && typeof actual.explicit === "boolean" && expected.explicit !== actual.explicit) return false
  const difference = Math.abs(expected.duration - actual.duration)
  if (difference > 3000 || difference / Math.min(expected.duration, actual.duration) > 0.02) return false
  if (source.identifiers.some(id => actual.identifiers.some(other => other.scheme === id.scheme) && !actual.identifiers.some(other => other.scheme === id.scheme && other.value.toLowerCase() === id.value.toLowerCase()))) return false
  const artist = source.artists.join(", ")
  return playlistCandidateScore({ id: expected.id, title: expected.title, artist, album: expected.albumName, durationMs: expected.duration },
    { id: String(actual.id), title: actual.title, artist, album: actual.album ?? undefined, durationMs: actual.duration }) > 0.95
}
