import { useEffect, useRef, useState } from "react"
import { useLocation } from "wouter"
import { useMixedPlaylistStore } from "../stores/mixedPlaylistStore"
import { useYoutubeMusicDiscoveryStore } from "../backends/ytmusic/discovery"

export function MixedPlaylistControl({ alias }: { alias: string }) {
  const connected = useYoutubeMusicDiscoveryStore(state => state.connected)
  return connected ? <ConnectedPlaylistControl key={alias} alias={alias} /> : null
}
function ConnectedPlaylistControl({ alias }: { alias: string }) {
  const [, navigate] = useLocation()
  const active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  const [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null)
  return <div>
    <button type="button" className="media-secondary" disabled={pending} onClick={() => {
      setPending(true); setError(null)
      void useMixedPlaylistStore.getState().convert(alias).then(playlist => { if (active.current) navigate(`/mixed-playlist/${encodeURIComponent(playlist.id)}`) })
        .catch(failure => { if (active.current) setError(String(failure instanceof Error ? failure.message : failure)) }).finally(() => { if (active.current) setPending(false) })
    }}>{pending ? "Preparing playlist…" : "Link Plex + YTM"}</button>
    {error && <p role="status" className="mt-2 max-w-lg text-sm text-(--text-secondary)">{error}</p>}
  </div>
}
