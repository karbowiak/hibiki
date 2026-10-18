import { useEffect } from "react"
import { useMixedPlaylistStore } from "../stores/mixedPlaylistStore"
import { useProviderStore } from "../stores/providerStore"
import { useYoutubeMusicDiscoveryStore } from "../backends/ytmusic/discovery"
import { useListenBrainzStore } from "../metadata/listenbrainz/authStore"
import { subscribeMatchingUpdates } from "../matching/updates"
import { createMatchingConsumer } from "../matching/consumerQueue"
import { mixedWriteCanRecover } from "../mixedPlaylists/model"
import { nextPlaylistSyncAt } from "../mixedPlaylists/schedule"
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
        if (!useMixedPlaylistStore.getState().loaded) await useMixedPlaylistStore.getState().load()
        if (!active) return
        if (initialCheck) { initialCheck = false; offerMatching() }
        const playlist = useMixedPlaylistStore.getState().playlists.filter(item => (item.automatic || mixedWriteCanRecover(item)) &&
          (item.merge || item.items.length || Object.keys(item.providers).length) &&
          Object.entries(item.owners).every(([side, owner]) => side === "plex" ? owner === scope && (!provider?.isOffline || external && item.external?.listenbrainz.enabled && item.external.listenbrainz.automatic) : owner === account) &&
          item.items.every(row => item.owners[row.original]))
          .filter(item => Date.now() >= nextPlaylistSyncAt(item, checked.get(item.id)))
          .sort((a, b) => nextPlaylistSyncAt(a, checked.get(a.id)) - nextPlaylistSyncAt(b, checked.get(b.id)))[0]
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
