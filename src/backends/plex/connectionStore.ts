import { listen } from "@tauri-apps/api/event"
import {
  catalogueHealth,
  projectOfflineAvailability,
} from "../../offline/catalogue"
import { useCatalogueStore } from "../../offline/catalogueStore"
import { createCatalogueRefreshQueue } from "../../offline/catalogueUpdates"
import type { MusicProvider } from "../../providers/types"
import type { PlexRequestContext } from "./scopedApi"
import { PlexProvider } from "./provider"
import { useSearchStore } from "../../stores/searchStore"
import { useOfflineStatusStore } from "../../offline/statusStore"
import { createOfflineProvider } from "../../offline/providerCache"
import { expireMetadataEvents } from "../../offline/metadataEvents"
import { createCollectionCacheProvider } from "../../offline/collectionCache"
import { createSavedLibraryProvider } from "../../offline/offlineProvider"
import { createPlexApi } from "./scopedApi"
import { localAudioTrack } from "../../offline/audio"
import { createFavoritesNative } from "../../favorites/native"
import { plexTrackToMusicTrack } from "./mappers"
import { buildPlexImageUrl } from "./imageUrl"
import {
  createNativeOfflineCache,
  restoreOfflineContext,
} from "../../offline/nativeCache"
import { useProviderStore } from "../../stores/providerStore"
import {
  activateMetadataCache,
  disconnectMetadataCache,
  clearMetadataCache,
  expireMetadataItem,
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
let stopMonitor: (() => void) | null = null
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    stopMonitor?.()
    wsManager?.disconnect()
  })
function savedProvider(
  context: PlexRequestContext,
  baseUrl: string,
  owns: () => boolean,
  sectionId: number
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
  const saved = createSavedLibraryProvider(
    context.cacheScope,
    cache,
    owns,
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
    },
    createFavoritesNative(context, sectionId, undefined, owns, async (rows) => {
      const tracks = rows.map((row) =>
        plexTrackToMusicTrack(
          row,
          (path, type, id, name, artist) =>
            buildPlexImageUrl(
              baseUrl,
              "native-owned",
              type,
              id,
              path,
              name,
              artist,
              context.cacheScope
            ) ?? ""
        )
      )
      return (await projectOfflineAvailability(
        context,
        tracks
      )) as import("../../types/music").MusicTrack[]
    })
  )
  return Object.assign(saved, {
    matchingIndexStatus: audio.matchingIndexStatus,
    matchingResolve: audio.matchingResolve,
    matchingReverse: audio.matchingReverse,
    matchingRows: audio.matchingRows,
    matchingChanges: audio.matchingChanges,
    matchingFallback: audio.matchingFallback,
    matchingIndexControl: audio.matchingIndexControl,
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
    const local = savedProvider(
      requestContext,
      context.baseUrl,
      owns,
      Number(section.key)
    )
    const cachedProvider = createOfflineProvider(
      provider,
      createNativeOfflineCache(requestContext),
      {
        owns,
        isOffline: () =>
          useOfflineStatusStore.getState().scope === provider.cacheScope &&
          useOfflineStatusStore.getState().offlineMode,
        offlineProvider: local,
        projectOffline: (payload) =>
          projectOfflineAvailability(requestContext, payload),
        onOfflineRead: (notice) =>
          useOfflineStatusStore.getState().cached(provider.cacheScope!, notice),
        onOnlineRead: (key) =>
          useOfflineStatusStore.getState().online(provider.cacheScope!, key),
      }
    )
    return createCollectionCacheProvider(cachedProvider, provider, requestContext)
  },
  restoreOfflineContext,
  activateOfflineProvider: async (context, ownsRequest) => {
    const captured = {
      connectionRevision: context.revision,
      cacheScope: context.cacheScope,
    }
    useCatalogueStore.getState().activate(captured)
    const saved = savedProvider(
      captured,
      context.baseUrl,
      ownsRequest,
      context.sectionId
    )
    const provider = createCollectionCacheProvider(saved, saved, captured)
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
    const captured = {
      connectionRevision: context.revision,
      cacheScope: provider.cacheScope!,
    }
    useCatalogueStore.getState().activate(captured)
    let retired = false,
      running = false,
      revision = 0
    void createPlexApi(captured, undefined, ownsRequest).matchingIndexStart().catch(() => {})
    let stopMetadata: (() => void) | undefined
    let metadataTimer: ReturnType<typeof setTimeout> | undefined
    const changedEntities = new Map<string, {kind: "artist" | "album" | "track";id:string}>()
    let changedSearch = false
    void listen<{ cacheScope: string; connectionRevision: number; path: string; entity?: {kind: "artist" | "album" | "track";id:string} | null }>("plex://metadata", event => {
      if (retired || !ownsRequest() || event.payload.cacheScope !== captured.cacheScope || event.payload.connectionRevision !== captured.connectionRevision) return
      const entity=event.payload.entity
      if (entity) changedEntities.set(`${entity.kind}:${entity.id}`,entity)
      changedSearch ||= event.payload.path?.includes("search")
      if (metadataTimer) return
      metadataTimer=setTimeout(() => {
        metadataTimer=undefined
        if (retired || !ownsRequest()) return
        for (const entity of changedEntities.values()) expireMetadataItem(entity.kind,entity.id)
        changedEntities.clear()
        useLibraryStore.getState().invalidateLibraryTTLs()
        void useLibraryStore.getState().refreshAll()
        if (changedSearch) {
          changedSearch=false
          const search=useSearchStore.getState()
          if (search.query.trim()) void search.search(search.query)
        }
      },200)
    }).then(stop => { if (retired) stop(); else stopMetadata = stop }).catch(() => {})
    const refreshes = createCatalogueRefreshQueue(
      () =>
        !retired &&
        ownsRequest() &&
        !useOfflineStatusStore.getState().offlineMode,
      async () => {
        useLibraryStore.getState().invalidateLibraryTTLs()
        await useLibraryStore.getState().refreshAll()
        // Shelf refreshes must not remount the current detail page, search
        // results or editor whenever unrelated music is added to Plex.
      }
    )
    const startSocket = () => {
      const socket = new PlexWebSocketManager(
        undefined,
        undefined,
        async (changes, catchup) => {
          if (retired || !ownsRequest()) return
          await expireMetadataEvents(provider, changes, catchup, () => !retired && ownsRequest()).catch(() => {})
          if (retired || !ownsRequest()) return
          await createPlexApi(captured, undefined, ownsRequest)
            .matchingIndexNotify(changes.filter(change => [8, 9, 10].includes(change.type)), catchup)
            .catch(() => {})
          if (retired || !ownsRequest()) return
          // Compact matching refresh and visible browse refresh have separate
          // lifecycles; neither schedules the retired raw mirror or waveform crawl.
          refreshes.offer(++revision)
        }
      )
      socket.connect(context.baseUrl, context.token, section.key)
      return socket
    }
    wsManager = startSocket()
    void provider.resumeDownloads?.().catch(() => {})
    stopMonitor = () => {
      retired = true
      stopMetadata?.()
      clearTimeout(metadataTimer)
      clearInterval(timer)
      refreshes.stop()
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
          clearMetadataCache()
          useLibraryStore.getState().invalidateCache()
          useUIStore.getState().incrementPageRefreshKey()
          if (!healthy) {
            wsManager?.disconnect()
            wsManager = null
          } else {
            wsManager = startSocket()
            void provider.resumeDownloads?.().catch(() => {})
          }
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
