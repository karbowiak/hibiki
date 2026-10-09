/**
 * Audio engine — Tauri IPC bridge to the Rust audio engine.
 *
 * Maps the public API to Tauri invoke() commands and listen() events.
 * The Rust engine handles all audio processing: fetch, decode (symphonia),
 * DSP (EQ, limiter, volume), crossfade, and output (cpal → CoreAudio).
 *
 * Module-level singleton: `import { engine } from "../audio/RustAudioEngine"`
 */

import { PlaybackEventGate } from "./playbackEventGate"
import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AudioEngineCallbacks {
  onPosition(positionMs: number, durationMs: number): void
  onState(state: "playing" | "paused" | "buffering" | "stopped"): void
  onTrackStarted(ratingKey: number, durationMs?: number): void
  onTrackEnded(ratingKey: number): void
  onError(message: string): void
  onVisFrame?(samples: Float32Array): void
}

export interface RampPoint { db: number; timeSec: number }
export interface TrackRamps { startRamp: RampPoint[]; endRamp: RampPoint[] }

/** Interpolate a loudness ramp to find where it crosses a dB threshold. */
function interpolateThreshold(ramp: RampPoint[], thresholdDb: number): number | null {
  if (ramp.length < 2) return null
  // If threshold is below the quietest point, return first time
  if (thresholdDb <= ramp[0].db) return ramp[0].timeSec
  // If threshold is above the loudest point, return last time
  if (thresholdDb >= ramp[ramp.length - 1].db) return ramp[ramp.length - 1].timeSec
  // Linear interpolation between surrounding points
  for (let i = 0; i < ramp.length - 1; i++) {
    const a = ramp[i], b = ramp[i + 1]
    if ((a.db <= thresholdDb && b.db >= thresholdDb) || (a.db >= thresholdDb && b.db <= thresholdDb)) {
      const ratio = (thresholdDb - a.db) / (b.db - a.db)
      return a.timeSec + ratio * (b.timeSec - a.timeSec)
    }
  }
  return null
}

export function parseRamp(raw: string | null | undefined): RampPoint[] {
  if (!raw) return []
  return raw.split(";").filter(Boolean).map(pair => {
    const [db, time] = pair.trim().split(" ").map(Number)
    return { db, timeSec: time }
  })
}

// ---------------------------------------------------------------------------
// Event payloads from Rust
// ---------------------------------------------------------------------------

// Payload field names are snake_case from Rust serde (rename_all only affects
// the enum tag, not struct fields in internally-tagged enums).
interface PositionPayload { request_id: number; position_ms: number; duration_ms: number }
interface StatePayload { request_id: number; state: string }
interface TrackStartedPayload { request_id: number; rating_key: number; duration_ms: number }
interface TrackEndedPayload { request_id: number; rating_key: number }
interface ErrorPayload { request_id: number; message: string }
interface VisFramePayload { samples: number[]; frequency_bins: number[] }

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

class RustAudioEngine {
  private cb: AudioEngineCallbacks | null = null
  private eventGate = new PlaybackEventGate()
  private listenerGeneration = 0
  private unlisteners: UnlistenFn[] = []

  // Ramp cache
  private rampCache = new Map<number, TrackRamps>()

  // Cached visualizer data (pushed from Rust, read synchronously by components)
  private lastFrequencyBins: Float32Array | null = null
  private cachedSampleRate = 44100

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  async init(callbacks: AudioEngineCallbacks): Promise<void> {
    this.cb = callbacks
    await this.setupEventListeners()
    this.cachedSampleRate = await invoke<number>("audio_get_sample_rate").catch(() => 44100)
  }

  beginSelection(): void {
    this.eventGate.begin()
  }

