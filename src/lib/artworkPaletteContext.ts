import { createContext, useContext } from "react"

/** Repaint paused visualizations when inherited artwork or appearance colors change. */
export const ArtworkPaletteContext = createContext("")
export const useArtworkPaletteRevision = () => useContext(ArtworkPaletteContext)
