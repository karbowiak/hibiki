import { create } from "zustand"
import { PlexProvider } from "./provider"
import { useProviderStore } from "../../stores/providerStore"
import { useLibraryStore } from "../../stores/libraryStore"
import {
  connectPlex,
  getIdentity,
  getLibrarySections,
  loadSettings,
  saveSettings,
  plexAuthStart,
} from "./api"
import type { LibrarySection, PlexAuthPin } from "./types"
import { PlexWebSocketManager } from "./websocket"
import { usePlayerStore } from "../../stores/playerStore"

let wsManager: PlexWebSocketManager | null = null

interface ConnectionState {
  baseUrl: string
  token: string
  isConnected: boolean
  isLoading: boolean
  error: string | null
  musicSectionId: number | null
  sectionUuid: string | null
  musicSectionTitle: string | null

  allUrls: string[]
  tlsExceptions: string[]

  /** All music sections on the connected server */
  availableMusicSections: LibrarySection[]
  /** True when user must choose a library (multiple music sections, no saved match) */
  needsLibraryPick: boolean

  loadAndConnect: () => Promise<void>
  connect: (baseUrl: string, token: string, allUrls?: string[], savedSectionId?: number, acceptInvalidCerts?: boolean, expectedMachineIdentifier?: string) => Promise<void>
  /** Select a library section (called from the picker or auto-select) */
  selectLibrary: (section: LibrarySection) => Promise<void>
  /** Switch to a different library while already connected */
  switchLibrary: (section: LibrarySection) => Promise<void>
  disconnect: () => void
  disconnectAndClear: () => Promise<void>
  clearError: () => void
  /** Start the Plex OAuth PIN flow — returns pin info for the modal to poll. */
  startPlexAuth: () => Promise<PlexAuthPin>
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  baseUrl: "",
  token: "",
  isConnected: false,
  isLoading: true,
  error: null,
  musicSectionId: null,
  sectionUuid: null,
  musicSectionTitle: null,
  allUrls: [],
  tlsExceptions: [],
  availableMusicSections: [],
  needsLibraryPick: false,

  loadAndConnect: async () => {
    set({ isLoading: true, error: null })
    try {
      const settings = await loadSettings()
      set({ tlsExceptions: settings.tls_exceptions ?? [] })
      if (!settings.base_url || !settings.token) {
        set({ isLoading: false })
        return
      }
      const savedSectionId = settings.section_id || undefined
      // Try the saved primary URL first. If it fails and we have fallbacks,
      // try them in parallel and use whichever responds first.
      try {
        await get().connect(settings.base_url, settings.token, settings.all_urls, savedSectionId)
      } catch {
        const fallbacks = (settings.all_urls ?? []).filter(u => u !== settings.base_url)
        if (fallbacks.length === 0) throw new Error("Could not reach Plex server")
        const winner = await Promise.any(
          fallbacks.map(url => get().connect(url, settings.token, settings.all_urls, savedSectionId).then(() => url))
        )
        // connect() already updated state; just ensure base_url is updated
        await saveSettings(winner, settings.token, settings.all_urls)
      }
    } catch (err) {
      set({ isLoading: false, error: String(err) })
    }
  },

  connect: async (baseUrl: string, token: string, allUrls?: string[], savedSectionId?: number, acceptInvalidCerts?: boolean, expectedMachineIdentifier?: string) => {
    usePlayerStore.getState().stop()
    if (wsManager) { wsManager.disconnect(); wsManager = null }
    useProviderStore.getState().clearProvider()
    useLibraryStore.getState().clearAll()
    set({ isLoading: true, isConnected: false, needsLibraryPick: false, error: null })
    try {
      await connectPlex(baseUrl, token, acceptInvalidCerts, expectedMachineIdentifier)
      const saved = await loadSettings()
      set({ tlsExceptions: saved.tls_exceptions ?? [] })
      await saveSettings(baseUrl, token, allUrls)
      const sections = await getLibrarySections()
      const musicSections = sections.filter(s => s.section_type === "artist")

      if (musicSections.length === 0) {
        set({
          baseUrl,
          token,
          isLoading: false,
          isConnected: false,
          allUrls: allUrls ?? [],
          error: "No music libraries found on this server.",
        })
        return
      }

      // Auto-select if only one music section
      if (musicSections.length === 1) {
        set({ baseUrl, token, allUrls: allUrls ?? [], availableMusicSections: musicSections })
        await get().selectLibrary(musicSections[0])
        return
      }

      // Multiple sections — check if saved selection matches one
      if (savedSectionId) {
        const saved = musicSections.find(s => s.key === savedSectionId)
        if (saved) {
          set({ baseUrl, token, allUrls: allUrls ?? [], availableMusicSections: musicSections })
          await get().selectLibrary(saved)
          return
        }
      }

      // Multiple sections, no saved match — ask user to pick
      set({
        baseUrl,
        token,
        isLoading: false,
        allUrls: allUrls ?? [],
        availableMusicSections: musicSections,
        needsLibraryPick: true,
      })
    } catch (err) {
      set({ isLoading: false, error: String(err), isConnected: false })
      throw err  // re-throw so callers (Promise.any, connectToServer) can handle it
    }
  },

