import { useEffect, useState } from "react"
import { usePlayerStore } from "../stores/playerStore"
import { useVisualizerStore } from "../stores/visualizerStore"
import { useRadioStreamStore } from "../stores/radioStreamStore"
import {
  hasKeyboardModifier,
  isCompositionKey,
  isKeyboardControl,
} from "../lib/keyboard"

export function useGlobalHotkeys() {
  const [hotkeyHelpOpen, setHotkeyHelpOpen] = useState(false)

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || isCompositionKey(e)) return
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
      // Modifier hotkeys (work even in inputs)
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        if (key === "f" || key === "k") {
          if (e.repeat) return
          e.preventDefault()
          const visualizer = useVisualizerStore.getState()
          if (visualizer.fullscreenOpen) visualizer.closeFullscreen()
          window.dispatchEvent(new CustomEvent("plexify:search-focus"))
          return
        }
        if (key === "r") {
          if (e.repeat) return
          e.preventDefault()
          window.dispatchEvent(new CustomEvent("plexify:refresh"))
          return
        }
      }

      if (isKeyboardControl(e)) return

      // Hotkeys that require no modifiers
      if (hasKeyboardModifier(e)) return
      if (e.repeat && !key.startsWith("Arrow")) return

      const player = usePlayerStore.getState()
      const visualizer = useVisualizerStore.getState()

      switch (key) {
        case " ":
          if (player.isInternetRadioActive) {
            const radio = useRadioStreamStore.getState()
            if (!radio.currentStation) return
            e.preventDefault()
            if (radio.isStreamPlaying) radio.pauseStream()
            else radio.resumeStream()
            break
          }
          if (!player.currentTrack) return
          e.preventDefault()
          if (player.isPlaying) player.pause()
          else player.resume()
          break
        case "n":
          e.preventDefault()
          player.next()
          break
        case "b":
          e.preventDefault()
          player.prev()
          break
        case "ArrowLeft":
          if (!player.currentTrack || player.isInternetRadioActive) return
          e.preventDefault()
          {
            const delta = e.shiftKey ? 15000 : 5000
            player.seekTo(Math.max(0, player.positionMs - delta))
          }
          break
        case "ArrowRight":
          if (!player.currentTrack || player.isInternetRadioActive) return
          e.preventDefault()
          {
            const delta = e.shiftKey ? 15000 : 5000
            const duration = player.currentTrack.duration
            const target = player.positionMs + delta
            player.seekTo(
              Number.isFinite(duration) && duration > 0
                ? Math.min(duration, target)
                : target
            )
          }
          break
        case "ArrowUp":
          e.preventDefault()
          player.setVolume(Math.min(100, player.volume + 5))
          break
        case "ArrowDown":
          e.preventDefault()
          player.setVolume(Math.max(0, player.volume - 5))
          break
        case "m":
          e.preventDefault()
          player.toggleMute()
          break
        case "s":
          e.preventDefault()
          player.toggleShuffle()
          break
        case "r":
          e.preventDefault()
          player.cycleRepeat()
          break
        case "v":
          if (!visualizer.fullscreenOpen) {
            e.preventDefault()
            visualizer.openFullscreen()
          }
          break
        case "?":
          e.preventDefault()
          setHotkeyHelpOpen((prev) => !prev)
          break
      }
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  return { hotkeyHelpOpen, setHotkeyHelpOpen }
}
