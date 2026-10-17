//! FFT processing — Hann window + realfft → frequency bins in dB.

use realfft::{num_complex::Complex, RealFftPlanner, RealToComplex};
use std::f32::consts::PI;
use std::sync::Arc;

/// FFT size (matching the JS engine's AnalyserNode fftSize).
pub const FFT_SIZE: usize = 2048;

/// Number of frequency bins (fftSize / 2 + 1).
pub const NUM_BINS: usize = FFT_SIZE / 2 + 1;

/// Compute a Hann window of the given size.
fn hann_window(size: usize) -> Vec<f32> {
    (0..size)
        .map(|i| 0.5 * (1.0 - (2.0 * PI * i as f32 / (size - 1) as f32).cos()))
        .collect()
}

/// Compute FFT frequency bins from time-domain samples.
///
/// Input: `FFT_SIZE` mono samples (if stereo, caller should downmix first).
/// Output: `NUM_BINS` values in dB (relative to full scale).
pub struct FftProcessor {
    window: Vec<f32>,
    windowed: Vec<f32>,
    fft: Arc<dyn RealToComplex<f32>>,
    spectrum: Vec<Complex<f32>>,
    scratch: Vec<Complex<f32>>,
}

impl FftProcessor {
    pub fn new() -> Self {
        let fft = RealFftPlanner::<f32>::new().plan_fft_forward(FFT_SIZE);
        Self {
            window: hann_window(FFT_SIZE),
            windowed: vec![0.0; FFT_SIZE],
            spectrum: fft.make_output_vec(),
            scratch: fft.make_scratch_vec(),
            fft,
        }
    }

    pub fn compute_into(&mut self, samples: &[f32], bins: &mut [f32; NUM_BINS]) {
        if samples.len() < FFT_SIZE {
            bins.fill(-100.0);
            return;
        }

        for ((out, sample), weight) in self.windowed.iter_mut().zip(samples).zip(&self.window) {
            *out = sample * weight;
        }
        if self
            .fft
            .process_with_scratch(&mut self.windowed, &mut self.spectrum, &mut self.scratch)
            .is_err()
        {
            bins.fill(-100.0);
            return;
        }

        // Convert to dB magnitude
        let scale = 2.0 / FFT_SIZE as f32;
        for (bin, c) in bins.iter_mut().zip(&self.spectrum) {
                let magnitude = c.norm() * scale;
                *bin = if magnitude > 1e-10 {
                    20.0 * magnitude.log10()
                } else {
                    -100.0
                };
        }
    }

    #[cfg(test)]
    fn compute(&mut self, samples: &[f32]) -> Vec<f32> {
        let mut bins = [-100.0; NUM_BINS];
        self.compute_into(samples, &mut bins);
        bins.to_vec()
    }
}

/// Downmix interleaved stereo to mono by averaging channels.
#[cfg(test)]
pub fn downmix_to_mono(interleaved: &[f32], channels: u16) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    let ch = channels as usize;
    let frames = interleaved.len() / ch;
    let mut mono = Vec::with_capacity(frames);
    for i in 0..frames {
        let mut sum = 0.0f32;
        for c in 0..ch {
            sum += interleaved[i * ch + c];
        }
        mono.push(sum / ch as f32);
    }
    mono
}

#[cfg(test)]
mod tests {
    use super::*;

    fn compute_fft(samples: &[f32]) -> Vec<f32> {
        FftProcessor::new().compute(samples)
    }

    #[test]
    fn reused_fft_has_no_history_and_matches_fresh_processing() {
        let mut processor = FftProcessor::new();
        for frequency in [1000.0, 4000.0, 0.0, 250.0] {
            let samples: Vec<f32> = (0..FFT_SIZE)
                .map(|i| (2.0 * PI * frequency * i as f32 / 48000.0).sin())
                .collect();
            let expected = compute_fft(&samples);
            let actual = processor.compute(&samples);
            assert_eq!(actual, expected);
        }
    }

    #[test]
    fn fft_of_silence_is_low_db() {
        let samples = vec![0.0f32; FFT_SIZE];
        let bins = compute_fft(&samples);
        assert_eq!(bins.len(), NUM_BINS);
        for &db in &bins {
            assert!(
                db <= -90.0,
                "silence should produce very low dB, got {}",
                db
            );
        }
    }

    #[test]
    fn fft_of_1khz_sine_peaks_at_correct_bin() {
        let sample_rate = 44100.0;
        let freq = 1000.0;
        let samples: Vec<f32> = (0..FFT_SIZE)
            .map(|i| (2.0 * PI * freq * i as f32 / sample_rate).sin())
            .collect();
        let bins = compute_fft(&samples);

        // Expected bin: freq / (sample_rate / FFT_SIZE) = 1000 / (44100/2048) ≈ 46.4
        let expected_bin = (freq / (sample_rate / FFT_SIZE as f32)).round() as usize;
        let peak_bin = bins
            .iter()
            .enumerate()
            .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap())
            .unwrap()
            .0;

        assert!(
            (peak_bin as i32 - expected_bin as i32).unsigned_abs() <= 2,
            "peak should be near bin {}, got {}",
            expected_bin,
            peak_bin
        );
    }

    #[test]
    fn downmix_stereo_to_mono() {
        let stereo = vec![1.0f32, 0.0, 0.0, 1.0, 0.5, 0.5];
        let mono = downmix_to_mono(&stereo, 2);
        assert_eq!(mono.len(), 3);
        assert!((mono[0] - 0.5).abs() < 1e-5);
        assert!((mono[1] - 0.5).abs() < 1e-5);
        assert!((mono[2] - 0.5).abs() < 1e-5);
    }

    #[test]
    fn short_input_returns_low_db() {
        let samples = vec![0.5f32; 100]; // Less than FFT_SIZE
        let bins = compute_fft(&samples);
        assert_eq!(bins.len(), NUM_BINS);
        for &db in &bins {
            assert!(db <= -90.0);
        }
    }
}
