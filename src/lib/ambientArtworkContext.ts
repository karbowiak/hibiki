import { createContext, useContext } from "react"
export const AmbientArtworkControlsContext = createContext({
  visible: false,
  paused: false,
  next: () => {},
  togglePaused: () => {},
})
export const useAmbientArtworkControls = () =>
  useContext(AmbientArtworkControlsContext)
