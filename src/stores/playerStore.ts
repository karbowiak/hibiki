import { rememberYoutubeMusicPlay } from "../backends/ytmusic/history"
import { create } from "zustand"
import { safeLocalPersist } from "./localPreferenceStorage"
import { listen } from "@tauri-apps/api/event"
import { fireAndForget } from "../lib/async"
import { PlaybackKeyLookup } from "../audio/playbackKeyLookup"
import { PlaybackJournal, startedQueueIndex } from "../audio/playbackJournal"
import type { SourceAudioFormat } from "../audio/playbackJournal"
import type { MusicProvider } from "../providers/types"
import { dispatchPlaybackWhenReady } from "../audio/playbackRequests"
import { isAlbumPlayback, playbackAlbumKey, preparedReplayGain } from "../audio/playbackContext"
import type { TransitionInfo } from "../audio/transitionInfo"
import { engine } from "../audio/RustAudioEngine"
import type { QueuePreparationTrack } from "../audio/RustAudioEngine"
import type { MusicTrack } from "../types/music"
import type { LevelData, LyricLineData, TrackPlaybackInfo } from "../providers/types"
import { useProviderStore } from "./providerStore"
import { useNotificationStore } from "./notificationStore"
import { selectDjTracks } from "../audio/queueExpansion"
import { playbackMetadata } from "../audio/playbackMetadata"
import { advancePlaybackSelection, capturePlaybackSelectionVersion } from "../lib/playbackSelection"
import type { QueueLoadOptions } from "../lib/queueHydration"
import { sendNotification } from "@tauri-apps/plugin-notification"
import { useSleepTimerStore } from "./sleepTimerStore"
import { useAnnouncerStore } from "./announcerStore"
import { useVisualizerStore } from "./visualizerStore"
import { useRadioStreamStore } from "./radioStreamStore"
import { radioSetVolume } from "../lib/radioAudio"
import { podcastIdentity, savePodcastProgress, podcastResumePosition } from "../audio/podcastProgress"
import { useLyricsStore } from "./lyricsStore"
import { TrackQueuePager, shuffled, type PagedTrackSource } from "../lib/pagedPlayback"
import { QueueSession, isQueuePlaceholder, copyQueueTrack, snapshotQueueEntry, type SavedQueue } from "../lib/queueSession"
import { hasIndependentAudio, isYoutubeMusicId, isYoutubeMusicTrack } from "../backends/ytmusic/tracks"
import { createMusicRadio } from "../lib/radioSources"
import { MusicRadioSession, orderRadioUpcoming, RADIO_UPCOMING, type MusicRadioMode } from "../lib/musicRadio"

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
  playbackFormat: { trackId: string; playbackId: number; format: SourceAudioFormat } | null
  transitionInfo: TransitionInfo | null
  queue: MusicTrack[]
  queueIndex: number
  queueId: number | null
  isPlaying: boolean
  isBuffering: boolean
  positionMs: number
  shuffle: boolean
  repeat: 0 | 1 | 2
  volume: number
  lastAudibleVolume: number

  /** Progressive playlist loading context — null when not playing from a playlist. */
  playlistKey: string | null
  playlistTotalCount: number
  playlistLoadedCount: number
  isLoadingMoreTracks: boolean

  /** Radio recommendations, independent of Guest DJ. */
  isRadioMode: boolean
  radioMode: MusicRadioMode | null
  radioError: string | null
  radioLoading: boolean
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
  setRadioDegreesOfSeparation: (v: number) => void

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
  /** Album explicitly started in the UI, independent of adjacent track metadata. */
  albumPlaybackId: string | null

  playTrack: (track: MusicTrack, context?: MusicTrack[], contextName?: string | null, contextHref?: string | null, albumPlaybackId?: string | null) => Promise<void>
  /** Play a URI via a server-side play queue. Handles full playlists with shuffle. */
  playFromUri: (uri: string, forceShuffle?: boolean, contextName?: string | null, contextHref?: string | null, albumPlaybackId?: string | null) => Promise<void>
  /** Start playing a playlist with progressive queue loading (100 tracks at a time). */
  playPlaylist: (playlistId: string, _estimatedTotalCount: number, title: string, href: string) => Promise<void>
  playPagedTracks: (source: PagedTrackSource, title: string, href: string, shuffle?: boolean, startIndex?: number) => Promise<void>
  /**
   * Start a radio station seeded from the given item.
   * Uses the services' radio recommendations, independently of Guest DJ.
   * Pass `seedName` to set a human-readable context label ("Ado Radio").
   */
  playRadio: (seedId: string, radioType: RadioType, seedName?: string, mode?: MusicRadioMode, seedTrack?: MusicTrack) => Promise<void>
  enableQueueRadio: (mode: MusicRadioMode) => Promise<void>
  refillRadio: () => Promise<void>
  /** Insert tracks immediately after the current track (play next). */
  addNext: (tracks: MusicTrack[]) => void
  /** Append tracks to the queue, taking manual control from radio autofill. */
  addToQueue: (tracks: MusicTrack[]) => void
  /** Stop radio auto-refill without clearing the existing queue. */
  stopRadio: () => void
  /** Set the active DJ personality (null = off), independently of radio. */
  setDjMode: (mode: DjMode | null) => void
  stop: () => void
  pause: () => void
  resume: () => void
  next: () => void
  prev: () => void
  seekTo: (ms: number) => void
  setVolume: (v: number) => void
  toggleMute: () => void
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
  refreshPreload: () => void

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

let _activeTrackGeneration = 0
let _playbackErrorRevision = 0
let _activeProviderWaveform: Promise<LevelData[]> = Promise.resolve([])

// ---------------------------------------------------------------------------
// Track ID resolution — maps numeric rating_key → MusicTrack.id
// ---------------------------------------------------------------------------

/** Maps numeric rating_key (sent to Rust engine) → MusicTrack.id string. */
let _selectionPlaybackKey: number | null = null
let _preloadPlaybackKey: number | null = null
const _trackPlaybackKeys = new WeakMap<MusicTrack, number>()
const _acceptedPlaybackKeys = new Map<number, number>() // playback_id → rating_key, journal-sized
const _ratingKeyToTrackId = new PlaybackKeyLookup(() => {
  const keys = new Set(_acceptedPlaybackKeys.values())
  if (_selectionPlaybackKey !== null) keys.add(_selectionPlaybackKey)
  if (_preloadPlaybackKey !== null) keys.add(_preloadPlaybackKey)
  const state = usePlayerStore.getState()
  const tracks = [state.currentTrack, ...state.queue.slice(state.queueIndex, state.queueIndex + 4)]
  if (state.repeat === 2 && state.queue.length) tracks.push(state.queue[(state.queueIndex + 1) % state.queue.length])
  for (const track of tracks) {
    if (!track) continue
    const key = _trackPlaybackKeys.get(track)
    if (key !== undefined) keys.add(key)
  }
  return keys
})

function rememberPlaybackKey(key: number, track: MusicTrack, owner?: "selection" | "preload"): void {
  if (owner === "selection") _selectionPlaybackKey = key
  if (owner === "preload") _preloadPlaybackKey = key
  _trackPlaybackKeys.set(track, key)
  _ratingKeyToTrackId.set(key, track.id)
}

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
// Explicit queue selections also own their asynchronous server responses.
// Skipping cancels a pending station/playlist selection without stopping audio.
let _queueContextGeneration = 0
/** Read-only fence for external asynchronous playback fallbacks. */
export { capturePlaybackSelectionVersion } from "../lib/playbackSelection"

function beginQueueSelection(): number {
  _shutdownResumePosition = null
  _radioSelectionRequest = null
  return advancePlaybackSelection()
}
function ownsQueueSelection(generation: number, provider: MusicProvider | null): boolean {
  return generation === capturePlaybackSelectionVersion() && getProvider() === provider
}
function replaceQueueContext(): void {
  _musicRadio?.retire()
  _musicRadio = null
  _musicRadioRefill = null
  _radioPreserveQueue = false
  _queueSession?.retire()
  ++_queueContextGeneration
  _djInsertRequest = null
  _playlistLoadRequest = null
  _playlistRefill = null
  _pagedQueue = null
  _queueSession = null
  _queueOwner = getProvider()
}
// Keep play/pause intent through buffering and asynchronous URL resolution.
let _playbackDesired = false

// Transcode fallback state — tracks whether we've already retried with transcoding
// for the current track, to avoid infinite retry loops.
let _transcodeRetriedTrackId: string | null = null
let _activeRetryInfo: TrackPlaybackInfo | null = null


// ---------------------------------------------------------------------------
// Periodic timeline reporting — throttle to every 10 seconds
// ---------------------------------------------------------------------------

let _lastTimelineReportedAt = 0
const TIMELINE_REPORT_INTERVAL_MS = 10_000

// Fire-and-forget wrappers — timeline/scrobble errors (400, 404) are
// non-fatal and must not surface as Unhandled Promise Rejections.
const _reportProgress = (trackId: string, state: string, positionMs: number, duration: number) => {
  const provider = getProvider()
  const current = usePlayerStore.getState().currentTrack
  if (provider && (!current || usesLibraryMetadata(current))) fireAndForget(provider.reportProgress(trackId, positionMs, state, duration))
}

// Each native play retains its own metadata and provider across outgoing overlaps.
interface PlaybackRecord {
  track: MusicTrack
  provider: MusicProvider | null
  positionMs: number
  podcastSavedAt: number
  podcastResumeTarget: number | null
}
const _playbackJournal = new PlaybackJournal<PlaybackRecord>()
let _pendingSelectedTrackId: string | null = null
let _shutdownResumePosition: number | null = null
let _podcastRequestedSeek: { generation: number; trackId: string; positionMs: number } | null = null

