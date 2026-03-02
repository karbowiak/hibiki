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
  computeSonicPath,
  getArtistPopularTracksInSection,
  getStreamUrl,
  getStreamLevels,
  getLyrics,
  getTrack,
  reportTimeline,
  markPlayed,
  updateNowPlaying,
  setNowPlayingState,
  getPlaylistItems,
} from "../lib/plex"
import type { Track, Level, LyricLine } from "../types/plex"
import { useConnectionStore } from "./connectionStore"
import { useAudioSettingsStore } from "./audioSettingsStore"

type RadioType = 'track' | 'artist' | 'album' | 'playlist'

export type DjMode = 'stretch' | 'twin' | 'twofer' | 'anno' | 'groupie' | 'freeze'

export const DJ_MODES: { key: DjMode; name: string; desc: string }[] = [
  { key: 'stretch',  name: 'DJ Stretch',  desc: 'Inserts a short Sonic Adventure between each pair of tracks' },
  { key: 'twin',     name: 'DJ Gemini',   desc: 'Inserts the most sonically similar track after each track' },
  { key: 'freeze',   name: 'DJ Freeze',   desc: 'Keeps playing with shuffled tracks from the same seed' },
  { key: 'twofer',   name: 'DJ Twofer',   desc: 'Inserts another track by the same artist after each track' },
  { key: 'anno',     name: 'DJ Contempo', desc: 'Keeps the mood going with tracks from the same era' },
  { key: 'groupie',  name: 'DJ Groupie',  desc: 'Keeps queueing tracks from the same artist' },
]

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
  /** Active DJ personality, or null when DJ is off. Persisted as a preference. */
  djMode: DjMode | null

  /** Waveform level data fetched on track-start. Null when unavailable. Not persisted. */
  waveformLevels: Level[] | null

  /** Lyrics lines fetched on track-start. Null when unavailable or still loading. Not persisted. */
  lyricsLines: LyricLine[] | null

  /** Transient error message shown briefly in the Player UI. Null when no error. */
  playerError: string | null

  /** Display name for the current playback context ("My Playlist", "Ado Radio", etc.). */
  contextName: string | null
  /** Optional deep-link for the context label (e.g. "/playlist/123"). */
  contextHref: string | null

  playTrack: (track: Track, context?: Track[], contextName?: string | null, contextHref?: string | null) => Promise<void>
  /** Play a Plex URI via a server-side play queue. Handles full playlists with shuffle. */
  playFromUri: (uri: string, forceShuffle?: boolean, contextName?: string | null, contextHref?: string | null) => Promise<void>
  /** Start playing a playlist with progressive queue loading (100 tracks at a time). */
  playPlaylist: (playlistId: number, totalCount: number, title: string, href: string) => Promise<void>
  /**
   * Start a radio station seeded from the given item.
   * Uses `createRadioQueue` normally, or `createSmartShuffleQueue` when Guest DJ is enabled.
   * Pass `seedName` to set a human-readable context label ("Ado Radio").
   */
  playRadio: (ratingKey: number, radioType: RadioType, seedName?: string) => Promise<void>
  /** Append tracks to the end of the queue without touching radio/playlist state. */
  addToQueue: (tracks: Track[]) => void
  /** Stop radio auto-refill without clearing the existing queue. */
  stopRadio: () => void
  /** Set the active DJ personality (null = off). Re-seeds the current station immediately. */
  setDjMode: (mode: DjMode | null) => void
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
// Gapless/crossfade transition tracking
// ---------------------------------------------------------------------------

/**
 * When track-ended fires, we set this timeout as a fallback for the non-gapless
 * case (Rust stopped without a preloaded next track). If track-started fires first
 * (gapless/crossfade transition), we cancel it so next() is not called twice.
 */
let _gaplessTimeoutId: ReturnType<typeof setTimeout> | null = null

// ---------------------------------------------------------------------------
// Periodic timeline reporting — throttle to every 10 seconds
// ---------------------------------------------------------------------------

let _lastTimelineReportMs = 0
const TIMELINE_REPORT_INTERVAL_MS = 10_000

