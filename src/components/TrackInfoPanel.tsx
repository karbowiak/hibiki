import { useCallback, useEffect, useRef, useState } from "react"
import { usePlayerStore } from "../stores"
import { useProviderStore } from "../stores/providerStore"
import { formatMs, formatSize, formatSampleRate } from "../lib/formatters"
import type { MusicTrack } from "../types/music"
import { useTrackEnrichment } from "../hooks/useMetadataEnrichment"
import { useDebugStore } from "../stores/debugStore"
import { transitionRows } from "../audio/transitionInfo"
import "../styles/trackInfo.css"
interface Props {
  onClose: () => void
}

export default function TrackInfoPanel({ onClose }: Props) {
  const currentTrack = usePlayerStore(s => s.currentTrack)
  const provider = useProviderStore(s => s.provider)
  const transitionInfo = usePlayerStore(s => s.transitionInfo)
  const repeat = usePlayerStore(s => s.repeat)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const queue = usePlayerStore(s => s.queue)
  const queueIndex = usePlayerStore(s => s.queueIndex)
  const [fullTrack, setFullTrack] = useState<MusicTrack | null>(null)
  const { lastfm: lastfmData, deezer: deezerArtistData } = useTrackEnrichment(
    currentTrack?.artistName ?? null,
    currentTrack?.title ?? null,
  )
  const nextTrackShallow = repeat === 1 ? null : queue[queueIndex + 1] ?? (repeat === 2 ? queue[0] : null)

  // Fetch full metadata to get stream details (bit depth, sample rate, etc.)
  useEffect(() => {
    setFullTrack(null)
    if (!currentTrack) return
    if (!provider) return
    let cancelled = false
    provider.getTrack(currentTrack.id).then(t => {
      if (!cancelled) setFullTrack(t)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [currentTrack?.id, provider])

  const debugEnabled = useDebugStore(s => s.debugEnabled)

  const track = fullTrack?.id === currentTrack?.id ? fullTrack : currentTrack
  const handleCopy = useCallback(() => {
    if (!track) return
    void navigator.clipboard.writeText(JSON.stringify(track._providerData ?? track, null, 2)).then(() => {
      setCopied(true)
      if (copyTimer.current !== null) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 1500)
    }).catch(() => setCopied(false))
  }, [track])
  useEffect(() => () => { if (copyTimer.current !== null) clearTimeout(copyTimer.current) }, [])
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

  const analysisRows = transitionRows(transitionInfo, !!nextTrackShallow, repeat === 1)

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
    <dl className={`track-info-values${mono ? " track-info-values--technical" : ""}`}>
      {r.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )

  const hasAnalysis = analysisRows.length > 0
  const hasDebug = debugRows.length > 0
  return (
    <div className="track-info-panel">
      {/* Header */}
      <div className="track-info-header">
        <div className="min-w-0 flex-1">
          <h3 className="track-info-title">{track.title}</h3>
          <p className="track-info-caption">Track information</p>
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
          <button type="button" onClick={onClose} aria-label="Close track info" className="track-info-close">
            <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
              <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/>
            </svg>
          </button>
        </div>
      </div>

      <div className="track-info-body">
        <SectionTable rows={rows} />

        {/* Panel 2: Smart Crossfade */}
        {hasAnalysis && (
          <section className="track-info-section" aria-label="Next transition">
            <h4>Next transition</h4>
            <SectionTable rows={analysisRows} mono />
          </section>
        )}

        {/* Panel 3: Debug */}
        {hasDebug && (
          <section className="track-info-section" aria-label="Debug">
            <h4>Debug</h4>
            <SectionTable rows={debugRows} mono />
          </section>
        )}
      </div>
    </div>
  )
}
