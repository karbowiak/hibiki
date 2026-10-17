import type { MusicTrack } from "../types/music"
import { isYoutubeMusicTrack } from "../backends/ytmusic/tracks"
import { sameRecording } from "./musicMatching"

export type MusicRadioMode = "plex" | "ytmusic" | "mixed"
export type MusicRadioSource = Exclude<MusicRadioMode, "mixed">
export type MusicRadioSeedType = "track" | "artist" | "album" | "playlist"
export const RADIO_UPCOMING = 10
export interface RadioSource {
  load(): Promise<MusicTrack[]>
}
export const radioTrackSource = (track: MusicTrack): MusicRadioSource => isYoutubeMusicTrack(track) ? "ytmusic" : "plex"
const duplicates = (track: MusicTrack, known: Iterable<MusicTrack>) => {
  for (const item of known) if (track.id === item.id || sameRecording(track, item)) return true
  return false
}

export function radioDeficits(mode: MusicRadioMode, upcoming: MusicTrack[]) {
  const counts = { plex: 0, ytmusic: 0 }
  upcoming.forEach(track => { counts[radioTrackSource(track)]++ })
  return {
    plex: Math.max(0, (mode === "mixed" ? 5 : mode === "plex" ? RADIO_UPCOMING : 0) - counts.plex),
    ytmusic: Math.max(0, (mode === "mixed" ? 5 : mode === "ytmusic" ? RADIO_UPCOMING : 0) - counts.ytmusic),
  }
}

/** Preserve each service's order while keeping a balanced, alternating window. */
export function orderRadioUpcoming(mode: MusicRadioMode, tracks: MusicTrack[], current: MusicTrack | null) {
  const limits = radioDeficits(mode, [])
  const pools: Record<MusicRadioSource, MusicTrack[]> = { plex: [], ytmusic: [] }
  for (const track of tracks) {
    const source = radioTrackSource(track)
    if (pools[source].length < limits[source]) pools[source].push(track)
  }
  const result: MusicTrack[] = []
  let next: MusicRadioSource = current && radioTrackSource(current) === "plex" ? "ytmusic" : "plex"
  while (result.length < RADIO_UPCOMING && (pools.plex.length || pools.ytmusic.length)) {
    const source = pools[next].length ? next : next === "plex" ? "ytmusic" : "plex"
    result.push(pools[source].shift()!)
    next = source === "plex" ? "ytmusic" : "plex"
  }
  return result
}

/** Small recommendation buffers, with a strict limit on published upcoming songs. */
export class MusicRadioSession {
  private pools: Record<MusicRadioSource, MusicTrack[]> = { plex: [], ytmusic: [] }
  private seen = new Map<string, MusicTrack>()
  private failures: Partial<Record<MusicRadioSource, { until: number; message: string }>> = {}
  private revisions = { plex: 0, ytmusic: 0 }
  private retired = false
  constructor(readonly mode: MusicRadioMode, private sources: Partial<Record<MusicRadioSource, RadioSource>>,
    private owns: () => boolean = () => true) {}

  retire() { this.retired = true; this.pools = { plex: [], ytmusic: [] } }
  current() { return !this.retired && this.owns() }
  retry() { this.failures = {} }
  resetSource(source: MusicRadioSource) {
    this.revisions[source]++
    this.pools[source] = []
    delete this.failures[source]
  }
  get error() { return Object.values(this.failures).map(failure => failure.message).join(" ") || null }
  canRefill(upcoming: MusicTrack[]) {
    const needed = radioDeficits(this.mode, upcoming)
    return (["plex", "ytmusic"] as const).some(source => needed[source] && this.sources[source] &&
      (this.pools[source].some(track => !duplicates(track, this.seen.values())) ||
        (this.failures[source]?.until ?? 0) <= Date.now()))
  }
  remember(tracks: MusicTrack[]) {
    tracks.forEach(track => { this.seen.delete(track.id); this.seen.set(track.id, track) })
    while (this.seen.size > 200) this.seen.delete(this.seen.keys().next().value!)
  }

  async fill(upcoming: MusicTrack[], current: MusicTrack | null) {
    if (!this.current()) return
    this.remember(current ? [current, ...upcoming] : upcoming)
    const needed = radioDeficits(this.mode, upcoming)
    await Promise.allSettled((["plex", "ytmusic"] as const).map(async source => {
      if (!needed[source] || !this.sources[source]) return
      // Selection removes seen recordings lazily, so ordinary skips do not
      // repeatedly compare every buffered track against the entire history.
      if (this.pools[source].length >= needed[source] || (this.failures[source]?.until ?? 0) > Date.now()) return
      const revision = this.revisions[source]
      try {
        const tracks = await this.sources[source]!.load()
        if (!this.current() || revision !== this.revisions[source]) return
        let added = 0
        for (const track of tracks) {
          if (radioTrackSource(track) !== source || duplicates(track, this.seen.values()) || duplicates(track, this.pools[source])) continue
          this.pools[source].push(track); added++
          if (this.pools[source].length >= 60) break
        }
        if (!added && !this.pools[source].length) throw Error("No new recommendations")
        delete this.failures[source]
      } catch {
        if (this.current() && revision === this.revisions[source]) this.failures[source] = { until: Date.now() + 30_000,
          message: `${source === "plex" ? "Plex" : "YTM"} radio could not load more songs. Retry or reconnect the service.` }
      }
    }))
  }

  take(upcoming: MusicTrack[], current: MusicTrack | null) {
    if (!this.current()) return []
    const needed = radioDeficits(this.mode, upcoming), result: MusicTrack[] = []
    const last = upcoming.at(-1) ?? current
    let next: MusicRadioSource = last && radioTrackSource(last) === "plex" ? "ytmusic" : "plex"
    const pick = (source: MusicRadioSource) => {
      while (needed[source] && this.pools[source].length) {
        const track = this.pools[source].shift()!
        if (duplicates(track, this.seen.values())) continue
        needed[source]--; result.push(track); this.remember([track]); return true
      }
      return false
    }
    while (upcoming.length + result.length < RADIO_UPCOMING && (needed.plex || needed.ytmusic)) {
      const other = next === "plex" ? "ytmusic" : "plex"
      if (pick(next)) next = other
      else if (!pick(other)) break
    }
    return result
  }
}
