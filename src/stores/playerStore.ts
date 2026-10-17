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
import type { MusicTrack } from "../types/music"
import type { LevelData, LyricLineData } from "../providers/types"
import { useProviderStore } from "./providerStore"
import { useNotificationStore } from "./notificationStore"
import { PlaybackMetadata } from "../audio/playbackMetadata"
import { advancePlaybackSelection, capturePlaybackSelectionVersion } from "../lib/playbackSelection"
import type { QueueLoadOptions } from "../lib/queueHydration"
import { sendNotification } from "@tauri-apps/plugin-notification"
import { useSleepTimerStore } from "./sleepTimerStore"
import { useAnnouncerStore } from "./announcerStore"
import { useVisualizerStore } from "./visualizerStore"
import { useRadioStreamStore } from "./radioStreamStore"
import { radioSetVolume } from "../lib/radioAudio"
import { usePodcastStore } from "../backends/podcast/store"
import { useLyricsStore } from "./lyricsStore"
import { TrackQueuePager, shuffled, type PagedTrackSource } from "../lib/pagedPlayback"
import { QueueSession, isQueuePlaceholder, queueSourcePosition, type SavedQueue } from "../lib/queueSession"

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

const playbackMetadata = new PlaybackMetadata()
let _activeTrackGeneration = 0
let _playbackErrorRevision = 0

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
  _radioRefillRequest = null
  return advancePlaybackSelection()
}
function ownsQueueSelection(generation: number, provider: MusicProvider | null): boolean {
  return generation === capturePlaybackSelectionVersion() && getProvider() === provider
}
function replaceQueueContext(): void {
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
  if (provider && (!current || !_isPodcastTrack(current))) fireAndForget(provider.reportProgress(trackId, positionMs, state, duration))
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
const PODCAST_PROGRESS_INTERVAL_MS = 5000
function podcastIdentity(track: MusicTrack): { feedUrl: string; guid: string } | null {
  const data = track._providerData as Record<string, unknown> | undefined
  return data?.isPodcast === true && typeof data.feedUrl === "string" && !!data.feedUrl
    && typeof data.episodeGuid === "string" && !!data.episodeGuid
    ? { feedUrl: data.feedUrl, guid: data.episodeGuid } : null
}
function savePodcastProgress(record: PlaybackRecord | null, positionMs: number, force = false, completed = false): void {
  if (!record || !Number.isFinite(positionMs) || positionMs < 0) return
  const identity = podcastIdentity(record.track)
  const elapsed = Date.now() - record.podcastSavedAt
  if (!identity || (!force && elapsed >= 0 && elapsed < PODCAST_PROGRESS_INTERVAL_MS)) return
  record.podcastSavedAt = Date.now()
  const podcasts = usePodcastStore.getState()
  if (podcasts.getEpisodeProgress(identity.feedUrl, identity.guid) !== positionMs / 1000) {
    podcasts.setEpisodeProgress(identity.feedUrl, identity.guid, positionMs / 1000)
  }
  if (completed) podcasts.markEpisodeCompleted(identity.feedUrl, identity.guid)
}
function podcastResumePosition(track: MusicTrack): number {
  const identity = podcastIdentity(track)
  if (!identity) return 0
  const podcasts = usePodcastStore.getState()
  if (podcasts.isEpisodeCompleted(identity.feedUrl, identity.guid)) return 0
  const position = podcasts.getEpisodeProgress(identity.feedUrl, identity.guid) * 1000
  return Number.isFinite(position) && position > 0 && (track.duration <= 0 || position < track.duration) ? position : 0
}
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

let _radioRefillRequest: symbol | null = null

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
  if (!isRadioMode || radioSeedKey === null || radioType === null || _radioRefillRequest !== null) return
  // `queue.length - queueIndex - 1` = tracks strictly after current position
  if (queue.length - queueIndex - 1 >= radioMinQueue) return  // plenty of tracks ahead

  const provider = getProvider()
  if (!provider?.createRadioQueue) return

  const generation = capturePlaybackSelectionVersion()
  const request = Symbol('radio refill')
  _radioRefillRequest = request
  try {
    const result = await provider.createRadioQueue(radioSeedKey, radioType, radioDegreesOfSeparation)
    if (!ownsQueueSelection(generation, provider)) return
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
    if (tracksAhead === 0) usePlayerStore.getState().refreshPreload()
  } catch (err) {
    console.error("Radio queue refill failed:", err)
  } finally {
    if (_radioRefillRequest === request) _radioRefillRequest = null
  }
}

