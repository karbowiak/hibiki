import { useCapability } from "./useCapability"
import { usePlayerStore } from "../stores/playerStore"
import { useGeniusStore } from "../metadata/genius/authStore"
import { isYoutubeMusicId } from "../backends/ytmusic/tracks"

export function useLyricsAvailable() {
  const native = useCapability("lyrics")
  const youtube = usePlayerStore(state => isYoutubeMusicId(state.currentTrack?.id ?? ""))
  const genius = useGeniusStore(state => state.isEnabled && state.hasCredentials)
  return native || youtube || genius
}
