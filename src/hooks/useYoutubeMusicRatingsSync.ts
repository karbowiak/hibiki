import { useEffect } from "react"
import { useYoutubeMusicDiscoveryStore } from "../backends/ytmusic/discovery"
import { useYoutubeMusicRatingsStore } from "../backends/ytmusic/ratings"
import { useProviderStore } from "../stores/providerStore"
import { useLastfmStore } from "../metadata/lastfm/authStore"
import { useListenBrainzStore } from "../metadata/listenbrainz/authStore"

export function useYoutubeMusicRatingsSync() {
  const owner = useYoutubeMusicDiscoveryStore(state => state.connected ? state.accountId : null)
  const provider = useProviderStore(state => state.provider)
  const lastfm = useLastfmStore(state => state.isAuthenticated ? state.username : null)
  const listenbrainz = useListenBrainzStore(state => state.isAuthenticated ? state.username : null)
  useEffect(() => {
    if (!owner) return
    let active = true, timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      try {
        await useYoutubeMusicRatingsStore.getState().load(owner)
        if (active) await useYoutubeMusicRatingsStore.getState().resume()
      } catch { /* Exact stars remain retained; controls expose pending sync. */ }
      finally { if (active) timer = setTimeout(tick, 60000) }
    }
    void tick()
    return () => { active = false; clearTimeout(timer) }
  }, [owner, provider, provider?.playbackSession, provider?.cacheScope, lastfm, listenbrainz])
}
