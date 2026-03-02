/**
 * TypeScript types mirroring the Rust Plex API models.
 * All field names match what Tauri's JSON serialization produces (snake_case from serde).
 */

/** A media stream (audio=2, video=1, subtitle=3) with Plex loudness analysis data */
export interface PlexStream {
  id: number | null
  stream_type: number | null
  /** Track gain in dB from Plex loudness analysis (equivalent to REPLAYGAIN_TRACK_GAIN) */
  gain: number | null
  album_gain: number | null
  peak: number | null
  loudness: number | null
  /** Audio codec (e.g. "flac", "mp3", "aac") */
  codec: string | null
  /** Number of audio channels */
  channels: number | null
  /** Bitrate in kbps */
  bitrate: number | null
  /** Bit depth (e.g. 16, 24) */
  bit_depth: number | null
  /** Sampling rate in Hz (e.g. 44100, 96000) */
  sampling_rate: number | null
  /** Human-readable description (e.g. "FLAC (Stereo)") */
  display_title: string | null
}

export interface MediaPart {
  id: number
  key: string
  duration: number | null
  file: string | null
  size: number | null
  container: string | null
  audio_profile: string | null
  indexes: string | null
  streams: PlexStream[]
}

export interface Media {
  id: number
  duration: number | null
  bitrate: number | null
  audio_channels: number | null
  audio_codec: string | null
  container: string | null
  parts: MediaPart[]
}

export interface Track {
  rating_key: number
  key: string
  title: string
  index: number
  duration: number
  parent_key: string
  /** Album title */
  parent_title: string
  parent_year: number | null
  /** Album studio / record label */
  parent_studio: string | null
  grandparent_key: string
  /** Artist name */
  grandparent_title: string
  library_section_id: number
  library_section_key: string | null
  library_section_title: string | null
  year: number
  view_count: number
  distance: number | null
  thumb: string | null
  /** Album art — returned by Plex for smart playlist items instead of thumb */
  parent_thumb: string | null
  grandparent_thumb: string | null
  thumb_blur_hash: string | null
  summary: string | null
  user_rating: number | null
  added_at: string | null
  last_viewed_at: string | null
  last_rated_at: string | null
  updated_at: string | null
  guid: string | null
  audio_bitrate: number | null
  audio_channels: number | null
  audio_codec: string | null
  original_title: string | null
  primary_extra_key: string | null
  view_offset: number | null
  /** Non-null = sonic analysis is available for this track */
  music_analysis_version: number | null
  rating_count: number | null
  skip_count: number | null
  /** Sequential ID Plex assigns when a track is added to a playlist. Lower = added earlier. Null outside playlist context. */
  playlist_item_id: number | null
  media: Media[]
}

export interface PlexTag {
  tag: string
  id: number | null
  filter: string | null
}

/** A genre/mood/style tag returned by the library tags endpoint. */
export interface LibraryTag {
  tag: string
  count: number | null
}

export interface Review {
  id: number | null
  tag: string | null
  text: string | null
  image: string | null
  link: string | null
  source: string | null
}

export interface Album {
  rating_key: number
  key: string
  title: string
  parent_key: string
  /** Artist name */
  parent_title: string
  year: number
  library_section_id: number
  leaf_count: number
  viewed_leaf_count: number
  studio: string | null
  thumb: string | null
  summary: string | null
  user_rating: number | null
  added_at: string | null
  last_viewed_at: string | null
  last_rated_at: string | null
  updated_at: string | null
  originally_available_at: string | null
  /** Sonic distance from a reference item (0 = identical, 1 = maximally different). Populated by /nearest queries. */
  distance: number | null
  guid: string | null
  parent_guid: string | null
  parent_theme: string | null
  parent_thumb: string | null
  /** "Single", "EP", "Live", etc. — empty array means full album */
  subformat: PlexTag[]
  genre: PlexTag[]
  style: PlexTag[]
  mood: PlexTag[]
  label: PlexTag[]
  collection: PlexTag[]
  reviews: Review[]
  /** Non-null = loudness analysis is available */
  loudness_analysis_version: number | null
}

