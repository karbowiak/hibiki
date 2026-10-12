import type { MatchResult, PlaylistTrack } from "./types"
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function recordingMbid(value: unknown): string | null {
  return typeof value === "string" && MBID.test(value)
    ? value.toLowerCase()
    : null
}
/** Keep edition/live/remix words and punctuation: these can identify different recordings. */
export function normalizeLabel(value: string) {
  return value
    .normalize("NFC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("en-US")
}
export function matchTrack(
  source: PlaylistTrack,
  candidates: readonly PlaylistTrack[]
): MatchResult {
  const mbid = recordingMbid(source.recordingMbid)
  const matches = candidates.filter((candidate) => {
    const candidateMbid = recordingMbid(candidate.recordingMbid)
    if (mbid && candidateMbid) return mbid === candidateMbid
    if (!normalizeLabel(source.artist) || !normalizeLabel(source.title))
      return false
    if (
      normalizeLabel(source.artist) !== normalizeLabel(candidate.artist) ||
      normalizeLabel(source.title) !== normalizeLabel(candidate.title)
    )
      return false
    if (
      source.album &&
      candidate.album &&
      normalizeLabel(source.album) !== normalizeLabel(candidate.album)
    )
      return false
    if (
      source.durationMs &&
      candidate.durationMs &&
      Math.abs(source.durationMs - candidate.durationMs) > 2000
    )
      return false
    return true
  })
  // Prefer an exact MBID over metadata-only candidates, but never silently choose between local editions.
  const exact = mbid
    ? matches.filter((track) => recordingMbid(track.recordingMbid) === mbid)
    : []
  const choices = exact.length ? exact : matches
  if (choices.length === 1)
    return {
      status: "matched",
      track: choices[0],
      by: exact.length ? "mbid" : "metadata",
    }
  return {
    status: choices.length ? "ambiguous" : "missing",
    candidates: choices,
  }
}
