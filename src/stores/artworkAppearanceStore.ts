import { create } from "zustand"
import { booleanPreference } from "./scalarPreference"
const preference = booleanPreference("plex-artwork-colors", true)
export const useArtworkAppearanceStore = create<{
  artworkColorsEnabled: boolean
  setArtworkColorsEnabled: (value: boolean) => void
}>(() => ({
  artworkColorsEnabled: preference.snapshot(),
  setArtworkColorsEnabled: (value) => preference.set(value),
}))
preference.subscribe(() =>
  useArtworkAppearanceStore.setState({
    artworkColorsEnabled: preference.snapshot(),
  })
)
