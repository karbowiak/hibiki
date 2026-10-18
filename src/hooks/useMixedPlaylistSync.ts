import { useEffect } from "react"
import { useMixedPlaylistStore } from "../stores/mixedPlaylistStore"
import { useProviderStore } from "../stores/providerStore"
import { useYoutubeMusicDiscoveryStore } from "../backends/ytmusic/discovery"
import { useListenBrainzStore } from "../metadata/listenbrainz/authStore"
import { subscribeMatchingUpdates } from "../matching/updates"
import { createMatchingConsumer } from "../matching/consumerQueue"

/** Resumable bounded jobs, round-robin; no library-wide matching scan. */
export function useMixedPlaylistSync() {
  const provider = useProviderStore(state => state.provider)
  const scope = provider?.cacheScope, session = provider?.playbackSession
  const account = useYoutubeMusicDiscoveryStore(state => state.connected ? state.accountId : null)
  const external = useListenBrainzStore(state => state.isAuthenticated)
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout>
    const matching = createMatchingConsumer(update => useMixedPlaylistStore.getState().retryIndexedMatches(update))
    const unsubscribe = subscribeMatchingUpdates(update => matching.offer(update))
    const checked = new Map<string, number>()
    const tick = async () => {
      try {
        await useMixedPlaylistStore.getState().load()
        if (!active) return
        matching.offer()
        const playlist = useMixedPlaylistStore.getState().playlists.filter(item => item.automatic &&
          (item.items.length || Object.keys(item.providers).length) &&
          Object.entries(item.owners).every(([side, owner]) => side === "plex" ? owner === scope && (!provider?.isOffline || external && item.external?.listenbrainz.enabled && item.external.listenbrainz.automatic) : owner === account) &&
          item.items.every(row => item.owners[row.original]))
          .sort((a, b) => (checked.get(a.id) ?? 0) - (checked.get(b.id) ?? 0))[0]
        if (playlist && Date.now() - (checked.get(playlist.id) ?? 0) >= (playlist.status === "syncing" ? 15000 : 120000)) {
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
