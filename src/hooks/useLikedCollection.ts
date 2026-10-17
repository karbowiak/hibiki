import { useLayoutEffect, useRef, useState } from "react"
import { useLibraryStore, useUIStore } from "../stores"
import { useProviderStore } from "../stores/providerStore"

const timestamps = {
  tracks: "_likedTracksFetchedAt",
  artists: "_likedArtistsFetchedAt",
  albums: "_likedAlbumsFetchedAt",
  hubs: "_hubsFetchedAt",
  recent: "_recentlyAddedFetchedAt",
} as const

/** Requests remain owned by the current route and active library. */
export function useLibraryCollection(kind: keyof typeof timestamps) {
  const provider = useProviderStore((s) => s.provider)
  const refresh = useUIStore((s) => s.pageRefreshKey)
  const previousRefresh = useRef(refresh)
  const [attempt, setAttempt] = useState(0)
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading")
  useLayoutEffect(() => {
    const force = previousRefresh.current !== refresh || attempt > 0
    previousRefresh.current = refresh
    let active = true
    setStatus("loading")
    if (!provider)
      return () => {
        active = false
      }
    const timestamp = timestamps[kind]
    const current = () =>
      active && useProviderStore.getState().provider === provider
    void (async () => {
      try {
        const state = useLibraryStore.getState()
        const opts = { force }
        if (kind === "hubs") await state.fetchHubs(opts)
        else if (kind === "recent")
          await state.fetchRecentlyAdded(undefined, opts)
        else if (kind === "tracks")
          await state.fetchLikedTracks(undefined, opts)
        else if (kind === "artists")
          await state.fetchLikedArtists(undefined, opts)
        else await state.fetchLikedAlbums(undefined, opts)
        if (current()) {
          // Store actions contain request failures. A missing resource timestamp
          // distinguishes a failed initial load from a successfully empty result.
          setStatus(
            useLibraryStore.getState()[timestamp] === null ? "error" : "ready"
          )
        }
      } catch {
        if (current()) setStatus("error")
      }
    })()
    return () => {
      active = false
    }
  }, [provider, refresh, attempt, kind])
  return { status, retry: () => setAttempt((value) => value + 1) }
}

export const useLikedCollection = useLibraryCollection
