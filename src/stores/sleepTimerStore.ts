import { create } from "zustand"
import { persist } from "zustand/middleware"
import { usePlayerStore } from "./playerStore"

// ---------------------------------------------------------------------------
// Module-level timer handle — survives store re-renders
// ---------------------------------------------------------------------------

let _timerId: ReturnType<typeof setTimeout> | null = null

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface SleepTimerState {
  /** UTC timestamp (ms) when playback will pause. Null when timer is off. */
  endsAt: number | null
  /** When true, playback will pause after the current track finishes. */
  endOfTrack: boolean

  start: (minutes: number) => void
  startEndOfTrack: () => void
  /** Called by playerStore when a track ends naturally. Returns true if playback should stop. */
  onTrackEnd: () => boolean
  cancel: () => void
  /** Call once on app mount to reschedule any timer that survived a refresh. */
  hydrate: () => void
}

export const useSleepTimerStore = create<SleepTimerState>()(
  persist(
    (set, get) => ({
      endsAt: null,
      endOfTrack: false,

      start: (minutes: number) => {
        const wasEndOfTrack = get().endOfTrack
        set({ endOfTrack: false })
        if (wasEndOfTrack) usePlayerStore.getState().refreshPreload()
        if (_timerId !== null) clearTimeout(_timerId)
        const endsAt = Date.now() + minutes * 60 * 1000
        set({ endsAt })
        _timerId = setTimeout(() => {
          usePlayerStore.getState().pause()
          set({ endsAt: null })
          _timerId = null
        }, minutes * 60 * 1000)
      },

      startEndOfTrack: () => {
        // Cancel any timed sleep timer
        if (_timerId !== null) {
          clearTimeout(_timerId)
          _timerId = null
        }
        set({ endsAt: null, endOfTrack: true })
        usePlayerStore.getState().refreshPreload()
      },

      onTrackEnd: () => {
        if (!get().endOfTrack) return false
        // Pause playback and clear the EOT flag
        usePlayerStore.getState().pause()
        set({ endOfTrack: false })
        return true
      },

      cancel: () => {
        const wasEndOfTrack = get().endOfTrack
        if (_timerId !== null) {
          clearTimeout(_timerId)
          _timerId = null
        }
        set({ endsAt: null, endOfTrack: false })
        if (wasEndOfTrack) usePlayerStore.getState().refreshPreload()
      },

      hydrate: () => {
        const { endsAt } = get()
        if (endsAt === null) return
        const remaining = endsAt - Date.now()
        if (remaining <= 0) {
          // Timer already expired while app was closed — clear silently
          set({ endsAt: null })
          return
        }
        // Reschedule for the remaining time
        if (_timerId !== null) clearTimeout(_timerId)
        _timerId = setTimeout(() => {
          usePlayerStore.getState().pause()
          set({ endsAt: null })
          _timerId = null
        }, remaining)
      },
    }),
    {
      name: "plex-sleep-timer-v1",
      partialize: (state) => ({ endsAt: state.endsAt, endOfTrack: state.endOfTrack }),
    },
  ),
)
