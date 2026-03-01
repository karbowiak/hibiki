import { create } from "zustand"
import { persist } from "zustand/middleware"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import {
  audioPlay,
  audioPause,
  audioResume,
  audioSeek,
  audioSetVolume,
  audioPreloadNext,
  audioPrefetch,
  buildItemUri,
  createPlayQueue,
  createRadioQueue,
  createSmartShuffleQueue,
  getStreamUrl,
  reportTimeline,
  markPlayed,
  updateNowPlaying,
  setNowPlayingState,
  getPlaylistItems,
} from "../lib/plex"
import type { Track } from "../types/plex"
import { useConnectionStore } from "./connectionStore"

type RadioType = 'track' | 'artist' | 'album'

interface PlayerState {
  currentTrack: Track | null
  queue: Track[]
  queueIndex: number
  queueId: number | null
  isPlaying: boolean
  isBuffering: boolean
  positionMs: number
  shuffle: boolean
  repeat: 0 | 1 | 2
  volume: number

  /** Progressive playlist loading context — null when not playing from a playlist. */
  playlistKey: number | null
  playlistTotalCount: number
  playlistLoadedCount: number
  isLoadingMoreTracks: boolean

  /** Radio mode: true while a radio/Guest DJ station is active. */
  isRadioMode: boolean
  /** Rating key of the item that seeded the current radio station. */
  radioSeedKey: number | null
  /** Type of seed item used to start radio. */
  radioType: RadioType | null
  /** Guest DJ: use AI smart-shuffle for radio recommendations. Persisted as a preference. */
  guestDjEnabled: boolean

  playTrack: (track: Track, context?: Track[]) => Promise<void>
  /** Play a Plex URI via a server-side play queue. Handles full playlists with shuffle. */
  playFromUri: (uri: string, forceShuffle?: boolean) => Promise<void>
  /** Start playing a playlist with progressive queue loading (100 tracks at a time). */
  playPlaylist: (playlistId: number, totalCount: number) => Promise<void>
  /**
   * Start a radio station seeded from the given item.
   * Uses `createRadioQueue` normally, or `createSmartShuffleQueue` when Guest DJ is enabled.
   */
  playRadio: (ratingKey: number, radioType: RadioType) => Promise<void>
  /** Toggle Guest DJ mode on/off. Re-seeds the current station when turning on. */
  toggleGuestDj: () => void
  pause: () => void
  resume: () => void
  next: () => void
  prev: () => void
  seekTo: (ms: number) => void
  setVolume: (v: number) => void
  toggleShuffle: () => void
  cycleRepeat: () => void
  updatePosition: (ms: number) => void

  /** Move a queue item from index `from` to index `to`, keeping current track tracked. */
  reorderQueue: (from: number, to: number) => void
  /** Remove the queue item at `index`, adjusting queueIndex if needed. */
  removeFromQueue: (index: number) => void
  /** Jump to the queue item at `index` without resetting the surrounding queue context. */
  jumpToQueueItem: (index: number) => void

  /** Initialize Tauri event listeners for the Rust audio engine. Call once on app mount. */
  initAudioEvents: () => Promise<() => void>
}

// ---------------------------------------------------------------------------
// Audio prefetch — module-level dedup set
// ---------------------------------------------------------------------------

const _prefetchedPartKeys = new Set<string>()

// ---------------------------------------------------------------------------
// Radio — module-level state
// ---------------------------------------------------------------------------

/** Tracks which rating keys were added by the Guest DJ smart-shuffle. */
const _djGeneratedKeys = new Set<number>()
/** Returns true if this track was added to the queue by the Guest DJ. */
export function isDjGenerated(ratingKey: number): boolean {
  return _djGeneratedKeys.has(ratingKey)
}

let _radioRefillInProgress = false

