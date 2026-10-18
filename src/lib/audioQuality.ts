import type { SourceAudioFormat } from "../audio/playbackJournal"

export interface AudioQuality {
  codec?: string | null
  bitDepth?: number | null
  samplingRate?: number | null
  bitrate?: number | null
}

/** Deliberately wide margins, not a codec-independent kbps ranking. Unknowns
 * never justify replacing Plex. See docs/metadata-cache-policy.md. */
export function clearlyBetterAudio(
  plex: AudioQuality,
  youtube: AudioQuality
): boolean {
  const codec = (value: string | null | undefined) =>
    value
      ?.trim()
      .toLowerCase()
      .replace(/^mp4a.*$/, "aac")
  const left = codec(plex.codec),
    right = codec(youtube.codec)
  const p = plex.bitrate,
    y = youtube.bitrate
  if (
    !p ||
    !y ||
    !Number.isFinite(p) ||
    !Number.isFinite(y) ||
    p <= 0 ||
    y <= 0
  )
    return false
  if (
    !["aac", "mp3", "opus", "vorbis"].includes(left ?? "") ||
    !["aac", "opus"].includes(right ?? "")
  )
    return false
  if (left === right) return y >= 128 && y >= p * 1.5 && y - p >= 64
  // Cross-codec comparisons qualify only at clearly inferior source rates.
  if (left === "mp3") return p <= 128 && y >= 192
  return p <= 96 && y >= 192
}

export function preferVerifiedYoutubeAudio(
  track: import("../types/music").MusicTrack,
  youtube: import("../types/music").MusicTrack,
  now = Date.now()
): boolean {
  const verified = youtube.mediaInfo?.verifiedAudio
  if (
    !verified ||
    now < verified.checkedAt ||
    now - verified.checkedAt > 30 * 60_000 ||
    !verified.formatId
  )
    return false
  if (track.mediaInfo?.hasAudioStream === false) return false
  const versions = track.mediaInfo?.versions?.filter(
    (version) => version.partCount === 1 && !!version.partId
  )
  // Unknown/truncated versions could contain a better copy; stay with Plex.
  if (track.mediaInfo?.versionsTruncated) return false
  if (track.mediaInfo?.versions?.length && !versions?.length) return false
  return (versions?.length ? versions : [track]).every((version) =>
    clearlyBetterAudio(version, verified)
  )
}

/** Prefer the active decoder input; never borrow a FLAC's depth for a transcode. */
export function playbackAudioQuality(
  track: AudioQuality,
  active?: SourceAudioFormat | null
): AudioQuality {
  if (!active) return track
  const sameCodec =
    track.codec
      ?.trim()
      .toUpperCase()
      .replace(/^MP4A.*$/, "AAC") === active.codec.toUpperCase()
  return {
    codec: active.codec,
    bitDepth: active.bit_depth,
    samplingRate: active.sample_rate,
    bitrate: sameCodec ? track.bitrate : null,
  }
}

/** Compact source-format description. Decoder float precision is not file depth. */
export function formatAudioQuality(audio: AudioQuality): string | null {
  const codec =
    audio.codec
      ?.trim()
      .toUpperCase()
      .replace(/^PCM_.+$/, "PCM") || ""
  const positive = (value: number | null | undefined) =>
    typeof value === "number" && Number.isFinite(value) && value > 0
  const lossless =
    /^(FLAC|ALAC|WAV|WAVE|AIFF|AIF|APE|WV|WAVPACK|PCM(?:_.*)?|DSD|DSF|DFF)$/.test(
      codec
    )
  const depth =
    lossless && positive(audio.bitDepth) && Number.isInteger(audio.bitDepth)
      ? `${audio.bitDepth}bit`
      : ""
  const rate = positive(audio.samplingRate)
    ? `${Number((audio.samplingRate! / 1000).toFixed(3))}kHz`
    : ""
  const bitrate =
    !depth && !lossless && positive(audio.bitrate)
      ? `${Math.round(audio.bitrate!)}kbps`
      : ""
  const format = [depth || bitrate, rate].filter(Boolean).join("/")
  return [codec, format].filter(Boolean).join(" ") || null
}
