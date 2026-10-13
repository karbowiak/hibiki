import type { PlaylistTrack } from "./types"
import { normalizeLabel } from "./matching"

const MAX_PATTERN = 256
/** Translate a manual wildcard filter into a bounded upstream text search.
 * Filtering happens locally; no undocumented provider wildcard syntax is sent. */
export function playlistSearchQuery(pattern: string): string | null {
  if (pattern.length > MAX_PATTERN) return null
  const query = pattern.replace(/[?*]/gu, " ").replace(/\s+/gu, " ").trim()
  return /[\p{L}\p{N}]/u.test(query) ? query : null
}

/** Dynamic programming avoids exponential regex backtracking on wildcard input. */
function matches(value: string, pattern: string): boolean {
  const text = Array.from(normalizeLabel(value)),
    glob = Array.from(normalizeLabel(pattern))
  if (text.length > 2005 || glob.length > MAX_PATTERN) return false
  let previous = new Uint8Array(text.length + 1)
  previous[0] = 1
  for (const token of glob) {
    const next = new Uint8Array(text.length + 1)
    if (token === "*") next[0] = previous[0]
    for (let i = 1; i <= text.length; i++)
      next[i] =
        token === "*"
          ? previous[i] || next[i - 1]
          : previous[i - 1] && (token === "?" || token === text[i - 1])
            ? 1
            : 0
    previous = next
  }
  return previous[text.length] === 1
}

/** Suggestions only: matching this filter never verifies a recording identity. */
export function filterPlaylistCandidates(
  candidates: readonly PlaylistTrack[],
  pattern: string
): PlaylistTrack[] {
  if (!/[?*]/u.test(pattern)) return [...candidates]
  if (!playlistSearchQuery(pattern)) return []
  return candidates.filter((candidate) =>
    [
      candidate.artist,
      candidate.title,
      `${candidate.artist} ${candidate.title}`,
      `${candidate.artist} - ${candidate.title}`,
      `${candidate.title} ${candidate.artist}`,
    ].some((value) => matches(value, pattern))
  )
}