  private async setupEventListeners(): Promise<void> {
    const generation = ++this.listenerGeneration
    // Clean up any existing listeners
    for (const unlisten of this.unlisteners) {
      unlisten()
    }
    this.unlisteners = []

    const registrations: (() => Promise<UnlistenFn>)[] = [
      () => listen<PositionPayload>("audio://position", e => {
        this.eventGate.accept(e.payload.request_id, () => this.cb?.onPosition(e.payload.position_ms, e.payload.duration_ms))
      }),
      () => listen<StatePayload>("audio://state", e => {
        this.eventGate.accept(e.payload.request_id, () => this.cb?.onState(e.payload.state as "playing" | "paused" | "buffering" | "stopped"))
      }),
      () => listen<TrackStartedPayload>("audio://track-started", e => {
        this.eventGate.accept(e.payload.request_id, () => this.cb?.onTrackStarted(e.payload.rating_key, e.payload.duration_ms))
      }),
      () => listen<TrackEndedPayload>("audio://track-ended", e => {
        this.eventGate.accept(e.payload.request_id, () => this.cb?.onTrackEnded(e.payload.rating_key))
      }),
      () => listen<ErrorPayload>("audio://error", e => {
        this.eventGate.accept(e.payload.request_id, () => this.cb?.onError(e.payload.message))
      }),
      () => listen<VisFramePayload>("audio://vis-frame", e => {
        const samples = new Float32Array(e.payload.samples)
        this.lastFrequencyBins = new Float32Array(e.payload.frequency_bins)
        this.cb?.onVisFrame?.(samples)
      }),
    ]
    try {
      for (const register of registrations) {
        const unlisten = await register()
        if (generation !== this.listenerGeneration) { unlisten(); return }
        this.unlisteners.push(unlisten)
      }
    } catch (error) {
      if (generation === this.listenerGeneration) {
        for (const unlisten of this.unlisteners) unlisten()
        this.unlisteners = []
      }
      throw error
    }
  }

  private sendControl(command: string, args?: Record<string, unknown>): void {
    void invoke(command, args).catch(error => this.cb?.onError(String(error)))
  }

  // ---------------------------------------------------------------------------
  // Playback
  // ---------------------------------------------------------------------------

  async play(
    url: string,
    ratingKey: number,
    durationMs: number,
    parentKey: string,
    gainDb: number | null,
    skipCrossfade?: boolean,
    startRamp?: string | null,
    endRamp?: string | null,
  ): Promise<void> {
    // Cache ramps
    if (startRamp || endRamp) {
      this.parseAndCacheRamps(ratingKey, startRamp ?? null, endRamp ?? null)
    }

    const ticket = this.eventGate.begin()
    const requestId = await invoke<number>("audio_play", {
      url,
      ratingKey,
      durationMs,
      parentKey,
      gainDb,
      skipCrossfade: skipCrossfade ?? false,
      startRamp: startRamp ?? null,
      endRamp: endRamp ?? null,
    })
    this.eventGate.confirm(ticket, requestId)
  }

  async preloadNext(
    url: string,
    ratingKey: number,
    durationMs: number,
    parentKey: string,
    gainDb: number | null,
    skipCrossfade?: boolean,
    startRamp?: string | null,
    endRamp?: string | null,
  ): Promise<void> {
    if (startRamp || endRamp) {
      this.parseAndCacheRamps(ratingKey, startRamp ?? null, endRamp ?? null)
    }

    await invoke("audio_preload_next", {
      url,
      ratingKey,
      durationMs,
      parentKey,
      gainDb,
      skipCrossfade: skipCrossfade ?? false,
      startRamp: startRamp ?? null,
      endRamp: endRamp ?? null,
    })
  }

  clearPreload(): void {
    this.sendControl("audio_clear_preload")
  }

  pause(): void {
    this.sendControl("audio_pause")
  }

  resume(): void {
    this.sendControl("audio_resume")
  }

  stop(): void {
    this.eventGate.disable()
    this.sendControl("audio_stop")
  }

  seek(positionMs: number): void {
    this.sendControl("audio_seek", { positionMs })
  }

  // Alias for seekTo (playerStore uses this name)
  seekTo(ms: number): void {
    this.seek(ms)
  }

  setVolume(gain: number): void {
    this.sendControl("audio_set_volume", { gain })
  }

  // ---------------------------------------------------------------------------
  // EQ / DSP
  // ---------------------------------------------------------------------------

  setEq(gainsDb: number[]): void {
    this.sendControl("audio_set_eq", { gainsDb })
  }

  setEqEnabled(enabled: boolean): void {
    this.sendControl("audio_set_eq_enabled", { enabled })
  }

  setPreampGain(db: number): void {
    this.sendControl("audio_set_preamp_gain", { db })
  }

