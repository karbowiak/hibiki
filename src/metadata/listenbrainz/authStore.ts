/**
 * ListenBrainz auth + settings state.
 *
 * Mirrors the ListenBrainz-related fields from app settings (which live on disk).
 * No Zustand persist needed — state is seeded from `loadAppSettings()` on init
 * and written back to disk via Tauri commands on every change.
 */

import { create } from "zustand"
import { AuthOwnership } from "../authOwnership"
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

const ownership = new AuthOwnership<keyof ListenBrainzState>()
let initialization = 0
let authentication: Promise<unknown> | null = null
export const useListenBrainzStore = create<ListenBrainzState>((set) => ({
  isAuthenticated: false,
  isEnabled: false,
  username: null,

  initialize: async () => {
    const read = ++initialization
    const owner = ownership.capture()
    try {
      const settings = await loadAppSettings()
      if (read !== initialization) return
      set(
        owner.filter({
          isAuthenticated: settings.has_listenbrainz_token,
          isEnabled: settings.listenbrainz_enabled,
          username: settings.listenbrainz_username || null,
        })
      )
    } catch {
      // Settings not yet saved — keep defaults
    }
  },

  saveToken: async (token) => {
    const owner = ownership.claim("isAuthenticated", "isEnabled", "username")
    const request = listenbrainzSaveToken(token)
    authentication = request
    let result: Awaited<ReturnType<typeof listenbrainzSaveToken>>
    try {
      result = await request
    } finally {
      if (authentication === request) authentication = null
    }
    set(
      owner.filter({
        isAuthenticated: true,
        isEnabled: true,
        username: result.username,
      })
    )
  },

  setEnabled: async (enabled) => {
    const owner = ownership.claim("isEnabled")
    // Token validation enables listening on disk. Apply a newer explicit toggle
    // after it completes so the saved setting agrees with the owned UI value.
    if (authentication) {
      try {
        await authentication
      } catch {
        /* The toggle can still be saved. */
      }
      if (!owner.owns("isEnabled")) return
    }
    await listenbrainzSetEnabledApi(enabled)
    set(owner.filter({ isEnabled: enabled }))
  },

  disconnect: async () => {
    const owner = ownership.claim("isAuthenticated", "isEnabled", "username")
    await listenbrainzDisconnectApi()
    set(
      owner.filter({
        isAuthenticated: false,
        isEnabled: false,
        username: null,
      })
    )
  },
}))
