import type { MusicTrack } from "../types/music"
import type { MusicProvider } from "../providers/types"
import { shuffled, type PagedTrackSource } from "./pagedPlayback"

function hashString(str: string): number {
  let hash = 5381
  for (let i = 0; i < str.length; i++)
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0
  return hash >>> 0
}

function mulberry32(seed: number): () => number {
  let s = seed | 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function shuffleTracks(
  tracks: MusicTrack[],
  seed: string
): MusicTrack[] {
  return shuffled(tracks, mulberry32(hashString(seed)))
}

/** Legacy full-list providers share one order for unchanged membership. */
export function orderMixTracks(tracks: MusicTrack[]): MusicTrack[] {
  const identity = (track: MusicTrack) =>
    JSON.stringify([track.id, track.playlistItemId ?? null])
  const members = tracks
    .map((track) => ({ track, key: identity(track) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return shuffleTracks(
    members.map((member) => member.track),
    JSON.stringify(members.map((member) => member.key))
  )
}

/** Capture the snapshot's complete stable membership inside the player fence. */
export function mixPlaybackSource(
  provider: MusicProvider,
  path: string,
  total?: number
): PagedTrackSource {
  const key = `mix:${path}`
  return {
    key,
    total,
    prepare: async () => {
      if (!provider.getCachedTrackSource) return null
      const snapshot = await provider.getCachedTrackSource(key)
      if (!snapshot) throw Error("This mix changed while loading. Try again.")
      return snapshot
    },
    loadPage: (offset, limit) =>
      provider.getMixTracksPage!(path, offset, limit),
  }
}
