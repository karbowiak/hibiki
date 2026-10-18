/**
 * Album deduplication and quality scoring utilities.
 *
 * Plex can store multiple copies of the same album (e.g., FLAC + MP3 rips,
 * or the same release scanned from two library locations). This module merges
 * them into a single entry and provides quality scoring so the best media
 * version is selected for playback.
 */

import type {
  MusicAlbum,
  MusicItem,
  MusicHub,
  MusicTrack,
} from "../types/music"
import type { Media } from "../backends/plex/types"

// ---------------------------------------------------------------------------
// Title normalisation
// ---------------------------------------------------------------------------

function normalizeTitle(title: string): string {
  return typeof title === "string"
    ? title.toLowerCase().trim().replace(/\s+/g, " ")
    : ""
}

// ---------------------------------------------------------------------------
// Album grouping / deduplication
// ---------------------------------------------------------------------------

/** Group a release independently of how many of its files Plex found. */
export function deduplicateAlbums(albums: MusicAlbum[]): MusicAlbum[] {
  const unique = [...new Map(albums.map((album) => [album.id, album])).values()]
  const groups: MusicAlbum[][] = []
  const keys = new Map<string, MusicAlbum[]>()
  for (const album of unique) {
    const artist = normalizeTitle(album.artistName)
    // Never combine generic titles from unrelated artists, or unknown artists.
    const identity = album.artistId || artist || `unknown:${album.id}`
    const title = normalizeTitle(album.title)
    const titleKey = title
      ? `title:${identity}|${title}|${album.year > 0 ? album.year : ""}`
      : `id:${album.id}`
    const guidKey = album.guid ? `guid:${identity}|${album.guid}` : null
    const matches = [
      ...new Set(
        [keys.get(titleKey), guidKey ? keys.get(guidKey) : undefined].filter(
          (group): group is MusicAlbum[] => !!group
        )
      ),
    ]
    const group = matches[0] ?? []
    if (!matches.length) groups.push(group)
    for (const other of matches.slice(1)) {
      group.push(...other)
      groups.splice(groups.indexOf(other), 1)
      for (const [key, existing] of keys)
        if (existing === other) keys.set(key, group)
    }
    group.push(album)
    keys.set(titleKey, group)
    if (guidKey) keys.set(guidKey, group)
  }
  return groups.map((group) => {
    if (group.length === 1) return group[0]
    const sorted = [...group].sort(
      (a, b) =>
        b.trackCount - a.trackCount ||
        a.id.localeCompare(b.id, undefined, { numeric: true })
    )
    const primary = sorted[0]
    const aliases = new Set(
      sorted.flatMap((album) => [album.id, ...(album._alternateIds ?? [])])
    )
    aliases.delete(primary.id)
    return { ...primary, _alternateIds: [...aliases] }
  })
}

/** Keep distinct disc/track positions; choose the best playable copy of a song. */
export function mergeAlbumTracks(
  tracks: MusicTrack[],
  albumIds: string[],
  offline = false
): MusicTrack[] {
  const groups = new Map<string, MusicTrack>()
  const better = (a: MusicTrack, b: MusicTrack) => {
    const comparison = compareTrackQuality(a, b, offline)
    if (comparison) return comparison > 0
    return a.id.localeCompare(b.id, undefined, { numeric: true }) < 0
  }
  for (const track of tracks) {
    const disc = track.discNumber ?? 1
    const title = normalizeTitle(track.title)
    const position = track.trackNumber > 0 ? track.trackNumber : "unknown"
    // A title match must also agree on disc and known track position. Repeated
    // recordings on separate discs/slots and named live/remix versions survive.
    const key = title ? `${disc}|${position}|${title}` : `id:${track.id}`
    const current = groups.get(key)
    if (!current || better(track, current)) groups.set(key, track)
  }
  return [...groups.values()]
    .sort(
      (a, b) =>
        (a.discNumber ?? 1) - (b.discNumber ?? 1) ||
        (a.trackNumber || Number.MAX_SAFE_INTEGER) -
          (b.trackNumber || Number.MAX_SAFE_INTEGER) ||
        a.title.localeCompare(b.title)
    )
    .map((track) => ({ ...track, _albumGroupIds: [...albumIds] }))
}

/**
 * Deduplicate album items within a MusicHub's items array.
 * Non-album items are passed through unchanged.
 */
export function deduplicateAlbumItems(items: MusicItem[]): MusicItem[] {
  const albums = deduplicateAlbums(
    items.filter(
      (item): item is MusicAlbum & { type: "album" } => item.type === "album"
    )
  )
  const byId = new Map<string, MusicAlbum>()
  for (const album of albums)
    for (const id of [album.id, ...(album._alternateIds ?? [])])
      byId.set(id, album)
  const emitted = new Set<string>()
  return items.flatMap<MusicItem>((item) => {
    if (item.type !== "album") return [item]
    const album = byId.get(item.id)!
    if (emitted.has(album.id)) return []
    emitted.add(album.id)
    return [{ ...album, type: "album" as const }]
  })
}
export function deduplicateHubAlbums(hub: MusicHub): MusicHub {
  return { ...hub, items: deduplicateAlbumItems(hub.items) }
}