// ---------------------------------------------------------------------------
// DJ track insertion — works in any playback context (playlist, album, radio)
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
  if (!djMode || !currentTrack) return
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
            if (!isCurrent()) return
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
  if (track.streamUrl && /^https?:\/\//i.test(track.streamUrl)) return
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

/** Send a track to the Web Audio engine for playback. */
async function sendToAudioEngine(track: MusicTrack, generation: number): Promise<void> {
  // Direct URL tracks (podcasts, external audio) bypass provider.getPlaybackInfo()
  if (track.streamUrl && /^https?:\/\//i.test(track.streamUrl)) {
    const syntheticKey = directTrackKey(track)
    if (generation !== _playGeneration) return
    rememberPlaybackKey(syntheticKey, track, "selection")
    await engine.play(track.streamUrl, syntheticKey, track.duration, "", null, true)
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
  if (nextTrack.streamUrl?.startsWith("http")) {
    try {
      const syntheticKey = directTrackKey(nextTrack)
      if (!isCurrent()) return
      rememberPlaybackKey(syntheticKey, nextTrack, "preload")
      await engine.preloadNext(nextTrack.streamUrl, syntheticKey, nextTrack.duration, "", null, true)
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
  return _queueSession ? _queueSession.snapshot(queue) : queue.map(track => ({ id: track.id, title: track.title, artistName: track.artistName, albumName: track.albumName, duration: track.duration, playlistItemId: track.playlistItemId ?? undefined }))
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
    isRadioMode: false, radioSeedKey: null, radioType: null, transitionInfo: null, waveformLevels: null, lyricsLines: null })
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
async function enrichCurrentTrack(track: MusicTrack, provider: MusicProvider, isCurrent: () => boolean, set: any): Promise<void> {
  try {
    const full = await playbackMetadata.fullTrack(provider, track.id)
    if (!isCurrent()) return
    set((state: PlayerState) => {
      const current = state.currentTrack!
      const enriched: MusicTrack = {...current, ...full, playlistItemId: current.playlistItemId,
        duration: current.duration > 0 ? current.duration : full.duration}
      return {currentTrack: enriched, queue: state.queue.map((item, index) => index === state.queueIndex && item.id === track.id ? enriched : item)}
    })
    if (isCurrent()) {
      const levels = await playbackMetadata.levels(provider, full)
      if (levels.length && isCurrent()) set({waveformLevels: levels})
    }
  } catch { /* Playback continues when optional enrichment is unavailable. */ }
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
  const isPodcast = _isPodcastTrack(track)
  set({ currentTrack: track, playbackFormat: null, transitionInfo: null, queueIndex: index, isPlaying: _playbackDesired, positionMs: 0,
        waveformLevels: null, lyricsLines: null })
  _lastTimelineReportedAt = 0
  _transcodeRetriedTrackId = null

  if (!isPodcast) {
    // If the track lacks stream details (from a list endpoint), enrich it.
    // Resolve stream ID and gain together from one full-track request.
    const needsEnrichment = track.codec == null && track.mediaInfo?.audioStreamId == null
    if (needsEnrichment) {
      if (provider) fireAndForget(enrichCurrentTrack(track, provider, isCurrent, set))
    } else {
      // Track already has full data (from PlayQueue/radio) — just fetch waveform
      if (provider) fireAndForget(playbackMetadata.levels(provider,track)
        .then(levels => { if (isCurrent() && levels.length > 0) set({ waveformLevels: levels }) }))
    }
    fetchLyricsForTrack(track)
  }
  if (get().djMode) fireAndForget(insertDjTracks(get, set))
}

function _onTrackAudiblyStarted(track: MusicTrack, provider: MusicProvider | null, playbackId: number): void {
  const isPodcast = _isPodcastTrack(track)
  _lastTimelineReportedAt = Date.now()
  if (useNotificationStore.getState().notificationsEnabled) {
    sendNotification({
      title: track.title,
      body: `${track.artistName ?? "Unknown Artist"} • ${track.albumName ?? "Unknown Album"}`,
    })
  }

  if (!isPodcast && provider) fireAndForget(provider.reportProgress(track.id, 0, "playing", track.duration))
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
  if (provider?.onTrackStart && !isPodcast) {
    provider.onTrackStart(track, () => _playbackJournal.currentId === playbackId && getProvider() === provider)
  }

}

/**
 * Prefetch the audio cache AND trigger analysis for the next few tracks
 * in the queue so that skip-ahead is instant and smart crossfade analysis
 * is ready well in advance.
 */
function prefetchAhead(queue: MusicTrack[], fromIndex: number, count: number): void {
  const provider = getProvider()
  const generation = _playGeneration
  const active = _activeTrackGeneration
  if (queue.slice(fromIndex + 1, fromIndex + count + 1).some(isQueuePlaceholder)) {
    fireAndForget(ensureQueueRange(fromIndex + 1, fromIndex + count + 1, { priority: "prefetch" }).then(() => {
      if (generation === _playGeneration && active === _activeTrackGeneration && getProvider() === provider)
        prefetchAhead(usePlayerStore.getState().queue, fromIndex, count)
    }))
    return
  }
  for (let i = 1; i <= count; i++) {
    const t = queue[fromIndex + i]
    if (!t) continue
    if (t.streamUrl?.startsWith("http")) {
      const key = directTrackKey(t)
      rememberPlaybackKey(key, t)
      continue
    }
    if (!provider) continue
    fireAndForget(playbackMetadata.playbackInfo(provider, t).then(info => {
      if (generation !== _playGeneration || active !== _activeTrackGeneration || getProvider() !== provider) return
      rememberPlaybackKey(info.trackKey, t)
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
  const selectedPosition = queueSourcePosition(get().queue[index])
  const generation = beginQueueSelection()
  const provider = getProvider()
  try {
    await ensureQueueRange(index, index + 1)
    if (!ownsQueueSelection(generation, provider)) return
    if (selectedPosition !== undefined) index = get().queue.findIndex(track => queueSourcePosition(track) === selectedPosition)
    const track = get().queue[index]
    if (!track || isQueuePlaceholder(track)) throw Error("This queued song is unavailable. Try another song or reconnect to Plex.")
    await _startPlayback(track, index, get, set)
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
  albumPlaybackId: null,

  playTrack: async (track: MusicTrack, context?: MusicTrack[], contextName?: string | null, contextHref?: string | null, albumPlaybackId?: string | null) => {
    const provider = getProvider()
    if(provider?.isOffline && !track.mediaInfo?.localAudio && track.mediaInfo?.offlineAvailable!==true){set({playerError:"This track is not available offline. Reconnect to Plex to download it."});return}
    if(provider?.isOffline && context)context=context.filter(item=>item.mediaInfo?.localAudio || item.mediaInfo?.offlineAvailable===true)
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
      isRadioMode: false, radioSeedKey: null, radioType: null, radioSeedArtist: null,
      contextName: contextName ?? null, contextHref: contextHref ?? null, albumPlaybackId: albumPlaybackId ?? null })

    try {
      // Start audio + register server-side queue in parallel
      const [playQueue] = await Promise.all([
        provider?.createPlayQueue ? provider.createPlayQueue(uri, false, repeat) : Promise.resolve({ queueId: 0, tracks: [] }),
        _startPlayback(track, queueIndex, get, set),
      ])
      if (ownsQueueSelection(generation, provider)) set({ queueId: playQueue.queueId })
    } catch (err) {
      console.error("playTrack failed:", err)
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
        isRadioMode: false, radioSeedKey: null, radioType: null, radioSeedArtist: null,
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
          isRadioMode: false, radioSeedKey: null, radioType: null, radioSeedArtist: null,
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
        isRadioMode: false, radioSeedKey: null, radioType: null, radioSeedArtist: null,
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
        isRadioMode: false, radioSeedKey: null, radioType: null, radioSeedArtist: null,
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

  playRadio: async (seedId: string, radioType: RadioType, seedName?: string) => {
    const provider = getProvider()
    if (!provider?.createRadioQueue) return

    const generation = beginQueueSelection()
    const active = _activeTrackGeneration
    const before = get()
    const audible = _playbackJournal.current()
    const keepSeedPlaying = radioType === 'track' && before.currentTrack?.id === seedId
      && !before.isInternetRadioActive
      && (_pendingSelectedTrackId === seedId || (audible?.track.id === seedId && audible.provider === provider))
    let selectionApplied = false
    const isCurrent = () => ownsQueueSelection(generation, provider)
      && (!keepSeedPlaying || active === _activeTrackGeneration)
      && (selectionApplied || get().isInternetRadioActive === before.isInternetRadioActive)
    // Block the position-listener refill from firing during our own async init.
    const request = Symbol('radio selection')
    _radioRefillRequest = request

    try {
      const { radioDegreesOfSeparation, radioMinQueue } = get()
      const result = await provider.createRadioQueue(seedId, radioType, radioDegreesOfSeparation)
      if (!isCurrent()) return

      // Filter to playable tracks then deduplicate by id.
      const seenKeys = new Set<string>()
      let tracks = filterPlayable(result.tracks).filter(
        t => seenKeys.has(t.id) ? false : (seenKeys.add(t.id), true)
      )

      if (tracks.length === 0) {
        set({ playerError: "Radio returned no playable tracks — the server may not support sonic analysis for this item." })
        setTimeout(() => { if (isCurrent()) set({ playerError: null }) }, 5000)
        return
      }

      // The server may omit or reorder the seed. Keep the current occurrence
      // first, retaining its duration, selected media, and playback position.
      if (keepSeedPlaying) {
        tracks = [get().currentTrack!, ...tracks.filter(track => track.id !== seedId)]
        seenKeys.add(seedId)
      }

      // Pre-fill to exactly radioMinQueue tracks after seed before setting queue state.
      // Only fetch a second batch if the initial one is short, and take only what's needed.
      const neededAfterSeed = radioMinQueue - (tracks.length - 1)
      if (neededAfterSeed > 0) {
        try {
          const pq2 = await provider.createRadioQueue(seedId, radioType, radioDegreesOfSeparation)
          if (!isCurrent()) return
          let added = 0
          filterPlayable(pq2.tracks).forEach(t => {
            if (added >= neededAfterSeed || seenKeys.has(t.id)) return
            seenKeys.add(t.id)
            tracks = [...tracks, t]
            added++
          })
        } catch { /* non-critical — start with fewer tracks if this fails */ }
      }
      if (!isCurrent()) return

      _djGeneratedKeys.clear()
      _radioGeneratedKeys.clear()
      replaceQueueContext()
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

      selectionApplied = true
      set({
        queue: keepSeedPlaying ? [get().currentTrack!, ...tracks.slice(1)] : tracks,
        queueIndex: 0, queueId: result.queueId, shuffle: false,
        isRadioMode: true, radioSeedKey: seedId, radioType, albumPlaybackId: null,
        radioSeedArtist: seedArtist,
        playlistKey: null, playlistTotalCount: 0, playlistLoadedCount: 0, isLoadingMoreTracks: false,
        playerError: null,
        contextName: derivedSeedName ? `${derivedSeedName} Radio` : null, contextHref: radioHref,
      })

      if (keepSeedPlaying) {
        // Keep the existing native playback identity and listened time. Only
        // replace the upcoming transition; pause/buffering intent stays intact.
        get().refreshPreload()
        prefetchAhead(get().queue, 0, 3)
        if (get().djMode) fireAndForget(insertDjTracks(get, set as never))
      } else {
        await _startPlayback(tracks[0], 0, get, set)
      }
    } catch (err) {
      if (!isCurrent()) return
      console.error("playRadio failed:", err)
      const msg = err instanceof Error ? err.message : String(err)
      set({ playerError: `Radio failed: ${msg}` })
      setTimeout(() => { if (isCurrent()) set({ playerError: null }) }, 6000)
    } finally {
      if (_radioRefillRequest === request) _radioRefillRequest = null
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
    const provider=getProvider();const available=provider?.isOffline?tracks.filter(track=>track.mediaInfo?.localAudio || track.mediaInfo?.offlineAvailable===true):tracks
    set(s => ({ queue: [...s.queue, ...available] }))
  },

  stopRadio: () => {
    beginQueueSelection()
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
      if (!_isPodcastTrack(audible.track)) fireAndForget(audible.provider.reportProgress(audible.track.id, audible.positionMs, "paused", audible.track.duration))
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
      if (!_isPodcastTrack(audible.track)) fireAndForget(audible.provider.reportProgress(audible.track.id, audible.positionMs, "playing", audible.track.duration))
      if (audible.provider.setNowPlayingState) fireAndForget(audible.provider.setNowPlayingState("playing", audible.positionMs))
    }
  },

  next: () => {
    const { queue, queueIndex, repeat, playlistKey, playlistLoadedCount, playlistTotalCount,
            isRadioMode, radioSeedKey, radioType } = get()
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
      } else if (isRadioMode && radioSeedKey !== null && radioType !== null) {
        // Radio mode: re-seed with a fresh station when the queue runs out
        fireAndForget(get().playRadio(radioSeedKey, radioType))
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
  },

  cycleRepeat: () => {
    const repeat = ((get().repeat + 1) % 3) as 0 | 1 | 2
    set({ repeat })
    _preloadPlaybackKey = null
    engine.clearPreload()
    if (repeat !== 1) fireAndForget(preloadNextTrack(get().queue, get().queueIndex, repeat))
  },

  updatePosition: (ms: number) => set({ positionMs: ms }),

  reorderQueue: (from: number, to: number) => {
    _queueOrderVersion++
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
        _onTrackAudiblyStarted(track, provider, event.playback_id)
        if (resumePosition > 0) {
          set({ positionMs: resumePosition })
          engine.seekTo(resumePosition)
        }
        const { queue, repeat, isRadioMode, radioMinQueue, playlistKey, playlistLoadedCount, playlistTotalCount } = get()
        const nextIndex = index

        // Pre-buffer the track after this one for the next gapless transition
        fireAndForget(preloadNextTrack(get().queue, nextIndex, repeat))
        prefetchAhead(get().queue, nextIndex, 3)

        // Progressive playlist loading: load more when approaching end
        if (playlistKey && (playlistTotalCount === 0 || playlistLoadedCount < playlistTotalCount) && nextIndex >= queue.length - 20) {
          fireAndForget(loadMorePlaylistTracks(get, set as never))
        }

        // Radio: refill queue if running low
        if (isRadioMode && queue.length - nextIndex - 1 < radioMinQueue) {
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