/** Silently append a fresh batch of radio tracks when the queue is running low. */
async function appendRadioTracks(
  get: () => PlayerState,
  set: (updater: (s: PlayerState) => Partial<PlayerState>) => void
) {
  const { isRadioMode, radioSeedKey, guestDjEnabled, queue, queueIndex } = get()
  if (!isRadioMode || radioSeedKey === null || _radioRefillInProgress) return
  if (queue.length - queueIndex > 5) return  // plenty of tracks ahead

  _radioRefillInProgress = true
  try {
    const playQueue = guestDjEnabled
      ? await createSmartShuffleQueue(radioSeedKey)
      : await createRadioQueue(radioSeedKey)

    // Append only tracks not already in the queue to avoid duplicates
    const existingKeys = new Set(get().queue.map(t => t.rating_key))
    const newTracks = playQueue.items.filter(t => !existingKeys.has(t.rating_key))
    if (newTracks.length === 0) return

    if (guestDjEnabled) {
      for (const t of newTracks) _djGeneratedKeys.add(t.rating_key)
    }
    set(s => ({ queue: [...s.queue, ...newTracks] }))
  } catch (err) {
    console.error("Radio queue refill failed:", err)
  } finally {
    _radioRefillInProgress = false
  }
}

/** Warm the audio disk cache for a track on hover. Deduped per part key. */
export function prefetchTrackAudio(track: Track): void {
  const partKey = track.media[0]?.parts[0]?.key
  if (!partKey || _prefetchedPartKeys.has(partKey)) return
  _prefetchedPartKeys.add(partKey)
  const { baseUrl, token } = useConnectionStore.getState()
  const url = `${baseUrl}${partKey}?X-Plex-Token=${token}`
  void audioPrefetch(url).catch(() => {/* non-critical */})
}

/** Send a track to the Rust audio engine for playback. */
async function sendToAudioEngine(track: Track): Promise<void> {
  const partKey = track.media[0]?.parts[0]?.key
  if (!partKey) return

  // Build URL locally — avoids a Tauri IPC round-trip and PlexState lock contention
  const { baseUrl, token } = useConnectionStore.getState()
  const url = `${baseUrl}${partKey}?X-Plex-Token=${token}`
  await audioPlay(
    url,
    track.rating_key,
    track.duration,
    track.media[0]?.parts[0]?.id ?? 0,
    track.parent_key,
    track.index,
  )
}

/** Pre-buffer the next track in queue for gapless playback. */
async function preloadNextTrack(queue: Track[], queueIndex: number, repeat: 0 | 1 | 2): Promise<void> {
  let nextIndex = queueIndex + 1
  if (nextIndex >= queue.length) {
    if (repeat === 2) nextIndex = 0
    else return // No next track
  }

  const nextTrack = queue[nextIndex]
  if (!nextTrack) return

  const partKey = nextTrack.media[0]?.parts[0]?.key
  if (!partKey) return

  try {
    const { baseUrl, token } = useConnectionStore.getState()
    const url = `${baseUrl}${partKey}?X-Plex-Token=${token}`
    await audioPreloadNext(
      url,
      nextTrack.rating_key,
      nextTrack.duration,
      nextTrack.media[0]?.parts[0]?.id ?? 0,
      nextTrack.parent_key,
      nextTrack.index,
    )
  } catch {
    // Pre-load failure is non-critical
  }
}

const PLAYLIST_PAGE_SIZE = 100