function playbackLabels(track: MusicTrack) {
  return { artist: track.artistName ?? "", track: track.title, album: track.albumName ?? "", album_artist: track.artistName ?? "" }
}

/** Freeze renderer advancement; native stop acknowledges both audible decks. */
export async function preparePlaybackShutdown(): Promise<void> {
  savePodcastProgress(_playbackJournal.current(), _playbackJournal.current()?.positionMs ?? 0, true)
  _playbackDesired = false
  ++_playGeneration
  if (_gaplessTimeoutId !== null) { clearTimeout(_gaplessTimeoutId); _gaplessTimeoutId = null }
  useRadioStreamStore.getState().stopStream()
  _shutdownResumePosition = usePlayerStore.getState().positionMs
  usePlayerStore.setState({ isPlaying: false, isBuffering: false, transitionInfo: null })
  // Failure leaves captured occurrences available for a later native proof retry.
  const endings = await engine.prepareShutdown()
  for (const ending of endings) {
    const record = _playbackJournal.finish(ending)
    if (record) {
      _acceptedPlaybackKeys.delete(ending.playback_id)
      savePodcastProgress(record.value, ending.position_ms, true, ending.reason === "natural")
    }
  }
  _playbackJournal.clear()
  _acceptedPlaybackKeys.clear()
  _selectionPlaybackKey = null
  _preloadPlaybackKey = null
  _ratingKeyToTrackId.clearUnowned()
}

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

let _radioSelectionRequest: symbol | null = null
let _musicRadio: MusicRadioSession | null = null
let _musicRadioRefill: Promise<void> | null = null
// Attached radio owns only additions; the user's ordered occurrences stay intact.
let _radioPreserveQueue = false

/** A refill belongs to the station, so skips do not discard in-flight results. */
function appendRadioTracks(
  get: () => PlayerState,
  set: (updater: (s: PlayerState) => Partial<PlayerState>) => void,
): Promise<void> {
  if (_musicRadioRefill) return _musicRadioRefill
  const radio = _musicRadio
  if (!get().isRadioMode || !radio || _radioSelectionRequest) return Promise.resolve()
  const owns = () => _musicRadio === radio && get().isRadioMode
  if (!radio.current()) {
    set(() => ({ radioLoading: false, radioError: "The radio connection changed. Start radio again to reconnect." }))
    return Promise.resolve()
  }
  radio.remember(get().queue.slice(Math.max(0, get().queueIndex - 199), get().queueIndex + 1))
  if (get().queue.length - get().queueIndex - 1 >= RADIO_UPCOMING) return Promise.resolve()
  if (!radio.canRefill(get().queue.slice(get().queueIndex + 1))) return Promise.resolve()
  const job = (async () => {
    set(() => ({ radioLoading: true }))
    try {
      // Two bounded pages allow a short continuation to fill the window.
      for (let pass = 0; pass < 2; pass++) {
        const before = get()
        await radio.fill(before.queue.slice(before.queueIndex + 1), before.currentTrack)
        if (!owns() || !radio.current()) return
        let changedNext = false
        set(state => {
          const upcoming = state.queue.slice(state.queueIndex + 1)
          const added = radio.take(upcoming, state.currentTrack)
          if (!added.length) return { radioError: radio.error }
          added.forEach(track => _radioGeneratedKeys.add(track.id))
          const ordered = _radioPreserveQueue ? [...upcoming, ...added] : orderRadioUpcoming(radio.mode, [...upcoming, ...added], state.currentTrack)
          changedNext = ordered[0] !== upcoming[0]
          return { queue: [...state.queue.slice(0, state.queueIndex + 1), ...ordered], radioError: radio.error }
        })
        if (changedNext) get().refreshPreload()
        prefetchAhead(get().queue, get().queueIndex, 3)
        if (get().queue.length - get().queueIndex - 1 >= RADIO_UPCOMING || radio.error) break
      }
    } finally {
      if (owns()) set(() => ({ radioLoading: false, radioError: radio.current() ? radio.error
        : "The radio connection changed. Start radio again to reconnect." }))
    }
  })().finally(() => { if (_musicRadioRefill === job) _musicRadioRefill = null })
  _musicRadioRefill = job
  return job
}

// ---------------------------------------------------------------------------
// DJ track insertion — independent of radio recommendations
// ---------------------------------------------------------------------------

let _djInsertRequest: symbol | null = null

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
  if (!djMode || !currentTrack || isYoutubeMusicTrack(currentTrack)) return
  if (_djInsertRequest !== null) return

  const provider = getProvider()
  if (!provider) return

  // Twofer & Stretch skip when the current track is DJ-generated
  // (Twofer alternates user→DJ→user→DJ; Stretch path is already laid out)
  if ((djMode === 'twofer' || djMode === 'stretch') && _djGeneratedKeys.has(currentTrack.id)) return

  const context = _queueContextGeneration, active = _activeTrackGeneration
  const request = Symbol('DJ insertion')
  _djInsertRequest = request
  const isCurrent = () => context === _queueContextGeneration && active === _activeTrackGeneration
    && getProvider() === provider && get().djMode === djMode && _djInsertRequest === request
  try {
    let picks: MusicTrack[] = []

    picks = await selectDjTracks({provider, mode:djMode, currentTrack, queue, queueIndex,
      generated:_djGeneratedKeys, current:isCurrent})

    if (!isCurrent()) return
    const latestKeys = new Set(get().queue.map(track => track.id))
    picks = picks.filter(track => {
      if (latestKeys.has(track.id)) return false
      latestKeys.add(track.id)
      return true
    })
    if (picks.length === 0) return

    picks.forEach(t => _djGeneratedKeys.add(t.id))
    const { queueIndex: qi } = get()
    set(s => {
      const nq = [...s.queue]
      nq.splice(qi + 1, 0, ...picks)
      return { queue: nq }
    })
    usePlayerStore.getState().refreshPreload()
  } catch (err) {
    console.error('DJ track insertion failed:', err)
  } finally {
    if (_djInsertRequest === request) _djInsertRequest = null
  }
}

/** Pre-resolve playback URL for a track on hover. Deduped per track id. */
export function prefetchTrackAudio(track: MusicTrack): void {
  if (hasIndependentAudio(track)) return
  const provider = getProvider()
  if (provider) fireAndForget(playbackMetadata.playbackInfo(provider, track))
}

async function fetchGainDb(track: MusicTrack, provider: MusicProvider): Promise<number | null> {
  return playbackMetadata.gain(provider, track, usePlayerStore.getState().albumPlaybackId)
}

// Public tracks use a separate numeric namespace from positive Plex IDs.
// A weak lookup keeps each track object stable through preload and playback
// without retaining every episode object for the lifetime of the app.
const _directTrackKeys = new WeakMap<MusicTrack, number>()
let _nextDirectTrackKey = -1
function directTrackKey(track: MusicTrack): number {
  const existing = _directTrackKeys.get(track)
  if (existing !== undefined) return existing
  if (!Number.isSafeInteger(_nextDirectTrackKey)) throw new Error("Audio track keys exhausted")
  const key = _nextDirectTrackKey--
  _directTrackKeys.set(track, key)
  return key
}

/** Check if a track is a podcast episode (has direct stream URL + podcast provider data). */
function _isPodcastTrack(track: MusicTrack): boolean {
  const pd = track._providerData as Record<string, unknown> | undefined
  return pd?.isPodcast === true
}

function usesLibraryMetadata(track: MusicTrack): boolean {
  return !_isPodcastTrack(track) && !isYoutubeMusicTrack(track)
}

/** Send a track to the Web Audio engine for playback. */
async function sendToAudioEngine(track: MusicTrack, generation: number): Promise<void> {
  // Direct URL tracks (podcasts, external audio) bypass provider.getPlaybackInfo()
  if (hasIndependentAudio(track)) {
    const syntheticKey = directTrackKey(track)
    if (generation !== _playGeneration) return
    rememberPlaybackKey(syntheticKey, track, "selection")
    await engine.play(track.streamUrl, syntheticKey, track.duration, "", null, true,
      null, null, false, undefined, playbackLabels(track))
    return
  }
  const provider = getProvider()
  if (!provider) return
  await dispatchPlaybackWhenReady(
    async () => {
      const [gainDb, info] = await Promise.all([fetchGainDb(track, provider), playbackMetadata.playbackInfo(provider, track)])
      return {info, gainDb}
    },
    () => generation === _playGeneration && getProvider() === provider,
    async ({ info, gainDb }) => {
      rememberPlaybackKey(info.trackKey, track, "selection")
      await engine.play(info.url, info.trackKey, track.duration, playbackAlbumKey(track, info.parentKey, usePlayerStore.getState().albumPlaybackId), preparedReplayGain(track, info, usePlayerStore.getState().albumPlaybackId, gainDb),
        undefined, track.startRamp ?? info.startRamp, track.endRamp ?? info.endRamp,
        isAlbumPlayback(track, usePlayerStore.getState().albumPlaybackId), info.plexContext, playbackLabels(track))
    },
  )
}

/**
 * Fetch and set lyrics for a track, guarded against stale results from a previous track.
 * Retries once after 2 s on transient error before giving up.
 */
function fetchLyricsForTrack(track: MusicTrack): void {
  useLyricsStore.getState().fetchForTrack(
    track.id,
    track.artistName ?? "",
    track.title,
  )
}

