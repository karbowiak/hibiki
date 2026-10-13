import { PlexProvider } from "./provider"
import {
  activateSemanticContext,
  scheduleSemanticIndex,
} from "../../semantic/discovery"
import { useOfflineStatusStore } from "../../offline/statusStore"
import { createOfflineProvider } from "../../offline/providerCache"
import { createSavedLibraryProvider } from "../../offline/offlineProvider"
import {
  createNativeOfflineCache,
  restoreOfflineContext,
} from "../../offline/nativeCache"
import { useProviderStore } from "../../stores/providerStore"
import {
  activateMetadataCache,
  disconnectMetadataCache,
} from "../../stores/metadataCache"
import { useLibraryStore } from "../../stores/libraryStore"
import { useUIStore } from "../../stores/uiStore"
import { useContextMenuStore } from "../../stores/contextMenuStore"
import { usePlayerStore } from "../../stores/playerStore"
import {
  connectPlex,
  disconnectPlex,
  loadSettings,
  saveSettings,
  testServerConnection,
  plexAuthStart,
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
    activateSemanticContext(null)
    useOfflineStatusStore.getState().activate(null)
    usePlayerStore.getState().stop()
    useContextMenuStore.setState({
      open: false,
      data: null,
      type: null,
      playlistId: null,
    })
    useUIStore.getState().setShowCreatePlaylist(false)
    useUIStore.getState().setPendingPlaylistItemIds(null)
    if (wsManager) {
      wsManager.disconnect()
      wsManager = null
    }
    const provider = useProviderStore.getState().provider
    useProviderStore.getState().clearProvider()
    if (provider) void provider.disconnect().catch(() => {})
    useLibraryStore.getState().clearAll()
    disconnectMetadataCache()
  },
  createProvider: async (context, section) => {
    const provider = new PlexProvider()
    await provider.connect({
      baseUrl: context.baseUrl,
      token: context.token,
      sectionId: section.key,
      sectionUuid: section.uuid ?? null,
      machineIdentifier: context.machineIdentifier,
      cacheScope: context.cacheScopes[String(section.key)],
      connectionRevision: context.revision,
    })
    return createOfflineProvider(
      provider,
      createNativeOfflineCache({
        connectionRevision: context.revision,
        cacheScope: provider.cacheScope!,
      }),
      {
        onOfflineRead: (notice) =>
          useOfflineStatusStore.getState().cached(provider.cacheScope!, notice),
        onOnlineRead: (key) => {
          useOfflineStatusStore.getState().online(provider.cacheScope!, key)
          scheduleSemanticIndex()
        },
      }
    )
  },
  restoreOfflineContext,
  activateOfflineProvider: async (context, ownsRequest) => {
    const cache = createNativeOfflineCache({
      connectionRevision: context.revision,
      cacheScope: context.cacheScope,
    })
    const provider = createSavedLibraryProvider(
      context.cacheScope,
      cache,
      ownsRequest
    )
    await Promise.all([
      useLibraryStore.getState().activateProvider(provider),
      activateMetadataCache(provider),
    ])
    if (!ownsRequest()) {
      await provider.disconnect()
      return
    }
    activateSemanticContext({
      connectionRevision: context.revision,
      cacheScope: context.cacheScope,
    })
    useOfflineStatusStore.getState().activate(provider.cacheScope ?? null, true)
    useProviderStore.getState().setProvider(provider)
  },
  activateProvider: async (provider, context, section, ownsRequest) => {
    await Promise.all([
      useLibraryStore.getState().activateProvider(provider),
      activateMetadataCache(provider),
    ])
    if (!ownsRequest()) return
    activateSemanticContext({
      connectionRevision: context.revision,
      cacheScope: provider.cacheScope!,
    })
    useOfflineStatusStore.getState().activate(provider.cacheScope ?? null)
    useProviderStore.getState().setProvider(provider)
    wsManager = new PlexWebSocketManager()
    wsManager.connect(context.baseUrl, context.token, section.key)
  },
})
