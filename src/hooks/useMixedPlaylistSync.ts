import { useEffect } from "react"
import { useMixedPlaylistStore } from "../stores/mixedPlaylistStore"
import { useProviderStore } from "../stores/providerStore"
import { useYoutubeMusicDiscoveryStore } from "../backends/ytmusic/discovery"

/** Resumable bounded jobs, round-robin; no library-wide matching scan. */
export function useMixedPlaylistSync() {
  const provider = useProviderStore(state => state.provider)
  const scope = provider?.cacheScope, session = provider?.playbackSession
  const account = useYoutubeMusicDiscoveryStore(state => state.connected ? state.accountId : null)
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout>
    const checked = new Map<string, number>()
    const tick = async () => {
      try {
        await useMixedPlaylistStore.getState().load()
        if (!active || !provider || provider.isOffline || !scope || !account) return
        const playlist = useMixedPlaylistStore.getState().playlists.filter(item => item.automatic && item.owners.plex === scope && item.owners.ytmusic === account)
          .sort((a, b) => (checked.get(a.id) ?? 0) - (checked.get(b.id) ?? 0))[0]
        if (playlist && Date.now() - (checked.get(playlist.id) ?? 0) >= (playlist.status === "syncing" ? 15000 : 120000)) {
          checked.set(playlist.id, Date.now())
          await useMixedPlaylistStore.getState().sync(playlist.id)
        }
      } catch { /* The retained playlist exposes any actionable failure. */ }
      finally { if (active) timer = setTimeout(tick, 15000) }
    }
    void tick()
    return () => { active = false; clearTimeout(timer) }
  }, [provider, scope, session, account])
}
