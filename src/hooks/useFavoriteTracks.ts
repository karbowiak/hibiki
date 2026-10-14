import { useEffect, useMemo, useState } from "react"
import { useFavoritesStore } from "../stores/favoritesStore"
import { useProviderStore } from "../stores/providerStore"
import type { MusicTrack } from "../types/music"
import { favoriteTracks } from "../favorites/collection"

/** Publish local pages immediately; bounded fallback requests never block the table. */
export function useFavoriteTracks(rated: MusicTrack[]) {
  const provider = useProviderStore((state) => state.provider)
  const collection = useFavoritesStore((state) => state.collection)
  const session = provider?.playbackSession
  const [cache, setCache] = useState<{
    owner: unknown
    provider: unknown
    tracks: Map<string, MusicTrack>
  }>({ owner: null, provider: null, tracks: new Map() })
  const [loading, setLoading] = useState(false),
    [attempt, setAttempt] = useState(0)
  const ids = useMemo(
    () => [
      ...new Set(
        Object.values(collection.entries)
          .filter((item) => item.liked)
          .flatMap((item) => item.localTrackIds)
      ),
    ],
    [collection.entries]
  )
  const idKey = ids.join(",")
  useEffect(() => {
    let active = true
    const current = () =>
      active &&
      useProviderStore.getState().provider === provider &&
      provider?.playbackSession === session
    const tracks = new Map(
      cache.provider === provider && cache.owner === session ? cache.tracks : []
    )
    rated.forEach((track) => tracks.set(track.id, track))
    const missing = ids.filter((id) => !tracks.has(id))
    if (!provider || !missing.length) {
      setLoading(false)
      return
    }
    setLoading(true)
    const publish = () => {
      if (current())
        setCache({ provider, owner: session, tracks: new Map(tracks) })
    }
    void (async () => {
      try {
        const native = provider.favorites
        if (native?.cachedTracks)
          for (let offset = 0; offset < missing.length; offset += 200) {
            const rows = await native.cachedTracks(
              missing.slice(offset, offset + 200)
            )
            if (!current()) return
            rows.forEach((track) => tracks.set(track.id, track))
            publish()
          }
        const uncached = missing.filter((id) => !tracks.has(id)).slice(0, 20)
        for (let offset = 0; offset < uncached.length; offset += 4) {
          const rows = await Promise.allSettled(
            uncached
              .slice(offset, offset + 4)
              .map((id) => provider.getTrack(id))
          )
          if (!current()) return
          rows.forEach((row) => {
            if (row.status === "fulfilled") tracks.set(row.value.id, row.value)
          })
          publish()
        }
      } finally {
        if (current()) setLoading(false)
      }
    })().catch(() => {})
    return () => {
      active = false
    }
    // Cache publication is not a new fetch request. Membership, ratings and retry are.
  }, [provider, session, idKey, rated, attempt])
  const tracks = useMemo(() => {
    const available = new Map(
      cache.provider === provider && cache.owner === session ? cache.tracks : []
    )
    rated.forEach((track) => available.set(track.id, track))
    return favoriteTracks(collection, available, !!provider?.isOffline)
  }, [collection, cache, rated, provider, session])
  return { tracks, loading, retry: () => setAttempt((value) => value + 1) }
}
