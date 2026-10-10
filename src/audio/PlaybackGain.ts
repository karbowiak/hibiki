/** Short Web Audio playback fades, separate from the user's master volume. */
export const PLAYBACK_FADE_SECONDS = 0.15

type GainParam = Pick<AudioParam, "cancelScheduledValues" | "setValueAtTime" | "setValueCurveAtTime">

export class PlaybackGain {
  private target = 0
  private startTime = 0
  private curve: Float32Array | null = null

  constructor(private param: GainParam, private clock: { readonly currentTime: number }) {
    this.silence()
  }

  private valueAt(time: number): number {
    if (!this.curve) return this.target
    const index = Math.max(0, Math.min(1, (time - this.startTime) / PLAYBACK_FADE_SECONDS)) * (this.curve.length - 1)
    const lo = Math.floor(index)
    const hi = Math.min(lo + 1, this.curve.length - 1)
    // Match AudioParam's interpolation when reversing an unfinished fade.
    return this.curve[lo] + (this.curve[hi] - this.curve[lo]) * (index - lo)
  }

  fadeTo(target: 0 | 1): void {
    if (this.target === target) return
    const now = this.clock.currentTime
    const from = this.valueAt(now)
    const curve = new Float32Array(65)
    for (let i = 0; i < curve.length; i++) {
      const t = i / (curve.length - 1)
      curve[i] = from + (target - from) * t * t * (3 - 2 * t)
    }
    this.param.cancelScheduledValues(now)
    this.param.setValueCurveAtTime(curve, now, PLAYBACK_FADE_SECONDS)
    this.target = target
    this.startTime = now
    this.curve = curve
  }

  silence(): void {
    const now = this.clock.currentTime
    this.param.cancelScheduledValues(now)
    this.param.setValueAtTime(0, now)
    this.target = 0
    this.curve = null
  }
}
