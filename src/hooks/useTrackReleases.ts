import { useEffect, useMemo, useState } from "react"
import type { MusicTrack } from "../types/music"
import { isYoutubeMusicId } from "../backends/ytmusic/tracks"
import { youtubeMusicSongMetadata } from "../backends/ytmusic/metadata"
import { useYoutubeMusicDiscoveryStore } from "../backends/ytmusic/discovery"

/** Fill missing song release credits, with three requests in flight at most. */
export function useTrackReleases(tracks: MusicTrack[]) {
  const connected = useYoutubeMusicDiscoveryStore(state => state.connected)
  const revision = useYoutubeMusicDiscoveryStore(state => state.revision)
  const identity = useMemo(() => ({}), [tracks, connected, revision])
  const [saved, setSaved] = useState<{ identity: object; tracks: Map<string, MusicTrack> } | null>(null)
  useEffect(() => {
    if (!connected) return
    let active = true, index = 0
    const missing = [...new Map(tracks.filter(track => isYoutubeMusicId(track.id) && (!track.albumId || !track.albumName))
      .map(track => [track.id, track])).values()]
    const owns = () => active && useYoutubeMusicDiscoveryStore.getState().connected && useYoutubeMusicDiscoveryStore.getState().revision === revision
    const worker = async () => {
      while (owns() && index < missing.length) {
        const track = missing[index++]
        try {
          const metadata = await youtubeMusicSongMetadata(track.id)
          if (owns() && metadata.albumName) setSaved(previous => {
            const next = new Map(previous?.identity === identity ? previous.tracks : [])
            next.set(track.id, metadata)
            return { identity, tracks: next }
          })
        } catch { /* Keep honest missing-release text and retry on revisit. */ }
      }
    }
    void Promise.all(Array.from({ length: Math.min(3, missing.length) }, worker))
    return () => { active = false }
  }, [identity, tracks, connected, revision])
  return useMemo(() => tracks.map(track => {
    const metadata = saved?.identity === identity ? saved.tracks.get(track.id) : null
    return metadata ? { ...track, albumName: track.albumName || metadata.albumName, albumId: track.albumId || metadata.albumId } : track
  }), [tracks, identity, saved])
}
