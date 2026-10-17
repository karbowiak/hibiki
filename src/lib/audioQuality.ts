import type { SourceAudioFormat } from "../audio/playbackJournal"

interface AudioQuality {
  codec?: string | null
  bitDepth?: number | null
  samplingRate?: number | null
  bitrate?: number | null
}

/** Prefer the active decoder input; never borrow a FLAC's depth for a transcode. */
export function playbackAudioQuality(
  track: AudioQuality,
  active?: SourceAudioFormat | null
): AudioQuality {
  if (!active) return track
  const sameCodec =
    track.codec?.trim().toUpperCase() === active.codec.toUpperCase()
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
