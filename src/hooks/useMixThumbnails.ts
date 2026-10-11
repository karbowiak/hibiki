import { useLayoutEffect, useState } from "react"
import type { MusicProvider } from "../providers/types"
import type { MusicItem, MusicPlaylist } from "../types/music"
import { useProviderStore } from "../stores/providerStore"

export function mixTitleToArtistName(title: string): string {
  return title.replace(/\s+(Mix|Radio|Station|Mix Radio)$/i, "").trim()
}

export function mixThumbnailKey(item: MusicPlaylist): string {
  return JSON.stringify([
    item.providerKey,
    item.id,
    item.guid,
    item.title,
    item.thumbUrl,
  ])
}

// Provider instances belong to one account/library activation. Weak ownership
// retains navigation hits without retaining departed accounts or their URLs.
const caches = new WeakMap<
  MusicProvider,
  {
    scope: string | null | undefined
    values: Map<string, string>
    searches: Map<string, Promise<string | null>>
  }
>()
function cacheFor(provider: MusicProvider) {
  let cache = caches.get(provider)
  if (!cache || cache.scope !== provider.cacheScope) {
    cache = {
      scope: provider.cacheScope,
      values: new Map(),
      searches: new Map(),
    }
    caches.set(provider, cache)
  }
  return cache
}
function searchThumbnail(provider: MusicProvider, artistName: string) {
  const cache = cacheFor(provider)
  const existing = cache.searches.get(artistName)
  if (existing) return existing
  const request = (async () => {
    const results = await provider.search(artistName, "artist")
    const artist =
      results.find(
        (item) =>
          item.type === "artist" &&
          item.title.toLowerCase() === artistName.toLowerCase()
      ) ?? results.find((item) => item.type === "artist")
    return artist?.type === "artist" ? artist.thumbUrl : null
  })()
  cache.searches.set(artistName, request)
  void request.then(
    () => {
      if (cache.searches.get(artistName) === request)
        cache.searches.delete(artistName)
    },
    () => {
      if (cache.searches.get(artistName) === request)
        cache.searches.delete(artistName)
    }
  )
  return request
}

export function useMixThumbnails(
  provider: MusicProvider | null,
  items: MusicItem[]
) {
  const [resolved, setResolved] = useState<Record<string, string>>({})
  const scope = provider?.cacheScope
  useLayoutEffect(() => {
    let active = true
    const current = () =>
      active &&
      useProviderStore.getState().provider === provider &&
      provider?.cacheScope === scope
    const mixes = items.filter(
      (item): item is MusicPlaylist & { type: "playlist" } =>
        item.type === "playlist"
    )
    const cache = provider ? cacheFor(provider) : null
    const initial = Object.fromEntries(
      mixes.flatMap((item) => {
        const key = mixThumbnailKey(item)
        const value = cache?.values.get(key)
        return value ? [[key, value]] : []
      })
    )
    setResolved(initial)
    if (provider && cache)
      void (async () => {
        const pending = mixes.filter(
          (item) => !cache.values.has(mixThumbnailKey(item))
        )
        for (let index = 0; index < pending.length && current(); index += 5) {
          const updates: Record<string, string> = {}
          await Promise.all(
            pending.slice(index, index + 5).map(async (item) => {
              const artistName = mixTitleToArtistName(item.title)
              if (!artistName) return
              try {
                const thumb = await searchThumbnail(provider, artistName)
                if (thumb && current()) updates[mixThumbnailKey(item)] = thumb
              } catch {
                // Leave normal artwork source resolution available for this item.
              }
            })
          )
          if (!current()) break
          for (const [key, thumb] of Object.entries(updates))
            cache.values.set(key, thumb)
          while (cache.values.size > 256)
            cache.values.delete(cache.values.keys().next().value!)
          if (Object.keys(updates).length)
            setResolved((previous) => ({ ...previous, ...updates }))
        }
      })()
    return () => {
      active = false
    }
  }, [provider, scope, items])
  return resolved
}
