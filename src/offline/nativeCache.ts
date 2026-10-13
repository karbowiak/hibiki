import { invoke } from "@tauri-apps/api/core"
import type { PlexRequestContext } from "../backends/plex/scopedApi"
import type { OfflineCache, OfflineSnapshot } from "./providerCache"

export interface OfflineContext {
  revision: number
  cacheScope: string
  baseUrl: string
  machineIdentifier: string
  sectionId: number
  sectionUuid: string
  sectionTitle: string
}
export function createNativeOfflineCache(
  context: PlexRequestContext
): OfflineCache {
  const owned = Object.freeze({ ...context })
  return {
    get: (key) =>
      invoke<OfflineSnapshot | null>("offline_cache_get", {
        context: owned,
        key,
      }),
    invalidate: (prefixes) =>
      invoke<void>("offline_cache_invalidate", { context: owned, prefixes }),
    put: (key, payload) =>
      invoke<void>("offline_cache_put", { context: owned, key, payload }),
  }
}
export function restoreOfflineContext(
  revision: number
): Promise<OfflineContext> {
  return invoke("restore_offline_context", { revision })
}
