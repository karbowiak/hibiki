import { PlexProvider } from "./provider"
import { useOfflineStatusStore } from "../../offline/statusStore"
import { createOfflineProvider } from "../../offline/providerCache"
import { createSavedLibraryProvider } from "../../offline/offlineProvider"
import { createPlexApi } from "./scopedApi"
import { localAudioTrack } from "../../offline/audio"
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
    const audio = createPlexApi(
      { connectionRevision: context.revision, cacheScope: context.cacheScope },
      undefined,
      ownsRequest
    )
    const project = (track: import("../../types/music").MusicTrack) =>
      localAudioTrack(track, context.baseUrl, context.cacheScope)
    const provider = createSavedLibraryProvider(
      context.cacheScope,
      cache,
      ownsRequest,
      {
        track: async (id) => {
          const track = await audio.localTrack(Number(id))
          return track ? project(track) : null
        },
        playback: (id) => audio.prepareTrackAudio(Number(id), true),
        list: async (offset, limit, cached) => {
          const page = await audio.localAudio(offset, limit, cached)
          return {
            ...page,
            items: page.items.map((item) => ({
              ...item,
              track: item.track ? project(item.track) : null,
            })),
          }
        },
        remove: (id) => audio.removeDownload(Number(id)),
        levels: (id) => audio.trackLevels(Number(id), true),
      }
    )
    await Promise.all([
      useLibraryStore.getState().activateProvider(provider),
      activateMetadataCache(provider),
    ])
    if (!ownsRequest()) {
      await provider.disconnect()
      return
    }
    useOfflineStatusStore.getState().activate(provider.cacheScope ?? null, true)
    useProviderStore.getState().setProvider(provider)
  },
  activateProvider: async (provider, context, section, ownsRequest) => {
    await Promise.all([
      useLibraryStore.getState().activateProvider(provider),
      activateMetadataCache(provider),
    ])
    if (!ownsRequest()) return
    useOfflineStatusStore.getState().activate(provider.cacheScope ?? null)
    useProviderStore.getState().setProvider(provider)
    wsManager = new PlexWebSocketManager()
    wsManager.connect(context.baseUrl, context.token, section.key)
    void provider.resumeDownloads?.().catch(() => {})
  },
})
