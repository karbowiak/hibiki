import {
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import { useArtworkTone } from "../hooks/useArtworkTone"
import { useAccentStore } from "../stores/accentStore"
import { useCustomColorStore } from "../stores/customColorStore"
import { getTheme, subscribeTheme } from "../stores/themeStore"
import { artworkUiPalette, fallbackArtworkTone } from "../lib/artworkUiPalette"
import { ArtworkPaletteContext } from "../lib/artworkPaletteContext"
import { PlaybackPaletteContext } from "../lib/playbackPaletteContext"
/** The playing album owns its controls even while other artwork is being browsed. */
export function PlaybackPalette({
  src,
  children,
}: {
  src: string | null
  children: ReactNode
}) {
  const sampled = useArtworkTone(src)
  const accent = useAccentStore((s) => s.accent)
  const overrides = useCustomColorStore((s) => s.overrides),
    enabled = useCustomColorStore((s) => s.enabled)
  const theme = useSyncExternalStore(subscribeTheme, getTheme, getTheme)
  const background =
    typeof window === "undefined"
      ? theme === "light"
        ? "#f0f0f0"
        : "#121212"
      : window
          .getComputedStyle(document.documentElement)
          .getPropertyValue("--bg-base")
          .trim()

  const toneKey = JSON.stringify(sampled)
  const palette = useMemo(
    () =>
      artworkUiPalette(sampled ?? fallbackArtworkTone(accent), background) ??
      {},
    [toneKey, accent, background, theme, overrides, enabled]
  )
  const revision = JSON.stringify(palette)
  return (
    <PlaybackPaletteContext.Provider value={palette}>
      <ArtworkPaletteContext.Provider value={revision}>
        <div
          className="playback-palette"
          data-playback-palette={sampled ? "artwork" : "accent"}
          style={palette}
        >
          {children}
        </div>
      </ArtworkPaletteContext.Provider>
    </PlaybackPaletteContext.Provider>
  )
}
