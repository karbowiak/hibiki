import { Button } from "./shared/Button"
import { useId, useRef, useState, useEffect } from "react"
import { usePlaybackDiagnostics } from "../hooks/usePlaybackDiagnostics"
import { usePlayerStore } from "../stores/playerStore"
import { useDeviceStore } from "../stores/deviceStore"
import { formatAudioQuality, playbackAudioQuality } from "../lib/audioQuality"
import { formatSampleRate, formatSize } from "../lib/formatters"
import {
  gainDecibels,
  type PlaybackDiagnosticSample,
} from "../audio/playbackDiagnostics"

type SeriesKey = "bufferSeconds" | "transferKiB"

function History({
  title,
  unit,
  samples,
  series,
  empty,
}: {
  title: string
  unit: string
  samples: PlaybackDiagnosticSample[]
  series: SeriesKey
  empty: string
}) {
  const labelId = useId()
  const usable = samples.filter(
    (sample) => sample[series] != null && Number.isFinite(sample[series])
  )
  const last = usable.at(-1)?.[series]
  const max = Math.max(1, ...usable.map((sample) => sample[series]!))
  const end = samples.at(-1)?.at ?? 0
  // Expand the time axis as observations arrive; never invent pre-open history.
  const start = Math.max(end - 30_000, usable[0]?.at ?? end)
  const span = Math.max(1, end - start)
  const seconds = (span / 1000).toLocaleString(undefined, {
    maximumFractionDigits: 1,
  })
  const paths: string[] = []
  let path = ""
  let previousAt = 0
  for (const sample of samples) {
    const value = sample[series]
    if (value == null || !Number.isFinite(value)) {
      if (path) paths.push(path)
      path = ""
      continue
    }
    if (path && sample.at - previousAt > 2000) {
      paths.push(path)
      path = ""
    }
    const x = 12 + Math.min(1, Math.max(0, (sample.at - start) / span)) * 276
    const y = 72 - Math.min(1, Math.max(0, value) / max) * 58
    path += `${path ? " L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`
    previousAt = sample.at
  }
  if (path) paths.push(path)
  return (
    <figure className="playback-history" aria-labelledby={labelId}>
      <figcaption id={labelId}>
        <span>{title}</span>
        <span className="playback-measurement">
          {last == null
            ? "—"
            : last.toLocaleString(undefined, { maximumFractionDigits: 1 })}{" "}
          <span>{unit}</span>
        </span>
      </figcaption>
      {usable.length > 1 ? (
        <svg
          viewBox="0 0 300 96"
          role="img"
          aria-label={`${title} during the last ${seconds} seconds. Latest ${last?.toFixed(1)} ${unit}; scale zero to ${max.toFixed(1)} ${unit}.`}
        >
          <path d="M12 14H288 M12 72H288" className="playback-history-grid" />
          {paths.map((d, i) => (
            <path key={i} d={d} className="playback-history-line" />
          ))}
          <text x="12" y="92">
            −{seconds}s
          </text>
          <text x="288" y="92" textAnchor="end">
            now
          </text>
        </svg>
      ) : (
        <div className="playback-history-empty">{empty}</div>
      )}
      <p className="playback-history-scale">
        0–{max.toLocaleString(undefined, { maximumFractionDigits: 1 })} {unit}
      </p>
    </figure>
  )
}

