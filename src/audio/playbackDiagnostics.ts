/** Native measurements only. No URLs, account identifiers or local file paths. */
export interface PlaybackTransfer {
  kind: "network" | "cache" | "download"
  downloadedBytes: number | null
  totalBytes: number | null
  complete: boolean
  failed: boolean
}

export interface PlaybackDiagnosticsSnapshot {
  requestId: number
  playbackId: number
  ratingKey: number
  state: "stopped" | "buffering" | "playing" | "paused"
  positionMs: number
  bufferedSeconds: number
  decodedComplete: boolean
  mixerRate: number
  mixerChannels: number
  outputAvailable: boolean
  outputRate: number
  outputChannels: number
  outputFormat: string
  blockUs: number
  blockBudgetUs: number
  blocks: number
  bufferStarvations: number
  normalizationGain: number
  preampGain: number
  postGain: number
  volume: number
  eqEnabled: boolean
  limiterEnabled: boolean
  crossfading: boolean
  source: PlaybackTransfer | null
}

export interface PlaybackDiagnosticSample {
  at: number
  bufferSeconds: number
  transferKiB: number | null
  blockUs: number | null
}

/** Do not infer speed across pauses in observation or across playback occurrences. */
export function transferKiBPerSecond(
  before: { at: number; snapshot: PlaybackDiagnosticsSnapshot } | null,
  snapshot: PlaybackDiagnosticsSnapshot,
  at: number
): number | null {
  const source = snapshot.source
  const previous = before?.snapshot.source
  if (
    !before ||
    snapshot.playbackId !== before.snapshot.playbackId ||
    source?.kind !== "network" ||
    previous?.kind !== "network" ||
    source.downloadedBytes == null ||
    previous.downloadedBytes == null
  )
    return null
  const elapsed = (at - before.at) / 1000
  const delta = source.downloadedBytes - previous.downloadedBytes
  return elapsed > 0 && elapsed <= 2 && delta >= 0
    ? delta / 1024 / elapsed
    : null
}

export function gainDecibels(gain: number): string {
  if (!Number.isFinite(gain) || gain < 0) return "Unknown"
  if (gain === 0) return "Muted"
  const db = 20 * Math.log10(gain)
  return `${db > 0 ? "+" : ""}${db.toFixed(1)} dB`
}
