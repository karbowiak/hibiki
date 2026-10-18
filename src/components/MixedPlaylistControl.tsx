import { useEffect, useRef, useState } from "react"
import { useLocation } from "wouter"
import { useMixedPlaylistStore } from "../stores/mixedPlaylistStore"
import { useYoutubeMusicDiscoveryStore } from "../backends/ytmusic/discovery"
import { captureMusicOwner } from "../mixedPlaylists/counterparts"

export function useMixedPlaylistLink(alias: string) {
  const [, navigate] = useLocation()
  const connected = useYoutubeMusicDiscoveryStore(state => state.connected)
  const generation = useRef(0), pendingRef = useRef(false)
  const [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setPending(false); setError(null)
    return () => { generation.current++; pendingRef.current = false }
  }, [alias])
  const link = async () => {
    if (pendingRef.current || !connected) return
    const capture = captureMusicOwner(), selected = generation.current
    const current = () => selected === generation.current && capture.current()
    pendingRef.current = true; setPending(true); setError(null)
    try {
      const playlist = await useMixedPlaylistStore.getState().convert(alias)
      if (current()) navigate(`/mixed-playlist/${encodeURIComponent(playlist.id)}`)
    } catch (failure) {
      if (current()) setError(failure instanceof Error ? failure.message : String(failure))
    } finally { if (selected === generation.current) { pendingRef.current = false; setPending(false) } }
  }
  return { connected, pending, error, link }
}