export default function PlaybackDiagnostics() {
  const { snapshot, samples, unavailable, browserAudio, playbackId } =
    usePlaybackDiagnostics()
  const track = usePlayerStore((s) => s.currentTrack)
  const binding = usePlayerStore((s) => s.playbackFormat)
  const outputName = useDeviceStore((s) => s.currentDevice)
  const progressId = useId()
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle"
  )
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copyEpoch = useRef(0)
  useEffect(() => {
    ++copyEpoch.current
    setCopyState("idle")
    return () => {
      ++copyEpoch.current
      if (copyTimer.current) clearTimeout(copyTimer.current)
    }
  }, [playbackId])

  if (browserAudio)
    return (
      <p className="playback-diagnostics-empty">
        Internet radio plays through the browser audio system. Native playback
        measurements apply to library tracks.
      </p>
    )
  if (unavailable)
    return (
      <p className="playback-diagnostics-empty">
        Playback measurements are unavailable. If you just updated the
        development app, restart it to load the native changes.
      </p>
    )
  if (!snapshot)
    return (
      <p className="playback-diagnostics-empty">
        {playbackId == null
          ? "Start or resume a track to inspect its playback."
          : "Waiting for the playback engine…"}
      </p>
    )

  const source = snapshot.source
  const received = source?.downloadedBytes
  const total = source?.totalBytes
  const network = source?.kind === "network"
  const sourceLabel =
    source?.kind === "download"
      ? "Offline download"
      : source?.kind === "cache"
        ? "Audio cache"
        : network
          ? "Network stream"
          : "Source pending"
  const input =
    track && binding?.trackId === track.id
      ? formatAudioQuality(playbackAudioQuality(track, binding.format))
      : null
  const stateLabel = {
    playing: "Playing",
    paused: "Paused",
    buffering: "Buffering",
    stopped: "Stopped",
  }[snapshot.state]
  const copy = async () => {
    const epoch = ++copyEpoch.current
    try {
      // Explicit allowlist: measured numeric data only; never raw provider metadata.
      await navigator.clipboard.writeText(
        JSON.stringify({ schema: 1, playback: snapshot, samples }, null, 2)
      )
      if (epoch !== copyEpoch.current) return
      setCopyState("copied")
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopyState("idle"), 2000)
    } catch {
      if (epoch === copyEpoch.current) setCopyState("failed")
    }
  }

  return (
    <div className="playback-diagnostics">
      <div className="playback-diagnostics-status">
        <strong>
          {stateLabel}
          {snapshot.crossfading ? " · Crossfading" : ""}
        </strong>
        <span>{sourceLabel}</span>
      </div>
      <dl className="playback-signal-path">
        <div>
          <dt>Decoder input</dt>
          <dd>{input ?? "Unknown"}</dd>
        </div>
        <div>
          <dt>Mixer</dt>
          <dd>
            32-bit float · {formatSampleRate(snapshot.mixerRate)} ·{" "}
            {snapshot.mixerChannels} channels
          </dd>
        </div>
        <div>
          <dt>Device output</dt>
          <dd>
            {snapshot.outputAvailable && snapshot.outputRate > 0
              ? `${snapshot.outputFormat} · ${formatSampleRate(snapshot.outputRate)} · ${snapshot.outputChannels} channels`
              : "Output unavailable"}
            {outputName && (
              <span className="playback-output-name">{outputName}</span>
            )}
          </dd>
        </div>
      </dl>

      <div className="playback-histories">
        <History
          title="Decoded ahead"
          unit="s"
          samples={samples}
          series="bufferSeconds"
          empty="Gathering buffer measurements…"
        />
        <History
          title="Network transfer"
          unit="KiB/s"
          samples={samples}
          series="transferKiB"
          empty={
            network
              ? "Gathering transfer measurements…"
              : "Playing from local storage"
          }
        />
      </div>

      <div className="playback-transfer">
        <div>
          <span id={progressId}>{network ? "Received" : "Local audio"}</span>
          <span>
            {received == null
              ? "Unknown size"
              : `${formatSize(received)}${total != null ? ` / ${formatSize(total)}` : " · total unknown"}`}
          </span>
        </div>
        {total != null && total > 0 && received != null && (
          <progress
            aria-labelledby={progressId}
            max={total}
            value={Math.min(total, received)}
          />
        )}
        <p>
          {source?.failed
            ? "The media transfer was interrupted."
            : source?.complete
              ? network
                ? "Transfer complete"
                : "Complete file available"
              : network
                ? "Downloading while the decoder reads ahead"
                : "Waiting for source measurements"}
          {snapshot.decodedComplete ? " · Decoding complete" : ""}
        </p>
      </div>

      <dl className="track-info-values playback-engine-values">
        <div>
          <dt>Engine render block</dt>
          <dd>
            {samples.at(-1)?.blockUs == null
              ? "No active block"
              : `${snapshot.blockUs.toLocaleString(undefined, { maximumFractionDigits: 1 })} µs / ${(snapshot.blockBudgetUs / 1000).toFixed(2)} ms budget`}
          </dd>
        </div>
        <div>
          <dt>Buffering interruptions</dt>
          <dd>{snapshot.bufferStarvations.toLocaleString()} this playback</dd>
        </div>
        <div>
          <dt>Normalization</dt>
          <dd>{gainDecibels(snapshot.normalizationGain)}</dd>
        </div>
        <div>
          <dt>Preamp / EQ postgain</dt>
          <dd>
            {gainDecibels(snapshot.preampGain)} /{" "}
            {gainDecibels(snapshot.postGain)}
          </dd>
        </div>
        <div>
          <dt>Equalizer / limiter</dt>
          <dd>
            {snapshot.eqEnabled ? "On" : "Off"} /{" "}
            {snapshot.limiterEnabled ? "On" : "Off"}
          </dd>
        </div>
        <div>
          <dt>Volume gain</dt>
          <dd>{gainDecibels(snapshot.volume)}</dd>
        </div>
      </dl>
      <div className="playback-diagnostics-footer">
        <p>
          Render time samples engine work, not device latency. Graphs retain 30
          seconds while this panel is visible.
        </p>
        <Button variant="bare" type="button" className="track-info-copy" onClick={copy}>
          {copyState === "copied"
            ? "Copied"
            : copyState === "failed"
              ? "Retry copy"
              : "Copy diagnostics"}
        </Button>
      </div>
    </div>
  )
}