  setEqPostgain(db: number): void {
    this.sendControl("audio_set_eq_postgain", { db })
  }

  /**
   * Brief volume duck to mask EQ filter transients.
   * The Rust engine ramps volume to 0, waits duckMs, then ramps back.
   */
  duckAndApply(fn_: () => void, duckMs = 30): void {
    void invoke("audio_duck_and_apply", { duckMs }).then(fn_).catch(error => this.cb?.onError(String(error)))
  }

  // ---------------------------------------------------------------------------
  // Crossfade settings
  // ---------------------------------------------------------------------------

  setCrossfadeWindow(ms: number): void {
    this.sendControl("audio_set_crossfade_window", { ms })
  }

  setSameAlbumCrossfade(enabled: boolean): void {
    this.sendControl("audio_set_same_album_crossfade", { enabled })
  }

  setSmartCrossfade(enabled: boolean): void {
    this.sendControl("audio_set_smart_crossfade", { enabled })
  }

  setSmartCrossfadeMax(ms: number): void {
    this.sendControl("audio_set_smart_crossfade_max", { ms })
  }

  setMixrampDb(db: number): void {
    this.sendControl("audio_set_mixramp_db", { db })
  }

  setNormalizationEnabled(enabled: boolean): void {
    this.sendControl("audio_set_normalization", { enabled })
  }

  // ---------------------------------------------------------------------------
  // Visualizer
  // ---------------------------------------------------------------------------

  setVisualizerEnabled(enabled: boolean): void {
    this.sendControl("audio_set_visualizer_enabled", { enabled })
  }

  /** Return cached FFT frequency data (pushed from Rust via vis-frame events). */
  getFrequencyData(): Float32Array | null {
    return this.lastFrequencyBins
  }

  /** Return the audio device sample rate. */
  getSampleRate(): number {
    return this.cachedSampleRate
  }

  // ---------------------------------------------------------------------------
  // Audio file cache
  // ---------------------------------------------------------------------------

  setCacheMaxBytes(bytes: number): void {
    this.sendControl("audio_set_cache_max_bytes", { bytes })
  }

  clearCache(): void {
    this.sendControl("audio_clear_cache")
  }

  async getCacheStats(): Promise<{ total_bytes: number; file_count: number; max_bytes: number }> {
    return invoke("audio_get_cache_stats")
  }

  // ---------------------------------------------------------------------------
  // Ramp cache
  // ---------------------------------------------------------------------------

  private parseAndCacheRamps(ratingKey: number, startRamp: string | null, endRamp: string | null): TrackRamps | null {
    if (!startRamp && !endRamp) return null
    const cached = this.rampCache.get(ratingKey)
    if (cached) return cached
    const ramps: TrackRamps = {
      startRamp: parseRamp(startRamp),
      endRamp: parseRamp(endRamp),
    }
    this.rampCache.set(ratingKey, ramps)
    if (this.rampCache.size > 500) {
      const firstKey = this.rampCache.keys().next().value
      if (firstKey !== undefined) this.rampCache.delete(firstKey)
    }
    return ramps
  }

  getTrackRamps(ratingKey: number): TrackRamps | null {
    return this.rampCache.get(ratingKey) ?? null
  }

  getMixrampOverlap(endRamp: RampPoint[], startRamp: RampPoint[]): { endOverlapSec: number; startOverlapSec: number } | null {
    // MixRamp interpolation for display only (actual crossfade computed in Rust)
    const threshold = -17
    const endCross = interpolateThreshold(endRamp, threshold)
    const startCross = interpolateThreshold(startRamp, threshold)
    if (endCross == null || startCross == null) return null
    // endCross is time from start of ramp (= time before track end)
    // startCross is time from start of next track
    const endOverlapSec = endRamp.length > 0
      ? endRamp[endRamp.length - 1].timeSec - endCross
      : 0
    if (endOverlapSec < 0.2 || startCross < 0.2) return null
    return { endOverlapSec, startOverlapSec: startCross }
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  destroy(): void {
    ++this.listenerGeneration
    this.stop()
    for (const unlisten of this.unlisteners) {
      unlisten()
    }
    this.unlisteners = []
    this.cb = null
  }
}

export const engine = new RustAudioEngine()