// Fire-and-forget wrappers — timeline/scrobble errors (400, 404) are
// non-fatal and must not surface as Unhandled Promise Rejections.
const _reportTimeline = (...args: Parameters<typeof reportTimeline>) =>
  void reportTimeline(...args).catch(() => {})
const _markPlayed = (...args: Parameters<typeof markPlayed>) =>
  void markPlayed(...args).catch(() => {})

// ---------------------------------------------------------------------------
// Radio — module-level state
// ---------------------------------------------------------------------------

/** Tracks which rating keys were added by the Guest DJ smart-shuffle. */
const _djGeneratedKeys = new Set<number>()
/** Returns true if this track was added to the queue by the Guest DJ. */
export function isDjGenerated(ratingKey: number): boolean {
  return _djGeneratedKeys.has(ratingKey)
}

/** Tracks which rating keys were auto-appended by the radio refill. */
const _radioGeneratedKeys = new Set<number>()
/** Returns true if this track was appended to the queue by radio auto-refill. */
export function isRadioGenerated(ratingKey: number): boolean {
  return _radioGeneratedKeys.has(ratingKey)
}

let _radioRefillInProgress = false

/** Keep only items that have actual audio (at least one media part with a key). */
function filterPlayable(tracks: Track[]): Track[] {
  return tracks.filter(t => t.media?.[0]?.parts?.[0]?.key)
}

/** Silently append a fresh batch of radio tracks when the queue is running low. */
async function appendRadioTracks(
  get: () => PlayerState,
  set: (updater: (s: PlayerState) => Partial<PlayerState>) => void,
) {
  const { isRadioMode, radioSeedKey, radioType, queue, queueIndex } = get()
  if (!isRadioMode || radioSeedKey === null || radioType === null || _radioRefillInProgress) return
  if (queue.length - queueIndex > 5) return  // plenty of tracks ahead

  _radioRefillInProgress = true
  try {
    const pq = await createRadioQueue(radioSeedKey, radioType)
    const newTracks = filterPlayable(pq.items)

    // Append only tracks not already in the queue to avoid duplicates
    const existingKeys = new Set(get().queue.map(t => t.rating_key))
    const dedupedTracks = newTracks.filter(t => {
      if (existingKeys.has(t.rating_key)) return false
      existingKeys.add(t.rating_key)  // deduplicate within batch too
      return true
    })
    if (dedupedTracks.length === 0) return

    dedupedTracks.forEach(t => _radioGeneratedKeys.add(t.rating_key))
    set(s => ({ queue: [...s.queue, ...dedupedTracks] }))
  } catch (err) {
    console.error("Radio queue refill failed:", err)
  } finally {
    _radioRefillInProgress = false
  }
}

// ---------------------------------------------------------------------------
// DJ track insertion — works in any playback context (playlist, album, radio)
// ---------------------------------------------------------------------------

let _djInsertInProgress = false

/**
 * Insert DJ-curated tracks into the queue based on the active DJ mode.
 * Fires on track-start and when enabling a DJ mode. Independent of radio.
 *
 * - Freeze:   1 sonically similar track (track radio seeded from current)
 * - Gemini:   1 most sonically similar track (smart shuffle twin mode)
 * - Stretch:  Sonic adventure path between current and next original track
 * - Twofer:   1 same-artist track (skips if current track is DJ-generated → alternating pattern)
 * - Contempo: 1 same-era track (smart shuffle anno mode)
 * - Groupie:  1 same-artist track via artist radio
 */
