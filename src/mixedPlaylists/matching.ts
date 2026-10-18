import type { MusicTrack } from "../types/music"
import { itemArtistCredits, splitArtistCredit } from "../lib/artistCredits"
import { playlistCandidateScore, playlistTitleSimilarity } from "../playlistSync/matching"
import { artistNameKey, artistNameSimilarity } from "../lib/artistMatching"
import { verifiedSongReference, type MixedOccurrence, type MixedPlaylist, type Service } from "./model"
import { matchingIdentifiers } from "../matching/sources"

const label = (text: string) => text.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ")
const credits = (track: MusicTrack) => itemArtistCredits(track).map(credit => label(credit.name)).sort()
/** Retry old search misses once through the grouped artist/release catalog. */
export const COUNTERPART_POLICY = 4
export function counterpartPending(row: MixedOccurrence, target: Service) {
  return (!row.songs[target] || !!row.songs[target]?.stale) &&
    (row.match.status === "pending" || row.match.policy !== COUNTERPART_POLICY)
}
const creditKey = (name: string) => label(name).normalize("NFKD")
  .replace(/(\p{Script=Latin})\p{M}+/gu, "$1").normalize("NFC").replace(/[^\p{L}\p{N}\p{M}]/gu, "")
function recordingCredits(track: MusicTrack) {
  const names = itemArtistCredits(track).map(credit => credit.name)
  // Services move featured performers between the title and artist fields.
  // Include them in identity, so different guests cannot collapse together.
  const feature = /[([]\s*(?:feat\.?|featuring|ft\.?)\s+([^()[\]]+)[)\]]|\s+(?:feat\.?|featuring|ft\.?)\s+(.+)$/giu
  for (const match of track.title.matchAll(feature)) names.push(match[1] ?? match[2])
  const identity = (values: string[]) => JSON.stringify([...new Set(values.map(creditKey).filter(Boolean))].sort())
  // Keep each structured name intact first. An alternate full-credit reading
  // handles Plex's combined artist entities; never accept just a shared primary.
  return [identity(names), identity(names.flatMap(name => splitArtistCredit(name)
    .flatMap(part => part.split(/\s+(?:&|and)\s+/iu))))]
}
export function recordingFingerprint(track: MusicTrack) {
  return JSON.stringify([track.id, label(track.title), credits(track), label(track.albumName), track.duration, track.explicit ?? null])
}
/** Performer names must agree, allowing formatting and feature-credit placement.
 * Version words, explicitness and duration still fence automatic selection. */
