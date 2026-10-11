/**
 * Last.fm auth + settings state.
 *
 * Mirrors the LastFM-related fields from app settings (which live on disk).
 * No Zustand persist needed — state is seeded from `loadAppSettings()` on init
 * and written back to disk via Tauri commands on every change.
 *
 * Important: the API secret is NEVER stored here — it lives only in Rust.
 */

import { create } from "zustand"
import { AuthOwnership } from "../authOwnership"
import { loadAppSettings } from "../../lib/settings"
import {
  lastfmCompleteAuth,
  lastfmDisconnect as lastfmDisconnectApi,
  lastfmSetEnabled as lastfmSetEnabledApi,
  lastfmSetLoveThreshold as lastfmSetLoveThresholdApi,
  lastfmSetReplaceMetadata as lastfmSetReplaceMetadataApi,
} from "./api"

interface LastfmState {
  /** Whether the user has a valid session key on disk. */
  isAuthenticated: boolean
  /** Whether scrobbling + now-playing updates are enabled. */
  isEnabled: boolean
  /** True if the user has configured a Last.fm API key (needed even for public metadata). */
  hasApiKey: boolean
  /** Last.fm username to display in Settings. Null if not authenticated. */
  username: string | null
  /** Whether to use Last.fm as the primary metadata source (true) or augment Plex (false). */
  replaceMetadata: boolean
  /**
   * Minimum Plex rating (0–10) that triggers a Last.fm love.
   * Plex scale: 0=unrated, 2=1★, 4=2★, 6=3★, 8=4★, 10=5★.
   * Default 6 = 3 stars.
   */
  loveThreshold: number

  // Actions
  /** Seed state from saved settings. Call once on app start. */
  initialize: () => Promise<void>
  /** Enable or disable scrobbling (saves to disk). */
  setEnabled: (enabled: boolean) => Promise<void>
  /** Exchange an authorized token for a permanent session key. */
  completeAuth: (token: string) => Promise<void>
  /** Clear session key + username from disk and reset local state. */
  disconnect: () => Promise<void>
  /** Toggle augment/replace metadata mode (saves to disk). */
  setReplaceMetadata: (replace: boolean) => Promise<void>
  /** Update the love threshold rating (saves to disk). */
  setLoveThreshold: (threshold: number) => Promise<void>
}

const ownership = new AuthOwnership<keyof LastfmState>()
let initialization = 0
export const useLastfmStore = create<LastfmState>((set) => ({
  isAuthenticated: false,
  isEnabled: false,
  hasApiKey: false,
  username: null,
  replaceMetadata: false,
  loveThreshold: 6,

  initialize: async () => {
    const read = ++initialization
    const owner = ownership.capture()
    try {
      const settings = await loadAppSettings()
      if (read !== initialization) return
      set(
        owner.filter({
          isAuthenticated: settings.has_lastfm_session,
          isEnabled: settings.lastfm_enabled,
          hasApiKey: !!settings.lastfm_api_key,
          username: settings.lastfm_username || null,
          replaceMetadata: settings.lastfm_replace_metadata,
          loveThreshold: settings.lastfm_love_threshold ?? 6,
        })
      )
    } catch {
      // Settings not yet saved — keep defaults
    }
  },

  setEnabled: async (enabled) => {
    const owner = ownership.claim("isEnabled")
    await lastfmSetEnabledApi(enabled)
    set(owner.filter({ isEnabled: enabled }))
  },

  completeAuth: async (token) => {
    const owner = ownership.claim(
      "isAuthenticated",
      "hasApiKey",
      "isEnabled",
      "username"
    )
    const session = await lastfmCompleteAuth(token)
    if (!owner.owns("isAuthenticated")) return
    if (owner.owns("isEnabled")) await lastfmSetEnabledApi(true)
    set(
      owner.filter({
        isAuthenticated: true,
        hasApiKey: true,
        isEnabled: true,
        username: session.username,
      })
    )
  },

  disconnect: async () => {
    const owner = ownership.claim("isAuthenticated", "isEnabled", "username")
    await lastfmDisconnectApi()
    set(
      owner.filter({
        isAuthenticated: false,
        isEnabled: false,
        username: null,
        // Keep hasApiKey — the API key is still on disk after disconnect;
        // public metadata lookups remain functional without a session key.
      })
    )
  },

  setReplaceMetadata: async (replace) => {
    const owner = ownership.claim("replaceMetadata")
    await lastfmSetReplaceMetadataApi(replace)
    set(owner.filter({ replaceMetadata: replace }))
  },

  setLoveThreshold: async (threshold) => {
    const owner = ownership.claim("loveThreshold")
    await lastfmSetLoveThresholdApi(threshold)
    set(owner.filter({ loveThreshold: threshold }))
  },
}))
