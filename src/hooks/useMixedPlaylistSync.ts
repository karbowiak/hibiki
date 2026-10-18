import { useEffect } from "react"
import { useMixedPlaylistStore } from "../stores/mixedPlaylistStore"
import { useProviderStore } from "../stores/providerStore"
import { useYoutubeMusicDiscoveryStore } from "../backends/ytmusic/discovery"
import { useListenBrainzStore } from "../metadata/listenbrainz/authStore"
import { subscribeMatchingUpdates } from "../matching/updates"
import { createMatchingConsumer } from "../matching/consumerQueue"
import { counterpartPending } from "../mixedPlaylists/matching"
import { playlistServices } from "../mixedPlaylists/model"
import { playlistNeedsIndexCheck } from "../mixedPlaylists/indexUpdates"
import type { MatchingUpdate } from "../matching/updates"

/** Resumable bounded jobs, round-robin; no library-wide matching scan. */
export function useMixedPlaylistSync() {
  const provider = useProviderStore(state => state.provider)
  const scope = provider?.cacheScope, session = provider?.playbackSession
  const account = useYoutubeMusicDiscoveryStore(state => state.connected ? state.accountId : null)
  const external = useListenBrainzStore(state => state.isAuthenticated)
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout>, initialCheck = true
    const matching = createMatchingConsumer(update => useMixedPlaylistStore.getState().retryIndexedMatches(update))
    const offerMatching = (update?: MatchingUpdate) => {
      if (!active || !provider?.matchingResolve || provider.isOffline || update && update.provider !== provider) return
      const relevant = useMixedPlaylistStore.getState().playlists.some(item => item.owners.plex === scope &&
        item.owners.ytmusic === (account ?? undefined) && playlistNeedsIndexCheck(item, update))
      if (relevant) matching.offer(update)
    }
    const unsubscribe = subscribeMatchingUpdates(offerMatching)
    const checked = new Map<string, number>()
    const tick = async () => {
      try {
        await useMixedPlaylistStore.getState().load()
        if (!active) return
        if (initialCheck) { initialCheck = false; offerMatching() }
        const playlist = useMixedPlaylistStore.getState().playlists.filter(item => item.automatic &&
          (item.merge || item.items.length || Object.keys(item.providers).length) &&
          Object.entries(item.owners).every(([side, owner]) => side === "plex" ? owner === scope && (!provider?.isOffline || external && item.external?.listenbrainz.enabled && item.external.listenbrainz.automatic) : owner === account) &&
          item.items.every(row => item.owners[row.original]))
          .filter(item => {
            const pending = item.items.some(row => playlistServices(item).some(service => counterpartPending(row, service)))
            return Date.now() - (checked.get(item.id) ?? 0) >= (item.status === "syncing" || pending ? 15000 : 120000)
          })
          .sort((a, b) => (checked.get(a.id) ?? 0) - (checked.get(b.id) ?? 0))[0]
        if (playlist && !useMixedPlaylistStore.getState().running[playlist.id]) {
          checked.set(playlist.id, Date.now())
          await useMixedPlaylistStore.getState().sync(playlist.id)
        }
      } catch { /* The retained playlist exposes any actionable failure. */ }
      finally { if (active) timer = setTimeout(tick, 15000) }
    }
    void tick()
    return () => { active = false; clearTimeout(timer); unsubscribe(); matching.stop() }
  }, [provider, scope, session, account, external])
}
