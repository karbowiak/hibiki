import { create } from "zustand"
import { persist } from "zustand/middleware"
import { listen } from "@tauri-apps/api/event"
import { fireAndForget } from "../lib/async"
import { engine } from "../audio/WebAudioEngine"
import type { MusicTrack } from "../types/music"
import type { LevelData, LyricLineData } from "../providers/types"
import { useProviderStore } from "./providerStore"
import { useAudioSettingsStore } from "./audioSettingsStore"
import { useNotificationStore } from "./notificationStore"
import { evictMap } from "./cacheUtils"
import { sendNotification } from "@tauri-apps/plugin-notification"
import { useSleepTimerStore } from "./sleepTimerStore"
import { useAnnouncerStore } from "./announcerStore"
import { useVisualizerStore } from "./visualizerStore"
import { useRadioStreamStore } from "./radioStreamStore"
import { radioStop, radioSetVolume } from "../lib/radioAudio"
import { getAudioTranscodeUrl } from "../backends/plex/api"

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
  currentTrack: MusicTrack | null
  queue: MusicTrack[]
  queueIndex: number
  queueId: number | null
  isPlaying: boolean
  isBuffering: boolean
  positionMs: number
  shuffle: boolean
  repeat: 0 | 1 | 2
  volume: number

  /** Progressive playlist loading context — null when not playing from a playlist. */
  playlistKey: string | null
  playlistTotalCount: number
  playlistLoadedCount: number
  isLoadingMoreTracks: boolean

  /** Radio mode: true while a radio/Guest DJ station is active. */
  isRadioMode: boolean
  /** ID of the item that seeded the current radio station. */
  radioSeedKey: string | null
  /** Type of seed item used to start radio. */
  radioType: RadioType | null
  /** Artist name for the seed item (track/album radio only). Shown in the Radio panel. */
  radioSeedArtist: string | null
  /** Active DJ personality, or null when DJ is off. Persisted as a preference. */
  djMode: DjMode | null
  /**
   * Variety of radio suggestions: 0 = focused (very similar), 1-4 = increasing diversity,
   * -1 = unlimited (anything goes). Maps to Plex `degreesOfSeparation`.
   */
  radioDegreesOfSeparation: number
  /** Minimum number of tracks to keep queued ahead before triggering a refill. */
  radioMinQueue: number
  setRadioDegreesOfSeparation: (v: number) => void
  setRadioMinQueue: (v: number) => void

  /** Waveform level data fetched on track-start. Null when unavailable. Not persisted. */
  waveformLevels: LevelData[] | null

  /** Lyrics lines fetched on track-start. Null when unavailable or still loading. Not persisted. */
  lyricsLines: LyricLineData[] | null

  /** Transient error message shown briefly in the Player UI. Null when no error. */
  playerError: string | null

  /** True when internet radio (HTML5 audio) is active instead of the Rust engine. */
  isInternetRadioActive: boolean

  /** Display name for the current playback context ("My Playlist", "Ado Radio", etc.). */
  contextName: string | null
  /** Optional deep-link for the context label (e.g. "/playlist/123"). */
  contextHref: string | null

  playTrack: (track: MusicTrack, context?: MusicTrack[], contextName?: string | null, contextHref?: string | null) => Promise<void>
  /** Play a URI via a server-side play queue. Handles full playlists with shuffle. */
  playFromUri: (uri: string, forceShuffle?: boolean, contextName?: string | null, contextHref?: string | null) => Promise<void>
  /** Start playing a playlist with progressive queue loading (100 tracks at a time). */
  playPlaylist: (playlistId: string, totalCount: number, title: string, href: string) => Promise<void>
  /**
   * Start a radio station seeded from the given item.
   * Uses `createRadioQueue` normally, or `createSmartShuffleQueue` when Guest DJ is enabled.
   * Pass `seedName` to set a human-readable context label ("Ado Radio").
   */
  playRadio: (seedId: string, radioType: RadioType, seedName?: string) => Promise<void>
  /** Insert tracks immediately after the current track (play next). */
  addNext: (tracks: MusicTrack[]) => void
  /** Append tracks to the end of the queue without touching radio/playlist state. */
  addToQueue: (tracks: MusicTrack[]) => void
  /** Stop radio auto-refill without clearing the existing queue. */
  stopRadio: () => void
  /** Set the active DJ personality (null = off). Re-seeds the current station immediately. */
  setDjMode: (mode: DjMode | null) => void
  stop: () => void
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
  /** Remove all tracks after the current one. */
  clearUpcoming: () => void

  /** Initialize Tauri event listeners for the Rust audio engine. Call once on app mount. */
  initAudioEvents: () => Promise<() => void>
}

// ---------------------------------------------------------------------------
// Provider helper
// ---------------------------------------------------------------------------

function getProvider() {
  return useProviderStore.getState().provider
}

// ---------------------------------------------------------------------------
// Audio prefetch — module-level dedup set
// ---------------------------------------------------------------------------

const _prefetchedPartKeys = new Set<string>()

// ---------------------------------------------------------------------------
// Track ID resolution — maps numeric rating_key → MusicTrack.id
// ---------------------------------------------------------------------------

/** Maps numeric rating_key (sent to Rust engine) → MusicTrack.id string. */
const _ratingKeyToTrackId = new Map<number, string>()

function resolveTrackId(ratingKey: number): string {
  return _ratingKeyToTrackId.get(ratingKey) ?? String(ratingKey)
}

// ---------------------------------------------------------------------------
// Gapless/crossfade transition tracking
// ---------------------------------------------------------------------------

/**
 * When track-ended fires, we set this timeout as a fallback for the non-gapless
 * case (Rust stopped without a preloaded next track). If track-started fires first
 * (gapless/crossfade transition), we cancel it so next() is not called twice.
 */
let _gaplessTimeoutId: ReturnType<typeof setTimeout> | null = null

// Monotonic counter for concurrent play guard — each _startPlayback call increments
// and captures its value. After async work, if the counter changed, a newer play
// superseded this one and the current call bails out.
let _playGeneration = 0

// Transcode fallback state — tracks whether we've already retried with transcoding
// for the current track, to avoid infinite retry loops.
let _transcodeRetriedTrackId: string | null = null


// ---------------------------------------------------------------------------
// Periodic timeline reporting — throttle to every 10 seconds
// ---------------------------------------------------------------------------

let _lastTimelineReportMs = 0
const TIMELINE_REPORT_INTERVAL_MS = 10_000

