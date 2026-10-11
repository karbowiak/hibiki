import { create } from "zustand"
import { safeLocalPersist } from "./localPreferenceStorage"

interface EasterEggState {
  rainbow: boolean
  partyMode: boolean
  vinylSpin: boolean
  vaporwave: boolean

  toggleRainbow: () => void
  togglePartyMode: () => void
  toggleVinylSpin: () => void
  toggleVaporwave: () => void
}

export function createEasterEggStore(persist = safeLocalPersist) {
  // Keep explicit pre-hydration intent, including values equal to startup defaults.
  let hydrated = false
  const pending: Partial<EasterEggState> = {}
  const remember = (patch: Partial<EasterEggState>) => {
    if (!hydrated) Object.assign(pending, patch)
    return patch
  }
  const store = create<EasterEggState>()(
    persist(
      (set) => ({
        rainbow: false,
        partyMode: false,
        vinylSpin: false,
        vaporwave: false,

        toggleRainbow: () => set((s) => remember({ rainbow: !s.rainbow })),
        togglePartyMode: () =>
          set((s) => remember({ partyMode: !s.partyMode })),
        toggleVinylSpin: () =>
          set((s) => remember({ vinylSpin: !s.vinylSpin })),
        toggleVaporwave: () =>
          set((s) => remember({ vaporwave: !s.vaporwave })),
      }),
      {
        name: "easter-eggs-v1",
        hasPendingIntent: () => Object.keys(pending).length > 0,
        onRehydrateStorage: () => {
          hydrated = false
          return (state, error) => {
            if (!state || error) return
            store.setState({ ...pending })
            for (const key of Object.keys(pending))
              delete pending[key as keyof EasterEggState]
            hydrated = true
          }
        },
        partialize: (state) => ({
          rainbow: state.rainbow,
          partyMode: state.partyMode,
          vinylSpin: state.vinylSpin,
          vaporwave: state.vaporwave,
        }),
      }
    )
  )

  return store
}

export const useEasterEggStore = createEasterEggStore()
