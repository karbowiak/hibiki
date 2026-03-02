import { useEffect, useState } from "react"
import { usePlayerStore } from "../stores"
import { getTrack } from "../lib/plex"
import type { Track } from "../types/plex"
import { useLastfmMetadataStore } from "../stores/lastfmMetadataStore"
import type { LastfmTrackInfo } from "../lib/lastfm"
import { useDeezerMetadataStore } from "../stores/deezerMetadataStore"
import type { DeezerArtistInfo } from "../lib/deezer"

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${s.toString().padStart(2, "0")}`
}

function formatSize(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GB`
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

function formatSampleRate(hz: number): string {
  if (hz >= 1000) return `${(hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 1)} kHz`
  return `${hz} Hz`
}

interface Props {
  onClose: () => void
}

export default function TrackInfoPanel({ onClose }: Props) {
  const currentTrack = usePlayerStore(s => s.currentTrack)
  const [fullTrack, setFullTrack] = useState<Track | null>(null)
  const getLastfmTrack = useLastfmMetadataStore(s => s.getTrack)
  const [lastfmData, setLastfmData] = useState<LastfmTrackInfo | null>(null)
  const getDeezerArtist = useDeezerMetadataStore(s => s.getArtist)
  const [deezerArtistData, setDeezerArtistData] = useState<DeezerArtistInfo | null>(null)

  // Fetch full metadata to get stream details (bit depth, sample rate, etc.)
  useEffect(() => {
    if (!currentTrack) return
    let cancelled = false
    getTrack(currentTrack.rating_key).then(t => {
      if (!cancelled) setFullTrack(t)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [currentTrack?.rating_key])

  // Fetch LastFM metadata for the current track
  useEffect(() => {
    if (!currentTrack?.grandparent_title || !currentTrack?.title) return
    let cancelled = false
    setLastfmData(null)
    void getLastfmTrack(currentTrack.grandparent_title, currentTrack.title).then(d => {
      if (!cancelled && d) setLastfmData(d)
    })
    return () => { cancelled = true }
  }, [currentTrack?.rating_key, getLastfmTrack])

  // Fetch Deezer artist data for fan count
  useEffect(() => {
    if (!currentTrack?.grandparent_title) return
    let cancelled = false
    setDeezerArtistData(null)
    void getDeezerArtist(currentTrack.grandparent_title).then(d => {
      if (!cancelled && d) setDeezerArtistData(d)
    })
    return () => { cancelled = true }
  }, [currentTrack?.rating_key, getDeezerArtist])

  const track = fullTrack ?? currentTrack
  if (!track) return null

  const media = track.media?.[0]
  const part = media?.parts?.[0]
  const audioStream = part?.streams?.find(s => s.stream_type === 2)

  const codec = audioStream?.codec ?? media?.audio_codec ?? track.audio_codec
  const channels = audioStream?.channels ?? media?.audio_channels ?? track.audio_channels
  const bitrate = audioStream?.bitrate ?? media?.bitrate ?? track.audio_bitrate
  const bitDepth = audioStream?.bit_depth
  const sampleRate = audioStream?.sampling_rate
  const fileSize = part?.size
  const container = media?.container

  const hasGain = audioStream?.gain != null
  const hasLoudness = audioStream?.loudness != null

  const rows: [string, string][] = []

  if (track.grandparent_title) rows.push(["Artist", track.grandparent_title])
  if (track.parent_title) rows.push(["Album", track.parent_title])
  if (track.parent_year) rows.push(["Year", String(track.parent_year)])
  rows.push(["Duration", formatDuration(track.duration)])

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
  if (hasGain) rows.push(["Track Gain", `${audioStream!.gain!.toFixed(1)} dB`])
  if (audioStream?.album_gain != null) rows.push(["Album Gain", `${audioStream.album_gain.toFixed(1)} dB`])
  if (hasLoudness) rows.push(["Loudness", `${audioStream!.loudness!.toFixed(1)} LUFS`])
  if (audioStream?.peak != null) rows.push(["Peak", `${(audioStream.peak * 100).toFixed(1)}%`])

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

  return (
    <>
      <div className="px-4 pt-3 pb-1 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-white/50">Track Info</h3>
        <button onClick={onClose} className="text-white/30 hover:text-white/60 transition-colors">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
            <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/>
          </svg>
        </button>
      </div>
      <div className="px-4 pb-1">
        <p className="text-sm font-medium text-white truncate">{track.title}</p>
      </div>
      <div className="px-4 pb-3">
        <table className="w-full text-xs">
          <tbody>
            {rows.map(([label, value]) => (
              <tr key={label} className="border-b border-white/5 last:border-0">
                <td className="py-1.5 pr-3 text-white/40 whitespace-nowrap">{label}</td>
                <td className="py-1.5 text-white/80 text-right">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
