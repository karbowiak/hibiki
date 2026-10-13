import { useLayoutEffect, useRef, useState, useCallback } from "react"
import type { MusicProvider } from "../../providers/types"
import { useProviderStore } from "../../stores/providerStore"
import { useListenBrainzStore } from "../../metadata/listenbrainz/authStore"
/** Store transitions retire operations immediately, including batched A→B→A. */
export function useCopyOwner(provider: MusicProvider | null, key: string) {
  const authenticated = useListenBrainzStore((s) => s.isAuthenticated)
  const username = useListenBrainzStore((s) => s.username)
  const scope = provider?.cacheScope,
    session = provider?.playbackSession
  const [epoch, setEpoch] = useState(0)
  const lifetime = useRef({ active: false, epoch: -1, key: "" })
  useLayoutEffect(() => {
    const view = { active: true, epoch, key }
    lifetime.current = view
    const retireProvider = useProviderStore.subscribe((next, previous) => {
      if (
        next.provider !== previous.provider ||
        next.provider?.cacheScope !== scope ||
        next.provider?.playbackSession !== session
      ) {
        view.active = false
        setEpoch((value) => value + 1)
      }
    })
    const retireAuth = useListenBrainzStore.subscribe((next, previous) => {
      if (
        next.isAuthenticated !== previous.isAuthenticated ||
        next.username !== previous.username
      ) {
        view.active = false
        setEpoch((value) => value + 1)
      }
    })
    return () => {
      view.active = false
      retireProvider()
      retireAuth()
    }
  }, [provider, scope, session, authenticated, username, key, epoch])
  return useCallback(() => {
    const view = lifetime.current
    return () =>
      view.active &&
      view.epoch === epoch &&
      view.key === key &&
      useProviderStore.getState().provider === provider &&
      provider?.cacheScope === scope &&
      provider?.playbackSession === session &&
      useListenBrainzStore.getState().isAuthenticated === authenticated &&
      useListenBrainzStore.getState().username === username
  }, [provider, scope, session, authenticated, username, key, epoch])
}
