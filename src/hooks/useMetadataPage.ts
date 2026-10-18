import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
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
  invalidateMetadataItem,
} from "../stores/metadataCache"
import { retryMetadataRefresh } from "../lib/metadataLoadError"
import { subscribeMatchingUpdates } from "../matching/updates"

interface PageSource<T> {
  kind: "artist" | "album"
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
  kind: "artist",
  read: getCachedArtist,
  load: loadArtistPage,
}
const albumSource: PageSource<AlbumCacheEntry> = {
  kind: "album",
  read: getCachedAlbum,
  load: loadAlbumPage,
}

/** Navigation shares prefetches; only an explicit refresh/retry supersedes a read. */
function useMetadataPage<T extends { fetchedAt: number }>(id: string | null, source: PageSource<T>) {
  const provider = useProviderStore((state) => state.provider)
  const ownerSession = provider?.playbackSession, ownerScope = provider?.cacheScope
  const refresh = useUIStore((state) => state.pageRefreshKey)
  const deduplicate = useUIStore((state) => state.deduplicateAlbums)
  const [entry, setEntry] = useState(() => id ? source.read(id, deduplicate) : undefined)
  const [isLoading, setIsLoading] = useState(!entry)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const previous = useRef({ provider, ownerSession, ownerScope, id, refresh, attempt })
  useEffect(() => {
    let admitted = 0
    if (!provider || !id) return
    return subscribeMatchingUpdates(update => {
      if (update.provider !== provider || useProviderStore.getState().provider !== provider || provider.playbackSession !== ownerSession || provider.cacheScope !== ownerScope) return
      const last = Math.max(admitted, source.read(id, deduplicate)?.fetchedAt ?? 0)
      const changed = update.changes.filter(change => (change.removed || (change.observed ?? 0) > last) &&
        (change.kind === source.kind && String(change.id) === id || source.kind === "artist" && String(change.artistId) === id || source.kind === "album" && String(change.albumId) === id))
      if (!changed.length) return
      admitted = Math.max(...changed.map(change => change.observed ?? 0))
      invalidateMetadataItem(source.kind, id)
      setAttempt(value => value + 1)
    })
  }, [provider, ownerSession, ownerScope, id, source, deduplicate])
  useLayoutEffect(() => {
    let active = true
    const session = captureMetadataCache(provider)
    const current = () => active && isMetadataCacheCurrent(session)
    const samePage =
      previous.current.provider === provider && previous.current.id === id && previous.current.ownerSession === ownerSession && previous.current.ownerScope === ownerScope
    const force =
      samePage &&
      (previous.current.refresh !== refresh ||
        previous.current.attempt !== attempt)
    previous.current = { provider, ownerSession, ownerScope, id, refresh, attempt }
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
  }, [id, source, provider, ownerSession, ownerScope, refresh, deduplicate, attempt])
  return {
    entry,
    isLoading,
    error,
    retry: useCallback(() => setAttempt((value) => value + 1), []),
  }
}

export const useArtistPage = (id: string | null) => useMetadataPage(id, artistSource)
export const useAlbumPage = (id: string) => useMetadataPage(id, albumSource)
