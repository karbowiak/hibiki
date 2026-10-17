import { useCallback, useLayoutEffect, useRef, useState } from "react"
import { useProviderStore } from "../stores/providerStore"
import { useUIStore } from "../stores/uiStore"
import {
  captureMetadataCache,
  isMetadataCacheCurrent,
  getCachedArtist,
  getCachedAlbum,
  loadArtistPage,
  loadAlbumPage,
  type ArtistCacheEntry,
  type AlbumCacheEntry,
} from "../stores/metadataCache"
import { retryMetadataRefresh } from "../lib/metadataLoadError"

interface PageSource<T> {
  read(id: string, deduplicate: boolean): T | undefined
  load(
    id: string,
    options: {
      force: boolean
      deduplicate: boolean
      onCore(entry: T): void
    }
  ): Promise<T>
}
const artistSource: PageSource<ArtistCacheEntry> = {
  read: getCachedArtist,
  load: loadArtistPage,
}
const albumSource: PageSource<AlbumCacheEntry> = {
  read: getCachedAlbum,
  load: loadAlbumPage,
}

/** Navigation shares prefetches; only an explicit refresh/retry supersedes a read. */
function useMetadataPage<T>(id: string | null, source: PageSource<T>) {
  const provider = useProviderStore((state) => state.provider)
  const refresh = useUIStore((state) => state.pageRefreshKey)
  const deduplicate = useUIStore((state) => state.deduplicateAlbums)
  const [entry, setEntry] = useState(() => id ? source.read(id, deduplicate) : undefined)
  const [isLoading, setIsLoading] = useState(!entry)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const previous = useRef({ provider, id, refresh, attempt })
  useLayoutEffect(() => {
    let active = true
    const session = captureMetadataCache(provider)
    const current = () => active && isMetadataCacheCurrent(session)
    const samePage =
      previous.current.provider === provider && previous.current.id === id
    const force =
      samePage &&
      (previous.current.refresh !== refresh ||
        previous.current.attempt !== attempt)
    previous.current = { provider, id, refresh, attempt }
    setError(null)
    const saved = id ? source.read(id, deduplicate) : undefined
    if (saved || !samePage) {
      setEntry(saved)
      setIsLoading(!saved)
    }
    if (!id || !provider || !session) {
      if (!id) setEntry(undefined)
      setIsLoading(false)
      return
    }
    const apply = (value: T) => {
      if (!current()) return
      setEntry(value)
      setIsLoading(false)
    }
    void retryMetadataRefresh(
      () => source.load(id, { force, deduplicate, onCore: apply }),
      current
    )
      .then(apply)
      .catch((cause) => {
        if (current()) setError(String(cause))
      })
      .finally(() => {
        if (current()) setIsLoading(false)
      })
    return () => {
      active = false
    }
  }, [id, source, provider, refresh, deduplicate, attempt])
  return {
    entry,
    isLoading,
    error,
    retry: useCallback(() => setAttempt((value) => value + 1), []),
  }
}

export const useArtistPage = (id: string | null) => useMetadataPage(id, artistSource)
export const useAlbumPage = (id: string) => useMetadataPage(id, albumSource)
