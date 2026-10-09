/**
 * Last.fm API — TypeScript wrappers around Tauri invoke() calls.
 *
 * The API secret never reaches this layer — it lives in Rust and is loaded
 * from `plex_settings.json` on disk by each Tauri command that needs it.
 *
 * Usage:
 *   1. Call `lastfmSaveCredentials(apiKey, apiSecret)` when user enters their key/secret.
 *   2. Call `lastfmGetToken()` to start the auth flow (returns token + auth URL).
 *   3. Open the auth URL in the browser via tauri-plugin-opener.
 *   4. Call `lastfmCompleteAuth(token)` after the user approves.
 *   5. Save the returned session to lastfmStore.
 */

import { invoke } from "@tauri-apps/api/core"

// ---------------------------------------------------------------------------
// Auth + Settings
// ---------------------------------------------------------------------------

/** Persist the user's Last.fm API key and secret to disk (stays in Rust). */
export const lastfmSaveCredentials = (apiKey: string, apiSecret: string): Promise<void> =>
  invoke("lastfm_save_credentials", { apiKey, apiSecret })

/** Step 1 of auth: request a temporary token and the URL to open in the browser. */
export const lastfmGetToken = (): Promise<LastfmAuthToken> => invoke("lastfm_get_token")

/** Step 3 of auth: exchange the authorized token for a permanent session key. */
export const lastfmCompleteAuth = (token: string): Promise<LastfmSession> =>
  invoke("lastfm_complete_auth", { token })

/** Clear the session key and username from settings (disconnect). */
export const lastfmDisconnect = (): Promise<void> => invoke("lastfm_disconnect")

/** Enable or disable Last.fm scrobbling and now-playing updates. */
export const lastfmSetEnabled = (enabled: boolean): Promise<void> =>
  invoke("lastfm_set_enabled", { enabled })

/** Set whether Last.fm metadata replaces (true) or augments (false) Plex data. */
export const lastfmSetReplaceMetadata = (replace: boolean): Promise<void> =>
  invoke("lastfm_set_replace_metadata", { replace })

/**
 * Set the minimum Plex rating (0–10) that triggers a Last.fm love.
 * Plex scale: 0=unrated, 2=1★, 4=2★, 6=3★, 8=4★, 10=5★.
 */
export const lastfmSetLoveThreshold = (threshold: number): Promise<void> =>
  invoke("lastfm_set_love_threshold", { threshold })

// ---------------------------------------------------------------------------
// Playback reporting (fire-and-forget — always catch errors at call site)
// ---------------------------------------------------------------------------

/** Notify Last.fm that a track has started playing. No-op if disabled/not authed. */
export const lastfmUpdateNowPlaying = (
  artist: string,
  track: string,
  album: string,
  albumArtist: string,
  durationMs: number,
): Promise<void> =>
  invoke("lastfm_update_now_playing", { artist, track, album, albumArtist, durationMs })

/**
 * Scrobble a completed track to Last.fm.
 * `startedAtUnix` — Unix timestamp (seconds) when playback began.
 * `listenedMs`    — How many milliseconds the user actually listened.
 * Rust enforces scrobble rules (>30s track, >50% listened or >4 min).
 * No-op if Last.fm is disabled or not authenticated.
 */
export const lastfmScrobble = (
  artist: string,
  track: string,
  album: string,
  albumArtist: string,
  durationMs: number,
  startedAtUnix: number,
  listenedMs: number,
): Promise<void> =>
  invoke("lastfm_scrobble", {
    artist,
    track,
    album,
    albumArtist,
    durationMs,
    startedAtUnix,
    listenedMs,
  })

/**
 * Love or unlove a track on Last.fm.
 * `love = true` → track.love, `love = false` → track.unlove.
 * No-op if not authenticated (intentionally ignores enabled toggle so ratings sync regardless).
 */
export const lastfmLoveTrack = (
  artist: string,
  track: string,
  love: boolean,
): Promise<void> => invoke("lastfm_love_track", { artist, track, love })

// ---------------------------------------------------------------------------
// Public metadata (cached in lastfmMetadataStore, TTL-gated)
// ---------------------------------------------------------------------------

/** Fetch artist metadata: biography, listeners, tags, similar artists. */
export const lastfmGetArtistInfo = (artist: string): Promise<LastfmArtistInfo> =>
  invoke("lastfm_get_artist_info", { artist })

/** Fetch track metadata: listeners, play count, tags, wiki summary. */
export const lastfmGetTrackInfo = (artist: string, track: string): Promise<LastfmTrackInfo> =>
  invoke("lastfm_get_track_info", { artist, track })

/** Fetch album metadata: tags and wiki summary. */
export const lastfmGetAlbumInfo = (artist: string, album: string): Promise<LastfmAlbumInfo> =>
  invoke("lastfm_get_album_info", { artist, album })

// ---------------------------------------------------------------------------
// TypeScript interfaces
// ---------------------------------------------------------------------------

export interface LastfmAuthToken {
  token: string
  auth_url: string
}

export interface LastfmSession {
  username: string
}

export interface LastfmSimilarArtist {
  name: string
  url: string
  image_url: string | null
}

export interface LastfmArtistInfo {
  name: string
  url: string
  listeners: number
  play_count: number
  /** Plain-text biography (HTML already stripped by Rust). */
  bio: string
  tags: string[]
  similar: LastfmSimilarArtist[]
}

export interface LastfmTrackInfo {
  name: string
  artist: string
  listeners: number
  play_count: number
  tags: string[]
  /** Short wiki summary, may contain basic HTML. Null if not available. */
  wiki: string | null
}

export interface LastfmAlbumInfo {
  name: string
  artist: string
  tags: string[]
  /** Short wiki summary, may contain basic HTML. Null if not available. */
  wiki: string | null
}
