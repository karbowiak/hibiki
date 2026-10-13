import { invoke } from "@tauri-apps/api/core"
import type { PlexRequestContext } from "../backends/plex/scopedApi"
import { catalogueRead } from "./catalogue"
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
/** A partial scan cannot replace a previously captured full visited result. */
export function selectOfflineSnapshot(
  exact: OfflineSnapshot | null,
  catalogue: (OfflineSnapshot & { catalogueComplete?: boolean }) | null
): OfflineSnapshot | null {
  if (!catalogue) return exact
  if (exact && catalogue.catalogueComplete === false) return exact
  return !exact || catalogue.cachedAt > exact.cachedAt ? catalogue : exact
}
export function createNativeOfflineCache(
  context: PlexRequestContext,
  baseUrl?: string
): OfflineCache {
  const owned = Object.freeze({ ...context })
  return {
    get: async (key) => {
      const exact = await invoke<OfflineSnapshot | null>("offline_cache_get", {
        context: owned,
        key,
      })
      if (!baseUrl) return exact
      const catalogue = await catalogueRead(owned, baseUrl, key).catch(
        () => null
      )
      return selectOfflineSnapshot(exact, catalogue)
    },
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
