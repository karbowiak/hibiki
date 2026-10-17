import { useEffect, useState } from "react"
import { useFavoritesStore } from "../stores/favoritesStore"
import { useProviderStore } from "../stores/providerStore"
import type { MusicTrack } from "../types/music"

const EMPTY_ITEMS: never[] = []

/** Metadata-dependent sorting reads cached favorites only, in bounded native batches. */
export function useFavoriteIndex(enabled: boolean) {
  const provider = useProviderStore((state) => state.provider)
  const entries = useFavoritesStore((state) => state.collection.entries)
  const [state, setState] = useState<{
    owner: unknown
    entries: unknown
    tracks: MusicTrack[]
    ready: boolean
  }>({ owner: null, entries: null, tracks: [], ready: false })
  useEffect(() => {
    if (!enabled || !provider) return
    let active = true
    const session = provider.playbackSession
    const ids = [
      ...new Set(
        Object.values(entries)
          .filter((entry) => entry.liked || entry.rating?.value != null)
          .flatMap((entry) => entry.localTrackIds)
      ),
    ]
    const current = () =>
      active &&
      provider === useProviderStore.getState().provider &&
      session === provider.playbackSession
    setState((previous) =>
      previous.owner === provider && previous.ready
        ? previous
        : { owner: provider, entries, tracks: [], ready: false }
    )
    void (async () => {
      const tracks: MusicTrack[] = []
      if (provider.favorites?.cachedTracks)
        for (let offset = 0; offset < ids.length; offset += 200) {
          const rows = await provider.favorites.cachedTracks(
            ids.slice(offset, offset + 200)
          )
          if (!current()) return
          tracks.push(...rows)
          await new Promise((resolve) => setTimeout(resolve, 0))
        }
      if (current()) setState({ owner: provider, entries, tracks, ready: true })
    })().catch(() => {
      if (current())
        setState({ owner: provider, entries, tracks: [], ready: true })
    })
    return () => {
      active = false
    }
  }, [enabled, provider, entries])
  return state.owner === provider
    ? state
    : { tracks: EMPTY_ITEMS, ready: false }
}
