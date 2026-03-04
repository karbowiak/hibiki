/**
 * Generic music types — provider-agnostic.
 *
 * All IDs are strings (Plex uses numbers, other backends may use UUIDs).
 * Image URLs are resolved by the provider during mapping — consumers only
 * ever see ready-to-use URLs (image:// or https://).
 */

/** Extended audio/media details that list endpoints may not include. */
export interface MediaInfo {
  container?: string | null
  fileSize?: number | null
  audioStreamId?: number | null
  hasAudioStream?: boolean
}

/** An editorial or critic review attached to an album. */
export interface AlbumReview {
  tag?: string | null
  text?: string | null
  source?: string | null
  image?: string | null
  link?: string | null
}

export interface MusicTrack {
  id: string
  title: string
  trackNumber: number
  duration: number // ms
  albumId: string | null
  albumName: string
  albumYear: number | null
  artistId: string | null
  artistName: string
  year: number
  playCount: number
  thumbUrl: string | null
  albumThumbUrl: string | null
  artistThumbUrl: string | null
  summary: string | null
  userRating: number | null // 0–10 scale
  addedAt: string | null // ISO 8601
  lastPlayedAt: string | null
  guid: string | null
  codec: string | null
  bitrate: number | null
  channels: number | null
  bitDepth: number | null
  samplingRate: number | null
  streamUrl: string | null
  gain: number | null
  albumGain: number | null
  peak: number | null
  loudness: number | null
  originalTitle?: string | null
  ratingCount?: number | null
  parentStudio?: string | null
  lastRatedAt?: string | null
  providerKey?: string | null
  rawThumbPath?: string | null
  mediaInfo?: MediaInfo | null
  /** Opaque provider-specific data (e.g. full Plex Track object). */
  _providerData?: unknown
}

export interface MusicAlbum {
  id: string
  title: string
  artistId: string | null
  artistName: string
  year: number
  trackCount: number
  studio: string | null
  thumbUrl: string | null
  artistThumbUrl: string | null
  summary: string | null
  userRating: number | null
  addedAt: string | null
  guid: string | null
  genres: string[]
  styles: string[]
  moods: string[]
  labels: string[]
  format: string | null // "Single", "EP", etc.
  providerKey?: string | null
  reviews?: AlbumReview[]
  /** IDs of duplicate albums merged into this one (for deduplication). */
  _alternateIds?: string[]
  /** Opaque provider-specific data. */
  _providerData?: unknown
}

export interface MusicArtist {
  id: string
  title: string
  thumbUrl: string | null
  artUrl: string | null // background art
  summary: string | null
  userRating: number | null
  addedAt: string | null
  guid: string | null
  distance?: number | null
  providerKey?: string | null
  /** Opaque provider-specific data. */
  _providerData?: unknown
}

export interface MusicPlaylist {
  id: string
  title: string
  smart: boolean
  trackCount: number
  duration: number | null
  thumbUrl: string | null
  summary: string | null
  addedAt: string | null
  guid?: string | null
  providerKey?: string | null
  /** Opaque provider-specific data. */
  _providerData?: unknown
}

export type MusicItem =
  | (MusicTrack & { type: "track" })
  | (MusicAlbum & { type: "album" })
  | (MusicArtist & { type: "artist" })
  | (MusicPlaylist & { type: "playlist" })

export interface MusicHub {
  title: string
  identifier: string
  items: MusicItem[]
  style: string | null
}

export interface PagedResult<T> {
  items: T[]
  total: number
}
