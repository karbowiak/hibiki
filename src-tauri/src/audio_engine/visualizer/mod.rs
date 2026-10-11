//! Visualizer — FFT frequency analysis and time-domain sample delivery.
//!
//! The audio callback sends raw PCM chunks via a lock-free channel.
//! The visualizer task accumulates them into a rolling buffer, computes
//! FFT at ~60fps, and emits VisFrame events to JS.

pub mod fft;

use self::fft::{downmix_to_mono, FftProcessor, FFT_SIZE};

/// Processes audio samples for visualizer output.
///
/// Accumulates interleaved PCM into a rolling buffer. When enough
/// samples are present (≥ FFT_SIZE mono frames), computes FFT and
/// returns time-domain + frequency-domain data for the JS event.
pub struct VisualizerProcessor {
    /// Rolling sample buffer (interleaved, same format as audio output).
    buffer: Vec<f32>,
    /// Number of interleaved channels.
    channels: u16,
    /// Max buffer size — keeps the last N samples to bound memory.
    max_samples: usize,
    fft: FftProcessor,
}

impl VisualizerProcessor {
    pub fn new(channels: u16) -> Self {
        // Keep enough for 2x FFT_SIZE mono frames (gives us headroom)
        let max_samples = FFT_SIZE * 2 * channels.max(1) as usize;
        Self {
            buffer: Vec::with_capacity(max_samples),
            channels,
            max_samples,
            fft: FftProcessor::new(),
        }
    }

    /// Push new interleaved PCM samples into the rolling buffer.
    pub fn push_samples(&mut self, samples: &[f32]) {
        self.buffer.extend_from_slice(samples);
        // Trim from the front if we've exceeded max size
        if self.buffer.len() > self.max_samples {
            let excess = self.buffer.len() - self.max_samples;
            self.buffer.drain(..excess);
        }
    }

    /// Compute FFT from the accumulated buffer.
    /// Returns `(time_domain_samples, frequency_bins)` or `None` if not enough data.
    pub fn compute(&mut self) -> Option<(Vec<f32>, Vec<f32>)> {
        let ch = self.channels.max(1) as usize;
        let min_interleaved = FFT_SIZE * ch;

        if self.buffer.len() < min_interleaved {
            return None;
        }

        // Downmix to mono
        let mono = downmix_to_mono(&self.buffer, self.channels);

        // Take the last FFT_SIZE mono samples
        let start = mono.len().saturating_sub(FFT_SIZE);
        let window = &mono[start..start + FFT_SIZE.min(mono.len() - start)];

        // Time-domain samples (for JS waveform/oscilloscope display)
        let time_domain = window.to_vec();

        // Frequency-domain bins (dB)
        let bins = self.fft.compute(window);

        Some((time_domain, bins))
    }
}
