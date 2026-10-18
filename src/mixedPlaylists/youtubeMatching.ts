import type { MusicTrack } from "../types/music"
import { itemArtistCredits } from "../lib/artistCredits"
import { playlistSearchTitle } from "../playlistSync/matching"
import { counterpartCandidates, rankPlaylistCounterparts } from "./matching"

/** Search is ranked, not a complete library enumeration. A continuation means
 * there are more suggestions, not that the returned recordings are invalid.
 * Bound discovery to three queries; strong fuzzy suggestions can stop early. */
export async function youtubeCounterpartCandidates(track: MusicTrack, options: {
  search(query: string): Promise<MusicTrack[]>
  current(): boolean
  fuzzy?: boolean
  catalog?(track: MusicTrack): Promise<MusicTrack[]>
}) {
  const candidates = new Map<string, MusicTrack>()
  if (options.catalog) {
    if (!options.current()) throw Error("Music accounts changed.")
    for (const candidate of await options.catalog(track)) candidates.set(candidate.id, candidate)
    if (!options.current()) throw Error("Music accounts changed.")
    const found = [...candidates.values()]
    if (options.fuzzy ? rankPlaylistCounterparts(track, found).length : counterpartCandidates(track, found).length === 1) return found
  }
  const artists = itemArtistCredits(track).map(credit => credit.name)
  const title = playlistSearchTitle({ id: track.id, title: track.title, artist: artists.join(", ") })
  const queries = [...new Set([
    `${artists.join(", ")} ${track.title}`,
    `${artists[0] ?? ""} ${title}`,
    track.albumName ? `${artists[0] ?? ""} ${title} ${track.albumName}` : "",
  ].map(query => query.trim().replace(/\s+/g, " ").slice(0, 500)).filter(Boolean))]
  for (const query of queries) {
    if (!options.current()) throw Error("Music accounts changed.")
    let found: MusicTrack[]
    try { found = await options.search(query) }
    catch (failure) {
      // A fallback query may be throttled after a plausible result was already
      // found. Keep that suggestion rather than discarding completed work.
      if (options.current() && options.fuzzy && rankPlaylistCounterparts(track, [...candidates.values()]).length) break
      throw failure
    }
    if (!options.current()) throw Error("Music accounts changed.")
    for (const candidate of found.slice(0, 20)) candidates.set(candidate.id, candidate)
    if (options.fuzzy) {
      const ranked = rankPlaylistCounterparts(track, [...candidates.values()])
      if (ranked[0]?.confidence >= 0.94 && (!ranked[1] || ranked[0].confidence - ranked[1].confidence >= 0.03)) break
    } else if (counterpartCandidates(track, [...candidates.values()]).length === 1) break
  }
  return [...candidates.values()]
}
