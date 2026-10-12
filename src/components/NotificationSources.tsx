import { useEffect } from "react"
import { isTauri } from "@tauri-apps/api/core"
import { useShallow } from "zustand/react/shallow"
import { usePlayerStore } from "../stores/playerStore"
import { useRadioStreamStore } from "../stores/radioStreamStore"
import { useDeviceStore } from "../stores/deviceStore"
import { useNotificationCenterStore } from "../stores/notificationCenterStore"
import { connectSystemNotifications } from "../lib/systemNotifications"

/** Global player notices use the same history and presentation as storage and scrobbling. */
export function NotificationSources() {
  const playerError = usePlayerStore((s) => s.playerError)
  const radioError = useRadioStreamStore((s) => s.streamError)
  const outputAvailable = useDeviceStore((s) => s.outputAvailable)
  const { hasTrack, internetRadio } = usePlayerStore(
    useShallow((s) => ({
      hasTrack: s.currentTrack !== null,
      internetRadio: s.isInternetRadioActive,
    }))
  )
  useEffect(() => {
    if (!playerError) return
    const cache = playerError.toLowerCase().includes("audio cache")
    useNotificationCenterStore
      .getState()
      .notify({
        id: cache ? "audio.cache" : "playback.error",
        title: cache ? "Audio cache unavailable" : "Playback error",
        message: playerError,
        severity: cache ? "warning" : "error",
      })
  }, [playerError])
  useEffect(() => {
    if (!radioError) return
    useNotificationCenterStore
      .getState()
      .notify({
        id: "radio.error",
        title: "Internet radio playback failed",
        message: radioError,
        severity: "error",
      })
  }, [radioError])
  useEffect(() => {
    const notices = useNotificationCenterStore.getState()
    if (!outputAvailable && hasTrack && !internetRadio)
      notices.notify({
        id: "audio.output",
        title: "Audio output disconnected",
        message: "Playback is waiting for an available audio output device.",
        severity: "warning",
        persistent: true,
      })
    else notices.resolve("audio.output")
  }, [outputAvailable, hasTrack, internetRadio])
  useEffect(() => {
    if (isTauri()) return connectSystemNotifications()
  }, [])
  return null
}
