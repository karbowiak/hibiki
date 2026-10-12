/** Display-only Plex loudness shaping; never modifies playback or gain. */
export function normalizeWaveformLoudness(levels: readonly { loudness: number }[]): number[] {
  const boosted = levels.map(level => {
    const loudness = Number.isFinite(level.loudness) ? Math.max(-35, level.loudness) : -35
    const t = (loudness + 35) * (100 / 35)
    const value = t * t / 100 * 1.5
    return Number.isFinite(value) ? value : 0
  })
  const max = boosted.reduce((highest, value) => Math.max(highest, value), 0.01)
  const curved = boosted.map(value => Math.pow(value / max * (90 / 2.2), 1.2) / 2.4)
  const peak = curved.reduce((highest, value) => Math.max(highest, value), 0.01)
  return curved.map(value => value / peak)
}

export function clampWaveformProgress(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0
}

export interface WaveformBar { x: number; y: number; width: number; height: number }

/** Symmetric bars cover the complete track, regardless of source/sample count. */
export function waveformBarGeometry(samples: readonly number[], width: number, height: number, dpr = 1): WaveformBar[] {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return []
  const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1
  const minimum = Math.min(height, 2 * ratio)
  if (samples.length === 0) return [{ x: 0, y: (height - minimum) / 2, width, height: minimum }]
  const count = Math.min(2048, Math.max(1, Math.floor(width / (4 * ratio))))
  const pitch = width / count
  const barWidth = Math.min(2 * ratio, pitch)
  const amplitude = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
  const bars: WaveformBar[] = []
  for (let index = 0; index < count; index++) {
    let value = 0
    if (samples.length >= count) {
      const start = Math.floor(index * samples.length / count)
      const end = Math.max(start + 1, Math.floor((index + 1) * samples.length / count))
      for (let source = start; source < end; source++) value = Math.max(value, amplitude(samples[source]))
    } else {
      const position = count === 1 ? 0 : index * (samples.length - 1) / (count - 1)
      const low = Math.floor(position), high = Math.ceil(position)
      value = amplitude(samples[low]) * (1 - (position - low)) + amplitude(samples[high]) * (position - low)
    }
    const barHeight = Math.min(height, Math.max(minimum, value * height * 0.82))
    bars.push({ x: index * pitch + (pitch - barWidth) / 2, y: (height - barHeight) / 2, width: barWidth, height: barHeight })
  }
  return bars
}
