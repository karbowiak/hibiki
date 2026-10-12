import { create } from "zustand"
import { booleanPreference, createScalarPreference } from "./scalarPreference"
const colors = booleanPreference("plex-artwork-colors", true)
const background = booleanPreference("plex-background-artwork", true)
const rotation = booleanPreference("plex-background-rotation", true)
export const INTERFACE_OPACITY_MIN = 0.45
export const INTERFACE_OPACITY_MAX = 1
export const INTERFACE_OPACITY_DEFAULT = 0.76
function normalizeOpacity(value: number) {
  return Number.isFinite(value)
    ? Math.max(INTERFACE_OPACITY_MIN, Math.min(INTERFACE_OPACITY_MAX, value))
    : INTERFACE_OPACITY_DEFAULT
}
const opacity = createScalarPreference(
  "plex-interface-opacity",
  INTERFACE_OPACITY_DEFAULT,
  (raw) => {
    if (!raw.trim() || !Number.isFinite(Number(raw)))
      throw new Error("Invalid interface opacity")
    return normalizeOpacity(Number(raw))
  },
  (value) => String(value)
)
export interface ArtworkAppearanceState {
  artworkColorsEnabled: boolean
  setArtworkColorsEnabled: (value: boolean) => void
  backgroundArtworkEnabled: boolean
  setBackgroundArtworkEnabled: (value: boolean) => void
  backgroundRotationEnabled: boolean
  setBackgroundRotationEnabled: (value: boolean) => void
  interfaceOpacity: number
  setInterfaceOpacity: (value: number) => void
}
export const useArtworkAppearanceStore = create<ArtworkAppearanceState>(() => ({
  artworkColorsEnabled: colors.snapshot(),
  setArtworkColorsEnabled: (value) => colors.set(value),
  backgroundArtworkEnabled: background.snapshot(),
  setBackgroundArtworkEnabled: (value) => background.set(value),
  backgroundRotationEnabled: rotation.snapshot(),
  setBackgroundRotationEnabled: (value) => rotation.set(value),
  interfaceOpacity: opacity.snapshot(),
  setInterfaceOpacity: (value) => opacity.set(normalizeOpacity(value)),
}))
colors.subscribe(() =>
  useArtworkAppearanceStore.setState({
    artworkColorsEnabled: colors.snapshot(),
  })
)
background.subscribe(() =>
  useArtworkAppearanceStore.setState({
    backgroundArtworkEnabled: background.snapshot(),
  })
)
opacity.subscribe(() =>
  useArtworkAppearanceStore.setState({ interfaceOpacity: opacity.snapshot() })
)

rotation.subscribe(() =>
  useArtworkAppearanceStore.setState({
    backgroundRotationEnabled: rotation.snapshot(),
  })
)
