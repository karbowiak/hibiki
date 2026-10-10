import { create } from "zustand"
import { persist } from "zustand/middleware"
import { listen } from "@tauri-apps/api/event"
import { idbJSONStorage } from "./idbStorage"
import type { RadioStation } from "../lib/radiobrowser"
import { radiobrowserClick } from "../lib/radiobrowser"
import { radioPlay, radioStop, radioPause, radioResume, radioOnEvents } from "../lib/radioAudio"
import { usePlayerStore } from "./playerStore"
import { parseIcyString } from "../lib/icyParser"

const MAX_RECENT = 50

export interface IcyNowPlaying {
  artist: string | null
  title: string | null
}

interface RadioStreamState {
  /** Currently playing station (null when no radio is active). */
  currentStation: RadioStation | null
  /** True while an internet radio stream is actively playing. */
  isStreamPlaying: boolean
  /** True while the stream is buffering. */
  isStreamBuffering: boolean
  /** Error message when a stream fails. */
  streamError: string | null
  /** ICY metadata now-playing info from the current stream. */
  icyNowPlaying: IcyNowPlaying | null
  /** Favorited stations (persisted). */
  favorites: RadioStation[]
  /** Recently played stations (persisted, max 50). */
  recentStations: RadioStation[]

  playStation: (station: RadioStation) => void
  stopStream: () => void
  pauseStream: () => void
  resumeStream: () => void
  toggleFavorite: (station: RadioStation) => void
  isFavorite: (uuid: string) => boolean
  clearRecent: () => void
  setIcyNowPlaying: (info: IcyNowPlaying | null) => void
}

let _unlisten: (() => void) | null = null
let _unlistenIcy: (() => void) | null = null
let streamRevision = 0
let errorTimer: ReturnType<typeof setTimeout> | null = null

function clearStreamListeners() {
  streamRevision++
  _unlisten?.()
  _unlisten = null
  _unlistenIcy?.()
  _unlistenIcy = null
  if (errorTimer !== null) clearTimeout(errorTimer)
  errorTimer = null
}

export const useRadioStreamStore = create<RadioStreamState>()(
  persist(
    (set, get) => ({
      currentStation: null,
      isStreamPlaying: false,
      isStreamBuffering: false,
      streamError: null,
      icyNowPlaying: null,
      favorites: [],
      recentStations: [],

      playStation: (station: RadioStation) => {
        // Revoke pending Plex loads and queue requests before installing the
        // new station. Stopping only the engine left those requests alive.
        usePlayerStore.getState().stop()
        // Stop any existing radio stream event listeners
        clearStreamListeners()
        const revision = streamRevision
        const isCurrent = () => revision === streamRevision && usePlayerStore.getState().isInternetRadioActive

        // Select the live stream after the previous source has been retired.
        usePlayerStore.setState({
          isPlaying: false,
          currentTrack: null,
          isInternetRadioActive: true,
        })

        // Get volume from player store
        const volume = usePlayerStore.getState().volume

        // Start HTML5 audio
        radioPlay(station.stream_url, volume)

        // Register click for community stats (fire-and-forget)
        radiobrowserClick(station.uuid).catch(() => {})

        // Add to recent stations
        const recent = get().recentStations.filter(s => s.uuid !== station.uuid)
        recent.unshift(station)
        if (recent.length > MAX_RECENT) recent.length = MAX_RECENT

        set({
          currentStation: station,
          isStreamPlaying: true,
          isStreamBuffering: true,
          streamError: null,
          icyNowPlaying: null,
          recentStations: recent,
        })

        // Listen for ICY metadata events from the Rust proxy (if available)
        listen<string>("radio://icy-metadata", (e) => {
          if (!isCurrent()) return
          const parsed = parseIcyString(e.payload)
          if (parsed.title || parsed.artist) {
            useRadioStreamStore.setState({ icyNowPlaying: parsed })
          }
        }).then(unlisten => {
          if (isCurrent()) _unlistenIcy = unlisten
          else unlisten()
        }).catch(() => {})

        // Listen for audio events
        _unlisten = radioOnEvents({
          onPlaying: () => { if (isCurrent()) set({ isStreamBuffering: false, isStreamPlaying: true, streamError: null }) },
          onWaiting: () => { if (isCurrent()) set({ isStreamBuffering: true }) },
          onError: (msg) => {
            if (!isCurrent()) return
            set({ streamError: msg, isStreamPlaying: false, isStreamBuffering: false })
            if (errorTimer !== null) clearTimeout(errorTimer)
            errorTimer = setTimeout(() => { if (isCurrent()) set({ streamError: null }) }, 6000)
          },
          onPause: () => { if (isCurrent()) set({ isStreamPlaying: false, isStreamBuffering: false }) },
          onStop: () => {
            if (revision !== streamRevision) return
            clearStreamListeners()
            usePlayerStore.setState({ isInternetRadioActive: false })
            set({ currentStation: null, isStreamPlaying: false, isStreamBuffering: false, streamError: null, icyNowPlaying: null })
          },
        })
      },

      stopStream: () => {
        clearStreamListeners()
        radioStop()
        usePlayerStore.setState({ isInternetRadioActive: false })
        set({ currentStation: null, isStreamPlaying: false, isStreamBuffering: false, streamError: null, icyNowPlaying: null })
      },

      pauseStream: () => {
        radioPause()
        set({ isStreamPlaying: false, isStreamBuffering: false })
      },

      resumeStream: () => {
        set({ isStreamPlaying: true, isStreamBuffering: true, streamError: null })
        radioResume()
      },

      toggleFavorite: (station: RadioStation) => {
        const { favorites } = get()
        const exists = favorites.some(s => s.uuid === station.uuid)
        if (exists) {
          set({ favorites: favorites.filter(s => s.uuid !== station.uuid) })
        } else {
          set({ favorites: [station, ...favorites] })
        }
      },

      isFavorite: (uuid: string) => get().favorites.some(s => s.uuid === uuid),

      clearRecent: () => set({ recentStations: [] }),

      setIcyNowPlaying: (info) => set({ icyNowPlaying: info }),
    }),
    {
      name: "radio-stream-v1",
      storage: idbJSONStorage,
      partialize: (state) => ({
        favorites: state.favorites,
        recentStations: state.recentStations,
      }),
    }
  )
)
