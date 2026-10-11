import { create } from "zustand"
import { safeLocalPersist } from "./localPreferenceStorage"
import { usePlayerStore } from "./playerStore"

const MIN_OFFSET = -15000
const MAX_OFFSET = 15000

interface LyricsOffsetState {
  /** Per-track offset map, keyed by track ID */
  offsets: Record<string, number>
  /** Current track ID — kept in sync via playerStore subscription */
  _trackId: string | null
  /** Derived offset for the current track (0 if no offset set) */
  offsetMs: number
  /** Set the offset for the current track (clamped to ±15s) */
  setOffset: (ms: number) => void
  /** Reset the current track's offset to 0 */
  resetOffset: () => void
}

function clamp(v: number) {
  return Math.max(MIN_OFFSET, Math.min(MAX_OFFSET, v))
}

export function createLyricsOffsetStore(persist = safeLocalPersist) {
  // Keep explicit pre-hydration intent, including values equal to startup defaults.
  let hydrated = false
  const pendingOffsets = new Map<string, number>()
  const store = create<LyricsOffsetState>()(
    persist(
      (set, get) => ({
        offsets: {},
        _trackId: null,
        offsetMs: 0,

        setOffset: (ms: number) => {
          const trackId = get()._trackId
          if (!trackId) return
          const clamped = clamp(ms)
          if (!hydrated) pendingOffsets.set(trackId, clamped)
          const offsets = { ...get().offsets }
          if (clamped === 0) delete offsets[trackId]
          else offsets[trackId] = clamped
          set({ offsets, offsetMs: clamped })
        },

        resetOffset: () => {
          const trackId = get()._trackId
          if (!trackId) return
          if (!hydrated) pendingOffsets.set(trackId, 0)
          const offsets = { ...get().offsets }
          delete offsets[trackId]
          set({ offsets, offsetMs: 0 })
        },
      }),
      {
        name: "plex-lyrics-offsets",
        hasPendingIntent: () => pendingOffsets.size > 0,
        partialize: (s) => ({ offsets: s.offsets }),
        validate: (saved) =>
          saved.offsets === undefined ||
          (saved.offsets !== null &&
            typeof saved.offsets === "object" &&
            !Array.isArray(saved.offsets) &&
            Object.values(saved.offsets).every(
              (offset) =>
                typeof offset === "number" &&
                Number.isFinite(offset) &&
                offset >= MIN_OFFSET &&
                offset <= MAX_OFFSET
            )),
        onRehydrateStorage: () => {
          hydrated = false
          return (state, error) => {
            if (!state || error) return
            const offsets = { ...state.offsets }
            for (const [trackId, offset] of pendingOffsets) {
              if (offset === 0) delete offsets[trackId]
              else offsets[trackId] = offset
            }
            pendingOffsets.clear()
            store.setState({
              offsets,
              offsetMs: state._trackId ? (offsets[state._trackId] ?? 0) : 0,
            })
            hydrated = true
          }
        },
      }
    )
  )

  return store
}

export const useLyricsOffsetStore = createLyricsOffsetStore()

// Subscribe to playerStore track changes — update _trackId and derive offsetMs
let _prevTrackId: string | null = null
usePlayerStore.subscribe((s) => {
  const trackId = s.currentTrack?.id ?? null
  if (trackId === _prevTrackId) return
  _prevTrackId = trackId
  const offsets = useLyricsOffsetStore.getState().offsets
  useLyricsOffsetStore.setState({
    _trackId: trackId,
    offsetMs: trackId ? (offsets[trackId] ?? 0) : 0,
  })
})