/** Pre-buffer the next track in queue for gapless playback. */
async function preloadNextTrack(queue: MusicTrack[], queueIndex: number, repeat: 0 | 1 | 2): Promise<void> {
  if (repeat === 1 || useSleepTimerStore.getState().endOfTrack) return
  const generation = _playGeneration
  const context = _queueContextGeneration
  const active = _activeTrackGeneration
  const sourceTrackId = queue[queueIndex]?.id
  const isCurrent = () => {
    const state = usePlayerStore.getState()
    return generation === _playGeneration && context === _queueContextGeneration
      && active === _activeTrackGeneration && state.currentTrack?.id === sourceTrackId
      && state.repeat !== 1
      && !useSleepTimerStore.getState().endOfTrack
      && state.queue[(state.queueIndex + 1) % state.queue.length]?.id === nextTrack.id
  }
  let nextIndex = queueIndex + 1
  if (nextIndex >= queue.length) {
    if (repeat === 2) nextIndex = 0
    else return // No next track
  }

  let nextTrack = queue[nextIndex]
  if (nextTrack && isQueuePlaceholder(nextTrack)) {
    await ensureQueueRange(nextIndex, nextIndex + 4).catch(() => {})
    if (context !== _queueContextGeneration || generation !== _playGeneration) return
    nextTrack = usePlayerStore.getState().queue[nextIndex]
  }
  if (!nextTrack) return
  if (isQueuePlaceholder(nextTrack)) return

  // Direct URL tracks (podcasts) — preload without provider
  if (hasIndependentAudio(nextTrack)) {
    try {
      const syntheticKey = directTrackKey(nextTrack)
      if (!isCurrent()) return
      rememberPlaybackKey(syntheticKey, nextTrack, "preload")
      await engine.preloadNext(nextTrack.streamUrl, syntheticKey, nextTrack.duration, "", null, true,
        null, null, false, undefined, playbackLabels(nextTrack))
    } catch { /* non-critical */ }
    return
  }

  const provider = getProvider()
  if (!provider) return

  try {
    await dispatchPlaybackWhenReady(
      async () => {
        const [gainDb, info] = await Promise.all([fetchGainDb(nextTrack, provider), playbackMetadata.playbackInfo(provider, nextTrack)])
        return {info, gainDb}
      },
      () => isCurrent() && getProvider() === provider,
      async ({ info, gainDb }) => {
        rememberPlaybackKey(info.trackKey, nextTrack, "preload")
        await engine.preloadNext(info.url, info.trackKey, nextTrack.duration, playbackAlbumKey(nextTrack, info.parentKey, usePlayerStore.getState().albumPlaybackId),
          preparedReplayGain(nextTrack, info, usePlayerStore.getState().albumPlaybackId, gainDb), undefined, nextTrack.startRamp ?? info.startRamp, nextTrack.endRamp ?? info.endRamp,
          isAlbumPlayback(nextTrack, usePlayerStore.getState().albumPlaybackId), info.plexContext, playbackLabels(nextTrack))
      },
    )
  } catch {
    // Pre-load failure is non-critical
  }
}

const PLAYLIST_PAGE_SIZE = 100
let _playlistLoadRequest: symbol | null = null
let _pagedQueue: TrackQueuePager | null = null
let _queueSession: QueueSession | null = null
let _queueOwner: MusicProvider | null = null
let _queueOrderVersion = 0
export const currentQueueOwner = () => _queueOwner
export const currentQueueOrderVersion = () => `${_queueContextGeneration}:${_queueOrderVersion}`
export function snapshotQueueEntries() {
  const queue = usePlayerStore.getState().queue
  return _queueSession ? _queueSession.snapshot(queue) : queue.map(snapshotQueueEntry)
}
export const queueSource = () => _queueSession?.source
export async function ensureQueueRange(start: number, end: number, options: QueueLoadOptions = {}) {
  const session = _queueSession, context = _queueContextGeneration
  const selection = capturePlaybackSelectionVersion()
  if (!session) return
  await session.ensure(usePlayerStore.getState().queue, start, end, {
    ...options,
    current: () => session === _queueSession && context === _queueContextGeneration &&
      (options.priority === "viewport" || selection === capturePlaybackSelectionVersion()) && options.current?.() !== false,
  })
  if (session !== _queueSession || context !== _queueContextGeneration) return
  usePlayerStore.setState(state => {
    const queue = session.project(state.queue, state.queueIndex)
    return queue === state.queue ? state : { queue }
  })
}
export async function restorePlaybackQueue(provider: MusicProvider, saved: SavedQueue, source: PagedTrackSource) {
  const generation = capturePlaybackSelectionVersion()
  const session = new QueueSession({ ...source, entries: saved.entries })
  await session.ensure(session.entries, saved.state.index, saved.state.index + 1).catch(() => {})
  if (generation !== capturePlaybackSelectionVersion() || getProvider() !== provider || usePlayerStore.getState().queue.length) return
  replaceQueueContext()
  _queueSession = session
  _shutdownResumePosition = saved.state.positionMs
  const queue = session.project(session.entries, saved.state.index)
  usePlayerStore.setState({ queue, queueIndex: saved.state.index, currentTrack: queue[saved.state.index], positionMs: saved.state.positionMs,
    isPlaying: false, isBuffering: false, shuffle: saved.state.shuffle, repeat: saved.state.repeat,
    contextName: saved.state.contextName, contextHref: saved.state.contextHref, albumPlaybackId: saved.state.albumPlaybackId,
    queueId: null, playlistKey: null, playlistTotalCount: queue.length, playlistLoadedCount: queue.length,
    isRadioMode: false, radioMode: null, radioError: null, radioLoading: false, radioSeedKey: null, radioType: null, transitionInfo: null, waveformLevels: null, lyricsLines: null })
}
let _playlistRefill: Promise<void> | null = null

function loadMorePlaylistTracks(get: () => PlayerState, set: (fn: (s: PlayerState) => Partial<PlayerState>) => void): Promise<void> {
  if (_playlistRefill) return _playlistRefill
  const job = fetchMorePlaylistTracks(get, set).finally(() => { if (_playlistRefill === job) _playlistRefill = null })
  _playlistRefill = job
  return job
}

