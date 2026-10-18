import type { MusicTrack } from "../types/music"
import { itemArtistCredits } from "../lib/artistCredits"
import { playlistCandidateScore } from "../playlistSync/matching"
import { verifiedSongReference, type MixedPlaylist, type Service } from "./model"
import { matchingIdentifiers } from "../matching/sources"

const label = (text: string) => text.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ")
const credits = (track: MusicTrack) => itemArtistCredits(track).map(credit => label(credit.name)).sort()
export function recordingFingerprint(track: MusicTrack) {
  return JSON.stringify([track.id, label(track.title), credits(track), label(track.albumName), track.duration, track.explicit ?? null])
}
/** No fuzzy artist matching for writes or lyrics. Version words and known duration
 * differences fence selection even when the song titles happen to be identical. */
export function counterpartCandidates(source: MusicTrack, candidates: MusicTrack[]) {
  const sourceCredits = credits(source)
  const identifiers = matchingIdentifiers(source.guid)
  const compatible = [...new Map(candidates.map(track => [track.id, track])).values()].filter(candidate => {
    if (!source.duration || !candidate.duration || !sourceCredits.length) return false
    if (JSON.stringify(sourceCredits) !== JSON.stringify(credits(candidate))) return false
    const otherIds = matchingIdentifiers(candidate.guid)
    if (identifiers.some(id => otherIds.some(other => other.scheme === id.scheme) && !otherIds.some(other => other.scheme === id.scheme && other.value === id.value))) return false
    if (typeof source.explicit === "boolean" && typeof candidate.explicit === "boolean" && source.explicit !== candidate.explicit) return false
    const difference = Math.abs(source.duration - candidate.duration)
    if (difference > 3000 || difference / Math.min(source.duration, candidate.duration) > 0.02) return false
    const input = (track: MusicTrack) => ({ id: track.id, title: track.title, artist: sourceCredits.join(", "), album: track.albumName, durationMs: track.duration })
    return playlistCandidateScore(input(source), input(candidate)) > 0.95
  })
  if (compatible.length > 1 && source.albumName) {
    const sameAlbum = compatible.filter(track => label(track.albumName) === label(source.albumName))
    if (sameAlbum.length === 1) return sameAlbum
  }
  return compatible
}
export type CounterpartResult = { status: "matched"; track: MusicTrack; checkedAt: number; fingerprint: string } |
  { status: "missing" | "ambiguous" | "failed"; checkedAt: number; message: string }
/** Each durable update is a checkpoint. One bounded worker preserves order and
 * repeats, and cancellation/owner changes stop admission of the remaining rows. */
export async function matchPlaylistBatch(playlist: MixedPlaylist, target: Service, options: {
  current: () => boolean
  resolve: (track: MusicTrack) => Promise<CounterpartResult>
  save: (playlist: MixedPlaylist) => Promise<MixedPlaylist>
  limit?: number
  retry?: boolean
  eligible?: (track: MusicTrack) => boolean
}) {
  let saved = playlist, completed = 0
  const resolved = new Map<string, CounterpartResult>()
  for (const row of playlist.items) {
    if (!options.current() || completed >= (options.limit ?? 20)) break
    if ((row.songs[target] && !row.songs[target]?.stale) || (!options.retry && row.match.status !== "pending")) continue
    const source = row.songs[row.original]?.track
    if (!source) continue
    if (options.eligible && !options.eligible(source)) continue
    const fingerprint = recordingFingerprint(source)
    let result = resolved.get(fingerprint)
    if (!result) {
      try { result = await options.resolve(source) } catch { result = { status: "failed", checkedAt: Date.now(), message: "Song lookup failed. Retry matching." } }
      resolved.set(fingerprint, result)
    }
    if (!options.current()) break
    saved = await options.save({ ...saved, items: saved.items.map(item => item.id !== row.id ? item : {
      ...item, songs: result.status === "matched" ? { ...item.songs, [target]: verifiedSongReference(result.track, item.songs[target]) } : item.songs,
      remote: result.status === "matched" && item.songs[target]?.stale && item.songs[target]?.track.id !== result.track.id
        ? { ...item.remote, [target]: undefined } : item.remote,
      match: { status: result.status, checkedAt: result.checkedAt, message: result.status === "matched" ? undefined : result.message },
    }) })
    completed++
  }
  return { playlist: saved, completed }
}
