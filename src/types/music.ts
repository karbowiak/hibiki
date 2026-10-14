/**
 * Generic music types — provider-agnostic.
 *
 * All IDs are strings (Plex uses numbers, other backends may use UUIDs).
 * Image URLs are resolved by the provider during mapping — consumers only
 * ever see ready-to-use URLs (image:// or https://).
 */

/** Read-only media version summary; never includes file paths or playback URLs. */
export interface MusicMediaVersion {
  mediaId: string | null
  partId: string | null
  versionNumber: number
  codec: string | null
  container: string | null
  bitrate: number | null
  channels: number | null
  bitDepth: number | null
  samplingRate: number | null
  duration: number | null
  fileSize: number | null
  partCount: number
  selected: boolean
}

/** Extended audio/media details that list endpoints may not include. */
export interface MediaInfo {
  /** A local-audio selection must not request playback, gain or waveform from Plex. */
  localAudio?: boolean
  /** Complete native cache/download exists; false disables offline play actions. */
  offlineAvailable?: boolean
  /** This item came from a full metadata request, including unavailable ramps. */
  metadataComplete?: boolean
  versions?: MusicMediaVersion[]
  versionsTruncated?: boolean
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
  discNumber?: number
  /** Physical album aliases, used only with explicit album playback intent. */
  _albumGroupIds?: string[]
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
  /** Local favorites love time; independent of Plex library/rating dates. */
  likedAt?: string | null
  providerKey?: string | null
  rawThumbPath?: string | null
  startRamp?: string | null
  endRamp?: string | null
  mediaInfo?: MediaInfo | null
  /** Playlist-specific item ID (for remove-from-playlist). Only present on playlist item responses. */
  playlistItemId?: string | null
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
  artUrl?: string | null // Plex background art, separate from the album poster
  artistThumbUrl: string | null
  summary: string | null
  userRating: number | null
  addedAt: string | null
  releaseDate?: string | null // originally released, YYYY-MM-DD
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
  /** Native complete-file evidence for offline collection play controls. */
  offlineAvailable?: boolean
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
  /** Native complete-file evidence for offline collection play controls. */
  offlineAvailable?: boolean
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
  /** Native complete-file evidence for offline collection play controls. */
  offlineAvailable?: boolean
  /** Opaque provider-specific data. */
  _providerData?: unknown
}

export type MusicItem =
  | (MusicTrack & { type: "track" })
  | (MusicAlbum & { type: "album" })
  | (MusicArtist & { type: "artist" })
  | (MusicPlaylist & { type: "playlist" })

export type HubLayout = "scroller" | "list" | "hero" | "pills"

export interface MusicHub {
  title: string
  identifier: string
  items: MusicItem[]
  style: string | null
  layout: HubLayout
}

export interface PagedResult<T> {
  /** Local partial scan; total counts saved rows and serverTotal is separately reported. */
  localCoverageComplete?: boolean
  serverTotal?: number | null
  items: T[]
  total: number
  /** Server-reported start index, when provided; never inferred from the request. */
  offset?: number
}