/**
 * Collect all IDs (primary + alternates) from a set of deduplicated albums.
 */
export function collectAllIds(albums: MusicAlbum[]): Set<string> {
  const ids = new Set<string>()
  for (const a of albums) {
    ids.add(a.id)
    if (a._alternateIds) {
      for (const alt of a._alternateIds) ids.add(alt)
    }
  }
  return ids
}

// ---------------------------------------------------------------------------
// Shared artist-album processing
// ---------------------------------------------------------------------------

/**
 * Single source of truth for splitting raw API responses into albums vs singles.
 *
 * Takes the two raw API lists (all albums + singles-filtered) and returns
 * cleanly separated, optionally deduplicated arrays. Both Artist.tsx and
 * the prefetch cache must use this to stay consistent.
 *
 * Flow:
 *   1. Use the singles list to determine which IDs are singles.
 *   2. Remove those IDs from the all-albums list → pure albums.
 *   3. Optionally deduplicate each partition independently.
 */
export function processArtistAlbums(
  allAlbums: MusicAlbum[],
  singleList: MusicAlbum[],
  deduplicate: boolean
): { albums: MusicAlbum[]; singles: MusicAlbum[] } {
  // IDs that came from the singles/EP-filtered endpoint
  const singleIds = new Set(singleList.map((s) => s.id))

  // Separate: remove singles from all-albums to get pure albums
  const albumsOnly = allAlbums.filter((a) => !singleIds.has(a.id))

  if (!deduplicate) {
    // Simple ID-dedup only
    const idDedup = <T extends { id: string }>(items: T[]): T[] => {
      const seen = new Set<string>()
      return items.filter((item) => {
        if (seen.has(item.id)) return false
        seen.add(item.id)
        return true
      })
    }
    return { albums: idDedup(albumsOnly), singles: idDedup(singleList) }
  }

  const merged = deduplicateAlbums([...allAlbums, ...singleList])
  const isSingle = (album: MusicAlbum) =>
    [album.id, ...(album._alternateIds ?? [])].every((id) => singleIds.has(id))
  return {
    albums: merged.filter((album) => !isSingle(album)),
    singles: merged.filter(isSingle),
  }
}

// ---------------------------------------------------------------------------
// Media quality scoring
// ---------------------------------------------------------------------------

const LOSSLESS_CODECS = new Set(["flac", "alac", "wav", "aiff", "dsd"])

/** Compare available audio first, then known lossless resolution and bitrate.
 * Unknown provider metadata stays unknown; callers choose their tie-breaker. */
export function compareTrackQuality(a: MusicTrack, b: MusicTrack, offline = false) {
  const quality = (track: MusicTrack) => {
    const lossless = LOSSLESS_CODECS.has((track.codec ?? "").toLowerCase())
    return [offline ? Number(!!(track.mediaInfo?.localAudio || track.mediaInfo?.offlineAvailable)) : Number(track.mediaInfo?.hasAudioStream !== false),
      Number(lossless), lossless ? track.bitDepth ?? 16 : 0, lossless ? track.samplingRate ?? 44100 : 0, track.bitrate ?? 0]
      .map(value => Number.isFinite(value) ? value : 0)
  }
  const left = quality(a), right = quality(b)
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return left[i] - right[i]
  return 0
}

/**
 * Score a Plex Media entry for quality comparison.
 * Higher = better quality.
 */
export function scoreMedia(media: Media): number {
  const codec = (media.audio_codec ?? "").toLowerCase()
  const stream = media.parts?.[0]?.streams?.find((s) => s.stream_type === 2)

  const isLossless =
    LOSSLESS_CODECS.has(codec) ||
    (stream?.codec ? LOSSLESS_CODECS.has(stream.codec.toLowerCase()) : false)

  const bitDepth = stream?.bit_depth ?? 16
  const samplingRate = stream?.sampling_rate ?? 44100
  const bitrate = stream?.bitrate ?? media.bitrate ?? 0

  let score = 0
  if (isLossless) score += 10_000
  score += bitDepth * 100 // 24-bit = 2400, 16-bit = 1600
  score += samplingRate / 100 // 96kHz = 960, 44.1kHz = 441
  score += bitrate // 320kbps = 320 (mostly for lossy tiebreak)
  return score
}

/**
 * Pick the best Media entry from a track's media array.
 * Returns the index of the best entry (0 if empty or single).
 */
export function pickBestMediaIndex(mediaList: Media[]): number {
  if (mediaList.length <= 1) return 0
  let bestIdx = 0
  let bestScore = -1
  const hasPlayableMedia = mediaList.some((media) => !!media.parts?.[0]?.key)
  for (let i = 0; i < mediaList.length; i++) {
    if (hasPlayableMedia && !mediaList[i].parts?.[0]?.key) continue
    const s = scoreMedia(mediaList[i])
    if (s > bestScore) {
      bestScore = s
      bestIdx = i
    }
  }
  return bestIdx
}
