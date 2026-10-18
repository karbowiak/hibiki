import type { MusicProvider } from "../providers/types"
import type { MusicTrack } from "../types/music"
import { indexedRecordingMatches } from "../matching/evidence"
import { counterpartCandidates } from "./matching"
import type { MixedPlaylist, RemotePlaylist } from "./model"

/** Library removal/rematching is not a user instruction to delete an occurrence
 * from its other services. Keep the intended recording until explicitly rematched. */
export async function verifyPlaylistIdentity(playlist: MixedPlaylist, options: {
  provider: MusicProvider | null
  current: () => boolean
  snapshots?: RemotePlaylist[]
  ids?: Set<string>
}) {
  const provider = options.provider
  if (!provider || playlist.owners.plex !== provider.cacheScope || provider.isOffline) return playlist
  const expected = new Map<string, MusicTrack[]>()
  for (const row of playlist.items) {
    const track = row.songs.plex?.track
    if (track && (!options.ids || options.ids.has(track.id))) {
      const retained = expected.get(track.id)
      if (retained) retained.push(track); else expected.set(track.id, [track])
    }
  }
  const invalid = new Map<string, MusicTrack | undefined>()
  const owns = () => { if (!options.current()) throw Error("Music accounts changed while verifying saved recordings.") }
  if (provider.matchingRows) {
    const ids = [...expected.keys()].filter(id => /^\d+$/.test(id)).map(Number)
    for (let index = 0; index < ids.length; index += 64) {
      const rows = await provider.matchingRows("track", ids.slice(index, index + 64)); owns()
      for (const entry of rows) {
        const tracks = expected.get(String(entry.id))
        if (tracks && (entry.state === "removed" || entry.row && tracks.some(track => !indexedRecordingMatches(track, entry.row!)))) invalid.set(String(entry.id), undefined)
      }
    }
  }
  const snapshot = options.snapshots?.find(item => item.service === "plex")
  if (snapshot) {
    const present = new Map(snapshot.items.map(item => [item.track.id, item.track]))
    for (const [id, tracks] of expected) {
      const actual = present.get(id)
      if (actual && tracks.some(track => counterpartCandidates(track, [actual]).length !== 1)) invalid.set(id, actual)
    }
    // Only verify library absence for membership that actually disappeared from
    // the remote playlist. Existing membership already supplied fresh metadata.
    const absent = [...new Set(playlist.baseline.plex?.items.map(item => item.track.id) ?? [])]
      .filter(id => expected.has(id) && !present.has(id) && !invalid.has(id))
    let cursor = 0
    await Promise.all(Array.from({ length: Math.min(2, absent.length) }, async () => {
      while (cursor < absent.length) {
        owns()
        const id = absent[cursor++], tracks = expected.get(id)!
        try {
          const actual = await provider.getTrack(id); owns()
          if (actual.id !== id || tracks.some(track => counterpartCandidates(track, [actual]).length !== 1)) invalid.set(id, actual)
        } catch { owns(); invalid.set(id, undefined) }
      }
    }))
  }
  owns()
  if (!invalid.size) return playlist
  let changed = false
  const items = playlist.items.map(row => {
    const before = row.songs.plex
    if (!before || !invalid.has(before.track.id)) return row
    const actual = invalid.get(before.track.id)
    const observed = actual ? { title: actual.title, artistName: actual.artistName, albumName: actual.albumName, duration: actual.duration } : before.observed
    if (before.stale && JSON.stringify(observed) === JSON.stringify(before.observed)) return row
    changed = true
    return { ...row, songs: { ...row.songs, plex: { ...before, stale: true, ...(observed ? { observed } : {}) } },
      match: { status: "failed" as const, message: "The original Plex recording needs matching again." } }
  })
  if (!changed) return playlist
  return { ...playlist, status: "error" as const, message: "A saved Plex recording changed or became unavailable. Original songs and playlist positions are retained.",
    items }
}