/**
 * Play the track at `index` in the current queue without clearing the playlist
 * or radio context. Used by next(), prev(), and jumpToQueueItem() so progressive
 * loading continues working. (playTrack() is for explicit user selection only.)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function playAtIndex(index: number, get: () => PlayerState, set: any): Promise<void> {
  const track = get().queue[index]
  if (!track) return
  set({ currentTrack: track, queueIndex: index, isPlaying: true, positionMs: 0 })
  void reportTimeline(track.rating_key, "playing", 0, track.duration)
  void updateNowPlaying(
    track.title,
    track.grandparent_title ?? "",
    track.parent_title ?? "",
    track.thumb || track.parent_thumb || null,
    track.duration ?? 0,
  )
  void setNowPlayingState("playing", 0)
  try {
    await sendToAudioEngine(track)
  } catch (err) {
    console.error("playAtIndex failed:", err)
  }
}

/** Load the next page of playlist tracks into the queue in the background. */
async function loadMorePlaylistTracks(get: () => PlayerState, set: (fn: (s: PlayerState) => Partial<PlayerState>) => void) {
  const { playlistKey, playlistLoadedCount, playlistTotalCount, isLoadingMoreTracks } = get()
  if (!playlistKey || playlistLoadedCount >= playlistTotalCount || isLoadingMoreTracks) return
  set(() => ({ isLoadingMoreTracks: true }))
  try {
    const tracks = await getPlaylistItems(playlistKey, PLAYLIST_PAGE_SIZE, playlistLoadedCount)
    if (tracks.length > 0) {
      set(s => ({
        queue: [...s.queue, ...tracks],
        playlistLoadedCount: s.playlistLoadedCount + tracks.length,
        isLoadingMoreTracks: false,
      }))
    } else {
      set(() => ({ isLoadingMoreTracks: false }))
    }
  } catch (err) {
    console.error("Failed to load more playlist tracks:", err)
    set(() => ({ isLoadingMoreTracks: false }))
  }
}

