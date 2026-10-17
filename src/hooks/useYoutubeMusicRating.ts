import { useEffect, useState } from "react"
import { useYoutubeMusicRatingsStore } from "../backends/ytmusic/ratings"
import { useYoutubeMusicLikesStore } from "../backends/ytmusic/likes"
import { useYoutubeMusicDiscoveryStore } from "../backends/ytmusic/discovery"
import type { MusicTrack } from "../types/music"

export function useYoutubeMusicRating(track?: MusicTrack) {
  const owner = useYoutubeMusicDiscoveryStore(state => state.connected ? state.accountId : null)
  const entry = useYoutubeMusicRatingsStore(state => track && state.owner === owner ? state.entries[track.id] : undefined)
  const loaded = useYoutubeMusicRatingsStore(state => state.owner === owner && state.loaded)
  const saving = useYoutubeMusicRatingsStore(state => !!track && !!state.saving[track.id])
  const liked = useYoutubeMusicLikesStore(state => track ? state.entries[track.id]?.liked : undefined)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    setError(null)
    if (track && owner) void useYoutubeMusicRatingsStore.getState().load(owner).catch(() => { if (active) setError("Local ratings could not be loaded. Try again.") })
    return () => { active = false }
  }, [track?.id, owner])
  return { display: entry ? entry.value : liked ? 6 : null, saving, error: error ?? entry?.error ?? null,
    hint: entry ? "Exact stars saved in Hibiki. YTM likes start at two stars; Last.fm and ListenBrainz loves start at three."
      : liked ? "Liked on YouTube Music. Choose stars to save an exact rating." : "Choose stars to save a rating.",
    available: !!track, enabled: !!track && !!owner && loaded,
    rate: async (value: number | null) => {
      if (!track || !owner) return false
      setError(null)
      try { return await useYoutubeMusicRatingsStore.getState().rate(track, value) }
      catch (failure) { setError(String(failure instanceof Error ? failure.message : failure)); return false }
    } }
}