export interface Artist {
  rating_key: number
  key: string
  title: string
  title_sort: string | null
  library_section_id: number
  album_sort: number
  rating: number | null
  thumb: string | null
  summary: string | null
  user_rating: number | null
  added_at: string | null
  last_viewed_at: string | null
  last_rated_at: string | null
  updated_at: string | null
  guid: string | null
  theme: string | null
  art: string | null
  locations: string[]
  /** Sonic distance from a reference item (0 = identical, 1 = maximally different). Populated by /nearest queries. */
  distance: number | null
}

export interface Playlist {
  rating_key: number
  key: string
  title: string
  title_sort: string | null
  playlist_type: string
  /** True for auto-generated "smart" playlists */
  smart: boolean
  /** True for radio-style station playlists */
  radio: boolean
  leaf_count: number
  duration: number | null
  duration_in_seconds: number | null
  library_section_id: number | null
  library_section_key: string | null
  library_section_title: string | null
  summary: string | null
  /** Custom user-uploaded artwork */
  thumb: string | null
  composite: string | null
  content: string | null
  icon: string | null
  added_at: string | null
  updated_at: string | null
  guid: string | null
  allow_sync: boolean
}

/**
 * Plex returns internally-tagged JSON: `{"type":"track","rating_key":123,...}`.
 * The variant fields are flat (not nested), so we use intersection types.
 * After narrowing on `item.type`, all variant-specific fields are accessible
 * directly (e.g. `item.rating_key`, `item.parent_title`).
 */
export type PlexMedia =
  | (Track & { type: "track" })
  | (Album & { type: "album" })
  | (Artist & { type: "artist" })
  | (Playlist & { type: "playlist" })
  | { type: "unknown" }

/** PlexMedia narrowed to only known variants (excludes the `{ type: "unknown" }` fallback). */
export type KnownPlexMedia = Exclude<PlexMedia, { type: "unknown" }>

export interface Hub {
  title: string
  hub_identifier: string
  size: number
  metadata: PlexMedia[]
  visibility: number | null
  style: string | null
}

export interface LibrarySection {
  key: number
  title: string
  section_type: string
  agent: string
  scanner: string
  language: string | null
  locations: string[]
  thumb: string | null
  composite: string | null
  art: string | null
  total_size: number | null
  created_at: string | null
  refreshed_at: string | null
  refreshing: boolean
  filters: boolean
  allow_sync: boolean
  uuid: string | null
}

export interface PlayQueue {
  id: number
  selected_item_id: number
  selected_item_offset: number
  total_count: number
  shuffled: boolean
  /** 0 = off, 1 = repeat one, 2 = repeat all */
  repeat: number
  source_uri: string | null
  items: Track[]
}

// ---------------------------------------------------------------------------
// Phase 2: Sonic / PlexAmp
// ---------------------------------------------------------------------------

/** A single loudness sample from stream level analysis. Plex returns each as {"v": dBFS}. */
export interface Level {
  loudness: number
}

/** A single timed lyric line parsed from TTML or LRC. */
export interface LyricLine {
  start_ms: number
  end_ms: number
  text: string
}

// ---------------------------------------------------------------------------
// Phase 5: Server info & settings
// ---------------------------------------------------------------------------

export interface IdentityResponse {
  claimed: boolean
  machine_identifier: string
  version: string
}

export interface ServerInfo {
  friendly_name: string
  machine_identifier: string
  platform: string
  version: string
  my_plex: boolean
  multiuser: boolean
  allow_sync: boolean
}

export interface PlexSettings {
  base_url: string
  token: string
  /** Stable per-installation UUID used as X-Plex-Client-Identifier. */
  client_id: string
  /** All known connection URLs ordered best-first; used as fallbacks. */
  all_urls: string[]
}

// ---------------------------------------------------------------------------
// plex.tv OAuth types
// ---------------------------------------------------------------------------

/** Returned by plex_auth_start — open auth_url in the browser, poll with pin_id. */
export interface PlexAuthPin {
  pin_id: number
  auth_url: string
}

/** A connection endpoint for a Plex resource. */
export interface PlexConnection {
  protocol: string
  address: string
  port: number
  uri: string
  local: boolean
  relay: boolean
}

/** A Plex Media Server returned by plex.tv /api/v2/resources. */
export interface PlexResource {
  name: string
  client_identifier: string
  provides: string
  connections: PlexConnection[]
}