// Fire-and-forget wrappers — timeline/scrobble errors (400, 404) are
// non-fatal and must not surface as Unhandled Promise Rejections.
const _reportProgress = (trackId: string, state: string, positionMs: number, duration: number) => {
  const provider = getProvider()
  if (provider) fireAndForget(provider.reportProgress(trackId, positionMs, state, duration))
}
const _markPlayed = (trackId: string) => {
  const provider = getProvider()
  if (provider) fireAndForget(provider.markPlayed(trackId))
}

// ---------------------------------------------------------------------------
// Last.fm integration — module-level tracking
// ---------------------------------------------------------------------------

/**
 * Unix timestamp (seconds) when the current track started playing.
 * Set in _onTrackBecomesActive, used by the track-ended handler to pass
 * `started_at_unix` to the Last.fm scrobble API.
 */
let _trackStartedAtUnix = 0

// ---------------------------------------------------------------------------
// Radio — module-level state
// ---------------------------------------------------------------------------

/** Tracks whose IDs were added by the Guest DJ smart-shuffle. */
const _djGeneratedKeys = new Set<string>()
/** Returns true if this track was added to the queue by the Guest DJ. */
export function isDjGenerated(trackId: string): boolean {
  return _djGeneratedKeys.has(trackId)
}

/** Tracks whose IDs were auto-appended by the radio refill. */
const _radioGeneratedKeys = new Set<string>()
/** Returns true if this track was appended to the queue by radio auto-refill. */
export function isRadioGenerated(trackId: string): boolean {
  return _radioGeneratedKeys.has(trackId)
}

let _radioRefillInProgress = false

/** Keep only items that have actual audio (at least one media part with a key). */
function filterPlayable(tracks: MusicTrack[]): MusicTrack[] {
  return tracks.filter(t => t.mediaInfo?.hasAudioStream)
}

