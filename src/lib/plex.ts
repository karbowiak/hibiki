/**
 * TypeScript wrappers around Tauri invoke() calls to the Plex Rust backend.
 *
 * Call `connectPlex(baseUrl, token)` once at startup, then use any other
 * function freely — the backend keeps the connection alive in managed state.
 *
 * Helper functions that only construct URLs (buildItemUri, buildDirectoryUri)
 * are pure client-side and need no invoke() call.
 */

import { invoke } from "@tauri-apps/api/core"
import type {
  Album,
  Artist,
  Hub,
  IdentityResponse,
  Level,
  LibrarySection,
  LibraryTag,
  LyricLine,
  PlayQueue,
  Playlist,
  PlexAuthPin,
  PlexMedia,
  PlexResource,
  PlexSettings,
  ServerInfo,
  Track,
} from "../types/plex"

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

/** Connect to a Plex Media Server. Must be called before all other functions. */
export function connectPlex(baseUrl: string, token: string): Promise<void> {
  return invoke("connect_plex", { baseUrl, token })
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

/** Get all library sections on the server. */
export function getLibrarySections(): Promise<LibrarySection[]> {
  return invoke("get_library_sections")
}

/**
 * Search a library section.
 * @param libtype Optional filter: "artist" | "album" | "track"
 */
export function searchLibrary(
  sectionId: number,
  query: string,
  libtype?: string
): Promise<PlexMedia[]> {
  return invoke("search_library", { sectionId, query, libtype: libtype ?? null })
}

/** Get recently added items in a section. */
export function getRecentlyAdded(
  sectionId: number,
  libtype?: string,
  limit?: number
): Promise<PlexMedia[]> {
  return invoke("get_recently_added", {
    sectionId,
    libtype: libtype ?? null,
    limit: limit ?? null,
  })
}

/** Get discovery hubs (home screen cards) for a section. */
export function getHubs(sectionId: number): Promise<Hub[]> {
  return invoke("get_hubs", { sectionId })
}

/** Get "on deck" / continue listening items for a section. */
export function getOnDeck(sectionId: number): Promise<PlexMedia[]> {
  return invoke("get_on_deck", { sectionId })
}

/**
 * Get tags (genres, moods, styles) for a library section.
 * @param tagType "genre" | "mood" | "style"
 */
export function getSectionTags(sectionId: number, tagType: string): Promise<LibraryTag[]> {
  return invoke("get_section_tags", { sectionId, tagType })
}

/** Get albums (or artists/tracks) filtered by a tag (genre/mood/style). libtype: "8"=artist, "9"=album, "10"=track. */
export function getItemsByTag(
  sectionId: number,
  tagType: "genre" | "mood" | "style",
  tagName: string,
  libtype?: string,
): Promise<PlexMedia[]> {
  return invoke("get_items_by_tag", { sectionId, tagType, tagName, libtype })
}

// ---------------------------------------------------------------------------
// Metadata fetch
// ---------------------------------------------------------------------------

/** Get a specific track by its rating key. */
export function getTrack(ratingKey: number): Promise<Track> {
  return invoke("get_track", { ratingKey })
}

/** Get an artist by rating key. */
export function getArtist(ratingKey: number): Promise<Artist> {
  return invoke("get_artist", { ratingKey })
}

/** Get an album by rating key. */
export function getAlbum(ratingKey: number): Promise<Album> {
  return invoke("get_album", { ratingKey })
}

/**
 * Get albums by an artist.
 * @param formatFilter Optional Plex `album.format` filter:
 *   - `undefined` / `null` → all albums
 *   - `"Single"` → only singles
 *   - `"!Single"` → full albums and EPs (excludes singles)
 */
export function getArtistAlbums(ratingKey: number, formatFilter?: string): Promise<Album[]> {
  return invoke("get_artist_albums", { ratingKey, formatFilter: formatFilter ?? null })
}

/** Get all tracks in an album. */
export function getAlbumTracks(ratingKey: number): Promise<Track[]> {
  return invoke("get_album_tracks", { ratingKey })
}

/** Get popular tracks for an artist (PlexAmp-style top tracks). */
export function getArtistPopularTracks(
  ratingKey: number,
  limit?: number
): Promise<Track[]> {
  return invoke("get_artist_popular_tracks", { ratingKey, limit: limit ?? null })
}

/** Get popular tracks for an artist using the /popularLeaves endpoint. */
export function getArtistPopularLeaves(
  ratingKey: number,
  limit?: number
): Promise<Track[]> {
  return invoke("get_artist_popular_leaves", { ratingKey, limit: limit ?? null })
}

/** Get metadata-based similar artists (from AllMusic/MusicBrainz). */
export function getArtistSimilar(ratingKey: number): Promise<Artist[]> {
  return invoke("get_artist_similar", { ratingKey })
}

/** Get sonically similar artists using the /nearest endpoint. */
export function getArtistSonicallySimilar(
  ratingKey: number,
  limit?: number,
  maxDistance?: number
): Promise<Artist[]> {
  return invoke("get_artist_sonically_similar", {
    ratingKey,
    limit: limit ?? null,
    maxDistance: maxDistance ?? null,
  })
}

/** Get albums for an artist using the section-specific endpoint (better deduplication). */
export function getArtistAlbumsInSection(
  sectionId: number,
  ratingKey: number,
  format?: string
): Promise<Album[]> {
  return invoke("get_artist_albums_in_section", {
    sectionId,
    ratingKey,
    format: format ?? null,
  })
}

/** Get popular tracks for an artist using the section-specific endpoint (server-side dedup via group=title). */
export function getArtistPopularTracksInSection(
  sectionId: number,
  ratingKey: number,
  limit?: number
): Promise<Track[]> {
  return invoke("get_artist_popular_tracks_in_section", {
    sectionId,
    ratingKey,
    limit: limit ?? null,
  })
}

/** Get hubs related to a specific item (e.g., sonically similar artists). */
export function getRelatedHubs(ratingKey: number, limit?: number): Promise<Hub[]> {
  return invoke("get_related_hubs", { ratingKey, limit: limit ?? null })
}

// ---------------------------------------------------------------------------
// Playlists
// ---------------------------------------------------------------------------

/** List all playlists in a library section. */
export function getPlaylists(sectionId: number): Promise<Playlist[]> {
  return invoke("get_playlists", { sectionId })
}

/** Get tracks that the user has rated (liked), sorted by most recently rated. */
export function getLikedTracks(sectionId: number, limit?: number): Promise<Track[]> {
  return invoke("get_liked_tracks", { sectionId, limit: limit ?? null })
}

/** Get artists that the user has rated (liked), sorted by most recently rated. */
export function getLikedArtists(sectionId: number, limit?: number): Promise<Artist[]> {
  return invoke("get_liked_artists", { sectionId, limit: limit ?? null })
}

/** Get albums that the user has rated (liked), sorted by most recently rated. */
export function getLikedAlbums(sectionId: number, limit?: number): Promise<Album[]> {
  return invoke("get_liked_albums", { sectionId, limit: limit ?? null })
}

/**
 * Fetch the track list for a "Mix for You" hub item.
 * Pass the raw `key` field from the hub mix item — the backend appends
 * `&type=10` automatically when it's missing.
 */
export function getMixTracks(key: string): Promise<Track[]> {
  return invoke("get_mix_tracks", { key })
}

/** Get tracks inside a playlist, with optional pagination. */
export function getPlaylistItems(
  playlistId: number,
  limit?: number,
  offset?: number
): Promise<Track[]> {
  return invoke("get_playlist_items", {
    playlistId,
    limit: limit ?? null,
    offset: offset ?? null,
  })
}

/** Create a new playlist from a list of track rating keys. */
export function createPlaylist(
  title: string,
  sectionId: number,
  itemIds: number[]
): Promise<Playlist> {
  return invoke("create_playlist", { title, sectionId, itemIds })
}

/** Add items to an existing playlist by rating key. */
export function addItemsToPlaylist(playlistId: number, itemIds: number[]): Promise<void> {
  return invoke("add_items_to_playlist", { playlistId, itemIds })
}

// ---------------------------------------------------------------------------
// Play queue
// ---------------------------------------------------------------------------

/**
 * Create a server-side play queue.
 *
 * Build the URI with the `buildItemUri` / `buildDirectoryUri` helpers, or
 * pass a raw path like `/library/metadata/{ratingKey}`.
 *
 * @param repeat 0 = off, 1 = repeat-one, 2 = repeat-all
 */
export function createPlayQueue(
  uri: string,
  shuffle: boolean,
  repeat: number
): Promise<PlayQueue> {
  return invoke("create_play_queue", { uri, shuffle, repeat })
}

/** Fetch an existing play queue by ID. */
export function getPlayQueue(queueId: number): Promise<PlayQueue> {
  return invoke("get_play_queue", { queueId })
}

/**
 * Add items to an existing play queue.
 * @param next If true, insert after current item; if false, append to end.
 */
export function addToPlayQueue(
  queueId: number,
  uri: string,
  next: boolean
): Promise<PlayQueue> {
  return invoke("add_to_play_queue", { queueId, uri, next })
}

/**
 * Create a radio play queue seeded from any Plex item.
 *
 * Uses PlexAmp's `plex://radio` URI scheme — the Plex server generates a
 * continuously-refreshing, sonically-curated stream of recommendations.
 *
 * @param ratingKey  Seed item (track, album, or artist rating key)
 * @param degreesOfSeparation  Diversity: -1 = unlimited, 0 = closest only, 3+ = adventurous
 * @param includeExternal  Include tracks from external/cloud sources
 * @param shuffle  Shuffle the initial queue
 */
export function createRadioQueue(
  ratingKey: number,
  itemType: string,
  degreesOfSeparation?: number,
  includeExternal?: boolean,
  shuffle?: boolean
): Promise<PlayQueue> {
  return invoke("create_radio_queue", {
    ratingKey,
    itemType,
    degreesOfSeparation: degreesOfSeparation ?? null,
    includeExternal: includeExternal ?? false,
    shuffle: shuffle ?? false,
  })
}

/**
 * Create a Guest DJ (smart-shuffle) play queue.
 *
 * Like `createRadioQueue` but uses Plex's AI-curated `smartShuffle` mode and
 * the "Guest DJ" persona header for richer contextual recommendations.
 *
 * @param ratingKey  Seed item rating key
 * @param degreesOfSeparation  Diversity: -1 = unlimited
 * @param includeExternal  Include external sources
 */
export function createSmartShuffleQueue(
  ratingKey: number,
  itemType: string,
  djMode?: string,
  degreesOfSeparation?: number,
  includeExternal?: boolean
): Promise<PlayQueue> {
  return invoke("create_smart_shuffle_queue", {
    ratingKey,
    itemType,
    djMode: djMode ?? null,
    degreesOfSeparation: degreesOfSeparation ?? null,
    includeExternal: includeExternal ?? false,
  })
}

// ---------------------------------------------------------------------------
// Playback tracking
// ---------------------------------------------------------------------------

/** Mark an item as played (scrobble). */
export function markPlayed(ratingKey: number): Promise<void> {
  return invoke("mark_played", { ratingKey })
}

/** Mark an item as unplayed. */
export function markUnplayed(ratingKey: number): Promise<void> {
  return invoke("mark_unplayed", { ratingKey })
}

/**
 * Report playback progress to the server.
 * Call every ~10 seconds during playback.
 */
export function reportTimeline(
  ratingKey: number,
  stateStr: "playing" | "paused" | "buffering" | "stopped",
  timeMs: number,
  durationMs: number
): Promise<void> {
  return invoke("report_timeline", { ratingKey, stateStr, timeMs, durationMs })
}

// ---------------------------------------------------------------------------
// Ratings (Phase 3)
// ---------------------------------------------------------------------------

/**
 * Rate a library item.
 *
 * `rating` is on a 0–10 scale (Plex half-star: 2 = 1★, 10 = 5★).
 * Pass `null` to clear an existing rating.
 */
export function rateItem(ratingKey: number, rating: number | null): Promise<void> {
  return invoke("rate_item", { ratingKey, rating })
}

// ---------------------------------------------------------------------------
// Sonic / PlexAmp features (Phase 2)
// ---------------------------------------------------------------------------

/** Get tracks sonically similar to a given track. */
export function getSonicallySimilar(
  ratingKey: number,
  limit?: number,
  maxDistance?: number
): Promise<Track[]> {
  return invoke("get_sonically_similar", {
    ratingKey,
    limit: limit ?? null,
    maxDistance: maxDistance ?? null,
  })
}

/** Get a track radio (mix) seeded from a track. */
export function getTrackRadio(
  sectionId: number,
  ratingKey: number,
  limit?: number
): Promise<Track[]> {
  return invoke("get_track_radio", { sectionId, ratingKey, limit: limit ?? null })
}

/**
 * Get radio stations seeded from an artist.
 * Returns playlists with `radio: true`.
 */
export function getArtistStations(ratingKey: number): Promise<Playlist[]> {
  return invoke("get_artist_stations", { ratingKey })
}

/**
 * Get all music stations available in a library section.
 *
 * Returns discovery hubs; filter by `hub.hub_identifier` containing
 * `"station"` to extract the station playlists from `hub.metadata`.
 */
export function getSectionStations(sectionId: number): Promise<Hub[]> {
  return invoke("get_section_stations", { sectionId })
}

/**
 * Compute a sonic path between two tracks.
 *
 * Returns intermediate tracks that bridge the sonic gap between `fromId`
 * and `toId` — the PlexAmp "Sonic Adventure" via `computePath`.
 */
export function computeSonicPath(
  sectionId: number,
  fromId: number,
  toId: number
): Promise<Track[]> {
  return invoke("compute_sonic_path", { sectionId, fromId, toId })
}

/**
 * Get loudness/peak level data for a media stream.
 *
 * Use for waveform visualisation. `streamId` is `track.media[0].parts[0].id`.
 * `subSample` controls resolution (128 = PlexAmp default).
 */
export function getStreamLevels(
  streamId: number,
  subSample?: number
): Promise<Level[]> {
  return invoke("get_stream_levels", { streamId, subSample: subSample ?? null })
}

// ---------------------------------------------------------------------------
// Streaming URLs (Phase 4)
// ---------------------------------------------------------------------------

/**
 * Build a direct-play stream URL for a media part.
 *
 * Pass `track.media[0].parts[0].key` as `partKey`.
 * Returns a URL you can set as the `src` of an `<audio>` element.
 */
export function getStreamUrl(partKey: string): Promise<string> {
  return invoke("get_stream_url", { partKey })
}

/**
 * Build an artwork/thumbnail URL.
 *
 * Pass `track.thumb`, `album.thumb`, `artist.thumb`, etc. as `thumbPath`.
 */
export function getThumbUrl(thumbPath: string): Promise<string> {
  return invoke("get_thumb_url", { thumbPath })
}

/**
 * Build an audio transcode URL.
 *
 * Use when the client cannot play the native format.
 * @param bitrate Max bitrate in kbps (e.g. 320)
 * @param codec Target codec: "mp3" | "aac" | "opus"
 */
export function getAudioTranscodeUrl(
  partKey: string,
  bitrate?: number,
  codec?: string
): Promise<string> {
  return invoke("get_audio_transcode_url", {
    partKey,
    bitrate: bitrate ?? null,
    codec: codec ?? null,
  })
}

// ---------------------------------------------------------------------------
// Server info (Phase 5)
// ---------------------------------------------------------------------------

/** Get the server's identity (machine ID, version, claimed status). */
export function getIdentity(): Promise<IdentityResponse> {
  return invoke("get_identity")
}

/** Get full server capabilities and metadata. */
export function getServerInfo(): Promise<ServerInfo> {
  return invoke("get_server_info")
}

// ---------------------------------------------------------------------------
// Settings persistence (Phase 5)
// ---------------------------------------------------------------------------

/** Load saved connection settings from disk. Returns empty strings if unset. */
export function loadSettings(): Promise<PlexSettings> {
  return invoke("load_settings")
}

/** Persist connection settings to disk. `allUrls` stores every known URL for fallback. */
export function saveSettings(baseUrl: string, token: string, allUrls?: string[]): Promise<void> {
  return invoke("save_settings", { baseUrl, token, allUrls: allUrls ?? null })
}

/**
 * Probe a Plex server URL for reachability and latency.
 * Uses a 5-second timeout with no retries — call in parallel for multiple candidates.
 * Returns latency in milliseconds.
 */
export function testServerConnection(url: string, token: string): Promise<number> {
  return invoke("test_server_connection", { url, token })
}

/** Delete all cached Plex artwork from disk. Called before a force-refresh. */
export function clearImageCache(): Promise<void> {
  return invoke("clear_image_cache")
}

export interface ImageCacheInfo {
  plex_files: number
  plex_bytes: number
  meta_files: number
  meta_bytes: number
}

/** Returns file count and total size for the Plex and external metadata image caches. */
export function getImageCacheInfo(): Promise<ImageCacheInfo> {
  return invoke("get_image_cache_info")
}

/** Delete all cached external metadata artwork from disk (Deezer, Apple Music, etc.). */
export function clearMetaImageCache(): Promise<void> {
  return invoke("clear_meta_image_cache")
}

// ---------------------------------------------------------------------------
// Plex.tv OAuth (PIN-based authentication)
// ---------------------------------------------------------------------------

/**
 * Start the Plex OAuth PIN flow.
 *
 * Returns a `PlexAuthPin` containing:
 * - `pin_id`: poll with `plexAuthPoll()` every ~2s until a token arrives
 * - `auth_url`: open in the system browser so the user can sign in
 */
export function plexAuthStart(): Promise<PlexAuthPin> {
  return invoke("plex_auth_start")
}

/**
 * Poll plex.tv to check if the user has completed authentication.
 *
 * Returns the auth token string when done, or `null` while still waiting.
 * Call every ~2 seconds until non-null or the user cancels.
 */
export function plexAuthPoll(pinId: number): Promise<string | null> {
  return invoke("plex_auth_poll", { pinId })
}

/**
 * Fetch the user's Plex Media Servers from plex.tv.
 *
 * Call once `plexAuthPoll` returns a token. Returns servers with local
 * connections listed first. If only one server exists, auto-connect to it.
 */
export function plexGetResources(token: string): Promise<PlexResource[]> {
  return invoke("plex_get_resources", { token })
}

// ---------------------------------------------------------------------------
// Audio engine (Rust-native playback)
// ---------------------------------------------------------------------------

/** Start playing a track via the Rust audio engine. */
export function audioPlay(
  url: string,
  ratingKey: number,
  durationMs: number,
  partId: number,
  parentKey: string,
  trackIndex: number,
  gainDb: number | null,
): Promise<void> {
  return invoke("audio_play", { url, ratingKey, durationMs, partId, parentKey, trackIndex, gainDb })
}

/** Pause audio playback. */
export function audioPause(): Promise<void> {
  return invoke("audio_pause")
}

/** Resume audio playback. */
export function audioResume(): Promise<void> {
  return invoke("audio_resume")
}

/** Stop audio playback and clear the current track. */
export function audioStop(): Promise<void> {
  return invoke("audio_stop")
}

/** Seek to a position in the current track. */
export function audioSeek(positionMs: number): Promise<void> {
  return invoke("audio_seek", { positionMs })
}

/** Set the playback volume (0.0 - 1.0). */
export function audioSetVolume(volume: number): Promise<void> {
  return invoke("audio_set_volume", { volume })
}

/** Pre-buffer the next track for gapless playback. */
export function audioPreloadNext(
  url: string,
  ratingKey: number,
  durationMs: number,
  partId: number,
  parentKey: string,
  trackIndex: number,
  gainDb: number | null,
): Promise<void> {
  return invoke("audio_preload_next", { url, ratingKey, durationMs, partId, parentKey, trackIndex, gainDb })
}

/** Warm the audio disk cache for a URL in the background. Returns immediately. */
export function audioPrefetch(url: string): Promise<void> {
  return invoke("audio_prefetch", { url })
}

/** Get current audio cache usage: bytes used and file count. */
export function audioCacheInfo(): Promise<{ size_bytes: number; file_count: number }> {
  return invoke("audio_cache_info")
}

/** Delete all audio cache files from disk. */
export function audioClearCache(): Promise<void> {
  return invoke("audio_clear_cache")
}

/** Set the maximum audio cache size in bytes. Pass 0 for unlimited. */
export function audioSetCacheMaxBytes(maxBytes: number): Promise<void> {
  return invoke("audio_set_cache_max_bytes", { maxBytes })
}

/**
 * Set the crossfade window duration in milliseconds.
 * Pass 0 to disable crossfade entirely. Default is 8000 ms (8 s).
 * Maximum recommended value is 30000 ms (30 s).
 */
export function audioSetCrossfadeWindow(ms: number): Promise<void> {
  return invoke("audio_set_crossfade_window", { ms })
}

/**
 * Enable or disable ReplayGain audio normalization.
 * When enabled (default), tracks are volume-levelled using embedded REPLAYGAIN_TRACK_GAIN tags.
 */
export function audioSetNormalizationEnabled(enabled: boolean): Promise<void> {
  return invoke("audio_set_normalization_enabled", { enabled })
}

/**
 * Set all 10 EQ band gains in dB (±12 dB per band).
 * Index order: 32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000 Hz.
 */
export function audioSetEq(gainsDb: [number, number, number, number, number, number, number, number, number, number]): Promise<void> {
  return invoke("audio_set_eq", { gainsDb })
}

/**
 * Enable or disable the 10-band graphic EQ.
 * When disabled, all EQ processing is bypassed with zero CPU cost.
 */
export function audioSetEqEnabled(enabled: boolean): Promise<void> {
  return invoke("audio_set_eq_enabled", { enabled })
}

/**
 * Set the pre-amp gain in dB (range −12..+3, default 0).
 * Applied before EQ; use to recover headroom after large EQ boosts.
 */
export function audioSetPreampGain(db: number): Promise<void> {
  return invoke("audio_set_preamp_gain", { db })
}

/**
 * Enable or disable crossfade for consecutive same-album tracks.
 * When disabled (default), same-album tracks play gaplessly without fading.
 */
export function audioSetSameAlbumCrossfade(enabled: boolean): Promise<void> {
  return invoke("audio_set_same_album_crossfade", { enabled })
}

/** Fetch parsed lyrics for a track. Returns [] if the track has no lyrics. */
export function getLyrics(ratingKey: number): Promise<LyricLine[]> {
  return invoke("get_lyrics", { ratingKey })
}

/** List available audio output device names for the default CPAL host. */
export function audioGetOutputDevices(): Promise<string[]> {
  return invoke("audio_get_output_devices")
}

/** Set the preferred audio output device by name. Pass null for system default. */
export function audioSetOutputDevice(name: string | null): Promise<void> {
  return invoke("audio_set_output_device", { name })
}

/** Enable or disable the PCM IPC bridge for the visualizer. */
export function audioSetVisualizerEnabled(enabled: boolean): Promise<void> {
  return invoke("audio_set_visualizer_enabled", { enabled })
}

// ---------------------------------------------------------------------------
// Now Playing / system media controls
// ---------------------------------------------------------------------------

/**
 * Push track metadata to the OS Now Playing system.
 *
 * - macOS: Control Centre, lock screen, AirPlay targets
 * - Windows: SMTC lock screen / taskbar
 * - Linux: MPRIS2 panel
 *
 * `thumbPath` is a Plex path like `/library/metadata/123/thumb`; Rust builds
 * the authenticated URL so the token never appears in frontend logs.
 */
export function updateNowPlaying(
  title: string,
  artist: string,
  album: string,
  thumbPath: string | null,
  durationMs: number,
): Promise<void> {
  return invoke("update_now_playing", { title, artist, album, thumbPath, durationMs })
}

/**
 * Update the playback state in the OS media controls.
 * `playbackState` must be `"playing"`, `"paused"`, or `"stopped"`.
 */
export function setNowPlayingState(
  playbackState: "playing" | "paused" | "stopped",
  positionMs?: number,
): Promise<void> {
  return invoke("set_now_playing_state", { playbackState, positionMs })
}

// ---------------------------------------------------------------------------
// URI helpers (client-side, no invoke needed)
// ---------------------------------------------------------------------------

/** Build a library item URI for a single track/album/playlist. */
export function buildItemUri(sectionUuid: string, itemKey: string): string {
  return `library://${sectionUuid}/item/${itemKey}`
}

/** Build a library directory URI for an album or playlist's children. */
export function buildDirectoryUri(sectionUuid: string, itemKey: string): string {
  return `library://${sectionUuid}/directory/${itemKey}/children`
}

/**
 * Build a radio station play queue URI.
 *
 * `stationKey` is the `key` field from a station hub item (e.g. from getSectionStations).
 * Pass the result to `createPlayQueue` / `playFromUri` to start station playback.
 * URI format matches PlexAmp: `library://{uuid}/station/{encoded-key}`.
 */
export function buildRadioPlayQueueUri(sectionUuid: string, stationKey: string): string {
  return `library://${sectionUuid}/station/${encodeURIComponent(stationKey)}`
}

/**
 * Build a directory URI that filters tracks by a tag (genre/mood/style).
 * Pass to `playFromUri(uri, true)` to start a shuffled genre/mood/style queue.
 * URI format: `library://{uuid}/directory//library/sections/{id}/all?type=10&{tagType}={value}`
 */
export function buildTagFilterUri(
  sectionUuid: string,
  sectionId: number,
  tagType: "genre" | "mood" | "style",
  tagValue: string
): string {
  const path = `/library/sections/${sectionId}/all?type=10&${tagType}=${encodeURIComponent(tagValue)}`
  return `library://${sectionUuid}/directory/${path}`
}
