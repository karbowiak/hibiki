/**
 * Audio engine — Tauri IPC bridge to the Rust audio engine.
 *
 * Maps the public API to Tauri this.ipc.invoke() commands and this.ipc.listen() events.
 * The Rust engine handles all audio processing: fetch, decode (symphonia),
 * DSP (EQ, limiter, volume), crossfade, and output (cpal → CoreAudio).
 *
 * Module-level singleton: `import { engine } from "../audio/RustAudioEngine"`
 */

import type { TrackPlaybackInfo } from "../providers/types"
import type { TransitionInfo } from "./transitionInfo"
import type { TrackStarted, TrackEnded } from "./playbackJournal"
import { PlaybackEventGate } from "./playbackEventGate"
import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AudioEngineCallbacks {
  onPosition(positionMs: number, durationMs: number, playbackId: number): void
  onState(state: "playing" | "paused" | "buffering" | "stopped"): void
  onTrackStarted(event: TrackStarted): void
  onTrackEnded(event: TrackEnded): void
  onControlError?(message: string): void
  onTransitionScheduled?(transition: TransitionInfo | null): void
  onError(message: string): void
  onVisFrame?(samples: Float32Array): void
}

export interface PlaybackLabels { artist: string; track: string; album: string; album_artist: string }

export interface AudioCacheStats {
  total_bytes: number
  file_count: number
  max_bytes: number
  status: "ready" | "busy" | "unavailable" | "retired"
}

// ---------------------------------------------------------------------------
// Event payloads from Rust
// ---------------------------------------------------------------------------

// Payload field names are snake_case from Rust serde (rename_all only affects
// the enum tag, not struct fields in internally-tagged enums).
interface PositionPayload { request_id: number; playback_id: number; position_ms: number; duration_ms: number }
interface StatePayload { request_id: number; state: string }
interface TrackStartedPayload extends TrackStarted { request_id: number }
interface TrackEndedPayload extends TrackEnded { request_id: number }
interface TransitionPayload { request_id: number; transition: TransitionInfo | null }
interface ErrorPayload { request_id: number; message: string }
interface VisFramePayload { samples: number[]; frequency_bins: number[] }

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface AudioTransport { invoke: typeof invoke; listen: typeof listen }

export interface EqConfiguration {
  gainsDb: number[]
  enabled: boolean
  /** Null selects native automatic headroom. */
  postgainDb: number | null
  duckMs?: number
}

export class RustAudioEngine {
  private cacheTail: Promise<void> = Promise.resolve()
  constructor(private ipc: AudioTransport = { invoke, listen }) {}
  private cb: AudioEngineCallbacks | null = null
  private eventGate = new PlaybackEventGate()
  private listenerGeneration = 0
  private unlisteners: UnlistenFn[] = []
  private eqConfigurationBusy = false
  private pendingEqConfiguration: {
    snapshot: EqConfiguration
    resolve: (gain: number | undefined) => void
    reject: (error: unknown) => void
  } | null = null

