import type { MusicTrack } from "../types/music"
import { compareTrackQuality } from "../lib/dedup"
import { playlistSearchTitle } from "../playlistSync/matching"
import { COUNTERPART_POLICY, samePlaylistRecording } from "./matching"
import type { MixedOccurrence, Service } from "./model"

const services: Service[] = ["plex", "ytmusic"]
const titleKey = (track: MusicTrack) => playlistSearchTitle({ id: track.id, title: track.title, artist: track.artistName })
  .normalize("NFKC").toLowerCase().replace(/(?:[([]\s*(?:original(?: mix| version)?|album version)\s*[)\]]|\s+[-–—]\s*(?:original(?: mix| version)?|album version)\s*$)/gu, "").replace(/[^\p{L}\p{N}\p{M}]/gu, "")
const keys = (row: MixedOccurrence) => services.flatMap(side => row.songs[side] && !row.songs[side]?.stale ? [`${side}:${row.songs[side]!.track.id}`] : [])

/** Keep the first occurrence's position and retain both provider references.
 * Title buckets keep the local join bounded; identities and recording versions
 * still decide whether entries belong together, never artist names alone. */
export function deduplicateMergeItems(items: MixedOccurrence[]) {
  const parent = items.map((_, index) => index)
  const root = (index: number): number => parent[index] === index ? index : (parent[index] = root(parent[index]))
  const join = (a: number, b: number) => { a = root(a); b = root(b); parent[Math.max(a, b)] = Math.min(a, b) }
  const identities = new Map<string, number>(), titles = new Map<string, number[]>()
  items.forEach((row, index) => {
    for (const key of keys(row)) {
      const previous = identities.get(key)
      if (previous !== undefined) join(index, previous)
      identities.set(key, index)
    }
    const reference = row.songs[row.original]
    if (!reference || reference.stale) return
    const key = titleKey(reference.track)
    if (!key) return
    const candidates = titles.get(key) ?? []
    for (const previous of candidates) {
      const other = items[previous]
      if (other.original !== row.original && samePlaylistRecording(reference.track, other.songs[other.original]!.track)) join(index, previous)
    }
    candidates.push(index); titles.set(key, candidates)
  })
  if (parent.every((index, position) => index === position)) return items
  const groups = new Map<number, MixedOccurrence>()
  items.forEach((row, index) => {
    const key = root(index), retained = groups.get(key)
    if (!retained) { groups.set(key, row); return }
    const songs = { ...retained.songs }, remote = { ...retained.remote }
    for (const side of services) {
      const candidate = row.songs[side], current = songs[side]
      if (!candidate) continue
      if (!current || (current.stale && !candidate.stale) || (!candidate.stale && !current.stale && compareTrackQuality(candidate.track, current.track) > 0)) {
        songs[side] = candidate
        if (row.remote[side]) remote[side] = row.remote[side]
        else delete remote[side]
      } else if (candidate.track.id === current.track.id && !remote[side] && row.remote[side]) remote[side] = row.remote[side]
    }
    groups.set(key, { ...retained, songs, remote,
      match: services.every(side => songs[side] && !songs[side]?.stale) ? { status: "matched", policy: COUNTERPART_POLICY, checkedAt: Date.now(), confidence: 0.99 } : retained.match })
  })
  return [...groups.values()]
}
