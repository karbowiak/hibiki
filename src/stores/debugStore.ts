import { create } from "zustand"
import { booleanPreference } from "./scalarPreference"

const STORAGE_KEY = "plex-debug-enabled"

const preference = booleanPreference(STORAGE_KEY, false)

interface DebugState {
  debugEnabled: boolean
  setDebugEnabled: (v: boolean) => void
}

export const useDebugStore = create<DebugState>(() => ({
  debugEnabled: preference.snapshot(),

  setDebugEnabled: (v: boolean) => {
    preference.set(v)
    useDebugStore.setState({ debugEnabled: v })
  },
}))

preference.subscribe(() => useDebugStore.setState({ debugEnabled: preference.snapshot() }))
