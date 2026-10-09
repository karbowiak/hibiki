/**
 * ListenBrainz auth + settings state.
 *
 * Mirrors the ListenBrainz-related fields from app settings (which live on disk).
 * No Zustand persist needed — state is seeded from `loadAppSettings()` on init
 * and written back to disk via Tauri commands on every change.
 */

import { create } from "zustand"
import { loadAppSettings } from "../../lib/settings"
import {
  listenbrainzSaveToken,
  listenbrainzDisconnect as listenbrainzDisconnectApi,
  listenbrainzSetEnabled as listenbrainzSetEnabledApi,
} from "./api"

interface ListenBrainzState {
  /** Whether the user has a valid token on disk. */
  isAuthenticated: boolean
  /** Whether scrobbling + now-playing updates are enabled. */
  isEnabled: boolean
  /** ListenBrainz username. Null if not authenticated. */
  username: string | null

  /** Seed state from saved settings. Call once on app start. */
  initialize: () => Promise<void>
  /** Validate and save a token. */
  saveToken: (token: string) => Promise<void>
  /** Enable or disable scrobbling (saves to disk). */
  setEnabled: (enabled: boolean) => Promise<void>
  /** Clear token + username from disk and reset local state. */
  disconnect: () => Promise<void>
}

export const useListenBrainzStore = create<ListenBrainzState>((set) => ({
  isAuthenticated: false,
  isEnabled: false,
  username: null,

  initialize: async () => {
    try {
      const settings = await loadAppSettings()
      set({
        isAuthenticated: settings.has_listenbrainz_token,
        isEnabled: settings.listenbrainz_enabled,
        username: settings.listenbrainz_username || null,
      })
    } catch {
      // Settings not yet saved — keep defaults
    }
  },

  saveToken: async (token) => {
    const result = await listenbrainzSaveToken(token)
    set({
      isAuthenticated: true,
      isEnabled: true,
      username: result.username,
    })
  },

  setEnabled: async (enabled) => {
    await listenbrainzSetEnabledApi(enabled)
    set({ isEnabled: enabled })
  },

  disconnect: async () => {
    await listenbrainzDisconnectApi()
    set({
      isAuthenticated: false,
      isEnabled: false,
      username: null,
    })
  },
}))
