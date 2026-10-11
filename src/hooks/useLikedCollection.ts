import { useLayoutEffect, useState } from "react"
import { useLibraryStore, useUIStore } from "../stores"
import { useProviderStore } from "../stores/providerStore"

const resources = {
  tracks: ["fetchLikedTracks", "_likedTracksFetchedAt"],
  artists: ["fetchLikedArtists", "_likedArtistsFetchedAt"],
  albums: ["fetchLikedAlbums", "_likedAlbumsFetchedAt"],
} as const

/** Each liked route requests its own collection when the active library changes. */
export function useLikedCollection(kind: keyof typeof resources) {
  const provider = useProviderStore((s) => s.provider)
  const refresh = useUIStore((s) => s.pageRefreshKey)
  const [attempt, setAttempt] = useState(0)
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading")
  useLayoutEffect(() => {
    let active = true
    setStatus("loading")
    if (!provider)
      return () => {
        active = false
      }
    const [action, timestamp] = resources[kind]
    const current = () =>
      active && useProviderStore.getState().provider === provider
    void (async () => {
      try {
        await useLibraryStore
          .getState()
          [action](undefined, { force: attempt > 0 })
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
