import { create } from "zustand"
import { safeLocalPersist } from "./localPreferenceStorage"
import { usePlayerStore } from "./playerStore"

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

export function createSleepTimerStore(
  persist = safeLocalPersist,
  player: { getState(): { pause(): unknown; refreshPreload(): unknown } } = {
    getState: () => usePlayerStore.getState(),
  }
) {
  // Timer belongs to this store instance and survives state updates.
  let _timerId: ReturnType<typeof setTimeout> | null = null
  // Timer mode and deadline must change together, even before saved data is readable.
  let hydrated = false
  let pendingTimer: Pick<SleepTimerState, "endsAt" | "endOfTrack"> | null = null
  const rememberTimer = () => {
    if (!hydrated) {
      const { endsAt, endOfTrack } = store.getState()
      pendingTimer = { endsAt, endOfTrack }
    }
  }
  const store = create<SleepTimerState>()(
    persist(
      (set, get) => ({
        endsAt: null,
        endOfTrack: false,

        start: (minutes: number) => {
          const wasEndOfTrack = get().endOfTrack
          set({ endOfTrack: false })
          if (wasEndOfTrack) player.getState().refreshPreload()
          if (_timerId !== null) clearTimeout(_timerId)
          const endsAt = Date.now() + minutes * 60 * 1000
          set({ endsAt })
          rememberTimer()
          _timerId = setTimeout(
            () => {
              player.getState().pause()
              set({ endsAt: null })
              rememberTimer()
              _timerId = null
            },
            minutes * 60 * 1000
          )
        },

        startEndOfTrack: () => {
          // Cancel any timed sleep timer
          if (_timerId !== null) {
            clearTimeout(_timerId)
            _timerId = null
          }
          set({ endsAt: null, endOfTrack: true })
          rememberTimer()
          player.getState().refreshPreload()
        },

        onTrackEnd: () => {
          if (!get().endOfTrack) return false
          // Pause playback and clear the EOT flag
          player.getState().pause()
          set({ endOfTrack: false })
          rememberTimer()
          return true
        },

        cancel: () => {
          const wasEndOfTrack = get().endOfTrack
          if (_timerId !== null) {
            clearTimeout(_timerId)
            _timerId = null
          }
          set({ endsAt: null, endOfTrack: false })
          rememberTimer()
          if (wasEndOfTrack) player.getState().refreshPreload()
        },

        hydrate: () => {
          if (_timerId !== null) {
            clearTimeout(_timerId)
            _timerId = null
          }
          const { endsAt } = get()
          if (endsAt === null) return
          const remaining = endsAt - Date.now()
          if (remaining <= 0) {
            // Timer already expired while app was closed — clear silently
            set({ endsAt: null })
            rememberTimer()
            return
          }
          // Reschedule for the remaining time
          _timerId = setTimeout(() => {
            player.getState().pause()
            set({ endsAt: null })
            rememberTimer()
            _timerId = null
          }, remaining)
        },
      }),
      {
        name: "plex-sleep-timer-v1",
        partialize: (state) => ({
          endsAt: state.endsAt,
          endOfTrack: state.endOfTrack,
        }),
        validate: (saved) =>
          saved.endsAt === undefined ||
          saved.endsAt === null ||
          (typeof saved.endsAt === "number" &&
            Number.isFinite(saved.endsAt) &&
            saved.endsAt >= 0),
        onRehydrateStorage: () => {
          hydrated = false
          return (state, error) => {
            if (!state || error) return
            if (pendingTimer) {
              const timer = pendingTimer
              pendingTimer = null
              store.setState(timer)
              if (state.endOfTrack !== timer.endOfTrack)
                player.getState().refreshPreload()
            }
            hydrated = true
            store.getState().hydrate()
          }
        },
      }
    )
  )

  return store
}

export const useSleepTimerStore = createSleepTimerStore()
