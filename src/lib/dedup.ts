/**
 * Album deduplication and quality scoring utilities.
 *
 * Plex can store multiple copies of the same album (e.g., FLAC + MP3 rips,
 * or the same release scanned from two library locations). This module merges
 * them into a single entry and provides quality scoring so the best media
 * version is selected for playback.
 */

import type { MusicAlbum, MusicItem, MusicHub } from "../types/music"
import type { Media } from "../backends/plex/types"

// ---------------------------------------------------------------------------
// Title normalisation
// ---------------------------------------------------------------------------

function normalizeTitle(title: string): string {
  return title.toLowerCase().trim().replace(/\s+/g, " ")
}

// ---------------------------------------------------------------------------
// Album grouping / deduplication
// ---------------------------------------------------------------------------

type AlbumGroup = { key: string; albums: MusicAlbum[] }

/**
 * Split albums into sub-groups where track counts are close enough to be
 * the same release (e.g. a 10-track and 11-track version are likely the same
 * album, but a 10-track album and a 1-track single are not).
 *
 * Two albums merge if |countA - countB| <= max(2, 0.3 * min(countA, countB)).
 * This allows small differences (bonus tracks, regional variants) while
 * keeping genuinely different releases apart (album vs single).
 *
 */
function splitByTrackCount(albums: MusicAlbum[]): MusicAlbum[][] {
  const sorted = [...albums].sort((a, b) => a.trackCount - b.trackCount)
  const subGroups: MusicAlbum[][] = [[sorted[0]]]
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].trackCount
    const curr = sorted[i].trackCount
    const threshold = Math.max(2, Math.floor(0.3 * Math.min(prev, curr)))
    if (curr - prev <= threshold) {
      subGroups[subGroups.length - 1].push(sorted[i])
    } else {
      subGroups.push([sorted[i]])
    }
  }
  return subGroups
}

/**
 * Multi-tier album deduplication.
 *
 * Tier 1 — GUID:  group albums sharing the same non-null `guid`.
 * Tier 2 — Title+Year+Artist:  normalised exact match (year must be > 0).
 * Tier 3 — Title+Artist:  normalised exact match when year is unknown (0).
 *
 * Within each group the album with the highest `trackCount` is kept as the
 * primary entry; all other IDs are stored in `_alternateIds`.
 */
export function deduplicateAlbums(albums: MusicAlbum[]): MusicAlbum[] {
  // First: classic ID-dedup (handles exact API duplicates)
  const seen = new Set<string>()
  const unique: MusicAlbum[] = []
  for (const a of albums) {
    if (seen.has(a.id)) continue
    seen.add(a.id)
    unique.push(a)
  }

  const groups: AlbumGroup[] = []
  const guidMap = new Map<string, AlbumGroup>()
  const titleMap = new Map<string, AlbumGroup>()
  const assigned = new Set<string>() // album.id → already in a group

  // Tier 1: group by guid
  for (const album of unique) {
    if (!album.guid) continue
    let group = guidMap.get(album.guid)
    if (!group) {
      group = { key: album.guid, albums: [] }
      guidMap.set(album.guid, group)
      groups.push(group)
    }
    group.albums.push(album)
    assigned.add(album.id)
  }

  // Tier 2 + 3: group by title+year+artist (or title+artist if year=0)
  for (const album of unique) {
    if (assigned.has(album.id)) continue
    const norm = normalizeTitle(album.title)
    const artist = normalizeTitle(album.artistName)
    const key = album.year > 0
      ? `${norm}|${album.year}|${artist}`
      : `${norm}||${artist}`

    let group = titleMap.get(key)
    if (!group) {
      group = { key, albums: [] }
      titleMap.set(key, group)
      groups.push(group)
    }
    group.albums.push(album)
    assigned.add(album.id)
  }

  // Merge each group → single album with _alternateIds.
  // Within a group, split into sub-groups by track-count similarity so that
  // e.g. a 10-track album and a 1-track single with the same title stay separate.
  const result: MusicAlbum[] = []
  for (const group of groups) {
    if (group.albums.length === 1) {
      result.push(group.albums[0])
      continue
    }
    for (const sub of splitByTrackCount(group.albums)) {
      if (sub.length === 1) {
        result.push(sub[0])
        continue
      }
      const sorted = [...sub].sort((a, b) => b.trackCount - a.trackCount)
      const primary = sorted[0]
      const alternateIds = sorted.slice(1).map(a => a.id)
      result.push({ ...primary, _alternateIds: alternateIds })
    }
  }

  return result
}

/**
 * Deduplicate album items within a MusicHub's items array.
 * Non-album items are passed through unchanged.
 */
export function deduplicateHubAlbums(hub: MusicHub): MusicHub {
  const albumItems: (MusicAlbum & { type: "album" })[] = []
  const otherItems: MusicItem[] = []
  for (const item of hub.items) {
    if (item.type === "album") albumItems.push(item)
    else otherItems.push(item)
  }
  if (albumItems.length <= 1) return hub
  const deduped = deduplicateAlbums(albumItems)
  return {
    ...hub,
    items: [
      ...deduped.map(a => ({ ...a, type: "album" as const })),
      ...otherItems,
    ],
  }
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
  deduplicate: boolean,
): { albums: MusicAlbum[]; singles: MusicAlbum[] } {
  // IDs that came from the singles/EP-filtered endpoint
  const singleIds = new Set(singleList.map(s => s.id))

  // Separate: remove singles from all-albums to get pure albums
  const albumsOnly = allAlbums.filter(a => !singleIds.has(a.id))

  if (!deduplicate) {
    // Simple ID-dedup only
    const idDedup = <T extends { id: string }>(items: T[]): T[] => {
      const seen = new Set<string>()
      return items.filter(item => {
        if (seen.has(item.id)) return false
        seen.add(item.id)
        return true
      })
    }
    return { albums: idDedup(albumsOnly), singles: idDedup(singleList) }
  }

  return {
    albums: deduplicateAlbums(albumsOnly),
    singles: deduplicateAlbums(singleList),
  }
}

// ---------------------------------------------------------------------------
// Media quality scoring
// ---------------------------------------------------------------------------

const LOSSLESS_CODECS = new Set(["flac", "alac", "wav", "aiff", "dsd"])

/**
 * Score a Plex Media entry for quality comparison.
 * Higher = better quality.
 */
export function scoreMedia(media: Media): number {
  const codec = (media.audio_codec ?? "").toLowerCase()
  const stream = media.parts?.[0]?.streams?.find(s => s.stream_type === 2)

  const isLossless = LOSSLESS_CODECS.has(codec) ||
    (stream?.codec ? LOSSLESS_CODECS.has(stream.codec.toLowerCase()) : false)

  const bitDepth = stream?.bit_depth ?? 16
  const samplingRate = stream?.sampling_rate ?? 44100
  const bitrate = stream?.bitrate ?? media.bitrate ?? 0

  let score = 0
  if (isLossless) score += 10_000
  score += bitDepth * 100        // 24-bit = 2400, 16-bit = 1600
  score += samplingRate / 100    // 96kHz = 960, 44.1kHz = 441
  score += bitrate               // 320kbps = 320 (mostly for lossy tiebreak)
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
  for (let i = 0; i < mediaList.length; i++) {
    const s = scoreMedia(mediaList[i])
    if (s > bestScore) {
      bestScore = s
      bestIdx = i
    }
  }
  return bestIdx
}