export function counterpartCandidates(source: MusicTrack, candidates: MusicTrack[]) {
  const sourceCredits = credits(source)
  const sourceIdentities = recordingCredits(source)
  const identifiers = matchingIdentifiers(source.guid)
  const compatible = [...new Map(candidates.map(track => [track.id, track])).values()].filter(candidate => {
    if (!source.duration || !candidate.duration || !sourceCredits.length) return false
    if (!recordingCredits(candidate).some(identity => sourceIdentities.includes(identity))) return false
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
function fuzzyCredits(track: MusicTrack) {
  const names = itemArtistCredits(track).map(credit => credit.name)
  for (const match of track.title.matchAll(/[([]\s*(?:feat\.?|featuring|ft\.?)\s+([^()[\]]+)[)\]]|\s+(?:feat\.?|featuring|ft\.?)\s+(.+)$/giu))
    names.push(match[1] ?? match[2])
  const unique = (values: string[]) => [...new Map(values.filter(Boolean).map(name => [creditKey(name), name])).values()]
  return [unique(names), unique(names.flatMap(name => splitArtistCredit(name)
    .flatMap(part => part.includes(",") ? [part] : part.split(/\s+(?:&|and)\s+/iu))))]
}
function performerSimilarity(source: MusicTrack, candidate: MusicTrack) {
  let best = 0
  for (const left of fuzzyCredits(source)) for (const right of fuzzyCredits(candidate)) {
    if (!left.length || !right.length) continue
    // Match each credit once. Extra credits on either service are common; two
    // conflicting guest lists must not pass on a shared lead performer alone.
    const shorter = left.length <= right.length ? left : right, longer = left.length <= right.length ? right : left
    const pairs = shorter.flatMap((name, i) => longer.map((other, j) => ({ i, j, score: artistNameSimilarity(name, other) })))
      .sort((a, b) => b.score - a.score)
    const usedLeft = new Set<number>(), usedRight = new Set<number>()
    let score = 0
    for (const pair of pairs) if (!usedLeft.has(pair.i) && !usedRight.has(pair.j)) {
      usedLeft.add(pair.i); usedRight.add(pair.j); score += pair.score
    }
    best = Math.max(best, score / shorter.length - (left.length === right.length ? 0 : 0.03))
  }
  return best
}
/** A metadata confidence score, not a statistical probability. Only playlist
 * suggestions use this policy; rating writes and recording proofs stay strict. */
export function rankPlaylistCounterparts(source: MusicTrack, candidates: MusicTrack[]) {
  const identifiers = matchingIdentifiers(source.guid)
  const input = (track: MusicTrack) => ({ id: track.id, title: track.title, artist: itemArtistCredits(track).map(credit => credit.name).join(", "), album: track.albumName })
  return [...new Map(candidates.map(track => [track.id, track])).values()].flatMap(track => {
    const otherIds = matchingIdentifiers(track.guid)
    if (identifiers.some(id => otherIds.some(other => other.scheme === id.scheme) && !otherIds.some(other => other.scheme === id.scheme && other.value === id.value))) return []
    if (typeof source.explicit === "boolean" && typeof track.explicit === "boolean" && source.explicit !== track.explicit) return []
    const title = playlistTitleSimilarity(input(source), input(track))
    if (title < 0.78) return []
    const artist = performerSimilarity(source, track)
    if (artist < 0.78) return []
    const knownDuration = source.duration > 0 && track.duration > 0
    const difference = Math.abs(source.duration - track.duration), relative = difference / Math.max(1, Math.min(source.duration, track.duration))
    if (knownDuration && (difference > 30000 || relative > 0.15)) return []
    const duration = knownDuration ? Math.max(0, 1 - Math.max(0, difference - 2000) / 30000) : 0.35
    const album = source.albumName && track.albumName ? artistNameSimilarity(source.albumName, track.albumName) : 0.5
    const confidence = Math.min(0.99, 0.5 * title + 0.33 * artist + 0.12 * duration + 0.05 * album)
    return confidence >= 0.82 ? [{ track, confidence }] : []
  }).sort((a, b) => b.confidence - a.confidence)
}
export function selectPlaylistCounterpart(source: MusicTrack, candidates: MusicTrack[]) {
  const ranked = rankPlaylistCounterparts(source, candidates), best = ranked[0]
  if (!best) return null
  // Similar catalog duplicates need not block a playlist. Keep search ranking
  // as the tie-breaker and make the uncertainty visible in the saved score.
  const gap = ranked[1] ? best.confidence - ranked[1].confidence : 1
  return { ...best, confidence: Math.round((best.confidence - Math.max(0, 0.04 - gap)) * 100) / 100 }
}
/** Local playlist copies can be joined without provider searches. Strong title,
 * performer and duration agreement is stricter than a search suggestion. */
export function samePlaylistRecording(source: MusicTrack, candidate: MusicTrack) {
  if (!source.duration || !candidate.duration || !source.title || !candidate.title) return false
  const difference = Math.abs(source.duration - candidate.duration)
  if (difference > 3000 || difference / Math.min(source.duration, candidate.duration) > 0.02 || performerSimilarity(source, candidate) < 0.95) return false
  const input = (track: MusicTrack) => ({ id: track.id, title: track.title, artist: track.artistName, album: track.albumName })
  return playlistTitleSimilarity(input(source), input(candidate)) >= 0.98 && rankPlaylistCounterparts(source, [candidate]).length > 0
}
export type CounterpartResult = { status: "matched"; track: MusicTrack; checkedAt: number; fingerprint: string; confidence?: number } |
  { status: "missing" | "ambiguous" | "failed"; checkedAt: number; message: string }
export function counterpartFailure(failure: unknown): CounterpartResult {
  return { status: "failed", checkedAt: Date.now(), message: failure instanceof Error ? failure.message :
    typeof failure === "string" ? failure : "Song lookup failed. Retry matching." }
}
export function counterpartDeferred(result: CounterpartResult) {
  return result.status === "failed" && /YouTube Music (?:is rate limited|request queue is busy)\.|Background queue is (?:busy|unavailable)\./.test(result.message)
}
export function counterpartAttempt(result: CounterpartResult): MixedOccurrence["match"] {
  return { status: counterpartDeferred(result) ? "pending" : result.status, policy: COUNTERPART_POLICY,
    checkedAt: counterpartDeferred(result) ? undefined : result.checkedAt, message: result.status === "matched" ? undefined : result.message,
    confidence: result.status === "matched" ? result.confidence : undefined }
}
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
  // Group lookup work without changing the saved playlist's occurrence order.
  const groups = new Map<string, MixedOccurrence[]>()
  for (const row of playlist.items) {
    const source = row.songs[row.original]?.track
    const key = target === "ytmusic" && source ? artistNameKey(itemArtistCredits(source)[0]?.name ?? "") : row.id
    const group = groups.get(key)
    if (group) group.push(row)
    else groups.set(key, [row])
  }
  for (const queued of [...groups.values()].flat()) {
    if (!options.current() || completed >= (options.limit ?? 20)) break
    // A concurrent sync may have adopted a remote edit at the last checkpoint.
    const row = saved.items.find(item => item.id === queued.id)
    if (!row) continue
    if ((row.songs[target] && !row.songs[target]?.stale) || (!options.retry && !counterpartPending(row, target))) continue
    const source = row.songs[row.original]?.track
    if (!source) continue
    if (options.eligible && !options.eligible(source)) continue
    const fingerprint = recordingFingerprint(source)
    let result = resolved.get(fingerprint)
    if (!result) {
      try { result = await options.resolve(source) } catch (failure) { result = counterpartFailure(failure) }
      resolved.set(fingerprint, result)
    }
    if (!options.current()) break
    saved = await options.save({ ...saved, items: saved.items.map(item => item.id !== row.id ? item : {
      ...item, songs: result.status === "matched" ? { ...item.songs, [target]: verifiedSongReference(result.track, item.songs[target]) } : item.songs,
      remote: result.status === "matched" && item.songs[target]?.stale && item.songs[target]?.track.id !== result.track.id
        ? { ...item.remote, [target]: undefined } : item.remote,
      match: counterpartAttempt(result),
    }) })
    completed++
    // Throttling is not evidence that the remaining songs are unavailable.
    if (counterpartDeferred(result)) break
  }
  return { playlist: saved, completed }
}
