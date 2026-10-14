import { useLayoutEffect } from "react"
import { useProviderStore } from "../stores/providerStore"
import { useFavoritesStore } from "../stores/favoritesStore"
import { useListenBrainzStore } from "../metadata/listenbrainz/authStore"
import { useLastfmStore } from "../metadata/lastfm/authStore"
export function useFavorites() {
  const provider = useProviderStore((state) => state.provider)
  const lb = useListenBrainzStore((state) => state.username),
    lf = useLastfmStore((state) => state.username)
  useLayoutEffect(() => {
    let active = true,
      timer: ReturnType<typeof setTimeout> | undefined,
      debounce: ReturnType<typeof setTimeout> | undefined
    const session = provider?.playbackSession
    const current = () =>
      active &&
      useProviderStore.getState().provider === provider &&
      provider?.playbackSession === session
    async function tick() {
      try {
        await useFavoritesStore.getState().load(provider)
        if (current() && navigator.onLine !== false)
          await useFavoritesStore.getState().sync()
      } catch {
        /* Local storage and service issues are visible in Liked Songs. */
      } finally {
        if (current()) timer = setTimeout(tick, 120000)
      }
    }
    void tick()
    const unsubscribe = useFavoritesStore.subscribe((next, old) => {
      if (next.collection === old.collection || next.running || !current())
        return
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => {
        if (current())
          void useFavoritesStore
            .getState()
            .sync()
            .catch(() => {})
      }, 2000)
    })
    return () => {
      active = false
      unsubscribe()
      if (timer) clearTimeout(timer)
      if (debounce) clearTimeout(debounce)
    }
  }, [provider, provider?.playbackSession, lb, lf])
}
