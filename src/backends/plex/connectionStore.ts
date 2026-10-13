import {
  catalogueStart,
  catalogueHealth,
  catalogueProgress,
  projectOfflineAvailability,
} from "../../offline/catalogue"
import { useCatalogueStore } from "../../offline/catalogueStore"
import type { MusicProvider } from "../../providers/types"
import type { PlexRequestContext } from "./scopedApi"
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
  refreshMetadataCache,
} from "../../stores/metadataCache"
import { useSearchStore } from "../../stores/searchStore"
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
let stopMonitor: (() => void) | null = null
function savedProvider(
  context: PlexRequestContext,
  baseUrl: string,
  owns: () => boolean
): MusicProvider {
  const native = createNativeOfflineCache(context, baseUrl)
  const cache = {
    ...native,
    get: async (key: string) => {
      const saved = await native.get(key)
      if (saved)
        saved.payload = await projectOfflineAvailability(context, saved.payload)
      return saved
    },
  }
  const audio = createPlexApi(context, undefined, owns)
  const project = (track: import("../../types/music").MusicTrack) =>
    localAudioTrack(track, baseUrl, context.cacheScope)
  return createSavedLibraryProvider(context.cacheScope, cache, owns, {
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
  })
}

export const useConnectionStore = createPlexConnectionStore({
  connectPlex,
  disconnectPlex,
  loadSettings,
  saveSettings,
  testServerConnection,
  startPlexAuth: plexAuthStart,
  clearSession: () => {
    stopMonitor?.()
    stopMonitor = null
    useCatalogueStore.getState().activate(null)
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
    const requestContext = {
      connectionRevision: context.revision,
      cacheScope: provider.cacheScope!,
    }
    const owns = () =>
      provider.isConnected() &&
      provider.cacheScope === requestContext.cacheScope
    const local = savedProvider(requestContext, context.baseUrl, owns)
    return createOfflineProvider(
      provider,
      createNativeOfflineCache(requestContext, context.baseUrl),
      {
        owns,
        localFirst: true,
        isOffline: () =>
          useOfflineStatusStore.getState().scope === provider.cacheScope &&
          useOfflineStatusStore.getState().offlineMode,
        offlineProvider: local,
        projectOffline: (payload) =>
          projectOfflineAvailability(requestContext, payload),
        onRefresh: (method, args, payload) => {
          if (!owns()) return
          useLibraryStore.getState().acceptLocalRefresh(method, args, payload)
          if (method === "search" && args[1] == null)
            useSearchStore
              .getState()
              .acceptLocalRefresh(
                provider.cacheScope!,
                provider.playbackSession,
                String(args[0]),
                payload as import("../../types/music").MusicItem[]
              )
          if (method === "getItemsByTag")
            useUIStore.getState().incrementPageRefreshKey()
          if (refreshMetadataCache(method, args, payload))
            useUIStore.getState().incrementPageRefreshKey()
        },
        onOfflineRead: (notice) =>
          useOfflineStatusStore.getState().cached(provider.cacheScope!, notice),
        onOnlineRead: (key) =>
          useOfflineStatusStore.getState().online(provider.cacheScope!, key),
      }
    )
  },
  restoreOfflineContext,
  activateOfflineProvider: async (context, ownsRequest) => {
    const captured = {
      connectionRevision: context.revision,
      cacheScope: context.cacheScope,
    }
    useCatalogueStore.getState().activate(captured)
    void catalogueProgress(captured)
      .then((progress) => {
        if (ownsRequest())
          useCatalogueStore.getState().update(captured, progress)
      })
      .catch(() => {})
    const provider = savedProvider(captured, context.baseUrl, ownsRequest)
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
    const captured = {
      connectionRevision: context.revision,
      cacheScope: provider.cacheScope!,
    }
    useCatalogueStore.getState().activate(captured)
    let retired = false,
      running = false,
      lastStart = 0
    stopMonitor = () => {
      retired = true
      clearInterval(timer)
    }
    const probe = async () => {
      if (retired || running || !ownsRequest()) return
      running = true
      try {
        const healthy = await catalogueHealth(captured)
        if (retired || !ownsRequest()) return
        const status = useOfflineStatusStore.getState()
        if (status.offlineMode === healthy) {
          status.activate(provider.cacheScope!, !healthy)
          useConnectionStore.setState({
            isOffline: !healthy,
            isConnected: healthy,
          })
          // Same playback owner/session survives network loss; consumers receive
          // reactive capabilities and availability while active audio continues.
          useProviderStore.getState().setProvider(provider)
          useLibraryStore.getState().invalidateCache()
          useUIStore.getState().incrementPageRefreshKey()
          if (!healthy) {
            wsManager?.disconnect()
            wsManager = null
          } else {
            wsManager = new PlexWebSocketManager()
            wsManager.connect(context.baseUrl, context.token, section.key)
            void provider.resumeDownloads?.().catch(() => {})
          }
        }
        const progress = await catalogueProgress(captured)
        if (!retired && ownsRequest())
          useCatalogueStore.getState().update(captured, progress)
        if (healthy && Date.now() - lastStart > 60_000) {
          lastStart = Date.now()
          await catalogueStart(captured)
        }
      } catch {
        /* A retired native revision cannot alter availability. */
      } finally {
        running = false
      }
    }
    const timer = setInterval(() => void probe(), 15_000)
    void probe()
  },
})