  // Cached visualizer data (pushed from Rust, read synchronously by components)
  private lastFrequencyBins: Float32Array | null = null
  private cachedSampleRate = 44100

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  async init(callbacks: AudioEngineCallbacks): Promise<void> {
    this.cb = callbacks
    await this.setupEventListeners()
    this.cachedSampleRate = await this.ipc.invoke<number>("audio_get_sample_rate").catch(() => 44100)
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
      () => this.ipc.listen<PositionPayload>("audio://position", e => {
        this.eventGate.accept(e.payload.request_id, () => this.cb?.onPosition(e.payload.position_ms, e.payload.duration_ms, e.payload.playback_id))
      }),
      () => this.ipc.listen<StatePayload>("audio://state", e => {
        this.eventGate.accept(e.payload.request_id, () => this.cb?.onState(e.payload.state as "playing" | "paused" | "buffering" | "stopped"))
      }),
      () => this.ipc.listen<TrackStartedPayload>("audio://track-started", e => {
        this.eventGate.accept(e.payload.request_id, () => this.cb?.onTrackStarted(e.payload))
      }),
      () => this.ipc.listen<TrackEndedPayload>("audio://track-ended", e => {
        // Ends are validated against known journal identities. An outgoing
        // deck can legitimately finish after selection changed or Stop.
        this.cb?.onTrackEnded(e.payload)
      }),
      () => this.ipc.listen<TransitionPayload>("audio://transition-scheduled", e => {
        this.eventGate.accept(e.payload.request_id, () => this.cb?.onTransitionScheduled?.(e.payload.transition))
      }),
      () => this.ipc.listen<ErrorPayload>("audio://error", e => {
        this.eventGate.accept(e.payload.request_id, () => this.cb?.onError(e.payload.message))
      }),
      () => this.ipc.listen<VisFramePayload>("audio://vis-frame", e => {
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
    void this.ipc.invoke(command, args).catch(error => this.cb?.onControlError?.(String(error)))
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
    albumPlayback = false,
    context?: TrackPlaybackInfo["plexContext"],
    labels?: PlaybackLabels,
  ): Promise<void> {
    const ticket = this.eventGate.begin()
    const requestId = await this.ipc.invoke<number>("audio_play", {
      url,
      ratingKey,
      durationMs,
      parentKey,
      gainDb,
      skipCrossfade: skipCrossfade ?? false,
      startRamp: startRamp ?? null,
      endRamp: endRamp ?? null,
      albumPlayback,
      labels: labels ?? null,
      context: context ? { connectionRevision: context.connectionRevision, cacheScope: context.cacheScope } : null,
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
    albumPlayback = false,
    context?: TrackPlaybackInfo["plexContext"],
    labels?: PlaybackLabels,
  ): Promise<void> {
    await this.ipc.invoke("audio_preload_next", {
      url,
      ratingKey,
      durationMs,
      parentKey,
      gainDb,
      skipCrossfade: skipCrossfade ?? false,
      startRamp: startRamp ?? null,
      endRamp: endRamp ?? null,
      albumPlayback,
      labels: labels ?? null,
      context: context ? { connectionRevision: context.connectionRevision, cacheScope: context.cacheScope } : null,
    })
  }

  async prepareShutdown(): Promise<TrackEnded[]> {
    this.eventGate.disable()
    return this.ipc.invoke<TrackEnded[]>("prepare_app_shutdown")
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

  configureEq(configuration: EqConfiguration): Promise<number | undefined> {
    const snapshot = { ...configuration, gainsDb: [...configuration.gainsDb] }
    // At most one invoke and one pending snapshot. Superseded waiting edits
    // resolve without an applied gain; the store fences their stale replies.
    this.pendingEqConfiguration?.resolve(undefined)
    const applied = new Promise<number | undefined>((resolve, reject) => {
      this.pendingEqConfiguration = { snapshot, resolve, reject }
    })
    if (!this.eqConfigurationBusy) void this.flushEqConfigurations()
    return applied
  }

  private async flushEqConfigurations(): Promise<void> {
    this.eqConfigurationBusy = true
    while (this.pendingEqConfiguration) {
      const request = this.pendingEqConfiguration
      this.pendingEqConfiguration = null
      try {
        request.resolve(
          await this.ipc.invoke<number>("audio_configure_eq", {
            gainsDb: request.snapshot.gainsDb,
            enabled: request.snapshot.enabled,
            postgainDb: request.snapshot.postgainDb,
            duckMs: request.snapshot.duckMs,
          })
        )
      } catch (error) {
        request.reject(error)
      }
    }
    this.eqConfigurationBusy = false
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
    void this.ipc.invoke("audio_duck_and_apply", { duckMs }).then(fn_).catch(error => this.cb?.onError(String(error)))
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

  /** Read-only telemetry. Call only while a diagnostics surface is visible. */
  getDiagnostics(): Promise<import("./playbackDiagnostics").PlaybackDiagnosticsSnapshot | null> {
    return this.ipc.invoke("audio_get_diagnostics")
  }

  /** Return the audio device sample rate. */
  getSampleRate(): number {
    return this.cachedSampleRate
  }

  // ---------------------------------------------------------------------------
  // Audio file cache
  // ---------------------------------------------------------------------------

  setCacheMaxBytes(bytes: number): Promise<AudioCacheStats> {
    if (!Number.isSafeInteger(bytes) || bytes < 0) return Promise.reject(new Error("Invalid audio cache limit"))
    return this.cacheMutation("audio_set_cache_max_bytes", { bytes })
  }

  clearCache(): Promise<AudioCacheStats> {
    return this.cacheMutation("audio_clear_cache")
  }

  private cacheMutation(command: string, args?: Record<string, unknown>): Promise<AudioCacheStats> {
    const operation = this.cacheTail.then(() => this.ipc.invoke<AudioCacheStats>(command, args))
    this.cacheTail = operation.then(() => {}, () => {})
    return operation
  }

  async getCacheStats(): Promise<AudioCacheStats> {
    return this.ipc.invoke("audio_get_cache_stats")
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
