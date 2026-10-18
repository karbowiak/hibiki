import type { MusicItem, MusicTrack } from "../types/music"
import { artistNameSimilarity, ARTIST_NAME_THRESHOLD } from "./artistMatching"
import { playlistCandidateScore } from "../playlistSync/matching"
import { itemArtistCredits, itemArtistCreditsKey } from "./artistCredits"

export const releaseNameKey = (title: string) => title.normalize("NFKC").toLowerCase().trim()
  .replace(/[‘’]/g, "'").replace(/\s+-\s+(single|ep)$/, "").replace(/\s+/g, " ")

/** Version/featured-credit/duration checks are shared with playlist matching. */
export function sameRecording(left: MusicTrack, right: MusicTrack) {
  if (typeof left.explicit === "boolean" && typeof right.explicit === "boolean" && left.explicit !== right.explicit) return false
  const source = { id: left.id, title: left.title, artist: itemArtistCreditsKey(left), album: left.albumName, durationMs: left.duration }
  const candidate = { id: right.id, title: right.title, artist: itemArtistCreditsKey(right), album: right.albumName, durationMs: right.duration }
  if (playlistCandidateScore(source, candidate) > 0.95) return true
  const credits = itemArtistCredits(left), others = itemArtistCredits(right)
  const used = new Set<number>()
  const sameArtists = credits.length === others.length && credits.length > 0 && credits.every(credit => {
    const index = others.findIndex((other, index) => !used.has(index) && artistNameSimilarity(credit.name, other.name) >= ARTIST_NAME_THRESHOLD)
    if (index < 0) return false
    used.add(index)
    return true
  })
  return sameArtists &&
    playlistCandidateScore(source, { ...candidate, artist: source.artist }) > 0.95
}

export function sameMusicItem(left: MusicItem, right: MusicItem) {
  if (left.type !== right.type) return false
  if (left.type === "artist" && right.type === "artist") return artistNameSimilarity(left.title, right.title) >= ARTIST_NAME_THRESHOLD
  if (left.type === "track" && right.type === "track") return sameRecording(left, right)
  if (left.type === "album" && right.type === "album") return releaseNameKey(left.title) === releaseNameKey(right.title) &&
    artistNameSimilarity(left.artistName, right.artistName) >= ARTIST_NAME_THRESHOLD && (!left.year || !right.year || left.year === right.year)
  return false
}

/** Keep provider relevance within each group and Plex editions on duplicates. */
export function mergeMusicSearchResults(plex: MusicItem[], youtube: MusicItem[], associations?: ReadonlyMap<string, string | null>) {
  const result: MusicItem[] = [], seen = new Set<string>()
  for (const type of ["artist", "album", "track", "playlist"] as const) {
    const local = plex.filter(item => item.type === type)
    const remote = youtube.filter(item => {
      if (item.type !== type || seen.has(item.id) || (associations?.has(item.id)
        ? local.some(known => known.id === associations.get(item.id)) : local.some(known => sameMusicItem(known, item)))) return false
      seen.add(item.id); return true
    })
    for (let i = 0; i < Math.max(local.length, remote.length); i++) {
      if (local[i]) result.push(local[i])
      if (remote[i]) result.push(remote[i])
    }
  }
  return result
}

/** Add missing recordings at YTM's album positions while retaining Plex order. */
export function supplementAlbumTracks(plex: MusicTrack[], youtube: MusicTrack[], associations?: ReadonlyMap<string, string | null>) {
  const related = (local: MusicTrack, remote: MusicTrack) => associations?.has(remote.id)
    ? associations.get(remote.id) === local.id : sameRecording(local, remote)
  const matches = youtube.map(remote => {
    const candidates = plex.filter(local => related(local, remote))
    return candidates.length === 1 ? candidates[0] : null
  })
  const result = [...plex]
  const inserted = new Set<string>()
  for (let index = 0; index < youtube.length; index++) {
    if (matches[index] || inserted.has(youtube[index].id)) continue
    // Ambiguous Plex recordings remain the authoritative local rows.
    if (plex.some(local => related(local, youtube[index]))) continue
    inserted.add(youtube[index].id)
    const next = matches.slice(index + 1).find(Boolean)
    const position = next ? result.findIndex(track => track.id === next.id) : result.length
    result.splice(position < 0 ? result.length : position, 0, youtube[index])
  }
  return result
}
