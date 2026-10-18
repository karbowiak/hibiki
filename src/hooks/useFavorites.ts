import { useLayoutEffect } from "react"
import { useProviderStore } from "../stores/providerStore"
import { useFavoritesStore } from "../stores/favoritesStore"
import { useListenBrainzStore } from "../metadata/listenbrainz/authStore"
import { useLastfmStore } from "../metadata/lastfm/authStore"
import { favoriteMatchBacklog } from "../favorites/matchingProgress"
import { pendingFavoriteSync } from "../favorites/work"
const IMPORT_INTERVAL = 60 * 60_000
export function useFavorites() {
  const provider = useProviderStore((state) => state.provider)
  const lb = useListenBrainzStore((state) => state.username),
    lf = useLastfmStore((state) => state.username)
  useLayoutEffect(() => {
    let active = true,
      timer: ReturnType<typeof setTimeout> | undefined,
      debounce: ReturnType<typeof setTimeout> | undefined,
      matchTimer: ReturnType<typeof setTimeout> | undefined,
      syncing = false, syncAgain = false, refreshAgain = false, matching = false
    const session = provider?.playbackSession
    const current = () =>
      active &&
      useProviderStore.getState().provider === provider &&
      provider?.playbackSession === session
    async function sync(refresh = false) {
      if (!current() || navigator.onLine === false) return
      if (syncing) { syncAgain = true; refreshAgain ||= refresh; return }
      syncing = true
      const before = pendingFavoriteSync(useFavoritesStore.getState().collection)
      try { await useFavoritesStore.getState().sync({ refresh }) }
      catch { /* Saved intent is retried by the next scheduled pass. */ }
      finally {
        syncing = false
        if (current()) {
          scheduleMatching()
          const remaining = pendingFavoriteSync(useFavoritesStore.getState().collection)
          if (syncAgain || remaining) {
            const again = syncAgain, nextRefresh = refreshAgain
            syncAgain = false; refreshAgain = false
            scheduleSync(again || refresh || remaining < before ? 2000 : 120000, nextRefresh)
          }
        }
      }
    }
    function scheduleSync(delay = 2000, refresh = false) {
      refreshAgain ||= refresh
      clearTimeout(debounce)
      debounce = setTimeout(() => {
        debounce = undefined
        const requestedRefresh = refreshAgain; refreshAgain = false
        void sync(requestedRefresh)
      }, delay)
    }
    function scheduleMatching(delay = 2000) {
      if (!current() || matching || matchTimer || !useFavoritesStore.getState().loaded ||
        !Object.values(useFavoritesStore.getState().collection.settings).some(value => value === true) ||
        !favoriteMatchBacklog(useFavoritesStore.getState().collection).length) return
      matchTimer = setTimeout(async () => {
        matchTimer = undefined
        if (!current() || navigator.onLine === false) return
        if (syncing) { scheduleMatching(); return }
        const before = favoriteMatchBacklog(useFavoritesStore.getState().collection).length
        matching = true
        try { await useFavoritesStore.getState().matchMissing() }
        catch { /* Resume saved matching checkpoints on the next turn. */ }
        finally {
          matching = false
          if (current()) {
            const remaining = favoriteMatchBacklog(useFavoritesStore.getState().collection).length
            // Drain bounded matching jobs, without rereading every remote likes
            // roster between batches. A stalled turn backs off instead of loops.
            if (remaining) scheduleMatching(remaining < before ? 2000 : 120000)
            else if (before && pendingFavoriteSync(useFavoritesStore.getState().collection)) scheduleSync()
          }
        }
      }, delay)
    }
    async function tick() {
      try {
        await useFavoritesStore.getState().load(provider)
        if (current() && navigator.onLine !== false)
          await sync(true)
      } catch {
        /* Local storage and service issues are visible in Liked Songs. */
      } finally {
        if (current()) timer = setTimeout(tick, IMPORT_INTERVAL)
      }
    }
    void tick()
    const unsubscribe = useFavoritesStore.subscribe((next, old) => {
      if (!current()) return
      if (next.syncRequest !== old.syncRequest) scheduleSync()
      if (next.collection !== old.collection) {
        scheduleMatching()
        // Newly resolved recording IDs can be exported immediately. Imports and
        // acknowledgements in the running sync are already handled by its drain.
        if (!syncing && pendingFavoriteSync(next.collection) > pendingFavoriteSync(old.collection)) scheduleSync()
      }
    })
    return () => {
      active = false
      unsubscribe()
      if (timer) clearTimeout(timer)
      if (debounce) clearTimeout(debounce)
      if (matchTimer) clearTimeout(matchTimer)
    }
  }, [provider, provider?.playbackSession, lb, lf])
}
