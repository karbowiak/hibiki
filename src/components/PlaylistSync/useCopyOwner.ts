import { useLayoutEffect, useRef } from "react"
import type { MusicProvider } from "../../providers/types"
import { useProviderStore } from "../../stores/providerStore"
import { useListenBrainzStore } from "../../metadata/listenbrainz/authStore"
/** Every asynchronous operation captures a view lifetime, never a later view's ownership. */
export function useCopyOwner(provider: MusicProvider | null, key: string) {
  const authenticated = useListenBrainzStore((s) => s.isAuthenticated)
  const username = useListenBrainzStore((s) => s.username)
  const scope = provider?.cacheScope,
    session = provider?.playbackSession
  const lifetime = useRef({ active: false })
  useLayoutEffect(() => {
    const view = { active: true }
    lifetime.current = view
    return () => {
      view.active = false
    }
  }, [provider, scope, session, authenticated, username, key])
  return () => {
    const view = lifetime.current
    return () =>
      view.active &&
      useProviderStore.getState().provider === provider &&
      provider?.cacheScope === scope &&
      provider?.playbackSession === session &&
      useListenBrainzStore.getState().isAuthenticated === authenticated &&
      useListenBrainzStore.getState().username === username
  }
}