async function insertDjTracks(
  get: () => PlayerState,
  set: (updater: (s: PlayerState) => Partial<PlayerState>) => void,
) {
  const { djMode, currentTrack, queue, queueIndex } = get()
  if (!djMode || !currentTrack) return
  if (_djInsertInProgress) return

  // Twofer & Stretch skip when the current track is DJ-generated
  // (Twofer alternates user→DJ→user→DJ; Stretch path is already laid out)
  if ((djMode === 'twofer' || djMode === 'stretch') && _djGeneratedKeys.has(currentTrack.rating_key)) return

  _djInsertInProgress = true
  try {
    const existingKeys = new Set(queue.map(t => t.rating_key))
    let picks: Track[] = []

    switch (djMode) {
      case 'freeze': {
        // Sonically similar tracks seeded from the current track
        const pq = await createRadioQueue(currentTrack.rating_key, 'track')
        picks = filterPlayable(pq.items)
          .filter(t => !existingKeys.has(t.rating_key))
          .slice(0, 1)
        break
      }

      case 'twin': {
        // Most sonically similar track
        const pq = await createSmartShuffleQueue(currentTrack.rating_key, 'track', 'twin')
        picks = filterPlayable(pq.items)
          .filter(t => !existingKeys.has(t.rating_key))
          .slice(0, 1)
        break
      }

      case 'stretch': {
        // Sonic adventure between current track and the next original (non-DJ) track
        const { musicSectionId } = useConnectionStore.getState()
        const nextOriginal = queue.slice(queueIndex + 1).find(t => !_djGeneratedKeys.has(t.rating_key))
        if (musicSectionId && nextOriginal) {
          try {
            const pathTracks = await computeSonicPath(musicSectionId, currentTrack.rating_key, nextOriginal.rating_key)
            picks = filterPlayable(pathTracks)
              .filter(t =>
                !existingKeys.has(t.rating_key) &&
                t.rating_key !== currentTrack.rating_key &&
                t.rating_key !== nextOriginal.rating_key
              )
          } catch {
            // Sonic path unavailable — fall back to smart shuffle
            const pq = await createSmartShuffleQueue(currentTrack.rating_key, 'track', 'stretch')
            picks = filterPlayable(pq.items)
              .filter(t => !existingKeys.has(t.rating_key))
              .slice(0, 2)
          }
        } else if (musicSectionId) {
          // No next original track — use smart shuffle for a couple of bridge tracks
          const pq = await createSmartShuffleQueue(currentTrack.rating_key, 'track', 'stretch')
          picks = filterPlayable(pq.items)
            .filter(t => !existingKeys.has(t.rating_key))
            .slice(0, 2)
        }
        break
      }

      case 'twofer': {
        // Same-artist track
        const { musicSectionId } = useConnectionStore.getState()
        const artistId = parseInt(currentTrack.grandparent_key?.split('/').pop() ?? '0', 10)
        if (musicSectionId && artistId > 0) {
          const tracks = await getArtistPopularTracksInSection(musicSectionId, artistId, 10)
          const available = tracks.filter(t =>
            t.rating_key !== currentTrack.rating_key &&
            !existingKeys.has(t.rating_key)
          )
          if (available.length > 0) {
            picks = [available[Math.floor(Math.random() * available.length)]]
          }
        }
        break
      }

      case 'anno': {
        // Same era track
        const pq = await createSmartShuffleQueue(currentTrack.rating_key, 'track', 'anno')
        picks = filterPlayable(pq.items)
          .filter(t => !existingKeys.has(t.rating_key))
          .slice(0, 1)
        break
      }

      case 'groupie': {
        // Same artist via artist radio
        const artistId = parseInt(currentTrack.grandparent_key?.split('/').pop() ?? '0', 10)
        if (artistId > 0) {
          const pq = await createRadioQueue(artistId, 'artist')
          picks = filterPlayable(pq.items)
            .filter(t => !existingKeys.has(t.rating_key))
            .slice(0, 1)
        }
        break
      }
    }

    if (picks.length === 0) return

    picks.forEach(t => _djGeneratedKeys.add(t.rating_key))
    const { queueIndex: qi } = get()
    set(s => {
      const nq = [...s.queue]
      nq.splice(qi + 1, 0, ...picks)
      return { queue: nq }
    })
  } catch (err) {
    console.error('DJ track insertion failed:', err)
  } finally {
    _djInsertInProgress = false
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

/**
 * Session-level gain cache: rating_key → { trackGain, albumGain }.
 * Both values are cached together so switching modes doesn't require a new fetch.
 * Plex list endpoints don't include Stream sub-elements, so we lazily fetch on first play.
 */
const _gainCache = new Map<number, { trackGain: number | null; albumGain: number | null }>()

/**
 * Session-level waveform stream-ID cache: rating_key → audio stream id (null = "no audio stream").
 * Same fallback pattern as _gainCache — list endpoints don't include Stream sub-elements.
 */
const _waveformStreamCache = new Map<number, number | null>()

/** Fetch the audio stream ID for waveform levels, falling back to a metadata call if needed. */
async function fetchAudioStreamId(track: Track): Promise<number | null> {
  const inline = track.media?.[0]?.parts?.[0]?.streams?.find(s => s.stream_type === 2)?.id ?? null
  if (inline !== null) {
    _waveformStreamCache.set(track.rating_key, inline)
    return inline
  }
  if (_waveformStreamCache.has(track.rating_key)) {
    return _waveformStreamCache.get(track.rating_key) ?? null
  }
  try {
    const full = await getTrack(track.rating_key)
    const id = full.media?.[0]?.parts?.[0]?.streams?.find(s => s.stream_type === 2)?.id ?? null
    _waveformStreamCache.set(track.rating_key, id)
    return id
  } catch {
    _waveformStreamCache.set(track.rating_key, null)
    return null
  }
}

/**
 * Get the gain for a track, fetching full metadata from Plex if the track object
 * has no stream data (which happens for tracks loaded via list endpoints).
 * Respects `audioSettingsStore.albumGainMode` — uses album_gain when enabled.
 */
async function fetchGainDb(track: Track): Promise<number | null> {
  const { albumGainMode } = useAudioSettingsStore.getState()

  // Helper to pick the right gain value from a stream entry
  const pickGain = (trackGain: number | null, albumGain: number | null) =>
    albumGainMode ? (albumGain ?? trackGain) : trackGain

  // Fast path: streams included inline in the track object
  const stream = track.media?.[0]?.parts?.[0]?.streams?.find(s => s.stream_type === 2)
  if (stream !== undefined) {
    const trackGain = stream.gain ?? null
    const albumGain = stream.album_gain ?? null
    _gainCache.set(track.rating_key, { trackGain, albumGain })
    return pickGain(trackGain, albumGain)
  }

  // Cache hit — both track and album gain already resolved
  if (_gainCache.has(track.rating_key)) {
    const cached = _gainCache.get(track.rating_key)!
    return pickGain(cached.trackGain, cached.albumGain)
  }

  // Fetch full track metadata — /library/metadata/{id} includes Stream elements
  try {
    const full = await getTrack(track.rating_key)
    const fullStream = full.media?.[0]?.parts?.[0]?.streams?.find(s => s.stream_type === 2)
    const trackGain = fullStream?.gain ?? null
    const albumGain = fullStream?.album_gain ?? null
    _gainCache.set(track.rating_key, { trackGain, albumGain })
    return pickGain(trackGain, albumGain)
  } catch {
    _gainCache.set(track.rating_key, { trackGain: null, albumGain: null })
    return null
  }
}

/** Send a track to the Rust audio engine for playback. */
async function sendToAudioEngine(track: Track): Promise<void> {
  const partKey = track.media[0]?.parts[0]?.key
  if (!partKey) return

  // Build URL locally — avoids a Tauri IPC round-trip and PlexState lock contention
  const { baseUrl, token } = useConnectionStore.getState()
  const url = `${baseUrl}${partKey}?X-Plex-Token=${token}`
  // fetchGainDb falls back to a /library/metadata/{id} call when the track object
  // has no streams data (common for tracks loaded via playlist/album list endpoints).
  const gainDb = await fetchGainDb(track)
  await audioPlay(
    url,
    track.rating_key,
    track.duration,
    track.media[0]?.parts[0]?.id ?? 0,
    track.parent_key,
    track.index,
    gainDb,
  )
}

/**
 * Fetch and set lyrics for a track, guarded against stale results from a previous track.
 * Retries once after 2 s on transient error before giving up.
 */
function fetchLyricsForTrack(ratingKey: number, get: () => PlayerState, set: any): void {
  void getLyrics(ratingKey)
    .then(lines => {
      if (get().currentTrack?.rating_key === ratingKey) set({ lyricsLines: lines })
    })
    .catch(err => {
      console.warn(`Lyrics fetch failed for track ${ratingKey}, retrying once:`, err)
      setTimeout(() => {
        if (get().currentTrack?.rating_key !== ratingKey) return
        void getLyrics(ratingKey)
          .then(lines => {
            if (get().currentTrack?.rating_key === ratingKey) set({ lyricsLines: lines })
          })
          .catch(() => {
            if (get().currentTrack?.rating_key === ratingKey) set({ lyricsLines: [] })
          })
      }, 2000)
    })
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
    const gainDb = await fetchGainDb(nextTrack)
    await audioPreloadNext(
      url,
      nextTrack.rating_key,
      nextTrack.duration,
      nextTrack.media[0]?.parts[0]?.id ?? 0,
      nextTrack.parent_key,
      nextTrack.index,
      gainDb,
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
  set({ currentTrack: track, queueIndex: index, isPlaying: true, positionMs: 0, waveformLevels: null, lyricsLines: null })
  _lastTimelineReportMs = 0

  // Fetch waveform data — falls back to a metadata call when track lacks inline stream data
  void fetchAudioStreamId(track).then(streamId => {
    if (!streamId) return
    return getStreamLevels(streamId, 128)
      .then(levels => { if (levels.length > 0) set({ waveformLevels: levels }) })
      .catch(() => {/* waveform unavailable */})
  })
  fetchLyricsForTrack(track.rating_key, get, set)
  _reportTimeline(track.rating_key, "playing", 0, track.duration)
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

  // DJ: insert curated tracks for the new current track
  if (get().djMode) {
    void insertDjTracks(get, set)
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
  djMode: null,
  waveformLevels: null,
  lyricsLines: null,
  playerError: null,
  contextName: null,
  contextHref: null,

  playTrack: async (track: Track, context?: Track[], contextName?: string | null, contextHref?: string | null) => {
    const { sectionUuid } = useConnectionStore.getState()
    const itemKey = `/library/metadata/${track.rating_key}`
    const uri = sectionUuid ? buildItemUri(sectionUuid, itemKey) : itemKey
    const { shuffle, repeat } = get()

    // Update UI immediately — never block the player display on network calls
    const queue = context ?? [track]
    const queueIndex = Math.max(0, context ? context.findIndex(t => t.rating_key === track.rating_key) : 0)
    // Explicit track selection: clear progressive playlist and radio context.
    set({ currentTrack: track, queue, queueIndex, isPlaying: true, positionMs: 0,
      waveformLevels: null, lyricsLines: null,
      playlistKey: null, playlistTotalCount: 0, playlistLoadedCount: 0,
      isRadioMode: false, radioSeedKey: null, radioType: null,
      contextName: contextName ?? null, contextHref: contextHref ?? null })
    _lastTimelineReportMs = 0
    void fetchAudioStreamId(track).then(streamId => {
      if (!streamId) return
      return getStreamLevels(streamId, 128)
        .then(levels => { if (levels.length > 0) set({ waveformLevels: levels }) })
        .catch(() => {})
    })
    fetchLyricsForTrack(track.rating_key, get, set)
    _reportTimeline(track.rating_key, "playing", 0, track.duration)
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
      if (get().djMode) void insertDjTracks(get, set as never)
    } catch (err) {
      console.error("playTrack failed:", err)
    }
  },

  playFromUri: async (uri: string, forceShuffle?: boolean, contextName?: string | null, contextHref?: string | null) => {
    const { shuffle, repeat } = get()
    const shouldShuffle = forceShuffle ?? shuffle
    try {
      const playQueue = await createPlayQueue(uri, shouldShuffle, repeat)
      if (playQueue.items.length === 0) {
        set({ playerError: "Couldn't load tracks — playlist may be empty or unsupported." })
        setTimeout(() => set({ playerError: null }), 5000)
        return
      }
      const firstTrack = playQueue.items[0]

      // Update UI as soon as we know what track is first — before the audio fetch.
      // Server-side play queue: clear all radio/DJ context (Plex owns the queue now).
      _djGeneratedKeys.clear()
      _radioGeneratedKeys.clear()
      _radioRefillInProgress = false
      set({
        currentTrack: firstTrack,
        queue: playQueue.items,
        queueIndex: 0,
        queueId: playQueue.id,
        isPlaying: true,
        positionMs: 0,
        waveformLevels: null,
        lyricsLines: null,
        shuffle: shouldShuffle,
        playlistKey: null,
        playlistTotalCount: 0,
        playlistLoadedCount: 0,
        isRadioMode: false,
        radioSeedKey: null,
        radioType: null,
        contextName: contextName ?? null,
        contextHref: contextHref ?? null,
      })
      _lastTimelineReportMs = 0
      void fetchAudioStreamId(firstTrack).then(streamId => {
        if (!streamId) return
        return getStreamLevels(streamId, 128)
          .then(levels => { if (levels.length > 0) set({ waveformLevels: levels }) })
          .catch(() => {})
      })
      fetchLyricsForTrack(firstTrack.rating_key, get, set)
      _reportTimeline(firstTrack.rating_key, "playing", 0, firstTrack.duration)
      void updateNowPlaying(
        firstTrack.title,
        firstTrack.grandparent_title ?? "",
        firstTrack.parent_title ?? "",
        firstTrack.thumb || firstTrack.parent_thumb || null,
        firstTrack.duration ?? 0,
      )
      void setNowPlayingState("playing", 0)

      await sendToAudioEngine(firstTrack)
      if (get().djMode) void insertDjTracks(get, set as never)
    } catch (err) {
      console.error("playFromUri failed:", err)
      const msg = err instanceof Error ? err.message : String(err)
      set({ playerError: `Shuffle failed: ${msg}` })
      setTimeout(() => set({ playerError: null }), 6000)
    }
  },

  playPlaylist: async (playlistId: number, totalCount: number, title: string, href: string) => {
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
      waveformLevels: null,
      lyricsLines: null,
      playlistKey: playlistId,
      playlistTotalCount: totalCount,
      playlistLoadedCount: tracks.length,
      isLoadingMoreTracks: false,
      contextName: title,
      contextHref: href,
    })
    void fetchAudioStreamId(firstTrack).then(streamId => {
      if (!streamId) return
      return getStreamLevels(streamId, 128)
        .then(levels => { if (levels.length > 0) set({ waveformLevels: levels }) })
        .catch(() => {})
    })
    fetchLyricsForTrack(firstTrack.rating_key, get, set)
    _reportTimeline(firstTrack.rating_key, "playing", 0, firstTrack.duration)
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
    if (get().djMode) void insertDjTracks(get, set as never)
  },

  playRadio: async (ratingKey: number, radioType: RadioType, seedName?: string) => {
    _djGeneratedKeys.clear()
    _radioGeneratedKeys.clear()
    _radioRefillInProgress = false

    try {
      const playQueue = await createRadioQueue(ratingKey, radioType)

      // Filter to playable tracks (skip artist/album metadata that Plex may include
      // as the first item in a station play queue), then deduplicate by rating_key.
      // Plex sonic radio often returns the seed track as both the pivot (index 0)
      // and again as the top sonically-similar result (index 1).
      const playable = filterPlayable(playQueue.items)
      const seenKeys = new Set<number>()
      const tracks = playable.filter(t => seenKeys.has(t.rating_key) ? false : (seenKeys.add(t.rating_key), true))

      if (tracks.length === 0) {
        set({ playerError: "Radio returned no playable tracks — the server may not support sonic analysis for this item." })
        setTimeout(() => set({ playerError: null }), 5000)
        return
      }
      const firstTrack = tracks[0]

      // Mark all tracks except the seed (index 0) as radio-generated so the queue
      // panel shows the radio indicator on the full initial batch, not just refill tracks.
      tracks.slice(1).forEach(t => _radioGeneratedKeys.add(t.rating_key))

      // Only update context label when a seedName was explicitly supplied.
      // Re-seeds triggered by next() / setDjMode() omit seedName to preserve the label.
      const radioHref = radioType === 'artist' ? `/artist/${ratingKey}`
        : radioType === 'album' ? `/album/${ratingKey}`
        : radioType === 'playlist' ? `/playlist/${ratingKey}`
        : null
      const contextUpdate = seedName !== undefined
        ? { contextName: `${seedName} Radio`, contextHref: radioHref }
        : {}

      set({
        currentTrack: firstTrack,
        queue: tracks,
        queueIndex: 0,
        queueId: playQueue.id,
        isPlaying: true,
        positionMs: 0,
        waveformLevels: null,
        lyricsLines: null,
        isRadioMode: true,
        radioSeedKey: ratingKey,
        radioType,
        playlistKey: null,
        playlistTotalCount: 0,
        playlistLoadedCount: 0,
        playerError: null,
        ...contextUpdate,
      })
      void fetchAudioStreamId(firstTrack).then(streamId => {
        if (!streamId) return
        return getStreamLevels(streamId, 128)
          .then(levels => { if (levels.length > 0) set({ waveformLevels: levels }) })
          .catch(() => {})
      })
      fetchLyricsForTrack(firstTrack.rating_key, get, set)
      _reportTimeline(firstTrack.rating_key, "playing", 0, firstTrack.duration)
      void updateNowPlaying(
        firstTrack.title,
        firstTrack.grandparent_title ?? "",
        firstTrack.parent_title ?? "",
        firstTrack.thumb || firstTrack.parent_thumb || null,
        firstTrack.duration ?? 0,
      )
      void setNowPlayingState("playing", 0)

      await sendToAudioEngine(firstTrack)
      if (get().djMode) void insertDjTracks(get, set as never)
    } catch (err) {
      console.error("playRadio failed:", err)
      const msg = err instanceof Error ? err.message : String(err)
      set({ playerError: `Radio failed: ${msg}` })
      setTimeout(() => set({ playerError: null }), 6000)
    }
  },

  addToQueue: (tracks: Track[]) => {
    set(s => ({ queue: [...s.queue, ...tracks] }))
  },

  stopRadio: () => {
    set({ isRadioMode: false, radioSeedKey: null, radioType: null })
  },

  setDjMode: (mode: DjMode | null) => {
    // Remove future DJ-generated bonus tracks from the queue
    set(s => ({
      queue: s.queue.filter((t, i) =>
        i <= s.queueIndex || !_djGeneratedKeys.has(t.rating_key)
      ),
    }))
    _djGeneratedKeys.clear()
    _djInsertInProgress = false

    set({ djMode: mode })

    if (mode === null) return  // DJ off: cleaned up, nothing more to do

    // Immediately insert DJ tracks for the current track (works in any context)
    void insertDjTracks(get, set as never)
  },

  pause: () => {
    void audioPause()
    set({ isPlaying: false })
    const { currentTrack, positionMs } = get()
    if (currentTrack) {
      _reportTimeline(currentTrack.rating_key, "paused", positionMs, currentTrack.duration)
      void setNowPlayingState("paused", positionMs)
    }
  },

  resume: () => {
    void audioResume()
    set({ isPlaying: true })
    const { currentTrack, positionMs } = get()
    if (currentTrack) {
      _reportTimeline(currentTrack.rating_key, "playing", positionMs, currentTrack.duration)
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
      _reportTimeline(currentTrack.rating_key, "playing", ms, currentTrack.duration)
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
        const { currentTrack, queue, queueIndex, repeat, isRadioMode, isPlaying } = get()
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

        // Periodic timeline report every 10s so Plex shows "Now Playing" on
        // other clients and correctly tracks resume position.
        if (isPlaying && currentTrack) {
          const now = e.payload.position_ms
          if (now - _lastTimelineReportMs >= TIMELINE_REPORT_INTERVAL_MS) {
            _lastTimelineReportMs = now
            _reportTimeline(currentTrack.rating_key, "playing", now, currentTrack.duration)
          }
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

    // Track ended naturally — scrobble + handle repeat-one.
    // For gapless/crossfade: track-started fires quickly and cancels the fallback timeout.
    // For non-gapless (Rust stopped without a preloaded next): the 500ms timeout calls next().
    unlisteners.push(
      await listen<{ type: string; rating_key: number }>("audio://track-ended", (e) => {
        const { currentTrack, repeat, queueIndex } = get()
        // Only clear waveform/lyrics if this track is still the active one.
        // If the user already switched tracks, preserve the new track's loaded state.
        if (currentTrack?.rating_key === e.payload.rating_key) {
          set({ waveformLevels: null, lyricsLines: null })
        }
        _markPlayed(e.payload.rating_key)
        if (currentTrack) {
          _reportTimeline(currentTrack.rating_key, "stopped", currentTrack.duration, currentTrack.duration)
        }

        // Repeat-one: restart the current track immediately
        if (repeat === 1) {
          void playAtIndex(queueIndex, get, set)
          return
        }

        // Fallback for non-gapless: advance queue if track-started doesn't fire within 500ms
        if (_gaplessTimeoutId !== null) clearTimeout(_gaplessTimeoutId)
        _gaplessTimeoutId = setTimeout(() => {
          _gaplessTimeoutId = null
          get().next()
        }, 500)
      }),
    )

    // Track started — fired for gapless transitions, crossfade completions, and user-initiated plays.
    // For gapless/crossfade: advance queue state without calling audioPlay() (audio is already playing).
    // For user-initiated plays: currentTrack already matches, so we skip.
    unlisteners.push(
      await listen<{ type: string; rating_key: number }>("audio://track-started", (e) => {
        // Cancel the non-gapless fallback timeout — Rust handled the transition
        if (_gaplessTimeoutId !== null) {
          clearTimeout(_gaplessTimeoutId)
          _gaplessTimeoutId = null
        }

        const { currentTrack, queue, queueIndex, repeat, isRadioMode, djMode,
                playlistKey, playlistLoadedCount, playlistTotalCount } = get()

        // User-initiated play: playAtIndex() already updated state — nothing to do here,
        // but still fetch waveform if it hasn't been loaded yet (playAtIndex fetches it too,
        // this handles the rare race where track-started fires before the fetch completes).
        if (currentTrack?.rating_key === e.payload.rating_key) return

        // Gapless/crossfade transition: find the next track
        let nextIndex = queueIndex + 1
        if (nextIndex >= queue.length && repeat === 2) nextIndex = 0

        // Verify the next track matches — fall back to searching the queue
        if (!queue[nextIndex] || queue[nextIndex].rating_key !== e.payload.rating_key) {
          const found = queue.findIndex(t => t.rating_key === e.payload.rating_key)
          if (found < 0) return
          nextIndex = found
        }

        const track = queue[nextIndex]
        if (!track) return

        // Advance queue state — audio is already playing, do NOT call audioPlay()
        set({ currentTrack: track, queueIndex: nextIndex, positionMs: 0, isPlaying: true, waveformLevels: null, lyricsLines: null })
        _lastTimelineReportMs = 0
        _reportTimeline(track.rating_key, "playing", 0, track.duration)

        // Fetch waveform data — falls back to a metadata call when track lacks inline stream data
        void fetchAudioStreamId(track).then(streamId => {
          if (!streamId) return
          return getStreamLevels(streamId, 128)
            .then(levels => { if (levels.length > 0) set({ waveformLevels: levels }) })
            .catch(() => {/* waveform unavailable */})
        })
        fetchLyricsForTrack(track.rating_key, get, set)
        void updateNowPlaying(
          track.title,
          track.grandparent_title ?? "",
          track.parent_title ?? "",
          track.thumb || track.parent_thumb || null,
          track.duration ?? 0,
        )
        void setNowPlayingState("playing", 0)

        // Pre-buffer the track after this one for the next gapless transition
        void preloadNextTrack(get().queue, nextIndex, repeat)

        // Progressive playlist loading: load more when approaching end
        if (playlistKey && playlistLoadedCount < playlistTotalCount && nextIndex >= queue.length - 20) {
          void loadMorePlaylistTracks(get, set as never)
        }

        // Radio: refill queue if running low
        if (isRadioMode && queue.length - nextIndex <= 5) {
          void appendRadioTracks(get, set as never)
        }

        // DJ: insert curated tracks based on active DJ mode
        if (djMode) {
          void insertDjTracks(get, set as never)
        }
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
          _reportTimeline(currentTrack.rating_key, "stopped", positionMs, currentTrack.duration)
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
        djMode: state.djMode,
      }),
    }
  )
)
