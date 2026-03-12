import { useCallback, useEffect, useState } from "react"
import { usePlayerStore } from "../stores"
import { useProviderStore } from "../stores/providerStore"
import { formatMs, formatSize, formatSampleRate } from "../lib/formatters"
import type { MusicTrack } from "../types/music"
import { useTrackEnrichment } from "../hooks/useMetadataEnrichment"
import { useDebugStore } from "../stores/debugStore"
import { parseRamp, engine } from "../audio/WebAudioEngine"
import { useAudioSettingsStore } from "../stores/audioSettingsStore"


interface Props {
  onClose: () => void
}

export default function TrackInfoPanel({ onClose }: Props) {
  const currentTrack = usePlayerStore(s => s.currentTrack)
  const queue = usePlayerStore(s => s.queue)
  const queueIndex = usePlayerStore(s => s.queueIndex)
  const [fullTrack, setFullTrack] = useState<MusicTrack | null>(null)
  const [fullNextTrack, setFullNextTrack] = useState<MusicTrack | null>(null)
  const { lastfm: lastfmData, deezer: deezerArtistData } = useTrackEnrichment(
    currentTrack?.artistName ?? null,
    currentTrack?.title ?? null,
  )
  const smartCrossfade = useAudioSettingsStore(s => s.smartCrossfade)
  const crossfadeWindowMs = useAudioSettingsStore(s => s.crossfadeWindowMs)
  const mixrampDb = useAudioSettingsStore(s => s.mixrampDb)
  const nextTrackShallow = queue[queueIndex + 1] ?? null

  // Fetch full metadata to get stream details (bit depth, sample rate, etc.)
  useEffect(() => {
    if (!currentTrack) return
    const provider = useProviderStore.getState().provider
    if (!provider) return
    let cancelled = false
    provider.getTrack(currentTrack.id).then(t => {
      if (!cancelled) setFullTrack(t)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [currentTrack?.id])

  // Fetch full metadata for next track to get ramp data from stream details
  useEffect(() => {
    setFullNextTrack(null)
    if (!nextTrackShallow) return
    const provider = useProviderStore.getState().provider
    if (!provider) return
    let cancelled = false
    provider.getTrack(nextTrackShallow.id).then(t => {
      if (!cancelled) setFullNextTrack(t)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [nextTrackShallow?.id])

  const debugEnabled = useDebugStore(s => s.debugEnabled)

  const track = fullTrack ?? currentTrack
  if (!track) return null

  const codec = track.codec
  const channels = track.channels
  const bitrate = track.bitrate
  const bitDepth = track.bitDepth
  const sampleRate = track.samplingRate
  const fileSize = track.mediaInfo?.fileSize
  const container = track.mediaInfo?.container

  const hasGain = track.gain != null
  const hasLoudness = track.loudness != null

  const rows: [string, string][] = []

  if (track.artistName) rows.push(["Artist", track.artistName])
  if (track.albumName) rows.push(["Album", track.albumName])
  if (track.albumYear) rows.push(["Year", String(track.albumYear)])
  rows.push(["Duration", formatMs(track.duration)])

  // Audio details
  if (codec) rows.push(["Codec", codec.toUpperCase()])
  if (container && container.toLowerCase() !== codec?.toLowerCase()) rows.push(["Container", container.toUpperCase()])
  if (bitDepth) rows.push(["Bit Depth", `${bitDepth}-bit`])
  if (sampleRate) rows.push(["Sample Rate", formatSampleRate(sampleRate)])
  if (bitrate) rows.push(["Bitrate", `${bitrate} kbps`])
  if (channels) rows.push(["Channels", channels === 2 ? "Stereo" : channels === 1 ? "Mono" : `${channels}ch`])
  if (fileSize) rows.push(["File Size", formatSize(fileSize)])

  // Loudness analysis status
  rows.push(["Loudness Analysis", hasGain || hasLoudness ? "Yes" : "No"])
  if (hasGain) rows.push(["Track Gain", `${track.gain!.toFixed(1)} dB`])
  if (track.albumGain != null) rows.push(["Album Gain", `${track.albumGain.toFixed(1)} dB`])
  if (hasLoudness) rows.push(["Loudness", `${track.loudness!.toFixed(1)} LUFS`])
  if (track.peak != null) rows.push(["Peak", `${(track.peak * 100).toFixed(1)}%`])

  // Last.fm stats
  if (lastfmData) {
    if (lastfmData.listeners > 0) rows.push(["Listeners (Last.fm)", lastfmData.listeners.toLocaleString()])
    if (lastfmData.play_count > 0) rows.push(["Scrobbles (Last.fm)", lastfmData.play_count.toLocaleString()])
    if (lastfmData.tags.length > 0) rows.push(["Tags (Last.fm)", lastfmData.tags.slice(0, 5).join(", ")])
  }

  // Deezer stats
  if (deezerArtistData?.fans && deezerArtistData.fans > 0) {
    rows.push(["Fans (Deezer)", deezerArtistData.fans.toLocaleString()])
  }

  const [copied, setCopied] = useState(false)
  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(JSON.stringify(track._providerData ?? track, null, 2))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [track])

  // Smart crossfade ramp rows — parse directly from MusicTrack to avoid engine cache race
  const nextTrack = fullNextTrack ?? nextTrackShallow
  const analysisRows: [string, string][] = []
  if (crossfadeWindowMs > 0 || smartCrossfade) {
    const endRamp = parseRamp(track.endRamp)
    const startRamp = parseRamp(track.startRamp)
    const nextStartRamp = nextTrack ? parseRamp(nextTrack.startRamp) : []

    if (endRamp.length > 0 || startRamp.length > 0) {
      analysisRows.push(["Ramps", "Yes"])
      if (endRamp.length > 0) {
        const rampWindowSec = endRamp[endRamp.length - 1].timeSec
        analysisRows.push(["End Ramp Window", `${rampWindowSec.toFixed(1)}s`])
      }
      if (startRamp.length > 0) {
        const rampWindowSec = startRamp[startRamp.length - 1].timeSec
        analysisRows.push(["Start Ramp Window", `${rampWindowSec.toFixed(1)}s`])
      }

      // Show MixRamp overlap calculation
      if (smartCrossfade && endRamp.length > 0 && nextStartRamp.length > 0) {
        const overlap = engine.getMixrampOverlap(endRamp, nextStartRamp)
        if (overlap) {
          analysisRows.push(["MixRamp Threshold", `${mixrampDb} dB`])
          analysisRows.push(["End crosses at", `${overlap.endOverlapSec.toFixed(1)}s before end`])
          analysisRows.push(["Start crosses at", `${overlap.startOverlapSec.toFixed(1)}s into track`])
          analysisRows.push(["Overlap", `${(overlap.endOverlapSec + overlap.startOverlapSec).toFixed(1)}s`])
        } else {
          analysisRows.push(["MixRamp", "Fallback (threshold not reached)"])
        }
      } else if (smartCrossfade && endRamp.length > 0) {
        const rampWindowMs = endRamp[endRamp.length - 1].timeSec * 1000
        const adaptiveMs = rampWindowMs > 500 ? rampWindowMs : 2000
        const cfStartMs = track.duration - adaptiveMs
        analysisRows.push(["Crossfade At", `${(cfStartMs / 1000).toFixed(1)}s (${(adaptiveMs / 1000).toFixed(1)}s)`])
      }
    } else {
      analysisRows.push(["Ramps", "None"])
    }

    if (nextTrack) {
      if (nextStartRamp.length > 0) {
        analysisRows.push(["Next: Start Ramp", `${nextStartRamp.length} points`])
      } else if (!fullNextTrack && nextTrackShallow) {
        analysisRows.push(["Next Track", "Loading ramps..."])
      } else {
        analysisRows.push(["Next Track", "No ramps"])
      }
    }
  }

  // Debug rows — intentionally backend-aware (shows raw provider data)
  const debugRows: [string, string][] = []
  if (debugEnabled) {
    const pd = track._providerData as any
    const pdPart = pd?.media?.[0]?.parts?.[0]
    debugRows.push(["ID", track.id])
    if (pd?.key) debugRows.push(["Key", pd.key])
    if (pd?.library_section_id) debugRows.push(["Library Section", String(pd.library_section_id)])
    if (pdPart?.file) debugRows.push(["File", pdPart.file])
    if (pd?.music_analysis_version != null) debugRows.push(["Music Analysis v", String(pd.music_analysis_version)])
    if (track.playCount != null) debugRows.push(["Play Count", String(track.playCount)])
    if (track.addedAt) debugRows.push(["Added At", track.addedAt])
    if (pd?.updated_at) debugRows.push(["Updated At", pd.updated_at])
  }

  const SectionTable = ({ rows: r, mono }: { rows: [string, string][]; mono?: boolean }) => (
    <table className="w-full text-xs">
      <tbody>
        {r.map(([label, value]) => (
          <tr key={label} className="border-b border-[var(--border-subtle)] last:border-0">
            <td className={`py-1.5 pr-3 whitespace-nowrap ${mono ? "text-[color:var(--text-muted)] font-mono text-[11px]" : "text-[color:var(--text-muted)]"}`}>{label}</td>
            <td className={`py-1.5 text-right ${mono ? "text-[color:var(--text-secondary)] font-mono text-[11px] break-all" : "text-[color:var(--text-secondary)]"}`}>{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )

  const hasAnalysis = analysisRows.length > 0
  const hasDebug = debugRows.length > 0
  const extraPanels = (hasAnalysis ? 1 : 0) + (hasDebug ? 1 : 0)

  return (
    <div style={{ width: extraPanels > 0 ? 280 + extraPanels * 260 : 300 }}>
      {/* Header */}
      <div className="px-4 pt-3 pb-1 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-widest text-[color:var(--text-muted)]">Track Info</h3>
          <p className="text-sm font-medium text-[color:var(--text-primary)] truncate">{track.title}</p>
        </div>
        <div className="flex items-center gap-2">
          {debugEnabled && (
            <button
              onClick={handleCopy}
              className="px-2 py-0.5 rounded text-[10px] bg-[var(--bg-surface)] hover:bg-[var(--bg-surface-hover)] text-[color:var(--text-muted)] hover:text-[color:var(--text-secondary)] transition-colors"
            >
              {copied ? "Copied!" : "Copy JSON"}
            </button>
          )}
          <button onClick={onClose} className="text-[color:var(--text-muted)] hover:text-[color:var(--text-secondary)] transition-colors">
            <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
              <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Panels side by side */}
      <div className="flex gap-0 px-2 pb-3">
        {/* Panel 1: Track Info — always visible */}
        <div className={`px-2 ${extraPanels > 0 ? "min-w-[260px]" : "flex-1"}`}>
          <SectionTable rows={rows} />
        </div>

        {/* Panel 2: Smart Crossfade */}
        {hasAnalysis && (
          <div className="min-w-[240px] flex-1 border-l border-[var(--border-subtle)] px-3">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)] mb-1">
              Smart Crossfade {smartCrossfade ? "" : "(off)"}
            </p>
            <SectionTable rows={analysisRows} mono />
          </div>
        )}

        {/* Panel 3: Debug */}
        {hasDebug && (
          <div className="min-w-[220px] flex-1 border-l border-[var(--border-subtle)] px-3">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)] mb-1">Debug</p>
            <SectionTable rows={debugRows} mono />
          </div>
        )}
      </div>
    </div>
  )
}
