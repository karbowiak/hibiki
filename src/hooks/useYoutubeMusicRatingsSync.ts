import { useEffect } from "react"
import { useYoutubeMusicDiscoveryStore } from "../backends/ytmusic/discovery"
import { useYoutubeMusicRatingsStore, currentRatingOwners, ratingNeedsSync } from "../backends/ytmusic/ratings"
import { useProviderStore } from "../stores/providerStore"
import { useLastfmStore } from "../metadata/lastfm/authStore"
import { useListenBrainzStore } from "../metadata/listenbrainz/authStore"
import { subscribeMatchingUpdates } from "../matching/updates"
import { createMatchingConsumer } from "../matching/consumerQueue"
import { matchingUpdateAffectsRecording, type MatchingUpdate } from "../matching/updates"

export function useYoutubeMusicRatingsSync() {
  const owner = useYoutubeMusicDiscoveryStore(state => state.connected ? state.accountId : null)
  const provider = useProviderStore(state => state.provider)
  const lastfm = useLastfmStore(state => state.isAuthenticated ? state.username : null)
  const listenbrainz = useListenBrainzStore(state => state.isAuthenticated ? state.username : null)
  useEffect(() => {
    if (!owner) return
    let active = true, timer: ReturnType<typeof setTimeout>, initialCheck = true
    const matching = createMatchingConsumer(update => useYoutubeMusicRatingsStore.getState().retryPlexMatches(update))
    const offerMatching = (update?: MatchingUpdate) => {
      if (!active || !provider?.matchingResolve || provider.isOffline || update && update.provider !== provider) return
      const state = useYoutubeMusicRatingsStore.getState()
      if (state.loaded && state.owner === owner && Object.values(state.entries).some(entry =>
        entry.plexOwner === provider.cacheScope && entry.saved.plex !== provider.cacheScope &&
        (!update || matchingUpdateAffectsRecording(update, entry.track)))) matching.offer(update)
    }
    const unsubscribe = subscribeMatchingUpdates(offerMatching)
    const tick = async () => {
      try {
        await useYoutubeMusicRatingsStore.getState().load(owner)
        if (!active) return
        if (initialCheck) { initialCheck = false; offerMatching() }
        const state = useYoutubeMusicRatingsStore.getState(), owners = currentRatingOwners()
        if (Object.values(state.entries).some(entry => ratingNeedsSync(entry, owners))) await state.resume()
      } catch { /* Exact stars remain retained; controls expose pending sync. */ }
      finally { if (active) timer = setTimeout(tick, 60000) }
    }
    void tick()
    return () => { active = false; clearTimeout(timer); unsubscribe(); matching.stop() }
  }, [owner, provider, provider?.playbackSession, provider?.cacheScope, lastfm, listenbrainz])
}
