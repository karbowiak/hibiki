import { useEffect } from "react"
import {
  useVisualizerStore,
  type FullscreenVisualizerMode,
} from "../stores/visualizerStore"
import {
  hasKeyboardModifier,
  isCompositionKey,
  isKeyboardControl,
} from "../lib/keyboard"

const MODES: FullscreenVisualizerMode[] = [
  "spectrum",
  "oscilloscope",
  "vu",
  "starfield",
  "milkdrop",
]

export function useVisualizerHotkeys(toggleNativeFullscreen: () => void) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        isCompositionKey(event) ||
        isKeyboardControl(event) ||
        hasKeyboardModifier(event)
      )
        return
      const visualizer = useVisualizerStore.getState()
      if (!visualizer.fullscreenOpen) return
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key
      if (event.repeat && key !== "ArrowLeft" && key !== "ArrowRight") return
      let action: (() => void) | undefined
      if (/^[1-5]$/.test(key)) {
        action = () => visualizer.setFullscreenMode(MODES[Number(key) - 1])
      } else if (key === "Escape") {
        action = () =>
          visualizer.presetBrowserOpen
            ? visualizer.setPresetBrowserOpen(false)
            : visualizer.closeFullscreen()
      } else if (key === "f") {
        action = () => {
          if (visualizer.fullscreenMode === "milkdrop") {
            if (visualizer.currentPresetName)
              visualizer.toggleFavorite(visualizer.currentPresetName)
          } else toggleNativeFullscreen()
        }
      } else if (visualizer.fullscreenMode === "milkdrop") {
        if (key === "b") {
          action = () =>
            visualizer.setPresetBrowserOpen(!visualizer.presetBrowserOpen)
        } else if (key === "ArrowLeft" || key === "ArrowRight") {
          action = () => {
            const name = visualizer.getNextPresetName(
              key === "ArrowLeft" ? -1 : 1
            )
            if (name) visualizer.setCurrentPreset(name)
          }
        } else if (key === "r") {
          action = () => {
            const name = visualizer.getRandomPresetName(
              visualizer.currentPresetName ?? undefined
            )
            if (name) visualizer.setCurrentPreset(name)
          }
        }
      }
      if (!action) return
      // The player listens on window. Claim visualizer-specific keys here so
      // preset browsing cannot also seek a song, skip it, or change repeat mode.
      event.preventDefault()
      event.stopPropagation()
      action()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [toggleNativeFullscreen])
}
