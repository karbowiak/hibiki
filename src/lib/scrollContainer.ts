import { createContext, useContext, type RefObject } from "react"
export const ScrollContainerContext =
  createContext<RefObject<HTMLDivElement | null> | null>(null)
export const useScrollContainer = () => useContext(ScrollContainerContext)
