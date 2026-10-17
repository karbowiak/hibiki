/**
 * TypeScript wrappers around Tauri invoke() calls to the Plex Rust backend.
 *
 * Connection and installation-level helpers live here. Library RPCs are
 * bound to their provider context in scopedApi.ts.
 *
 * Helper functions that only construct URLs (buildItemUri, buildDirectoryUri)
 * are pure client-side and need no invoke() call.
 */

import { invoke } from "@tauri-apps/api/core"
import type { LibrarySection, PlexAuthPin, PlexResource, PlexSettings } from "./types"

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

/** Connect to a Plex Media Server. Must be called before all other functions. */
export interface PlexConnectionInfo { machineIdentifier: string; sections: LibrarySection[]; cacheScopes: Record<string, string> }

export function connectPlex(baseUrl: string, token: string, connectionRevision: number, acceptInvalidCerts?: boolean, expectedMachineIdentifier?: string): Promise<PlexConnectionInfo> {
  return invoke("connect_plex", { baseUrl, token, connectionRevision, acceptInvalidCerts: acceptInvalidCerts ?? null, expectedMachineIdentifier: expectedMachineIdentifier ?? null })
}

/** Revoke the client and return an ownership revision for the next connection. */
export function disconnectPlex(clearSaved: boolean): Promise<number> {
  return invoke("disconnect_plex", { clearSaved })
}

// ---------------------------------------------------------------------------
// Settings persistence (Phase 5)
// ---------------------------------------------------------------------------

/** Load saved connection settings from disk. Returns empty strings if unset. */
export function loadSettings(): Promise<PlexSettings> {
  return invoke("load_settings")
}

/** Persist connection settings to disk. `allUrls` stores every known URL for fallback. */
export function saveSettings(connectionRevision: number, allUrls: string[], sectionId?: number, sectionUuid?: string): Promise<void> {
  return invoke("save_settings", { connectionRevision, allUrls, sectionId: sectionId ?? null, sectionUuid: sectionUuid ?? null })
}

/**
 * Probe a Plex server URL for reachability and latency.
 * Uses a 5-second timeout with no retries — call in parallel for multiple candidates.
 * Returns latency in milliseconds.
 */
export function testServerConnection(url: string, expectedMachineIdentifier?: string): Promise<number> {
  return invoke("test_server_connection", { url, expectedMachineIdentifier: expectedMachineIdentifier ?? null })
}

/** Delete all cached Plex artwork from disk. Called before a force-refresh. */
export function clearImageCache(): Promise<void> {
  return invoke("clear_image_cache")
}

export interface ImageCacheInfo {
  files: number
  bytes: number
}

/** Returns file count and total size for the unified image cache. */
export function getImageCacheInfo(): Promise<ImageCacheInfo> {
  return invoke("get_image_cache_info")
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
// URI helpers (client-side, no invoke needed)
// ---------------------------------------------------------------------------

/** Build a library item URI for a single track/album/playlist. */
export function buildItemUri(sectionUuid: string, itemKey: string): string {
  return `library://${sectionUuid}/item/${itemKey}`
}

/** Build a server-level URI for playlists (which aren't scoped to a library section). */
export function buildPlaylistUri(machineIdentifier: string, playlistKey: string): string {
  return `server://${machineIdentifier}/com.plexapp.plugins.library${playlistKey}`
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
