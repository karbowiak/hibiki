import { useState } from "react"
import { useLocation } from "wouter"
import { useMixedPlaylistStore } from "../stores/mixedPlaylistStore"
import { useYoutubeMusicDiscoveryStore } from "../backends/ytmusic/discovery"

export function MixedPlaylistControl({ alias }: { alias: string }) {
  const connected = useYoutubeMusicDiscoveryStore(state => state.connected)
  const [, navigate] = useLocation()
  const [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null)
  if (!connected) return null
  return <div>
    <button type="button" className="media-secondary" disabled={pending} onClick={() => {
      setPending(true); setError(null)
      void useMixedPlaylistStore.getState().convert(alias).then(playlist => navigate(`/mixed-playlist/${encodeURIComponent(playlist.id)}`))
        .catch(failure => setError(String(failure instanceof Error ? failure.message : failure))).finally(() => setPending(false))
    }}>{pending ? "Preparing playlist…" : "Link Plex + YTM"}</button>
    {error && <p role="status" className="mt-2 max-w-lg text-sm text-(--text-secondary)">{error}</p>}
  </div>
}
