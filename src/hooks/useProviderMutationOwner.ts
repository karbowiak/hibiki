import { useCallback, useEffect, useRef } from "react"
import type { MusicProvider } from "../providers/types"
import { useProviderStore } from "../stores/providerStore"

/** Accepted requests may finish, but retired views cannot publish their results. */
export function useProviderMutationOwner(provider: MusicProvider | null) {
  const lifetime = useRef({ mounted: true, epoch: 0 })
  useEffect(() => {
    lifetime.current.mounted = true
    let previous = useProviderStore.getState().provider
    const unsubscribe = useProviderStore.subscribe(state => {
      if (state.provider !== previous) {
        previous = state.provider
        ++lifetime.current.epoch
      }
    })
    return () => { lifetime.current.mounted = false; ++lifetime.current.epoch; unsubscribe() }
  }, [])
  return useCallback(() => {
    const epoch = lifetime.current.epoch
    return () => lifetime.current.mounted && lifetime.current.epoch === epoch
      && provider !== null && useProviderStore.getState().provider === provider
  }, [provider])
}
