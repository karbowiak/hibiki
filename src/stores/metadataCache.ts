import { createMetadataCache } from "./metadataCacheCore"
import { idbStorage } from "./idbStorage"
import { useProviderStore } from "./providerStore"
import { useUIStore } from "./uiStore"
import { playbackMetadata } from "../audio/playbackMetadata"
export type { ArtistCacheEntry, AlbumCacheEntry, MetadataCacheSession } from "./metadataCacheCore"

const metadata = createMetadataCache({
  getProvider: () => useProviderStore.getState().provider,
  storage: idbStorage,
  deduplicate: () => useUIStore.getState().deduplicateAlbums
})
export const getCachedArtist = metadata.getArtist
export const getCachedAlbum = metadata.getAlbum
export const loadArtistPage = metadata.loadArtist
export const loadAlbumPage = metadata.loadAlbum
export const captureMetadataCache = metadata.capture
export const isMetadataCacheCurrent = metadata.current
export const activateMetadataCache = metadata.activate
export const disconnectMetadataCache = metadata.disconnect
export const clearMetadataCache = metadata.clear
export const invalidateMetadataItem: typeof metadata.invalidate = (...args) => {
  const provider = useProviderStore.getState().provider
  if (provider) playbackMetadata.invalidate(provider)
  return metadata.invalidate(...args)
}
export const getMetadataCacheStats = metadata.stats
export const prefetchArtist = metadata.prefetchArtist
export const prefetchAlbum = metadata.prefetchAlbum

export const refreshMetadataCache = metadata.refresh