  selectLibrary: async (section: LibrarySection) => {
    const { baseUrl, token, allUrls } = get()
    set({ isLoading: true, error: null })
    try {
      // Save the selection to disk
      await saveSettings(baseUrl, token, allUrls, section.key, section.uuid ?? "")

      // Fetch machine identifier for server-level URIs (playlists)
      const identity = await getIdentity()

      // Create and register the PlexProvider in the global provider store
      const provider = new PlexProvider()
      await provider.connect({
        baseUrl,
        token,
        sectionId: section.key,
        sectionUuid: section.uuid ?? null,
        machineIdentifier: identity.machine_identifier,
      })
      useProviderStore.getState().setProvider(provider)

      // Start WebSocket for real-time library updates
      if (wsManager) wsManager.disconnect()
      wsManager = new PlexWebSocketManager()
      wsManager.connect(baseUrl, token, section.key)

      set({
        isConnected: true,
        isLoading: false,
        musicSectionId: section.key,
        sectionUuid: section.uuid ?? null,
        musicSectionTitle: section.title,
        needsLibraryPick: false,
      })
    } catch (err) {
      set({ isLoading: false, error: String(err), isConnected: false })
      throw err
    }
  },

  switchLibrary: async (section: LibrarySection) => {
    const { baseUrl, token, allUrls } = get()

    // Stop playback
    usePlayerStore.getState().stop()

    // Clear library cache
    useLibraryStore.getState().clearAll()

    // Disconnect existing WebSocket
    if (wsManager) { wsManager.disconnect(); wsManager = null }

    // Clear provider
    useProviderStore.getState().clearProvider()

    set({ isLoading: true, error: null })
    try {
      // Save the new selection
      await saveSettings(baseUrl, token, allUrls, section.key, section.uuid ?? "")

      const identity = await getIdentity()

      const provider = new PlexProvider()
      await provider.connect({
        baseUrl,
        token,
        sectionId: section.key,
        sectionUuid: section.uuid ?? null,
        machineIdentifier: identity.machine_identifier,
      })
      useProviderStore.getState().setProvider(provider)

      // Start WebSocket for new section
      wsManager = new PlexWebSocketManager()
      wsManager.connect(baseUrl, token, section.key)

      set({
        isConnected: true,
        isLoading: false,
        musicSectionId: section.key,
        sectionUuid: section.uuid ?? null,
        musicSectionTitle: section.title,
        needsLibraryPick: false,
      })
    } catch (err) {
      set({ isLoading: false, error: String(err) })
      throw err
    }
  },

  disconnect: () => {
    if (wsManager) { wsManager.disconnect(); wsManager = null }
    useProviderStore.getState().clearProvider()
    useLibraryStore.getState().clearAll()
    set({
      baseUrl: "",
      token: "",
      isConnected: false,
      musicSectionId: null,
      sectionUuid: null,
      musicSectionTitle: null,
      availableMusicSections: [],
      needsLibraryPick: false,
    })
  },

  disconnectAndClear: async () => {
    try {
      await saveSettings("", "")
    } catch (err) {
      console.error("Failed to clear saved settings:", err)
    }
    if (wsManager) { wsManager.disconnect(); wsManager = null }
    useProviderStore.getState().clearProvider()
    useLibraryStore.getState().clearAll()
    set({
      baseUrl: "",
      token: "",
      isConnected: false,
      musicSectionId: null,
      sectionUuid: null,
      musicSectionTitle: null,
      availableMusicSections: [],
      needsLibraryPick: false,
    })
  },

  clearError: () => set({ error: null }),

  startPlexAuth: async () => {
    set({ error: null })
    return plexAuthStart()
  },
}))