export const usePlayerStore = create<PlayerState>()(
  persist(
    (set, get) => ({
  currentTrack: null,
  queue: [],
  queueIndex: 0,
  queueId: null,
  isPlaying: false,
  isBuffering: false,
  positionMs: 0,
  shuffle: false,
  repeat: 0,
  volume: 80,
  playlistKey: null,
  playlistTotalCount: 0,
  playlistLoadedCount: 0,
  isLoadingMoreTracks: false,
  isRadioMode: false,
  radioSeedKey: null,
  radioType: null,
  guestDjEnabled: false,

  playTrack: async (track: Track, context?: Track[]) => {
    const { sectionUuid } = useConnectionStore.getState()
    const itemKey = `/library/metadata/${track.rating_key}`
    const uri = sectionUuid ? buildItemUri(sectionUuid, itemKey) : itemKey
    const { shuffle, repeat } = get()

    // Update UI immediately — never block the player display on network calls
    const queue = context ?? [track]
    const queueIndex = Math.max(0, context ? context.findIndex(t => t.rating_key === track.rating_key) : 0)
    // Explicit track selection: clear progressive playlist and radio context.
    set({ currentTrack: track, queue, queueIndex, isPlaying: true, positionMs: 0,
      playlistKey: null, playlistTotalCount: 0, playlistLoadedCount: 0,
      isRadioMode: false, radioSeedKey: null, radioType: null })
    void reportTimeline(track.rating_key, "playing", 0, track.duration)
    void updateNowPlaying(
      track.title,
      track.grandparent_title ?? "",
      track.parent_title ?? "",
      track.thumb || track.parent_thumb || null,
      track.duration ?? 0,
    )
    void setNowPlayingState("playing", 0)

    try {
      // Start audio + register server-side queue in parallel
      const [playQueue] = await Promise.all([
        createPlayQueue(uri, shuffle, repeat),
        sendToAudioEngine(track),
      ])
      set({ queueId: playQueue.id })
    } catch (err) {
      console.error("playTrack failed:", err)
    }
  },

  playFromUri: async (uri: string, forceShuffle?: boolean) => {
    const { shuffle, repeat } = get()
    const shouldShuffle = forceShuffle ?? shuffle
    try {
      const playQueue = await createPlayQueue(uri, shouldShuffle, repeat)
      if (playQueue.items.length === 0) return
      const firstTrack = playQueue.items[0]

      // Update UI as soon as we know what track is first — before the audio fetch.
      // Server-side play queue: clear progressive playlist context (Plex owns the queue).
      set({
        currentTrack: firstTrack,
        queue: playQueue.items,
        queueIndex: 0,
        queueId: playQueue.id,
        isPlaying: true,
        positionMs: 0,
        shuffle: shouldShuffle,
        playlistKey: null,
        playlistTotalCount: 0,
        playlistLoadedCount: 0,
      })
      void reportTimeline(firstTrack.rating_key, "playing", 0, firstTrack.duration)
      void updateNowPlaying(
        firstTrack.title,
        firstTrack.grandparent_title ?? "",
        firstTrack.parent_title ?? "",
        firstTrack.thumb || firstTrack.parent_thumb || null,
        firstTrack.duration ?? 0,
      )
      void setNowPlayingState("playing", 0)

      await sendToAudioEngine(firstTrack)
    } catch (err) {
      console.error("playFromUri failed:", err)
    }
  },

  playPlaylist: async (playlistId: number, totalCount: number) => {
    const tracks = await getPlaylistItems(playlistId, PLAYLIST_PAGE_SIZE, 0)
    if (tracks.length === 0) return
    const firstTrack = tracks[0]

    set({
      currentTrack: firstTrack,
      queue: tracks,
      queueIndex: 0,
      queueId: null,
      isPlaying: true,
      positionMs: 0,
      playlistKey: playlistId,
      playlistTotalCount: totalCount,
      playlistLoadedCount: tracks.length,
      isLoadingMoreTracks: false,
    })
    void reportTimeline(firstTrack.rating_key, "playing", 0, firstTrack.duration)
    void updateNowPlaying(
      firstTrack.title,
      firstTrack.grandparent_title ?? "",
      firstTrack.parent_title ?? "",
      firstTrack.thumb || firstTrack.parent_thumb || null,
      firstTrack.duration ?? 0,
    )
    void setNowPlayingState("playing", 0)
    set({ isRadioMode: false, radioSeedKey: null, radioType: null })
    await sendToAudioEngine(firstTrack)
  },

  playRadio: async (ratingKey: number, radioType: RadioType) => {
    const { guestDjEnabled } = get()
    _djGeneratedKeys.clear()
    _radioRefillInProgress = false

    try {
      const playQueue = guestDjEnabled
        ? await createSmartShuffleQueue(ratingKey)
        : await createRadioQueue(ratingKey)

      if (playQueue.items.length === 0) return
      const firstTrack = playQueue.items[0]

      if (guestDjEnabled) {
        for (const t of playQueue.items) _djGeneratedKeys.add(t.rating_key)
      }

      set({
        currentTrack: firstTrack,
        queue: playQueue.items,
        queueIndex: 0,
        queueId: playQueue.id,
        isPlaying: true,
        positionMs: 0,
        isRadioMode: true,
        radioSeedKey: ratingKey,
        radioType,
        playlistKey: null,
        playlistTotalCount: 0,
        playlistLoadedCount: 0,
      })
      void reportTimeline(firstTrack.rating_key, "playing", 0, firstTrack.duration)
      void updateNowPlaying(
        firstTrack.title,
        firstTrack.grandparent_title ?? "",
        firstTrack.parent_title ?? "",
        firstTrack.thumb || firstTrack.parent_thumb || null,
        firstTrack.duration ?? 0,
      )
      void setNowPlayingState("playing", 0)

      await sendToAudioEngine(firstTrack)
    } catch (err) {
      console.error("playRadio failed:", err)
    }
  },

  toggleGuestDj: () => {
    const { guestDjEnabled, isRadioMode, radioSeedKey, radioType } = get()
    set({ guestDjEnabled: !guestDjEnabled })
    // Re-seed the station when toggling so the new mode takes effect immediately
    if (isRadioMode && radioSeedKey !== null && radioType !== null) {
      void get().playRadio(radioSeedKey, radioType)
    }
  },

  pause: () => {
    void audioPause()
    set({ isPlaying: false })
    const { currentTrack, positionMs } = get()
    if (currentTrack) {
      void reportTimeline(currentTrack.rating_key, "paused", positionMs, currentTrack.duration)
      void setNowPlayingState("paused", positionMs)
    }
  },

  resume: () => {
    void audioResume()
    set({ isPlaying: true })
    const { currentTrack, positionMs } = get()
    if (currentTrack) {
      void reportTimeline(currentTrack.rating_key, "playing", positionMs, currentTrack.duration)
      void setNowPlayingState("playing", positionMs)
    }
  },

  next: () => {
    const { queue, queueIndex, repeat, playlistKey, playlistLoadedCount, playlistTotalCount,
            isRadioMode, radioSeedKey, radioType } = get()
    if (queue.length === 0) return

    // Proactively load the next page when within 20 tracks of the end.
    if (playlistKey && playlistLoadedCount < playlistTotalCount && queueIndex >= queue.length - 20) {
      void loadMorePlaylistTracks(get, set as never)
    }

    let nextIndex = queueIndex + 1
    if (nextIndex >= queue.length) {
      if (repeat === 2) {
        nextIndex = 0
      } else if (isRadioMode && radioSeedKey !== null && radioType !== null) {
        // Radio mode: re-seed with a fresh station when the queue runs out
        void get().playRadio(radioSeedKey, radioType)
        return
      } else {
        void setNowPlayingState("stopped")
        set({ isPlaying: false })
        return
      }
    }
    // Use playAtIndex to preserve playlist/radio context (playTrack would clear it)
    void playAtIndex(nextIndex, get, set)
  },

  prev: () => {
    const { queue, queueIndex, positionMs } = get()
    if (positionMs > 3000) {
      // Restart current track in-place (preserve context)
      void playAtIndex(queueIndex, get, set)
      return
    }
    const prevIndex = Math.max(0, queueIndex - 1)
    void playAtIndex(prevIndex, get, set)
  },

  seekTo: (ms: number) => {
    void audioSeek(ms)
    set({ positionMs: ms })
    const { currentTrack } = get()
    if (currentTrack) {
      void reportTimeline(currentTrack.rating_key, "playing", ms, currentTrack.duration)
    }
  },

  setVolume: (v: number) => {
    const clamped = Math.max(0, Math.min(100, Math.round(v)))
    // Cubic curve: maps 0-100 slider to 0.0-1.0 gain matching human loudness perception
    const gain = clamped <= 0 ? 0 : clamped >= 100 ? 1 : Math.pow(clamped / 100, 3)
    void audioSetVolume(gain)
    set({ volume: clamped })
  },

  toggleShuffle: () => set(s => ({ shuffle: !s.shuffle })),

  cycleRepeat: () => set(s => ({ repeat: ((s.repeat + 1) % 3) as 0 | 1 | 2 })),

  updatePosition: (ms: number) => set({ positionMs: ms }),

  reorderQueue: (from: number, to: number) => {
    const { queue, queueIndex } = get()
    if (from === to || from < 0 || to < 0 || from >= queue.length || to >= queue.length) return
    const next = [...queue]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    // Adjust queueIndex to follow the currently playing track
    let newIndex = queueIndex
    if (from === queueIndex) {
      newIndex = to
    } else if (from < queueIndex && to >= queueIndex) {
      newIndex = queueIndex - 1
    } else if (from > queueIndex && to <= queueIndex) {
      newIndex = queueIndex + 1
    }
    set({ queue: next, queueIndex: newIndex })
  },

  removeFromQueue: (index: number) => {
    const { queue, queueIndex } = get()
    if (index < 0 || index >= queue.length) return
    const next = [...queue]
    next.splice(index, 1)
    let newIndex = queueIndex
    if (index < queueIndex) newIndex = queueIndex - 1
    else if (index === queueIndex) newIndex = Math.min(queueIndex, next.length - 1)
    set({ queue: next, queueIndex: Math.max(0, newIndex) })
  },

  jumpToQueueItem: (index: number) => {
    const { queue } = get()
    if (index < 0 || index >= queue.length) return
    void playAtIndex(index, get, set)
  },

  initAudioEvents: async () => {
    const unlisteners: UnlistenFn[] = []

    // Sync persisted volume to the audio engine on every startup.
    get().setVolume(get().volume)

    // Position updates from the Rust audio engine (~4x/sec)
    unlisteners.push(
      await listen<{ position_ms: number; duration_ms: number }>("audio://position", (e) => {
        const { currentTrack, queue, queueIndex, repeat, isRadioMode } = get()
        set({ positionMs: e.payload.position_ms })

        // Trigger pre-load when approaching end of track (30s before end)
        if (currentTrack && e.payload.duration_ms > 0) {
          const remaining = e.payload.duration_ms - e.payload.position_ms
          if (remaining > 0 && remaining < 30000 && remaining > 29500) {
            void preloadNextTrack(queue, queueIndex, repeat)
          }
        }

        // Proactively refill the queue when ≤ 5 tracks remain in radio mode
        if (isRadioMode && queue.length - queueIndex <= 5) {
          void appendRadioTracks(get, set as never)
        }
      }),
    )

    // Playback state changes
    unlisteners.push(
      await listen<{ type: string; state: string }>("audio://state", (e) => {
        const state = e.payload.state
        set({
          isPlaying: state === "playing",
          isBuffering: state === "buffering",
        })
      }),
    )

    // Track ended naturally — scrobble + advance to next
    unlisteners.push(
      await listen<{ type: string; rating_key: number }>("audio://track-ended", (e) => {
        // Scrobble the completed track
        void markPlayed(e.payload.rating_key)
        const { currentTrack } = get()
        if (currentTrack) {
          void reportTimeline(currentTrack.rating_key, "stopped", currentTrack.duration, currentTrack.duration)
        }
        void setNowPlayingState("stopped")
        get().next()
      }),
    )

    // Audio errors
    unlisteners.push(
      await listen<{ type: string; message: string }>("audio://error", (e) => {
        console.error("Audio engine error:", e.payload.message)
      }),
    )

    // Media key / Now Playing events forwarded from the Rust souvlaki integration
    unlisteners.push(
      await listen("media://play-pause", () => {
        const { isPlaying, currentTrack } = get()
        if (!currentTrack) return
        if (isPlaying) get().pause()
        else get().resume()
      }),
    )

    unlisteners.push(
      await listen("media://next", () => {
        get().next()
      }),
    )

    unlisteners.push(
      await listen("media://previous", () => {
        get().prev()
      }),
    )

    // Seek position set from the OS Now Playing scrubber
    unlisteners.push(
      await listen<number>("media://seek", (e) => {
        get().seekTo(e.payload)
      }),
    )

    // Stop command from the OS (e.g. closing Now Playing widget)
    unlisteners.push(
      await listen("media://stop", () => {
        const { currentTrack, positionMs } = get()
        if (currentTrack) {
          void reportTimeline(currentTrack.rating_key, "stopped", positionMs, currentTrack.duration)
        }
        void setNowPlayingState("stopped")
        set({ isPlaying: false, positionMs: 0 })
      }),
    )

    // Return cleanup function
    return () => {
      for (const unlisten of unlisteners) {
        unlisten()
      }
    }
  },
    }),
    {
      name: "plex-player-prefs",
      // Only persist lightweight user preferences — not playback runtime state.
      partialize: (state) => ({
        volume: state.volume,
        shuffle: state.shuffle,
        repeat: state.repeat,
        guestDjEnabled: state.guestDjEnabled,
      }),
    }
  )
)
