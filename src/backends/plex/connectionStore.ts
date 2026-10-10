import { PlexProvider } from "./provider"
import { useProviderStore } from "../../stores/providerStore"
import { useLibraryStore } from "../../stores/libraryStore"
import { usePlayerStore } from "../../stores/playerStore"
import {
  connectPlex,
  disconnectPlex,
  loadSettings,
  saveSettings,
  testServerConnection,
  plexAuthStart
} from "./api"
import { PlexWebSocketManager } from "./websocket"
import { createPlexConnectionStore } from "./connectionLifecycle"

let wsManager: PlexWebSocketManager | null = null

export const useConnectionStore = createPlexConnectionStore({
  connectPlex,
  disconnectPlex,
  loadSettings,
  saveSettings,
  testServerConnection,
  startPlexAuth: plexAuthStart,
  clearSession: () => {
    usePlayerStore.getState().stop()
    if (wsManager) {
      wsManager.disconnect()
      wsManager = null
    }
    const provider = useProviderStore.getState().provider
    useProviderStore.getState().clearProvider()
    if (provider) void provider.disconnect().catch(() => {})
    useLibraryStore.getState().clearAll()
  },
  createProvider: async (context, section) => {
    const provider = new PlexProvider()
    await provider.connect({
      baseUrl: context.baseUrl,
      token: context.token,
      sectionId: section.key,
      sectionUuid: section.uuid ?? null,
      machineIdentifier: context.machineIdentifier
    })
    return provider
  },
  activateProvider: (provider, context, section) => {
    useProviderStore.getState().setProvider(provider)
    wsManager = new PlexWebSocketManager()
    wsManager.connect(context.baseUrl, context.token, section.key)
  }
})
