import { createContext, useContext, type CSSProperties } from "react"
export const PlaybackPaletteContext = createContext<CSSProperties>({})
export const usePlaybackPalette = () => useContext(PlaybackPaletteContext)