/** Load the next page of playlist tracks into the queue in the background. */
async function fetchMorePlaylistTracks(get: () => PlayerState, set: (fn: (s: PlayerState) => Partial<PlayerState>) => void) {
  const { playlistKey, playlistLoadedCount, playlistTotalCount, isLoadingMoreTracks } = get()
  if (!playlistKey || (playlistTotalCount > 0 && playlistLoadedCount >= playlistTotalCount) || isLoadingMoreTracks) return
  const provider = getProvider()
  if (!provider) return
  const context = _queueContextGeneration
  const request = Symbol('playlist page')
  _playlistLoadRequest = request
  const isCurrent = () => context === _queueContextGeneration && getProvider() === provider
    && get().playlistKey === playlistKey && _playlistLoadRequest === request
  set(() => ({ isLoadingMoreTracks: true }))
  try {
    const pager = _pagedQueue
    const result = pager
      ? { items: await pager.next(), total: pager.totalCount }
      : await provider.getPlaylistItems(playlistKey, playlistLoadedCount, PLAYLIST_PAGE_SIZE)
    if (!isCurrent()) return
    if (result.items.length > 0) {
      set(s => ({
        queue: pager?.shuffle && s.shuffle
          ? [...s.queue.slice(0, s.queueIndex + 2), ...shuffled([...s.queue.slice(s.queueIndex + 2), ...result.items])]
          : [...s.queue, ...(provider.isOffline?result.items.filter(track=>track.mediaInfo?.localAudio || track.mediaInfo?.offlineAvailable===true):result.items)],
        playlistLoadedCount: s.playlistLoadedCount + result.items.length,
        playlistTotalCount: pager && !pager.hasMore ? playlistLoadedCount + result.items.length : result.total > 0 ? result.total : 0,
        isLoadingMoreTracks: false,
      }))
      const latest = get()
      fireAndForget(preloadNextTrack(latest.queue, latest.queueIndex, latest.repeat))
      prefetchAhead(latest.queue, latest.queueIndex, 3)
    } else {
      set(() => ({ isLoadingMoreTracks: false, playlistTotalCount: playlistLoadedCount }))
    }
  } catch (err) {
    if (!isCurrent()) return
    console.error("Failed to load more playlist tracks:", err)
    set(() => ({ isLoadingMoreTracks: false }))
  } finally {
    if (_playlistLoadRequest === request) _playlistLoadRequest = null
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
async function enrichCurrentTrack(track: MusicTrack, provider: MusicProvider, isCurrent: () => boolean, set: any): Promise<LevelData[]> {
  try {
    const full = await playbackMetadata.fullTrack(provider, track.id)
    if (!isCurrent()) return []
    set((state: PlayerState) => {
      const current = state.currentTrack!
      const enriched: MusicTrack = {...current, ...full, playlistItemId: current.playlistItemId,
        duration: current.duration > 0 ? current.duration : full.duration}
      return {currentTrack: enriched, queue: state.queue.map((item, index) => index === state.queueIndex && item.id === track.id ? enriched : item)}
    })
    if (isCurrent()) {
      const levels = await playbackMetadata.levels(provider, full)
      if (levels.length && isCurrent()) set({waveformLevels: levels})
      return levels
    }
  } catch { /* Playback continues when optional enrichment is unavailable. */ }
  return []
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
  const active = ++_activeTrackGeneration
  _djInsertRequest = null
  const isCurrent = () => active === _activeTrackGeneration && getProvider() === provider && get().currentTrack?.id === track.id
  _activeProviderWaveform = Promise.resolve([])
  set({ currentTrack: track, playbackFormat: null, transitionInfo: null, queueIndex: index, isPlaying: _playbackDesired, positionMs: 0,
        waveformLevels: null, lyricsLines: null })
  _lastTimelineReportedAt = 0
  _transcodeRetriedTrackId = null
  _activeRetryInfo = null

  if (usesLibraryMetadata(track)) {
    // If the track lacks stream details (from a list endpoint), enrich it.
    // Resolve stream ID and gain together from one full-track request.
    const needsEnrichment = track.codec == null && track.mediaInfo?.audioStreamId == null
    if (needsEnrichment) {
      if (provider) _activeProviderWaveform = enrichCurrentTrack(track, provider, isCurrent, set)
    } else {
      // Track already has full data (from PlayQueue/radio) — just fetch waveform
      if (provider) _activeProviderWaveform = playbackMetadata.levels(provider,track)
        .then(levels => {
          if (isCurrent() && levels.length > 0) set({ waveformLevels: levels })
          return levels
        }).catch(() => [])
    }
    fetchLyricsForTrack(track)
  } else useLyricsStore.getState().clear()
  if (get().djMode) fireAndForget(insertDjTracks(get, set))
}

function _onTrackAudiblyStarted(track: MusicTrack, provider: MusicProvider | null, playbackId: number): void {
  const libraryTrack = usesLibraryMetadata(track)
  _lastTimelineReportedAt = Date.now()
  if (useNotificationStore.getState().notificationsEnabled) {
    sendNotification({
      title: track.title,
      body: `${track.artistName ?? "Unknown Artist"} • ${track.albumName ?? "Unknown Album"}`,
    })
  }

  if (libraryTrack && provider) fireAndForget(provider.reportProgress(track.id, 0, "playing", track.duration))
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

  // Notify provider of track start (scrobbling, external integrations) — skip for podcasts
  if (provider?.onTrackStart && libraryTrack) {
    provider.onTrackStart(track, () => _playbackJournal.currentId === playbackId && getProvider() === provider)
  }

}

/**
 * Prefetch the audio cache AND trigger analysis for the next few tracks
 * in the queue so that skip-ahead is instant and smart crossfade analysis
 * is ready well in advance.
 */
let _prefetchVersion = 0
function prefetchAhead(queue: MusicTrack[], fromIndex: number, count: number): void {
  const version = ++_prefetchVersion
  const provider = getProvider()
  const generation = _playGeneration
  const active = _activeTrackGeneration
  const context = _queueContextGeneration
  const order = _queueOrderVersion
  const upcoming = queue.slice(fromIndex + 1, fromIndex + Math.min(count, 3) + 1)
  const ids = upcoming.map(track => track.id).join("\0")
  const ownsSelection = () => {
    const state = usePlayerStore.getState()
    return version === _prefetchVersion && generation === _playGeneration && active === _activeTrackGeneration
      && context === _queueContextGeneration && getProvider() === provider && state.currentTrack?.id === queue[fromIndex]?.id
      && order === _queueOrderVersion
  }
  const isCurrent = () => ownsSelection() && usePlayerStore.getState().queue.slice(fromIndex + 1, fromIndex + Math.min(count, 3) + 1).map(track => track.id).join("\0") === ids
  if (usePlayerStore.getState().repeat === 1 || useSleepTimerStore.getState().endOfTrack) {
    fireAndForget(engine.prepareQueue([]))
    return
  }
  if (upcoming.some(isQueuePlaceholder)) {
    fireAndForget(ensureQueueRange(fromIndex + 1, fromIndex + count + 1, { priority: "prefetch" }).then(() => {
      if (ownsSelection())
        prefetchAhead(usePlayerStore.getState().queue, fromIndex, count)
    }))
    return
  }
  fireAndForget(Promise.all(upcoming.map(async (t): Promise<QueuePreparationTrack | null> => {
    if (hasIndependentAudio(t)) {
      const key = directTrackKey(t)
      if (isCurrent()) rememberPlaybackKey(key, t)
      return { url: t.streamUrl, ratingKey: key, durationMs: t.duration, gainDb: null, prepareWaveform: true }
    }
    if (!provider) return null
    try {
      const [gain, info, levels] = await Promise.all([fetchGainDb(t, provider), playbackMetadata.playbackInfo(provider, t),
        playbackMetadata.levels(provider, t).catch(() => [])])
      if (!isCurrent()) return null
      rememberPlaybackKey(info.trackKey, t)
      return { url: info.url, ratingKey: info.trackKey, durationMs: t.duration, context: info.plexContext,
        prepareWaveform: levels.length === 0,
        gainDb: preparedReplayGain(t, info, usePlayerStore.getState().albumPlaybackId, gain) }
    } catch { return null }
  })).then(async tracks => {
    if (isCurrent()) await engine.prepareQueue(tracks.filter((track): track is QueuePreparationTrack => track !== null))
  }))
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
    useRadioStreamStore.getState().stopStream()
  }
  const outgoing = _playbackJournal.current()
  savePodcastProgress(outgoing, outgoing?.positionMs ?? 0, true)
  _shutdownResumePosition = null
  _selectionPlaybackKey = null
  _preloadPlaybackKey = null
  _podcastRequestedSeek = null
  const gen = ++_playGeneration
  _pendingSelectedTrackId = track.id
  _playbackDesired = true
  if (_gaplessTimeoutId !== null) { clearTimeout(_gaplessTimeoutId); _gaplessTimeoutId = null }
  engine.beginSelection()
  set({ isBuffering: true })
  _onTrackBecomesActive(track, index, get, set)
  try {
    await sendToAudioEngine(track, gen)
  } catch (err) {
    // Only roll back state if this play attempt is still the active one
    if (_playGeneration === gen) {
      set({ isPlaying: false, isBuffering: false })
    }
    throw err
  }
  // A newer play superseded this one — bail out
  if (_playGeneration !== gen) return
  if (!_playbackDesired) engine.pause()
  // Immediately preload the next track (triggers analysis + gapless prep)
  // and cache-warm a few more tracks ahead for instant skipping
  const { queue, queueIndex, repeat } = get()
  fireAndForget(preloadNextTrack(queue, queueIndex, repeat))
  prefetchAhead(queue, queueIndex, 3)
}

/**
 * Play the track at `index` in the current queue without clearing the playlist
 * or radio context. Used by next(), prev(), and jumpToQueueItem() so progressive
 * loading continues working. (playTrack() is for explicit user selection only.)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function playAtIndex(index: number, get: () => PlayerState, set: any): Promise<void> {
  if (!get().queue[index]) return
  const selectedTrack = get().queue[index]
  const selectedPosition = _queueSession?.sourcePosition(selectedTrack)
  const generation = beginQueueSelection()
  const provider = getProvider()
  try {
    await ensureQueueRange(index, index + 1)
    if (!ownsQueueSelection(generation, provider)) return
    index = get().queue.findIndex(track => selectedPosition !== undefined
      ? _queueSession?.sourcePosition(track) === selectedPosition : track === selectedTrack)
    const track = get().queue[index]
    if (!track || isQueuePlaceholder(track)) throw Error("This queued song is unavailable. Try another song or reconnect to Plex.")
    if (get().isRadioMode && _musicRadio) {
      const state = get()
      const upcoming = _radioPreserveQueue ? state.queue.slice(index + 1) : orderRadioUpcoming(_musicRadio.mode, state.queue.slice(index + 1), track)
      set({ queue: [...state.queue.slice(0, index + 1), ...upcoming] })
    }
    await _startPlayback(track, index, get, set)
    if (get().isRadioMode) fireAndForget(appendRadioTracks(get, set as never))
  } catch (err) {
    if (ownsQueueSelection(generation, provider)) set({ playerError: err instanceof Error ? err.message : "Could not load this queued song." })
    console.error("playAtIndex failed:", err)
  }
}

export const usePlayerStore = create<PlayerState>()(
  safeLocalPersist(
    (set, get) => ({
  currentTrack: null,
  playbackFormat: null,
  transitionInfo: null,
  queue: [],
  queueIndex: 0,
  queueId: null,
  isPlaying: false,
  isBuffering: false,
  positionMs: 0,
  shuffle: false,
  repeat: 0,
  volume: 80,
  lastAudibleVolume: 80,
  playlistKey: null,
  playlistTotalCount: 0,
  playlistLoadedCount: 0,
  isLoadingMoreTracks: false,
  isRadioMode: false,
  radioMode: null, radioError: null, radioLoading: false,
  radioSeedKey: null,
  radioType: null,
  radioSeedArtist: null,
  radioDegreesOfSeparation: 2,
  djMode: null,
  waveformLevels: null,
  lyricsLines: null,
  playerError: null,
  isInternetRadioActive: false,
  contextName: null,
  contextHref: null,
  albumPlaybackId: null,

  playTrack: async (track: MusicTrack, context?: MusicTrack[], contextName?: string | null, contextHref?: string | null, albumPlaybackId?: string | null) => {
    const provider = getProvider()
    if(provider?.isOffline && !isYoutubeMusicTrack(track) && !track.mediaInfo?.localAudio && track.mediaInfo?.offlineAvailable!==true){set({playerError:"This track is not available offline. Reconnect to Plex to download it."});return}
    if(provider?.isOffline && context)context=context.filter(item=>isYoutubeMusicTrack(item) || item.mediaInfo?.localAudio || item.mediaInfo?.offlineAvailable===true)
    const generation = beginQueueSelection()
    const itemKey = `/library/metadata/${track.id}`
    const uri = provider?.buildItemUri ? provider.buildItemUri(itemKey) : itemKey
    const { repeat } = get()

    const queue = context ?? [track]
    const queueIndex = Math.max(0, context ? context.findIndex(t => t.id === track.id) : 0)
    // Explicit track selection: clear progressive playlist and radio context, reset shuffle.
    _djGeneratedKeys.clear()
    _radioGeneratedKeys.clear()
    replaceQueueContext()
    set({ queue, queueId: null, shuffle: false, playerError: null,
      playlistKey: null, playlistTotalCount: 0, playlistLoadedCount: 0, isLoadingMoreTracks: false,
      isRadioMode: false, radioMode: null, radioError: null, radioLoading: false, radioSeedKey: null, radioType: null, radioSeedArtist: null,
      contextName: contextName ?? null, contextHref: contextHref ?? null, albumPlaybackId: albumPlaybackId ?? null })

    try {
      // Start audio + register server-side queue in parallel
      const [playQueue] = await Promise.all([
        provider?.createPlayQueue && !hasIndependentAudio(track) ? provider.createPlayQueue(uri, false, repeat) : Promise.resolve({ queueId: 0, tracks: [] }),
        _startPlayback(track, queueIndex, get, set),
      ])
      if (ownsQueueSelection(generation, provider)) set({ queueId: playQueue.queueId })
    } catch (err) {
      console.error("playTrack failed:", err)
      if (ownsQueueSelection(generation, provider) && isYoutubeMusicTrack(track)) {
        set({ playerError: err instanceof Error ? err.message : String(err) })
      }
    }
  },

  playFromUri: async (uri: string, forceShuffle?: boolean, contextName?: string | null, contextHref?: string | null, albumPlaybackId?: string | null) => {
    const provider = getProvider()
    if (!provider?.createPlayQueue) return
    const generation = beginQueueSelection()
    const isCurrent = () => ownsQueueSelection(generation, provider)
    const { repeat } = get()
    const shouldShuffle = forceShuffle ?? false
    try {
      const result = await provider.createPlayQueue(uri, shouldShuffle, repeat)
      if (!isCurrent()) return
      if (result.tracks.length === 0) {
        set({ playerError: "Couldn't load tracks — playlist may be empty or unsupported." })
        setTimeout(() => { if (isCurrent()) set({ playerError: null }) }, 5000)
        return
      }

      _djGeneratedKeys.clear()
      _radioGeneratedKeys.clear()
      replaceQueueContext()
      set({
        queue: result.tracks, queueId: result.queueId, shuffle: shouldShuffle, playerError: null,
        playlistKey: null, playlistTotalCount: 0, playlistLoadedCount: 0, isLoadingMoreTracks: false,
        isRadioMode: false, radioMode: null, radioError: null, radioLoading: false, radioSeedKey: null, radioType: null, radioSeedArtist: null,
        contextName: contextName ?? null, contextHref: contextHref ?? null, albumPlaybackId: albumPlaybackId ?? null,
      })

      await _startPlayback(result.tracks[0], 0, get, set)
    } catch (err) {
      if (!isCurrent()) return
      console.error("playFromUri failed:", err)
      const msg = err instanceof Error ? err.message : String(err)
      set({ playerError: `Shuffle failed: ${msg}` })
      setTimeout(() => { if (isCurrent()) set({ playerError: null }) }, 6000)
    }
  },

  playPagedTracks: async (source, title, href, shuffle = false, startIndex = 0) => {
    const provider = getProvider()
    if (!provider) return
    const generation = beginQueueSelection()
    try {
      const resolved = await source.prepare?.() ?? source
      if (!ownsQueueSelection(generation, provider)) return
      if (resolved.entries?.length || resolved.total) {
        const session = new QueueSession(resolved, shuffle)
        const index = shuffle ? 0 : Math.min(Math.max(0, startIndex), session.entries.length - 1)
        await session.ensure(session.entries, index, index + 1)
        if (!ownsQueueSelection(generation, provider)) return
        const queue = session.project(session.entries, index)
        if (!queue[index] || isQueuePlaceholder(queue[index])) throw Error("No playable songs were found in this collection.")
        _djGeneratedKeys.clear(); _radioGeneratedKeys.clear()
        replaceQueueContext(); _queueSession = session
        set({ queue, queueIndex: index, queueId: null, shuffle, playerError: null, playlistKey: null,
          playlistTotalCount: queue.length, playlistLoadedCount: queue.length, isLoadingMoreTracks: false,
          isRadioMode: false, radioMode: null, radioError: null, radioLoading: false, radioSeedKey: null, radioType: null, radioSeedArtist: null,
          contextName: title, contextHref: href, albumPlaybackId: null })
        await _startPlayback(queue[index], index, get, set)
        return
      }
      const pager = new TrackQueuePager(resolved, shuffle, Math.random, startIndex)
      const page = await pager.next()
      if (!ownsQueueSelection(generation, provider)) return
      const tracks = provider.isOffline ? page.filter(track => track.mediaInfo?.localAudio || track.mediaInfo?.offlineAvailable === true) : page
      if (!tracks.length) { set({ playerError: "No playable songs were found on this page." }); return }
      _djGeneratedKeys.clear()
      _radioGeneratedKeys.clear()
      replaceQueueContext()
      _pagedQueue = pager
      set({ queue: tracks, queueId: null, queueIndex: 0, shuffle, playerError: null,
        playlistKey: `paged:${source.key}`, playlistTotalCount: pager.hasMore ? pager.totalCount : page.length,
        playlistLoadedCount: page.length, isLoadingMoreTracks: false,
        isRadioMode: false, radioMode: null, radioError: null, radioLoading: false, radioSeedKey: null, radioType: null, radioSeedArtist: null,
        contextName: title, contextHref: href, albumPlaybackId: null })
      await _startPlayback(tracks[0], 0, get, set)
    } catch (error) {
      if (ownsQueueSelection(generation, provider)) set({ playerError: error instanceof Error ? error.message : "Could not start this collection. Try again." })
    }
  },

  playPlaylist: async (playlistId: string, _estimatedTotalCount: number, title: string, href: string) => {
    const provider = getProvider()
    if (!provider) return
    const generation = beginQueueSelection()
    const isCurrent = () => ownsQueueSelection(generation, provider)
    try {
      const cached = await provider.getCachedTrackSource?.(`playlist:${playlistId}`)
      if (!isCurrent()) return
      if (cached) { await get().playPagedTracks(cached, title, href); return }
      const result = await provider.getPlaylistItems(playlistId, 0, PLAYLIST_PAGE_SIZE)
      if (!isCurrent()) return
      if (result.total > 0) {
        await get().playPagedTracks({ key: `playlist:${playlistId}`, total: result.total, initialPage: { offset: 0, items: result.items }, loadPage: (offset, limit) => provider.getPlaylistItems(playlistId, offset, limit) }, title, href)
        return
      }
      const tracks = provider.isOffline ? result.items.filter(track=>track.mediaInfo?.localAudio || track.mediaInfo?.offlineAvailable===true) : result.items
      if (tracks.length === 0) {set({playerError:"No tracks on this page are available offline. Open the playlist and choose a downloaded track."});return}

      _djGeneratedKeys.clear()
      _radioGeneratedKeys.clear()
      replaceQueueContext()
      set({
        queue: tracks, queueId: null, shuffle: false, playerError: null,
        playlistKey: playlistId, playlistTotalCount: result.total > 0 ? result.total : 0,
        playlistLoadedCount: result.items.length, isLoadingMoreTracks: false,
        isRadioMode: false, radioMode: null, radioError: null, radioLoading: false, radioSeedKey: null, radioType: null, radioSeedArtist: null,
        contextName: title, contextHref: href, albumPlaybackId: null,
      })

      await _startPlayback(tracks[0], 0, get, set)
    } catch (err) {
      if (!isCurrent()) return
      console.error("playPlaylist failed:", err)
      const msg = err instanceof Error ? err.message : String(err)
      set({ playerError: `Playlist failed: ${msg}` })
      setTimeout(() => { if (isCurrent()) set({ playerError: null }) }, 6000)
    }
  },

  playRadio: async (seedId, radioType, seedName, requestedMode, seedTrack) => {
    const provider = getProvider()
    const mode = requestedMode ?? (isYoutubeMusicId(seedId) ? "ytmusic" : "plex")
    const generation = beginQueueSelection()
    const active = _activeTrackGeneration
    const before = get()
    const audible = _playbackJournal.current()
    const keepSeedPlaying = radioType === "track" && before.currentTrack?.id === seedId
      && !before.isInternetRadioActive
      && (_pendingSelectedTrackId === seedId || (audible?.track.id === seedId && audible.provider === provider))
    let installed = false
    let radio: MusicRadioSession | null = null
    const isCurrent = () => ownsQueueSelection(generation, provider)
      && (!keepSeedPlaying || active === _activeTrackGeneration)
      && (installed || get().isInternetRadioActive === before.isInternetRadioActive)
    const request = Symbol("radio selection")
    _radioSelectionRequest = request
    try {
      let track = seedTrack ?? (radioType === "track" && before.currentTrack?.id === seedId ? before.currentTrack : null)
      if (!track && radioType === "track" && !isYoutubeMusicId(seedId) && provider) track = await provider.getTrack(seedId)
      if (!isCurrent()) return
      const created = await createMusicRadio({ mode, provider, seedId, seedType: radioType, track,
        degrees: () => get().radioDegreesOfSeparation,
        current: () => installed ? _musicRadio === radio : isCurrent(),
      })
      radio = created.radio
      let first = keepSeedPlaying ? get().currentTrack : created.seed
      let upcoming: MusicTrack[] = []
      for (let pass = 0; pass < 3; pass++) {
        await radio.fill(upcoming, first)
        if (!isCurrent() || !radio.current()) return
        first ??= created.seed
        if (first) radio.remember([first])
        upcoming = orderRadioUpcoming(radio.mode, [...upcoming, ...radio.take(upcoming, first)], first)
        if (upcoming.length >= RADIO_UPCOMING || radio.error) break
      }
      // Catalog seeds (album/artist/playlist) choose their first playable song.
      first ??= upcoming.shift() ?? null
      if (!first || !upcoming.length) throw Error(radio.error ?? "Radio returned no new playable songs for this item.")
      if (!isCurrent()) return
      _djGeneratedKeys.clear()
      _radioGeneratedKeys.clear()
      replaceQueueContext()
      _musicRadio = radio
      _radioPreserveQueue = false
      installed = true
      upcoming.forEach(item => _radioGeneratedKeys.add(item.id))
      const derivedName = seedName ?? (radioType === "artist" ? first.artistName
        : radioType === "album" ? first.albumName : first.title)
      const href = isYoutubeMusicId(seedId) ? null
        : radioType === "artist" ? `/artist/${seedId}` : radioType === "album" ? `/album/${seedId}`
        : radioType === "playlist" ? `/playlist/${seedId}` : null
      set({ queue: [first, ...upcoming], queueIndex: 0, queueId: created.queueId, shuffle: false, repeat: 0,
        isRadioMode: true, radioMode: radio.mode, radioError: radio.error, radioLoading: false,
        radioSeedKey: seedId, radioType, radioSeedArtist: first.artistName || null,
        djMode: null, albumPlaybackId: null,
        playlistKey: null, playlistTotalCount: 0, playlistLoadedCount: 0, isLoadingMoreTracks: false,
        playerError: null, contextName: derivedName ? `${derivedName} Radio` : "Radio", contextHref: href })
      if (keepSeedPlaying) {
        get().refreshPreload()
        prefetchAhead(get().queue, 0, 3)
      } else await _startPlayback(first, 0, get, set)
    } catch (err) {
      if (!isCurrent()) return
      const message = `Radio failed: ${err instanceof Error ? err.message : String(err)}`
      set({ playerError: message })
      setTimeout(() => { if (get().playerError === message) set({ playerError: null }) }, 6000)
    } finally {
      if (!installed) radio?.retire()
      if (_radioSelectionRequest === request) _radioSelectionRequest = null
    }
  },

  enableQueueRadio: async mode => {
    if (_radioSelectionRequest || get().isRadioMode) return
    const before = get(), provider = getProvider()
    if (!before.queue.length || before.isInternetRadioActive) {
      set({ radioError: "Add a playable song to the queue first." })
      return
    }
    const generation = _queueContextGeneration, selection = capturePlaybackSelectionVersion()
    const session = provider?.playbackSession, scope = provider?.cacheScope
    const request = Symbol("attach queue radio")
    _radioSelectionRequest = request
    let radio: MusicRadioSession | null = null, installed = false
    const owns = () => _radioSelectionRequest === request && generation === _queueContextGeneration &&
      selection === capturePlaybackSelectionVersion() && getProvider() === provider &&
      provider?.playbackSession === session && provider?.cacheScope === scope
    set({ radioLoading: true, radioError: null })
    try {
      // Resolve the start of a lazy queue, independently of the playback cursor.
      await ensureQueueRange(0, Math.min(200, get().queue.length), { current: owns })
      if (!owns()) return
      const seed = get().queue.find(track => !isQueuePlaceholder(track) &&
        (isYoutubeMusicTrack(track) || track.mediaInfo?.hasAudioStream !== false) && !!track.id && !!track.title)
      if (!seed) throw Error("This queue has no playable song to seed radio.")
      const created = await createMusicRadio({ mode, provider, seedId: seed.id, seedType: "track", track: seed,
        degrees: () => get().radioDegreesOfSeparation,
        current: () => installed ? _musicRadio === radio : owns(),
      })
      radio = created.radio
      if (!owns() || !radio.current()) return
      radio.remember(get().queue.slice(Math.max(0, get().queueIndex - 200)))
      _musicRadio = radio
      _radioPreserveQueue = true
      _djInsertRequest = null
      _radioGeneratedKeys.clear()
      installed = true
      _radioSelectionRequest = null
      set({ isRadioMode: true, radioMode: radio.mode, radioSeedKey: seed.id, radioType: "track", djMode: null,
        radioSeedArtist: seed.artistName || null, radioLoading: false, radioError: null })
      await appendRadioTracks(get, set as never)
    } catch (error) {
      if (owns()) set({ radioError: error instanceof Error ? error.message : "Could not enable radio. Try again." })
    } finally {
      if (!installed) radio?.retire()
      if (_radioSelectionRequest === request) {
        _radioSelectionRequest = null
        set({ radioLoading: false })
      }
    }
  },

  refillRadio: async () => {
    _musicRadio?.retry()
    await appendRadioTracks(get, set as never)
  },

  addNext: (tracks: MusicTrack[]) => {
    if (!tracks.length) return
    if (get().isRadioMode || _radioSelectionRequest) get().stopRadio()
    set(s => {
      const next = [...s.queue]
      next.splice(s.queueIndex + 1, 0, ...tracks.map(copyQueueTrack))
      return { queue: next }
    })
    get().refreshPreload()
  },

  addToQueue: (tracks: MusicTrack[]) => {
    if (!tracks.length) return
    if (get().isRadioMode || _radioSelectionRequest) get().stopRadio()
    const provider=getProvider();const available=provider?.isOffline?tracks.filter(track=>isYoutubeMusicTrack(track) || track.mediaInfo?.localAudio || track.mediaInfo?.offlineAvailable===true):tracks
    set(s => ({ queue: [...s.queue, ...available.map(copyQueueTrack)] }))
    const { queue, queueIndex, repeat } = get()
    fireAndForget(preloadNextTrack(queue, queueIndex, repeat))
    prefetchAhead(queue, queueIndex, 3)
  },

  stopRadio: () => {
    beginQueueSelection()
    _musicRadio?.retire()
    _musicRadio = null
    _radioPreserveQueue = false
    _musicRadioRefill = null
    set({ isRadioMode: false, radioMode: null, radioError: null, radioLoading: false, radioSeedKey: null, radioType: null, radioSeedArtist: null })
  },

  setRadioDegreesOfSeparation: (v) => {
    set({ radioDegreesOfSeparation: v })
    _musicRadio?.resetSource("plex")
  },

  setDjMode: (mode: DjMode | null) => {
    if (mode && (get().isRadioMode || _radioSelectionRequest)) get().stopRadio()
    // Remove future DJ-generated bonus tracks from the queue
    set(s => ({
      queue: s.queue.filter((t, i) =>
        i <= s.queueIndex || !_djGeneratedKeys.has(t.id)
      ),
    }))
    _djGeneratedKeys.clear()
    _djInsertRequest = null

    set({ djMode: mode })

    if (mode === null) return  // DJ off: cleaned up, nothing more to do

    // Immediately insert DJ tracks for the current track (works in any context)
    fireAndForget(insertDjTracks(get, set as never))
  },

  stop: () => {
    _selectionPlaybackKey = null
    _preloadPlaybackKey = null
    const audible = _playbackJournal.current()
    savePodcastProgress(audible, audible?.positionMs ?? 0, true)
    beginQueueSelection()
    replaceQueueContext()
    _djGeneratedKeys.clear()
    _radioGeneratedKeys.clear()
    _pendingSelectedTrackId = null
    _playbackDesired = false
    ++_playGeneration
    ++_activeTrackGeneration
    useLyricsStore.getState().clear()
    if (_gaplessTimeoutId !== null) { clearTimeout(_gaplessTimeoutId); _gaplessTimeoutId = null }
    engine.stop()
    const { isInternetRadioActive } = get()
    // Stop internet radio if active
    if (isInternetRadioActive) {
      useRadioStreamStore.getState().stopStream()
    }
    // Report stopped to OS media controls
    const provider = getProvider()
    if (provider?.setNowPlayingState) fireAndForget(provider.setNowPlayingState("stopped"))
    // Reset all playback state
    set({
      currentTrack: null,
      playbackFormat: null,
      transitionInfo: null,
      albumPlaybackId: null,
      queue: [],
      queueIndex: 0,
      queueId: null,
      isPlaying: false,
      isBuffering: false,
      positionMs: 0,
      playlistKey: null,
      playlistTotalCount: 0,
      playlistLoadedCount: 0,
      isLoadingMoreTracks: false,
      playerError: null,
      isRadioMode: false, radioMode: null, radioError: null, radioLoading: false,
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
    _ratingKeyToTrackId.clearUnowned()
  },

  pause: () => {
    _playbackDesired = false
    const current = _playbackJournal.current()
    savePodcastProgress(current, current?.positionMs ?? 0, true)
    engine.pause()
    set({ isPlaying: false })
    const audible = _playbackJournal.current()
    if (audible?.provider && audible.provider === getProvider()) {
      if (usesLibraryMetadata(audible.track)) fireAndForget(audible.provider.reportProgress(audible.track.id, audible.positionMs, "paused", audible.track.duration))
      if (audible.provider.setNowPlayingState) fireAndForget(audible.provider.setNowPlayingState("paused", audible.positionMs))
    }
  },

  resume: () => {
    if (!get().currentTrack) return
    const state = get()
    if (_shutdownResumePosition !== null) {
      const position = _shutdownResumePosition
      _shutdownResumePosition = null
      const generation = _playGeneration + 1
      const playing = playAtIndex(state.queueIndex, get, set)
      const selection = capturePlaybackSelectionVersion()
      fireAndForget(playing.then(() => {
        if (selection === capturePlaybackSelectionVersion() && generation === _playGeneration && position > 0 && !_isPodcastTrack(state.currentTrack!)) engine.seekTo(position)
      }))
      return
    }
    if (_pendingSelectedTrackId === null && state.currentTrack.duration > 0 && state.positionMs >= state.currentTrack.duration) {
      if (state.repeat === 1 || (state.queueIndex + 1 >= state.queue.length && state.repeat !== 2 && !state.isRadioMode)) {
        fireAndForget(playAtIndex(state.queueIndex, get, set))
      } else get().next()
      return
    }
    if (_pendingSelectedTrackId === null && _playbackJournal.currentId === null) {
      fireAndForget(playAtIndex(state.queueIndex, get, set))
      return
    }
    _playbackDesired = true
    engine.resume()
    set({ isPlaying: true })
    const audible = _playbackJournal.current()
    if (audible?.provider && audible.provider === getProvider()) {
      if (usesLibraryMetadata(audible.track)) fireAndForget(audible.provider.reportProgress(audible.track.id, audible.positionMs, "playing", audible.track.duration))
      if (audible.provider.setNowPlayingState) fireAndForget(audible.provider.setNowPlayingState("playing", audible.positionMs))
    }
  },

  next: () => {
    const { queue, queueIndex, repeat, playlistKey, playlistLoadedCount, playlistTotalCount,
            isRadioMode } = get()
    if (queue.length === 0) return

    // Proactively load the next page when within 20 tracks of the end.
    if (playlistKey && (playlistTotalCount === 0 || playlistLoadedCount < playlistTotalCount) && queueIndex >= queue.length - 20) {
      fireAndForget(loadMorePlaylistTracks(get, set as never))
    }

    let nextIndex = queueIndex + 1
    if (nextIndex >= queue.length) {
      if (playlistKey && (playlistTotalCount === 0 || playlistLoadedCount < playlistTotalCount)) {
        const context = _queueContextGeneration
        fireAndForget(loadMorePlaylistTracks(get, set as never).then(() => {
          if (context !== _queueContextGeneration || get().queueIndex !== queueIndex) return
          if (get().queue.length > queue.length) get().next()
          else set({ playerError: "Couldn't load the next songs. Press Next to retry." })
        }))
        return
      }
      if (repeat === 2) {
        nextIndex = 0
      } else if (isRadioMode) {
        const radio = _musicRadio
        fireAndForget(appendRadioTracks(get, set as never).then(() => {
          if (radio !== _musicRadio || get().queueIndex !== queueIndex) return
          if (get().queue.length > queue.length) get().next()
          else set({ playerError: get().radioError ?? "No new radio songs. Retry from the queue." })
        }))
        return
      } else {
        beginQueueSelection()
        replaceQueueContext()
        _playbackDesired = false
        _pendingSelectedTrackId = null
        ++_playGeneration
        ++_activeTrackGeneration
        useLyricsStore.getState().clear()
        engine.stop()
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
    const { queueIndex, positionMs } = get()
    if (positionMs > 3000) {
      // Restart current track in-place (preserve context)
      fireAndForget(playAtIndex(queueIndex, get, set))
      return
    }
    const prevIndex = Math.max(0, queueIndex - 1)
    fireAndForget(playAtIndex(prevIndex, get, set))
  },

  seekTo: (ms: number) => {
    const selected = get().currentTrack
    if (selected && _isPodcastTrack(selected)) {
      if (!Number.isFinite(ms) || ms < 0) return
      if (selected.duration > 0) ms = Math.min(ms, selected.duration)
      if (_pendingSelectedTrackId !== null) _podcastRequestedSeek = { generation: _playGeneration, trackId: selected.id, positionMs: ms }
    }
    engine.seek(ms)
    set({ positionMs: ms })
    const { currentTrack } = get()
    if (currentTrack && _pendingSelectedTrackId === null) {
      const audible = _playbackJournal.current()
      if (audible) {
        if (podcastIdentity(audible.track)) audible.podcastResumeTarget = ms
        else audible.positionMs = ms
      }
      _reportProgress(currentTrack.id, get().isPlaying ? "playing" : "paused", ms, currentTrack.duration)
    }
  },

  setVolume: (v: number) => {
    if (!Number.isFinite(v)) return
    const previous = get().volume
    const clamped = Math.max(0, Math.min(100, Math.round(v)))
    // Cubic curve: maps 0-100 slider to 0.0-1.0 gain matching human loudness perception
    const gain = clamped <= 0 ? 0 : clamped >= 100 ? 1 : Math.pow(clamped / 100, 3)
    engine.setVolume(gain)
    // Also route volume to the internet radio HTML5 audio element
    if (get().isInternetRadioActive) {
      radioSetVolume(clamped)
    }
    set({
      volume: clamped,
      lastAudibleVolume: clamped > 0
        ? clamped
        : Number.isFinite(previous) && previous > 0
          ? Math.max(1, Math.min(100, Math.round(previous)))
          : get().lastAudibleVolume,
    })
  },

  toggleMute: () => {
    const { volume, lastAudibleVolume } = get()
    const restored = Number.isFinite(lastAudibleVolume) && lastAudibleVolume > 0
      ? Math.min(100, lastAudibleVolume)
      : 80
    get().setVolume(volume > 0 ? 0 : restored)
  },

  toggleShuffle: () => {
    if (get().isRadioMode || _radioSelectionRequest) get().stopRadio()
    _queueOrderVersion++
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
    get().refreshPreload()
  },

  cycleRepeat: () => {
    const repeat = ((get().repeat + 1) % 3) as 0 | 1 | 2
    if (repeat === 2 && get().isRadioMode) get().stopRadio()
    set({ repeat })
    _preloadPlaybackKey = null
    engine.clearPreload()
    if (repeat !== 1) fireAndForget(preloadNextTrack(get().queue, get().queueIndex, repeat))
    prefetchAhead(get().queue, get().queueIndex, 3)
  },

  updatePosition: (ms: number) => set({ positionMs: ms }),

  reorderQueue: (from: number, to: number) => {
    _queueOrderVersion++
    const { queue, queueIndex } = get()
    if (from === to || from < 0 || to < 0 || from >= queue.length || to >= queue.length) return
    if (get().isRadioMode || _radioSelectionRequest) get().stopRadio()
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
    get().refreshPreload()
  },

  removeFromQueue: (index: number) => {
    const { queue, queueIndex } = get()
    if (index < 0 || index >= queue.length) return
    if (_radioSelectionRequest) get().stopRadio()
    const next = [...queue]
    next.splice(index, 1)
    let newIndex = queueIndex
    if (index < queueIndex) newIndex = queueIndex - 1
    else if (index === queueIndex) newIndex = Math.min(queueIndex, next.length - 1)
    if (index === queueIndex && get().isRadioMode) get().stopRadio()
    const radio = _musicRadio
    const ordered = radio && !_radioPreserveQueue ? [...next.slice(0, newIndex + 1),
      ...orderRadioUpcoming(radio.mode, next.slice(newIndex + 1), get().currentTrack)] : next
    set({ queue: ordered, queueIndex: Math.max(0, newIndex) })
    // Re-preload the (potentially new) next track for analysis + gapless
    get().refreshPreload()
    if (get().isRadioMode) fireAndForget(appendRadioTracks(get, set as never))
  },

  jumpToQueueItem: (index: number) => {
    const { queue } = get()
    if (index < 0 || index >= queue.length) return
    fireAndForget(playAtIndex(index, get, set))
    // Radio: trigger refill immediately on jump rather than waiting for the next position event
    if (get().isRadioMode) fireAndForget(appendRadioTracks(get, set as never))
  },

  clearUpcoming: () => {
    if (get().isRadioMode || _radioSelectionRequest) get().stopRadio()
    ++_prefetchVersion
    _preloadPlaybackKey = null
    engine.clearPreload()
    set(s => ({ queue: s.queue.slice(0, s.queueIndex + 1), transitionInfo: null }))
  },

  refreshPreload: () => {
    _preloadPlaybackKey = null
    engine.clearPreload()
    set({ transitionInfo: null })
    const { queue, queueIndex, repeat } = get()
    fireAndForget(preloadNextTrack(queue, queueIndex, repeat))
    prefetchAhead(queue, queueIndex, 3)
  },

  initAudioEvents: async () => {
    // Sync persisted volume to the audio engine on every startup.
    get().setVolume(get().volume)

    // Initialize the Web Audio engine with callbacks that replace the Tauri listen("audio://...") calls
    await engine.init({
      onTransitionScheduled(transition) {
        const state = get()
        const next = state.queue[state.queueIndex + 1] ?? (state.repeat === 2 ? state.queue[0] : null)
        if (!transition || (resolveTrackId(transition.outgoing_rating_key) === state.currentTrack?.id
          && resolveTrackId(transition.incoming_rating_key) === next?.id)) {
          set({ transitionInfo: transition })
        }
      },
      onPosition(positionMs, durationMs, playbackId) {
        if (playbackId !== _playbackJournal.currentId || _pendingSelectedTrackId !== null) return
        const audible = _playbackJournal.current()
        if (!audible || (!_isPodcastTrack(audible.track) && audible.provider !== getProvider())) return
        const seekAcknowledged = audible.podcastResumeTarget !== null
        if (seekAcknowledged) {
          if (Math.abs(positionMs - audible.podcastResumeTarget!) > 1000) return
          audible.podcastResumeTarget = null
        }
        audible.positionMs = positionMs
        savePodcastProgress(audible, positionMs, seekAcknowledged || !get().isPlaying)
        const { currentTrack, queue, queueIndex, repeat, isRadioMode, isPlaying } = get()
        set({ positionMs })

        // Trigger pre-load when approaching end of track (30s before end)
        if (currentTrack && durationMs > 0) {
          const remaining = durationMs - positionMs
          if (remaining > 0 && remaining < 30000 && remaining > 29500) {
            fireAndForget(preloadNextTrack(queue, queueIndex, repeat))
          }
        }

        // Keep ten upcoming radio tracks, excluding the current song.
        if (isRadioMode && queue.length - queueIndex - 1 < RADIO_UPCOMING) {
          fireAndForget(appendRadioTracks(get, set as never))
        }

        // Periodic timeline report every 10s so Plex shows "Now Playing" on
        // other clients and correctly tracks resume position.
        if (isPlaying && currentTrack) {
          if (Date.now() - _lastTimelineReportedAt >= TIMELINE_REPORT_INTERVAL_MS) {
            _lastTimelineReportedAt = Date.now()
            _reportProgress(currentTrack.id, "playing", positionMs, currentTrack.duration)
          }
        }
      },

      onState(state) {
        set({
          isPlaying: (state === "playing" || state === "buffering") && _playbackDesired,
          isBuffering: state === "buffering",
        })
      },

      // Track ended naturally — scrobble + handle repeat-one.
      // For gapless/crossfade: track-started fires quickly and cancels the fallback timeout.
      // For non-gapless: the 500ms timeout calls next().
      onTrackEnded(event) {
        const record = _playbackJournal.finish(event)
        if (!record) return
        _acceptedPlaybackKeys.delete(event.playback_id)
        _ratingKeyToTrackId.trim()
        const { track } = record.value
        savePodcastProgress(record.value, event.position_ms, true, event.reason === "natural")
        const { currentTrack, repeat, queueIndex } = get()
        // Native history retains actual listened frames and submits all final
        // reports through one durable, account-bound outbox.
        if (!record.wasCurrent || _pendingSelectedTrackId !== null || event.reason !== "natural"
          || currentTrack?.id !== track.id) return
        set({ waveformLevels: null, lyricsLines: null, positionMs: event.position_ms })

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

      // Native identity distinguishes automatic repeats from explicit selection.
      onTrackStarted(event) {
        const startedId = resolveTrackId(event.rating_key)
        const state = get()
        const index = startedQueueIndex(state.queue.map(track => track.id), state.queueIndex,
          state.repeat, startedId, _pendingSelectedTrackId)
        if (index === null) return
        const selected = state.queue[index]
        if (!selected) return
        const track = event.duration_ms > 0 ? { ...selected, duration: event.duration_ms } : selected
        const provider = getProvider()
        const requestedSeek = _podcastRequestedSeek
        const resumePosition = requestedSeek?.generation === _playGeneration && requestedSeek.trackId === track.id
          ? requestedSeek.positionMs : podcastResumePosition(track)
        _podcastRequestedSeek = null
        if (!_playbackJournal.start(event, { track, provider, positionMs: resumePosition, podcastSavedAt: Date.now(), podcastResumeTarget: resumePosition > 0 ? resumePosition : null })) return
        _acceptedPlaybackKeys.set(event.playback_id, event.rating_key)
        if (_selectionPlaybackKey === event.rating_key) _selectionPlaybackKey = null
        if (_preloadPlaybackKey === event.rating_key) _preloadPlaybackKey = null
        while (_acceptedPlaybackKeys.size > 64) _acceptedPlaybackKeys.delete(_acceptedPlaybackKeys.keys().next().value!)
        _ratingKeyToTrackId.trim()
        if (_gaplessTimeoutId !== null) { clearTimeout(_gaplessTimeoutId); _gaplessTimeoutId = null }
        const automatic = _pendingSelectedTrackId === null
        _pendingSelectedTrackId = null
        if (automatic) _onTrackBecomesActive(track, index, get, set)
        else set((s: PlayerState) => ({
          currentTrack: { ...s.currentTrack!, duration: track.duration },
          queue: s.queue.map((item, i) => i === index ? { ...item, duration: track.duration } : item),
        }))
        set({ playbackFormat: event.source_format ? { trackId: track.id, playbackId: event.playback_id, format: event.source_format } : null })
        rememberYoutubeMusicPlay(track)
        _onTrackAudiblyStarted(track, provider, event.playback_id)
        if (track.duration > 0) {
          const active = _activeTrackGeneration
          const preferred = _activeProviderWaveform
          const current = () => active === _activeTrackGeneration && _playbackJournal.currentId === event.playback_id
            && get().currentTrack?.id === track.id && getProvider() === provider
          fireAndForget((async () => {
            // Provider data wins; generation reads only the same cached item as playback.
            const supplied = await preferred
            if (!current() || supplied.length || get().waveformLevels?.length) return
            const info = _activeRetryInfo ?? (hasIndependentAudio(track) ? { url: track.streamUrl! }
              : provider ? await playbackMetadata.playbackInfo(provider, track) : null)
            if (!info || !current()) return
            const levels = await engine.getWaveform(info.url, event.rating_key, "plexContext" in info ? info.plexContext : undefined)
            if (levels.length && current() && !get().waveformLevels?.length) set({ waveformLevels: levels })
          })())
        }
        if (resumePosition > 0) {
          set({ positionMs: resumePosition })
          engine.seekTo(resumePosition)
        }
        const { queue, repeat, isRadioMode, playlistKey, playlistLoadedCount, playlistTotalCount } = get()
        const nextIndex = index

        // Pre-buffer the track after this one for the next gapless transition
        fireAndForget(preloadNextTrack(get().queue, nextIndex, repeat))
        prefetchAhead(get().queue, nextIndex, 3)

        // Progressive playlist loading: load more when approaching end
        if (playlistKey && (playlistTotalCount === 0 || playlistLoadedCount < playlistTotalCount) && nextIndex >= queue.length - 20) {
          fireAndForget(loadMorePlaylistTracks(get, set as never))
        }

        // Radio: refill queue if running low
        if (isRadioMode && queue.length - nextIndex - 1 < RADIO_UPCOMING) {
          fireAndForget(appendRadioTracks(get, set as never))
        }
      },

      onControlError(message) {
        const errorRevision = ++_playbackErrorRevision
        const generation = _playGeneration, active = _activeTrackGeneration
        const audible = _playbackJournal.current()
        if (audible) audible.podcastResumeTarget = null
        set({ playerError: message })
        setTimeout(() => {
          if (generation === _playGeneration && active === _activeTrackGeneration
            && errorRevision === _playbackErrorRevision && get().playerError === message) set({ playerError: null })
        }, 6000)
      },

      async onError(message) {
        const generation = _playGeneration
        const active = _activeTrackGeneration
        const errorRevision = ++_playbackErrorRevision
        const providerAtError = getProvider()
        console.error("Audio engine error:", message)
        const { currentTrack, positionMs } = get()
        const isCurrent = () => generation === _playGeneration && active === _activeTrackGeneration
          && errorRevision === _playbackErrorRevision && getProvider() === providerAtError
          && get().currentTrack?.id === currentTrack?.id

        // Attempt transcode fallback once per track on playback errors
        if (currentTrack && !_isPodcastTrack(currentTrack) && !currentTrack.streamUrl
          && _transcodeRetriedTrackId !== currentTrack.id) {
          _transcodeRetriedTrackId = currentTrack.id
          try {
            if (providerAtError?.getTranscodePlaybackInfo) {
              console.log("[Transcode fallback] Retrying with transcoded audio for:", currentTrack.title)
              const info = await providerAtError.getTranscodePlaybackInfo(currentTrack, 320, "mp3")
              if (!isCurrent()) return
              _activeRetryInfo = info
              rememberPlaybackKey(info.trackKey, currentTrack, "selection")
              _pendingSelectedTrackId = currentTrack.id
              await engine.play(info.url, info.trackKey, currentTrack.duration, info.parentKey, null, true, null, null, false, info.plexContext, playbackLabels(currentTrack))
              if (!isCurrent()) return
              if (positionMs > 0) engine.seekTo(positionMs)
              if (!_playbackDesired) engine.pause()
              set({ playerError: null })
              return
            }
          } catch (err) {
            console.error("Transcode fallback failed:", err)
          }
        }

        if (!isCurrent()) return
        _pendingSelectedTrackId = null
        set({ playerError: message })
        useAnnouncerStore.getState().announce(`Playback error: ${message}`, "assertive")
        setTimeout(() => {
          if (isCurrent() && get().playerError === message) {
            set({ playerError: null })
          }
        }, 6000)
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
        get().stop()
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
        lastAudibleVolume: state.lastAudibleVolume,
        shuffle: state.shuffle,
        repeat: state.repeat,
        djMode: state.djMode,
      }),
    }
  )
)