/** Silently append a fresh batch of radio tracks when the queue is running low. */
async function appendRadioTracks(
  get: () => PlayerState,
  set: (updater: (s: PlayerState) => Partial<PlayerState>) => void,
) {
  const { isRadioMode, radioSeedKey, radioType, queue, queueIndex, radioDegreesOfSeparation, radioMinQueue } = get()
  if (!isRadioMode || radioSeedKey === null || radioType === null || _radioRefillInProgress) return
  // `queue.length - queueIndex - 1` = tracks strictly after current position
  if (queue.length - queueIndex - 1 >= radioMinQueue) return  // plenty of tracks ahead

  const provider = getProvider()
  if (!provider?.createRadioQueue) return

  _radioRefillInProgress = true
  try {
    const result = await provider.createRadioQueue(radioSeedKey, radioType, radioDegreesOfSeparation)
    const newTracks = filterPlayable(result.tracks)

    // Append only tracks not already in the queue to avoid duplicates
    const existingKeys = new Set(get().queue.map(t => t.id))
    const candidates = newTracks.filter(t => {
      if (existingKeys.has(t.id)) return false
      existingKeys.add(t.id)  // deduplicate within batch too
      return true
    })

    // Cap the batch: only add enough to bring the queue to radioMinQueue + 1 ahead.
    // This prevents 3+ tracks popping in at once — at most 1–2 appear at a time.
    const { queue: latestQueue, queueIndex: latestIdx } = get()
    const tracksAhead = latestQueue.length - latestIdx - 1
    const needed = Math.max(0, radioMinQueue + 1 - tracksAhead)
    const capped = candidates.slice(0, needed)
    if (capped.length === 0) return

    capped.forEach(t => _radioGeneratedKeys.add(t.id))
    set(s => ({ queue: [...s.queue, ...capped] }))
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

  const provider = getProvider()
  if (!provider) return

  // Twofer & Stretch skip when the current track is DJ-generated
  // (Twofer alternates user→DJ→user→DJ; Stretch path is already laid out)
  if ((djMode === 'twofer' || djMode === 'stretch') && _djGeneratedKeys.has(currentTrack.id)) return

  _djInsertInProgress = true
  try {
    const existingKeys = new Set(queue.map(t => t.id))
    let picks: MusicTrack[] = []

    switch (djMode) {
      case 'freeze': {
        // Sonically similar tracks seeded from the current track
        if (!provider.createRadioQueue) break
        const result = await provider.createRadioQueue(currentTrack.id, 'track')
        picks = filterPlayable(result.tracks)
          .filter(t => !existingKeys.has(t.id))
          .slice(0, 1)
        break
      }

      case 'twin': {
        // Most sonically similar track
        if (!provider.createSmartShuffleQueue) break
        const result = await provider.createSmartShuffleQueue(currentTrack.id, 'track', 'twin')
        picks = filterPlayable(result.tracks)
          .filter(t => !existingKeys.has(t.id))
          .slice(0, 1)
        break
      }

      case 'stretch': {
        // Sonic adventure between current track and the next original (non-DJ) track
        const nextOriginal = queue.slice(queueIndex + 1).find(t => !_djGeneratedKeys.has(t.id))
        if (nextOriginal && provider.computeSonicPath) {
          try {
            const pathTracks = await provider.computeSonicPath(currentTrack.id, nextOriginal.id)
            picks = filterPlayable(pathTracks)
              .filter(t =>
                !existingKeys.has(t.id) &&
                t.id !== currentTrack.id &&
                t.id !== nextOriginal.id
              )
          } catch {
            // Sonic path unavailable — fall back to smart shuffle
            if (provider.createSmartShuffleQueue) {
              const result = await provider.createSmartShuffleQueue(currentTrack.id, 'track', 'stretch')
              picks = filterPlayable(result.tracks)
                .filter(t => !existingKeys.has(t.id))
                .slice(0, 2)
            }
          }
        } else if (provider.createSmartShuffleQueue) {
          // No next original track — use smart shuffle for a couple of bridge tracks
          const result = await provider.createSmartShuffleQueue(currentTrack.id, 'track', 'stretch')
          picks = filterPlayable(result.tracks)
            .filter(t => !existingKeys.has(t.id))
            .slice(0, 2)
        }
        break
      }

      case 'twofer': {
        // Same-artist track
        const artistId = currentTrack.artistId
        if (artistId && provider.getArtistPopularTracksInSection) {
          const tracks = await provider.getArtistPopularTracksInSection(artistId, 10)
          const available = tracks.filter(t =>
            t.id !== currentTrack.id &&
            !existingKeys.has(t.id)
          )
          if (available.length > 0) {
            picks = [available[Math.floor(Math.random() * available.length)]]
          }
        }
        break
      }

      case 'anno': {
        // Same era track
        if (!provider.createSmartShuffleQueue) break
        const result = await provider.createSmartShuffleQueue(currentTrack.id, 'track', 'anno')
        picks = filterPlayable(result.tracks)
          .filter(t => !existingKeys.has(t.id))
          .slice(0, 1)
        break
      }

      case 'groupie': {
        // Same artist via artist radio
        const artistId = currentTrack.artistId
        if (artistId && provider.createRadioQueue) {
          const result = await provider.createRadioQueue(artistId, 'artist')
          picks = filterPlayable(result.tracks)
            .filter(t => !existingKeys.has(t.id))
            .slice(0, 1)
        }
        break
      }
    }

    if (picks.length === 0) return

    picks.forEach(t => _djGeneratedKeys.add(t.id))
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

/** Pre-resolve playback URL for a track on hover. Deduped per track id. */
export function prefetchTrackAudio(track: MusicTrack): void {
  if (_prefetchedPartKeys.has(track.id)) return
  _prefetchedPartKeys.add(track.id)
  if (track.streamUrl?.startsWith("http")) return
  const provider = getProvider()
  if (!provider) return
  // Just resolve the URL so it's cached by the provider — no disk cache needed
  fireAndForget(provider.getPlaybackInfo(track).then(() => {}))
}

/**
 * Session-level gain cache: track id → { trackGain, albumGain }.
 * Both values are cached together so switching modes doesn't require a new fetch.
 * List endpoints don't include Stream sub-elements, so we lazily fetch on first play.
 */
const _gainCache = new Map<string, { trackGain: number | null; albumGain: number | null }>()

/**
 * Session-level waveform stream-ID cache: track id → audio stream id (null = "no audio stream").
 * Same fallback pattern as _gainCache — list endpoints don't include Stream sub-elements.
 */
const _waveformStreamCache = new Map<string, number | null>()

/** Fetch the audio stream ID for waveform levels, falling back to a metadata call if needed. */
async function fetchAudioStreamId(track: MusicTrack): Promise<number | null> {
  const inline = track.mediaInfo?.audioStreamId ?? null
  if (inline !== null) {
    _waveformStreamCache.set(track.id, inline)
    evictMap(_waveformStreamCache, 500)
    return inline
  }
  if (_waveformStreamCache.has(track.id)) {
    return _waveformStreamCache.get(track.id) ?? null
  }
  const provider = getProvider()
  if (!provider) return null
  try {
    const full = await provider.getTrack(track.id)
    const id = full.mediaInfo?.audioStreamId ?? null
    _waveformStreamCache.set(track.id, id)
    evictMap(_waveformStreamCache, 500)
    return id
  } catch {
    _waveformStreamCache.set(track.id, null)
    evictMap(_waveformStreamCache, 500)
    return null
  }
}

/**
 * Get the gain for a track, fetching full metadata if the track object
 * has no stream data (which happens for tracks loaded via list endpoints).
 * Respects `audioSettingsStore.albumGainMode` — uses album_gain when enabled.
 */
async function fetchGainDb(track: MusicTrack): Promise<number | null> {
  const { albumGainMode } = useAudioSettingsStore.getState()

  // Helper to pick the right gain value
  const pickGain = (trackGain: number | null, albumGain: number | null) =>
    albumGainMode ? (albumGain ?? trackGain) : trackGain

  // Fast path: gain already on the MusicTrack (mapped from stream data)
  if (track.gain !== null || track.albumGain !== null) {
    _gainCache.set(track.id, { trackGain: track.gain, albumGain: track.albumGain })
    evictMap(_gainCache, 500)
    return pickGain(track.gain, track.albumGain)
  }

  // Cache hit — both track and album gain already resolved
  if (_gainCache.has(track.id)) {
    const cached = _gainCache.get(track.id)!
    return pickGain(cached.trackGain, cached.albumGain)
  }

  // Fetch full track metadata — includes Stream elements with gain data
  const provider = getProvider()
  if (!provider) return null
  try {
    const full = await provider.getTrack(track.id)
    _gainCache.set(track.id, { trackGain: full.gain, albumGain: full.albumGain })
    evictMap(_gainCache, 500)
    return pickGain(full.gain, full.albumGain)
  } catch {
    _gainCache.set(track.id, { trackGain: null, albumGain: null })
    evictMap(_gainCache, 500)
    return null
  }
}

/** Simple string hash for synthetic track keys. */
function hashCode(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return h
}

/** Check if a track is a podcast episode (has direct stream URL + podcast provider data). */
function _isPodcastTrack(track: MusicTrack): boolean {
  const pd = track._providerData as Record<string, unknown> | undefined
  return pd?.isPodcast === true
}

/** Send a track to the Web Audio engine for playback. */
async function sendToAudioEngine(track: MusicTrack): Promise<void> {
  // Direct URL tracks (podcasts, external audio) bypass provider.getPlaybackInfo()
  if (track.streamUrl?.startsWith("http")) {
    const syntheticKey = Math.abs(hashCode(track.id))
    _ratingKeyToTrackId.set(syntheticKey, track.id)
    await engine.play(track.streamUrl, syntheticKey, track.duration, "", null, true)
    return
  }
  const provider = getProvider()
  if (!provider) return
  const info = await provider.getPlaybackInfo(track)
  _ratingKeyToTrackId.set(info.trackKey, track.id)
  const gainDb = await fetchGainDb(track)
  await engine.play(
    info.url,
    info.trackKey,
    track.duration,
    info.parentKey,
    gainDb,
    undefined,
    track.startRamp ?? info.startRamp,
    track.endRamp ?? info.endRamp,
  )
}

/**
 * Fetch and set lyrics for a track, guarded against stale results from a previous track.
 * Retries once after 2 s on transient error before giving up.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fetchLyricsForTrack(trackId: string, get: () => PlayerState, set: any): void {
  const provider = getProvider()
  if (!provider?.getLyrics) return
  void provider.getLyrics(trackId)
    .then(lines => {
      if (get().currentTrack?.id === trackId) set({ lyricsLines: lines })
    })
    .catch(err => {
      console.warn(`Lyrics fetch failed for track ${trackId}, retrying once:`, err)
      setTimeout(() => {
        if (get().currentTrack?.id !== trackId) return
        const p = getProvider()
        if (!p?.getLyrics) return
        void p.getLyrics(trackId)
          .then(lines => {
            if (get().currentTrack?.id === trackId) set({ lyricsLines: lines })
          })
          .catch(() => {
            if (get().currentTrack?.id === trackId) set({ lyricsLines: [] })
          })
      }, 2000)
    })
}

/** Pre-buffer the next track in queue for gapless playback. */
async function preloadNextTrack(queue: MusicTrack[], queueIndex: number, repeat: 0 | 1 | 2): Promise<void> {
  let nextIndex = queueIndex + 1
  if (nextIndex >= queue.length) {
    if (repeat === 2) nextIndex = 0
    else return // No next track
  }

  const nextTrack = queue[nextIndex]
  if (!nextTrack) return

  // Direct URL tracks (podcasts) — preload without provider
  if (nextTrack.streamUrl?.startsWith("http")) {
    try {
      const syntheticKey = Math.abs(hashCode(nextTrack.id))
      _ratingKeyToTrackId.set(syntheticKey, nextTrack.id)
      await engine.preloadNext(nextTrack.streamUrl, syntheticKey, nextTrack.duration, "", null, true)
    } catch { /* non-critical */ }
    return
  }

  const provider = getProvider()
  if (!provider) return

  try {
    const info = await provider.getPlaybackInfo(nextTrack)
    _ratingKeyToTrackId.set(info.trackKey, nextTrack.id)
    const gainDb = await fetchGainDb(nextTrack)
    await engine.preloadNext(
      info.url,
      info.trackKey,
      nextTrack.duration,
      info.parentKey,
      gainDb,
      undefined,
      nextTrack.startRamp ?? info.startRamp,
      nextTrack.endRamp ?? info.endRamp,
    )
  } catch {
    // Pre-load failure is non-critical
  }
}

const PLAYLIST_PAGE_SIZE = 100

/** Load the next page of playlist tracks into the queue in the background. */
async function loadMorePlaylistTracks(get: () => PlayerState, set: (fn: (s: PlayerState) => Partial<PlayerState>) => void) {
  const { playlistKey, playlistLoadedCount, playlistTotalCount, isLoadingMoreTracks } = get()
  if (!playlistKey || playlistLoadedCount >= playlistTotalCount || isLoadingMoreTracks) return
  const provider = getProvider()
  if (!provider) return
  set(() => ({ isLoadingMoreTracks: true }))
  try {
    const result = await provider.getPlaylistItems(playlistKey, playlistLoadedCount, PLAYLIST_PAGE_SIZE)
    if (result.items.length > 0) {
      set(s => ({
        queue: [...s.queue, ...result.items],
        playlistLoadedCount: s.playlistLoadedCount + result.items.length,
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

// ---------------------------------------------------------------------------
// Track enrichment — fetch full metadata for tracks from list endpoints
// ---------------------------------------------------------------------------

/**
 * Tracks from list endpoints (playlists, liked, albums, popular) lack Stream
 * sub-elements (codec, bitrate, bit depth, sample rate, gain, etc.).
 * This fetches the full metadata once, updates currentTrack + the queue entry,
 * and populates the gain and waveform stream caches — consolidating what were
 * previously 2–3 separate getTrack() calls into one.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function enrichCurrentTrack(track: MusicTrack, index: number, get: () => PlayerState, set: any): Promise<void> {
  const provider = getProvider()
  if (!provider) return
  try {
    const full = await provider.getTrack(track.id)
    // Only update if this track is still the active one
    if (get().currentTrack?.id !== track.id) return
    // Merge: keep fields from full metadata, preserving any non-null originals
    const enriched: MusicTrack = { ...track, ...full }
    set((s: PlayerState) => ({
      currentTrack: enriched,
      queue: s.queue.map((t, i) => i === index ? enriched : t),
    }))
    // Populate caches so fetchGainDb/fetchAudioStreamId don't re-fetch
    _gainCache.set(track.id, { trackGain: full.gain, albumGain: full.albumGain })
    evictMap(_gainCache, 500)
    const streamId = full.mediaInfo?.audioStreamId ?? null
    _waveformStreamCache.set(track.id, streamId)
    evictMap(_waveformStreamCache, 500)
    // Fetch waveform levels now that we have the stream ID
    if (streamId && provider.getStreamLevels) {
      const levels = await provider.getStreamLevels(streamId, 128)
      if (levels.length > 0 && get().currentTrack?.id === track.id) {
        set({ waveformLevels: levels })
      }
    }
  } catch {
    // Non-critical — track still plays, just without enriched metadata
  }
}

// ---------------------------------------------------------------------------
// Shared playback ceremony — every track transition funnels through here
// ---------------------------------------------------------------------------

/**
 * Update all UI/metadata/scrobble/DJ state for a newly active track.
 * Called by both user-initiated plays (via _startPlayback) and gapless
 * transitions (audio already playing, no engine call needed).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function _onTrackBecomesActive(track: MusicTrack, index: number, get: () => PlayerState, set: any): void {
  const provider = getProvider()
  const isPodcast = _isPodcastTrack(track)
  set({ currentTrack: track, queueIndex: index, isPlaying: true, positionMs: 0,
        waveformLevels: null, lyricsLines: null })
  _lastTimelineReportMs = 0
  _transcodeRetriedTrackId = null

  if (useNotificationStore.getState().notificationsEnabled) {
    sendNotification({
      title: track.title,
      body: `${track.artistName ?? "Unknown Artist"} • ${track.albumName ?? "Unknown Album"}`,
    })
  }

  if (!isPodcast) {
    // If the track lacks stream details (from a list endpoint), enrich it.
    // This single call replaces separate fetchAudioStreamId + fetchGainDb calls.
    const needsEnrichment = track.codec == null && track.mediaInfo?.audioStreamId == null
    if (needsEnrichment) {
      fireAndForget(enrichCurrentTrack(track, index, get, set))
    } else {
      // Track already has full data (from PlayQueue/radio) — just fetch waveform
      fireAndForget(fetchAudioStreamId(track).then(streamId => {
        if (!streamId || !provider?.getStreamLevels) return
        return provider.getStreamLevels(streamId, 128)
          .then(levels => { if (levels.length > 0) set({ waveformLevels: levels }) })
      }))
    }
    fetchLyricsForTrack(track.id, get, set)
    _reportProgress(track.id, "playing", 0, track.duration)
  }
  if (provider?.updateNowPlaying) {
    fireAndForget(provider.updateNowPlaying(
      track.title,
      track.artistName ?? "",
      track.albumName ?? "",
      track.rawThumbPath ?? null,
      track.duration ?? 0,
    ))
  }
  if (provider?.setNowPlayingState) {
    fireAndForget(provider.setNowPlayingState("playing", 0))
  }

  // Announce track change for screen readers
  useAnnouncerStore.getState().announce(
    `Now playing: ${track.title} by ${track.artistName ?? "Unknown Artist"}`
  )

  // Record when this track started (for scrobble timestamp)
  _trackStartedAtUnix = Math.floor(Date.now() / 1000)

  // Notify provider of track start (scrobbling, external integrations) — skip for podcasts
  if (provider?.onTrackStart && !isPodcast) {
    provider.onTrackStart(track)
  }

  if (get().djMode) fireAndForget(insertDjTracks(get, set))
}

/**
 * Prefetch the audio cache AND trigger analysis for the next few tracks
 * in the queue so that skip-ahead is instant and smart crossfade analysis
 * is ready well in advance.
 */
function prefetchAhead(queue: MusicTrack[], fromIndex: number, count: number): void {
  const provider = getProvider()
  for (let i = 1; i <= count; i++) {
    const t = queue[fromIndex + i]
    if (!t) continue
    if (t.streamUrl?.startsWith("http")) {
      const key = Math.abs(hashCode(t.id))
      _ratingKeyToTrackId.set(key, t.id)
      continue
    }
    if (!provider) continue
    fireAndForget(provider.getPlaybackInfo(t).then(info => {
      _ratingKeyToTrackId.set(info.trackKey, t.id)
    }))
  }
}

/**
 * Send a track to the audio engine and update all playback state.
 * Used by all user-initiated play actions and within-queue navigation.
 * NOT used for gapless transitions (audio is already playing there).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function _startPlayback(track: MusicTrack, index: number, get: () => PlayerState, set: any): Promise<void> {
  // If internet radio is active, stop it before starting Plex playback
  if (get().isInternetRadioActive) {
    radioStop()
    set({ isInternetRadioActive: false })
  }
  const gen = ++_playGeneration
  _onTrackBecomesActive(track, index, get, set)
  try {
    await sendToAudioEngine(track)
  } catch (err) {
    // Only roll back state if this play attempt is still the active one
    if (_playGeneration === gen) {
      set({ isPlaying: false, isBuffering: false })
    }
    throw err
  }
  // A newer play superseded this one — bail out
  if (_playGeneration !== gen) return
  // Immediately preload the next track (triggers analysis + gapless prep)
  // and cache-warm a few more tracks ahead for instant skipping
  const { queue, repeat } = get()
  fireAndForget(preloadNextTrack(queue, index, repeat))
  prefetchAhead(queue, index, 3)
}

/**
 * Play the track at `index` in the current queue without clearing the playlist
 * or radio context. Used by next(), prev(), and jumpToQueueItem() so progressive
 * loading continues working. (playTrack() is for explicit user selection only.)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function playAtIndex(index: number, get: () => PlayerState, set: any): Promise<void> {
  const track = get().queue[index]
  if (!track) return
  try {
    await _startPlayback(track, index, get, set)
  } catch (err) {
    console.error("playAtIndex failed:", err)
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
  radioSeedArtist: null,
  radioDegreesOfSeparation: 2,
  radioMinQueue: 5,
  djMode: null,
  waveformLevels: null,
  lyricsLines: null,
  playerError: null,
  isInternetRadioActive: false,
  contextName: null,
  contextHref: null,

  playTrack: async (track: MusicTrack, context?: MusicTrack[], contextName?: string | null, contextHref?: string | null) => {
    const provider = getProvider()
    const itemKey = `/library/metadata/${track.id}`
    const uri = provider?.buildItemUri ? provider.buildItemUri(itemKey) : itemKey
    const { repeat } = get()

    const queue = context ?? [track]
    const queueIndex = Math.max(0, context ? context.findIndex(t => t.id === track.id) : 0)
    // Explicit track selection: clear progressive playlist and radio context, reset shuffle.
    set({ queue, shuffle: false,
      playlistKey: null, playlistTotalCount: 0, playlistLoadedCount: 0,
      isRadioMode: false, radioSeedKey: null, radioType: null,
      contextName: contextName ?? null, contextHref: contextHref ?? null })

    try {
      // Start audio + register server-side queue in parallel
      const [playQueue] = await Promise.all([
        provider?.createPlayQueue ? provider.createPlayQueue(uri, false, repeat) : Promise.resolve({ queueId: 0, tracks: [] }),
        _startPlayback(track, queueIndex, get, set),
      ])
      set({ queueId: playQueue.queueId })
    } catch (err) {
      console.error("playTrack failed:", err)
    }
  },

  playFromUri: async (uri: string, forceShuffle?: boolean, contextName?: string | null, contextHref?: string | null) => {
    const provider = getProvider()
    if (!provider?.createPlayQueue) return
    const { repeat } = get()
    const shouldShuffle = forceShuffle ?? false
    try {
      const result = await provider.createPlayQueue(uri, shouldShuffle, repeat)
      if (result.tracks.length === 0) {
        set({ playerError: "Couldn't load tracks — playlist may be empty or unsupported." })
        setTimeout(() => set({ playerError: null }), 5000)
        return
      }

      _djGeneratedKeys.clear()
      _radioGeneratedKeys.clear()
      _radioRefillInProgress = false
      set({
        queue: result.tracks, queueId: result.queueId, shuffle: shouldShuffle,
        playlistKey: null, playlistTotalCount: 0, playlistLoadedCount: 0,
        isRadioMode: false, radioSeedKey: null, radioType: null,
        contextName: contextName ?? null, contextHref: contextHref ?? null,
      })

      await _startPlayback(result.tracks[0], 0, get, set)
    } catch (err) {
      console.error("playFromUri failed:", err)
      const msg = err instanceof Error ? err.message : String(err)
      set({ playerError: `Shuffle failed: ${msg}` })
      setTimeout(() => set({ playerError: null }), 6000)
    }
  },

  playPlaylist: async (playlistId: string, totalCount: number, title: string, href: string) => {
    const provider = getProvider()
    if (!provider) return
    try {
      const result = await provider.getPlaylistItems(playlistId, 0, PLAYLIST_PAGE_SIZE)
      const tracks = result.items
      if (tracks.length === 0) return

      set({
        queue: tracks, queueId: null, shuffle: false,
        playlistKey: playlistId, playlistTotalCount: totalCount,
        playlistLoadedCount: tracks.length, isLoadingMoreTracks: false,
        isRadioMode: false, radioSeedKey: null, radioType: null,
        contextName: title, contextHref: href,
      })

      await _startPlayback(tracks[0], 0, get, set)
    } catch (err) {
      console.error("playPlaylist failed:", err)
      const msg = err instanceof Error ? err.message : String(err)
      set({ playerError: `Playlist failed: ${msg}` })
      setTimeout(() => set({ playerError: null }), 6000)
    }
  },

  playRadio: async (seedId: string, radioType: RadioType, seedName?: string) => {
    const provider = getProvider()
    if (!provider?.createRadioQueue) return

    _djGeneratedKeys.clear()
    _radioGeneratedKeys.clear()
    // Block the position-listener refill from firing during our own async init.
    _radioRefillInProgress = true

    try {
      const { radioDegreesOfSeparation, radioMinQueue } = get()
      const result = await provider.createRadioQueue(seedId, radioType, radioDegreesOfSeparation)

      // Filter to playable tracks then deduplicate by id.
      const seenKeys = new Set<string>()
      let tracks = filterPlayable(result.tracks).filter(
        t => seenKeys.has(t.id) ? false : (seenKeys.add(t.id), true)
      )

      if (tracks.length === 0) {
        set({ playerError: "Radio returned no playable tracks — the server may not support sonic analysis for this item." })
        setTimeout(() => set({ playerError: null }), 5000)
        _radioRefillInProgress = false
        return
      }

      // Pre-fill to exactly radioMinQueue tracks after seed before setting queue state.
      // Only fetch a second batch if the initial one is short, and take only what's needed.
      const neededAfterSeed = radioMinQueue - (tracks.length - 1)
      if (neededAfterSeed > 0) {
        try {
          const pq2 = await provider.createRadioQueue(seedId, radioType, radioDegreesOfSeparation)
          let added = 0
          filterPlayable(pq2.tracks).forEach(t => {
            if (added >= neededAfterSeed || seenKeys.has(t.id)) return
            seenKeys.add(t.id)
            tracks = [...tracks, t]
            added++
          })
        } catch { /* non-critical — start with fewer tracks if this fails */ }
      }

      // Mark all tracks except the seed (index 0) as radio-generated.
      tracks.slice(1).forEach(t => _radioGeneratedKeys.add(t.id))

      // Derive context name from queue results when not explicitly supplied.
      const derivedSeedName = seedName
        ?? (radioType === 'artist' ? tracks[0]?.artistName
           : radioType === 'album'  ? tracks[0]?.albumName
           : tracks[0]?.title)
        ?? null

      const radioHref = radioType === 'artist' ? `/artist/${seedId}`
        : radioType === 'album' ? `/album/${seedId}`
        : radioType === 'playlist' ? `/playlist/${seedId}`
        : null

      const seedArtist = (radioType === 'track' || radioType === 'album')
        ? (tracks[0]?.artistName ?? null)
        : null

      set({
        queue: tracks, queueId: result.queueId,
        isRadioMode: true, radioSeedKey: seedId, radioType,
        radioSeedArtist: seedArtist,
        playlistKey: null, playlistTotalCount: 0, playlistLoadedCount: 0,
        playerError: null,
        ...(derivedSeedName ? { contextName: `${derivedSeedName} Radio`, contextHref: radioHref } : {}),
      })

      // Unlock position-listener refills now that the queue is fully populated.
      _radioRefillInProgress = false

      await _startPlayback(tracks[0], 0, get, set)
    } catch (err) {
      _radioRefillInProgress = false
      console.error("playRadio failed:", err)
      const msg = err instanceof Error ? err.message : String(err)
      set({ playerError: `Radio failed: ${msg}` })
      setTimeout(() => set({ playerError: null }), 6000)
    }
  },

  addNext: (tracks: MusicTrack[]) => {
    set(s => {
      const next = [...s.queue]
      next.splice(s.queueIndex + 1, 0, ...tracks)
      return { queue: next }
    })
  },

  addToQueue: (tracks: MusicTrack[]) => {
    set(s => ({ queue: [...s.queue, ...tracks] }))
  },

  stopRadio: () => {
    set({ isRadioMode: false, radioSeedKey: null, radioType: null, radioSeedArtist: null })
  },

  setRadioDegreesOfSeparation: (v) => set({ radioDegreesOfSeparation: v }),
  setRadioMinQueue: (v) => set({ radioMinQueue: v }),

  setDjMode: (mode: DjMode | null) => {
    // Remove future DJ-generated bonus tracks from the queue
    set(s => ({
      queue: s.queue.filter((t, i) =>
        i <= s.queueIndex || !_djGeneratedKeys.has(t.id)
      ),
    }))
    _djGeneratedKeys.clear()
    _djInsertInProgress = false

    set({ djMode: mode })

    if (mode === null) return  // DJ off: cleaned up, nothing more to do

    // Immediately insert DJ tracks for the current track (works in any context)
    fireAndForget(insertDjTracks(get, set as never))
  },

  stop: () => {
    engine.stop()
    const { currentTrack, positionMs, isInternetRadioActive } = get()
    // Stop internet radio if active
    if (isInternetRadioActive) {
      radioStop()
      useRadioStreamStore.getState().stopStream()
    }
    // Report stopped to Plex server
    if (currentTrack) {
      _reportProgress(currentTrack.id, "stopped", positionMs, currentTrack.duration)
    }
    // Report stopped to OS media controls
    const provider = getProvider()
    if (provider?.setNowPlayingState) fireAndForget(provider.setNowPlayingState("stopped"))
    // Reset all playback state
    set({
      currentTrack: null,
      queue: [],
      queueIndex: 0,
      queueId: null,
      isPlaying: false,
      isBuffering: false,
      positionMs: 0,
      playlistKey: null,
      playlistTotalCount: 0,
      playlistLoadedCount: 0,
      isRadioMode: false,
      radioSeedKey: null,
      radioType: null,
      radioSeedArtist: null,
      djMode: null,
      waveformLevels: null,
      lyricsLines: null,
      isInternetRadioActive: false,
      contextName: null,
      contextHref: null,
    })
  },

  pause: () => {
    engine.pause()
    set({ isPlaying: false })
    const { currentTrack, positionMs } = get()
    if (currentTrack) {
      _reportProgress(currentTrack.id, "paused", positionMs, currentTrack.duration)
      const provider = getProvider()
      if (provider?.setNowPlayingState) fireAndForget(provider.setNowPlayingState("paused", positionMs))
    }
  },

  resume: () => {
    engine.resume()
    set({ isPlaying: true })
    const { currentTrack, positionMs } = get()
    if (currentTrack) {
      _reportProgress(currentTrack.id, "playing", positionMs, currentTrack.duration)
      const provider = getProvider()
      if (provider?.setNowPlayingState) fireAndForget(provider.setNowPlayingState("playing", positionMs))
    }
  },

  next: () => {
    const { queue, queueIndex, repeat, playlistKey, playlistLoadedCount, playlistTotalCount,
            isRadioMode, radioSeedKey, radioType } = get()
    if (queue.length === 0) return

    // Proactively load the next page when within 20 tracks of the end.
    if (playlistKey && playlistLoadedCount < playlistTotalCount && queueIndex >= queue.length - 20) {
      fireAndForget(loadMorePlaylistTracks(get, set as never))
    }

    let nextIndex = queueIndex + 1
    if (nextIndex >= queue.length) {
      if (repeat === 2) {
        nextIndex = 0
      } else if (isRadioMode && radioSeedKey !== null && radioType !== null) {
        // Radio mode: re-seed with a fresh station when the queue runs out
        fireAndForget(get().playRadio(radioSeedKey, radioType))
        return
      } else {
        const provider = getProvider()
        if (provider?.setNowPlayingState) fireAndForget(provider.setNowPlayingState("stopped"))
        set({ isPlaying: false, currentTrack: null, positionMs: 0, waveformLevels: null, lyricsLines: null })
        return
      }
    }
    // Use playAtIndex to preserve playlist/radio context (playTrack would clear it)
    fireAndForget(playAtIndex(nextIndex, get, set))
    // Radio: trigger refill immediately on skip rather than waiting for the next position event
    if (get().isRadioMode) fireAndForget(appendRadioTracks(get, set as never))
  },

  prev: () => {
    const { queue, queueIndex, positionMs } = get()
    if (positionMs > 3000) {
      // Restart current track in-place (preserve context)
      fireAndForget(playAtIndex(queueIndex, get, set))
      return
    }
    const prevIndex = Math.max(0, queueIndex - 1)
    fireAndForget(playAtIndex(prevIndex, get, set))
  },

  seekTo: (ms: number) => {
    engine.seek(ms)
    set({ positionMs: ms })
    const { currentTrack } = get()
    if (currentTrack) {
      _reportProgress(currentTrack.id, "playing", ms, currentTrack.duration)
    }
  },

  setVolume: (v: number) => {
    const clamped = Math.max(0, Math.min(100, Math.round(v)))
    // Cubic curve: maps 0-100 slider to 0.0-1.0 gain matching human loudness perception
    const gain = clamped <= 0 ? 0 : clamped >= 100 ? 1 : Math.pow(clamped / 100, 3)
    engine.setVolume(gain)
    // Also route volume to the internet radio HTML5 audio element
    if (get().isInternetRadioActive) {
      radioSetVolume(clamped)
    }
    set({ volume: clamped })
  },

  toggleShuffle: () => {
    const { shuffle, queue, queueIndex } = get()
    if (!shuffle && queue.length > 1) {
      // Keep current track at index 0, Fisher-Yates shuffle the rest
      const current = queue[queueIndex]
      const rest = queue.filter((_, i) => i !== queueIndex)
      for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [rest[i], rest[j]] = [rest[j], rest[i]]
      }
      set({ shuffle: true, queue: [current, ...rest], queueIndex: 0 })
    } else {
      set({ shuffle: !shuffle })
    }
  },

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
    // Re-preload the (potentially new) next track for analysis + gapless
    fireAndForget(preloadNextTrack(next, newIndex, get().repeat))
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
    // Re-preload the (potentially new) next track for analysis + gapless
    fireAndForget(preloadNextTrack(next, Math.max(0, newIndex), get().repeat))
  },

  jumpToQueueItem: (index: number) => {
    const { queue } = get()
    if (index < 0 || index >= queue.length) return
    fireAndForget(playAtIndex(index, get, set))
    // Radio: trigger refill immediately on jump rather than waiting for the next position event
    if (get().isRadioMode) fireAndForget(appendRadioTracks(get, set as never))
  },

  clearUpcoming: () => {
    set(s => ({ queue: s.queue.slice(0, s.queueIndex + 1) }))
  },

  initAudioEvents: async () => {
    // Sync persisted volume to the audio engine on every startup.
    get().setVolume(get().volume)

    // Initialize the Web Audio engine with callbacks that replace the Tauri listen("audio://...") calls
    engine.init({
      onPosition(positionMs, durationMs) {
        const { currentTrack, queue, queueIndex, repeat, isRadioMode, isPlaying, radioMinQueue } = get()
        set({ positionMs })

        // Trigger pre-load when approaching end of track (30s before end)
        if (currentTrack && durationMs > 0) {
          const remaining = durationMs - positionMs
          if (remaining > 0 && remaining < 30000 && remaining > 29500) {
            fireAndForget(preloadNextTrack(queue, queueIndex, repeat))
          }
        }

        // Proactively refill the queue when tracks strictly ahead fall below the configured minimum
        if (isRadioMode && queue.length - queueIndex - 1 < radioMinQueue) {
          fireAndForget(appendRadioTracks(get, set as never))
        }

        // Periodic timeline report every 10s so Plex shows "Now Playing" on
        // other clients and correctly tracks resume position.
        if (isPlaying && currentTrack) {
          if (positionMs - _lastTimelineReportMs >= TIMELINE_REPORT_INTERVAL_MS) {
            _lastTimelineReportMs = positionMs
            _reportProgress(currentTrack.id, "playing", positionMs, currentTrack.duration)
          }
        }
      },

      onState(state) {
        set({
          isPlaying: state === "playing",
          isBuffering: state === "buffering",
        })
      },

      // Track ended naturally — scrobble + handle repeat-one.
      // For gapless/crossfade: track-started fires quickly and cancels the fallback timeout.
      // For non-gapless: the 500ms timeout calls next().
      onTrackEnded(ratingKey) {
        const { currentTrack, repeat, queueIndex } = get()
        const endedId = resolveTrackId(ratingKey)
        _ratingKeyToTrackId.delete(ratingKey)
        // Only clear waveform/lyrics if this track is still the active one.
        const isStillActive = currentTrack?.id === endedId
        if (isStillActive) {
          set({ waveformLevels: null, lyricsLines: null })
        }
        const isPodcast = currentTrack ? _isPodcastTrack(currentTrack) : false
        if (!isPodcast) _markPlayed(endedId)
        if (currentTrack) {
          if (!isPodcast) {
            _reportProgress(currentTrack.id, "stopped", currentTrack.duration, currentTrack.duration)
          }
          const provider = getProvider()
          if (provider?.onTrackEnd && !isPodcast) {
            provider.onTrackEnd(currentTrack, _trackStartedAtUnix, get().positionMs)
          }
        }

        // If the queue already advanced (gapless/crossfade onTrackStarted fired first),
        // don't set the fallback timeout — that would cause a double-skip.
        if (!isStillActive) return

        // End-of-track sleep timer: pause and stop queue advancement
        {
          if (useSleepTimerStore.getState().onTrackEnd()) return
        }

        // Repeat-one: restart the current track immediately
        if (repeat === 1) {
          fireAndForget(playAtIndex(queueIndex, get, set))
          return
        }

        // Fallback for non-gapless: advance queue if track-started doesn't fire within 500ms
        if (_gaplessTimeoutId !== null) clearTimeout(_gaplessTimeoutId)
        _gaplessTimeoutId = setTimeout(() => {
          _gaplessTimeoutId = null
          get().next()
        }, 500)
      },

      // Track started — fired for gapless transitions and crossfade completions.
      // For user-initiated plays: currentTrack already matches, so we skip.
      onTrackStarted(ratingKey, durationMs) {
        // Cancel the non-gapless fallback timeout — engine handled the transition
        if (_gaplessTimeoutId !== null) {
          clearTimeout(_gaplessTimeoutId)
          _gaplessTimeoutId = null
        }

        const startedId = resolveTrackId(ratingKey)
        const { currentTrack, queue, queueIndex, repeat, isRadioMode, radioMinQueue,
                playlistKey, playlistLoadedCount, playlistTotalCount } = get()

        // User-initiated play: playAtIndex() already updated state
        if (currentTrack?.id === startedId) {
          if (durationMs && durationMs !== currentTrack.duration) {
            set({ currentTrack: { ...currentTrack, duration: durationMs } })
          }
          return
        }

        // Gapless/crossfade transition: find the next track
        let nextIndex = queueIndex + 1
        if (nextIndex >= queue.length && repeat === 2) nextIndex = 0

        // Verify the next track matches — fall back to searching the queue
        if (!queue[nextIndex] || queue[nextIndex].id !== startedId) {
          const found = queue.findIndex(t => t.id === startedId)
          if (found < 0) return
          nextIndex = found
        }

        const track = queue[nextIndex]
        if (!track) return

        // Advance queue state — audio is already playing
        _onTrackBecomesActive(track, nextIndex, get, set)

        // Apply corrected duration
        if (durationMs && durationMs !== track.duration) {
          const correctedTrack = { ...track, duration: durationMs }
          set((s: PlayerState) => ({
            currentTrack: correctedTrack,
            queue: s.queue.map((t, i) => i === nextIndex ? correctedTrack : t),
          }))
        }

        // Pre-buffer the track after this one for the next gapless transition
        fireAndForget(preloadNextTrack(get().queue, nextIndex, repeat))
        prefetchAhead(get().queue, nextIndex, 3)

        // Progressive playlist loading: load more when approaching end
        if (playlistKey && playlistLoadedCount < playlistTotalCount && nextIndex >= queue.length - 20) {
          fireAndForget(loadMorePlaylistTracks(get, set as never))
        }

        // Radio: refill queue if running low
        if (isRadioMode && queue.length - nextIndex - 1 < radioMinQueue) {
          fireAndForget(appendRadioTracks(get, set as never))
        }
      },

      async onError(message) {
        console.error("Audio engine error:", message)
        const { currentTrack } = get()

        // Attempt transcode fallback once per track on playback errors
        if (currentTrack && _transcodeRetriedTrackId !== currentTrack.id) {
          _transcodeRetriedTrackId = currentTrack.id
          try {
            // Extract part key from provider data for transcoding
            const providerData = currentTrack._providerData as { media?: { parts?: { key?: string }[] }[] } | undefined
            const partKey = providerData?.media?.[0]?.parts?.[0]?.key
            if (partKey) {
              console.log("[Transcode fallback] Retrying with transcoded audio for:", currentTrack.title)
              const transcodeUrl = await getAudioTranscodeUrl(partKey, 320, "mp3")
              const ratingKey = Number(currentTrack.id)
              _ratingKeyToTrackId.set(ratingKey, currentTrack.id)
              await engine.play(transcodeUrl, ratingKey, currentTrack.duration, "", null, true)
              set({ playerError: null })
              return
            }
          } catch (err) {
            console.error("Transcode fallback failed:", err)
          }
        }

        set({ playerError: message })
        useAnnouncerStore.getState().announce(`Playback error: ${message}`, "assertive")
        setTimeout(() => set({ playerError: null }), 6000)
      },

      onVisFrame(samples) {
        useVisualizerStore.getState().pushPcm(Array.from(samples))
      },
    })

    // Media key / Now Playing events forwarded from the Rust souvlaki integration
    const unlisteners = await Promise.all([
      listen("media://play-pause", () => {
        const { isPlaying, currentTrack } = get()
        if (!currentTrack) return
        if (isPlaying) get().pause()
        else get().resume()
      }),

      listen("media://next", () => {
        get().next()
      }),

      listen("media://previous", () => {
        get().prev()
      }),

      // Seek position set from the OS Now Playing scrubber
      listen<number>("media://seek", (e) => {
        get().seekTo(e.payload)
      }),

      // Stop command from the OS (e.g. closing Now Playing widget)
      listen("media://stop", () => {
        const { currentTrack, positionMs } = get()
        if (currentTrack) {
          _reportProgress(currentTrack.id, "stopped", positionMs, currentTrack.duration)
        }
        const provider = getProvider()
        if (provider?.setNowPlayingState) fireAndForget(provider.setNowPlayingState("stopped"))
        set({ isPlaying: false, positionMs: 0 })
      }),
    ])

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
