/** Visual bands from native FFT dB bins and the actual audio output sample rate. */
export function computeSpectrumFromFFT(
  fftData: Float32Array,
  bins: number,
  sampleRate: number
): Float32Array {
  const result = new Float32Array(bins)
  const nyquist = sampleRate / 2
  const binCount = fftData.length
  const fMin = 20
  const fMax = Math.min(nyquist, 20000)
  if (!binCount || !Number.isFinite(sampleRate) || fMax <= fMin) return result
  const DB_MIN = -70
  const DB_MAX = -5
  const DB_RANGE = DB_MAX - DB_MIN
  const REF_FREQ = 1000 // pink-noise compensation reference
  const DB_PER_OCTAVE = 4.5

  for (let b = 0; b < bins; b++) {
    // Log-spaced frequency edges for this visual bin
    const fLo = fMin * Math.pow(fMax / fMin, b / bins)
    const fHi = fMin * Math.pow(fMax / fMin, (b + 1) / bins)
    const idxLo = Math.max(0, Math.floor((fLo / nyquist) * binCount))
    const idxHi = Math.min(binCount - 1, Math.ceil((fHi / nyquist) * binCount))

    // Average in linear power domain (avoids -Infinity poisoning from empty bins)
    let sumPower = 0
    let count = 0
    for (let j = idxLo; j <= idxHi; j++) {
      sumPower += Math.pow(10, fftData[j] / 10)
      count++
    }
    const avgDb = count > 0 ? 10 * Math.log10(sumPower / count) : DB_MIN

    // Pink-noise compensation: boost higher frequencies relative to 1kHz
    const centerFreq = (fLo + fHi) / 2
    const octavesFromRef = Math.log2(centerFreq / REF_FREQ)
    const compensated = avgDb + octavesFromRef * DB_PER_OCTAVE

    result[b] = Math.max(0, Math.min(1, (compensated - DB_MIN) / DB_RANGE))
  }
  return result
}
