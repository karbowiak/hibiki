//! Biquad IIR filter — the building block for the parametric EQ.
//!
//! Supports lowshelf, highshelf, and peaking filter types.
//! Coefficient formulas from the Audio EQ Cookbook (Robert Bristow-Johnson).

use std::f64::consts::PI;

/// Filter type matching the JS engine's BiquadFilterNode types.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum BiquadType {
    Lowshelf,
    Highshelf,
    Peaking,
}

/// Coefficients for a biquad filter (normalized so a0 = 1).
#[derive(Debug, Clone, Copy)]
struct Coefficients {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
}

const IDENTITY: Coefficients = Coefficients {
    b0: 1.0,
    b1: 0.0,
    b2: 0.0,
    a1: 0.0,
    a2: 0.0,
};
pub const MAX_CHANNELS: usize = 32;

/// Per-channel delay state for the Direct Form II Transposed implementation.
#[derive(Debug, Clone, Copy, Default)]
struct ChannelState {
    z1: f64,
    z2: f64,
}

/// A single biquad IIR filter with per-channel state.
///
/// Each supported output channel has its own delay state.
#[derive(Debug, Clone)]
pub struct BiquadFilter {
    filter_type: BiquadType,
    frequency: f64,
    q: f64,
    gain_db: f64,
    sample_rate: f64,
    coeffs: Coefficients,
    state: [ChannelState; MAX_CHANNELS],
}

impl BiquadFilter {
    pub fn new(filter_type: BiquadType, frequency: f64, q: f64, sample_rate: u32) -> Self {
        let mut f = Self {
            filter_type,
            frequency,
            q,
            gain_db: 0.0,
            sample_rate: sample_rate as f64,
            coeffs: IDENTITY,
            state: [ChannelState::default(); MAX_CHANNELS],
        };
        f.compute_coefficients();
        f
    }

    /// Set the gain in dB and recompute coefficients.
    pub fn set_gain_db(&mut self, db: f64) {
        let db = if db.is_finite() {
            db.clamp(-12.0, 12.0)
        } else {
            0.0
        };
        if (self.gain_db - db).abs() < 1e-9 {
            return;
        }
        self.gain_db = db;
        self.compute_coefficients();
    }

    /// Update sample rate (e.g., when device changes). Recomputes coefficients.
    pub fn set_sample_rate(&mut self, rate: u32) {
        let r = rate as f64;
        if (self.sample_rate - r).abs() < 1e-9 {
            return;
        }
        self.sample_rate = r;
        self.compute_coefficients();
        self.reset();
    }

    /// Reset filter state (call on seek or track change to prevent transients).
    pub fn reset(&mut self) {
        self.state = [ChannelState::default(); MAX_CHANNELS];
    }

    /// Process interleaved samples in-place.
    pub fn process(&mut self, samples: &mut [f32], channels: u16) {
        let ch = channels as usize;
        if ch == 0 || ch > MAX_CHANNELS {
            samples.fill(0.0);
            return;
        }
        let c = &self.coeffs;

        let complete = samples.len() / ch * ch;
        samples[complete..].fill(0.0);
        for frame in samples[..complete].chunks_exact_mut(ch) {
            for (sample, s) in frame.iter_mut().zip(&mut self.state) {
                if !sample.is_finite() {
                    *sample = 0.0;
                    *s = ChannelState::default();
                    continue;
                }
                let x = f64::from(*sample);

                // Direct Form II Transposed
                let y = c.b0 * x + s.z1;
                let z1 = c.b1 * x - c.a1 * y + s.z2;
                let z2 = c.b2 * x - c.a2 * y;
                let output = y as f32;
                if output.is_finite() && z1.is_finite() && z2.is_finite() {
                    s.z1 = z1;
                    s.z2 = z2;
                    *sample = output;
                } else {
                    *sample = 0.0;
                    *s = ChannelState::default();
                }
            }
        }
    }

    /// Compute biquad coefficients from the Audio EQ Cookbook.
    fn compute_coefficients(&mut self) {
        // Bands outside the representable spectrum must not wrap into unstable poles.
        if self.sample_rate <= 0.0
            || !self.frequency.is_finite()
            || self.frequency <= 0.0
            || self.frequency >= self.sample_rate / 2.0
            || !self.q.is_finite()
            || self.q <= 0.0
            || self.gain_db == 0.0
        {
            self.coeffs = IDENTITY;
            self.reset();
            return;
        }
        let w0 = 2.0 * PI * self.frequency / self.sample_rate;
        let cos_w0 = w0.cos();
        let sin_w0 = w0.sin();
        let alpha = sin_w0 / (2.0 * self.q);

        let (b0, b1, b2, a0, a1, a2) = match self.filter_type {
            BiquadType::Peaking => {
                let a = 10.0_f64.powf(self.gain_db / 40.0);
                let b0 = 1.0 + alpha * a;
                let b1 = -2.0 * cos_w0;
                let b2 = 1.0 - alpha * a;
                let a0 = 1.0 + alpha / a;
                let a1 = -2.0 * cos_w0;
                let a2 = 1.0 - alpha / a;
                (b0, b1, b2, a0, a1, a2)
            }
            BiquadType::Lowshelf => {
                let a = 10.0_f64.powf(self.gain_db / 40.0);
                let two_sqrt_a_alpha = 2.0 * a.sqrt() * alpha;
                let b0 = a * ((a + 1.0) - (a - 1.0) * cos_w0 + two_sqrt_a_alpha);
                let b1 = 2.0 * a * ((a - 1.0) - (a + 1.0) * cos_w0);
                let b2 = a * ((a + 1.0) - (a - 1.0) * cos_w0 - two_sqrt_a_alpha);
                let a0 = (a + 1.0) + (a - 1.0) * cos_w0 + two_sqrt_a_alpha;
                let a1 = -2.0 * ((a - 1.0) + (a + 1.0) * cos_w0);
                let a2 = (a + 1.0) + (a - 1.0) * cos_w0 - two_sqrt_a_alpha;
                (b0, b1, b2, a0, a1, a2)
            }
            BiquadType::Highshelf => {
                let a = 10.0_f64.powf(self.gain_db / 40.0);
                let two_sqrt_a_alpha = 2.0 * a.sqrt() * alpha;
                let b0 = a * ((a + 1.0) + (a - 1.0) * cos_w0 + two_sqrt_a_alpha);
                let b1 = -2.0 * a * ((a - 1.0) + (a + 1.0) * cos_w0);
                let b2 = a * ((a + 1.0) + (a - 1.0) * cos_w0 - two_sqrt_a_alpha);
                let a0 = (a + 1.0) - (a - 1.0) * cos_w0 + two_sqrt_a_alpha;
                let a1 = 2.0 * ((a - 1.0) - (a + 1.0) * cos_w0);
                let a2 = (a + 1.0) - (a - 1.0) * cos_w0 - two_sqrt_a_alpha;
                (b0, b1, b2, a0, a1, a2)
            }
        };

        // Normalize so a0 = 1
        self.coeffs = Coefficients {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
        };
        if ![
            self.coeffs.b0,
            self.coeffs.b1,
            self.coeffs.b2,
            self.coeffs.a1,
            self.coeffs.a2,
        ]
        .iter()
        .all(|c| c.is_finite())
        {
            self.coeffs = IDENTITY;
            self.reset();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peaking_flat_is_passthrough() {
        let mut f = BiquadFilter::new(BiquadType::Peaking, 1000.0, 1.4, 44100);
        f.set_gain_db(0.0);
        let mut samples = vec![1.0f32, 0.5, -0.3, 0.8, 0.0, -1.0];
        let orig = samples.clone();
        f.process(&mut samples, 2);
        for (a, b) in samples.iter().zip(orig.iter()) {
            assert!((a - b).abs() < 1e-5, "flat peaking should be passthrough");
        }
    }

    #[test]
    fn lowshelf_flat_is_passthrough() {
        let mut f = BiquadFilter::new(BiquadType::Lowshelf, 32.0, 0.7, 44100);
        f.set_gain_db(0.0);
        let mut samples = vec![0.5f32, -0.5, 0.3, -0.3];
        let orig = samples.clone();
        f.process(&mut samples, 2);
        for (a, b) in samples.iter().zip(orig.iter()) {
            assert!((a - b).abs() < 1e-5, "flat lowshelf should be passthrough");
        }
    }

    #[test]
    fn highshelf_flat_is_passthrough() {
        let mut f = BiquadFilter::new(BiquadType::Highshelf, 16000.0, 0.7, 44100);
        f.set_gain_db(0.0);
        let mut samples = vec![0.5f32, -0.5, 0.3, -0.3];
        let orig = samples.clone();
        f.process(&mut samples, 2);
        for (a, b) in samples.iter().zip(orig.iter()) {
            assert!((a - b).abs() < 1e-5, "flat highshelf should be passthrough");
        }
    }

    #[test]
    fn peaking_boost_changes_signal() {
        let mut f = BiquadFilter::new(BiquadType::Peaking, 1000.0, 1.4, 44100);
        f.set_gain_db(12.0);
        // Generate a 1kHz sine at 44100Hz — 44 samples per cycle
        let n = 4410; // 100ms
        let mut samples: Vec<f32> = (0..n)
            .map(|i| (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / 44100.0).sin())
            .collect();
        let orig_energy: f32 = samples.iter().map(|s| s * s).sum();
        f.process(&mut samples, 1);
        let boosted_energy: f32 = samples.iter().map(|s| s * s).sum();
        assert!(
            boosted_energy > orig_energy * 2.0,
            "12dB boost at center freq should increase energy significantly"
        );
    }

    #[test]
    fn reset_clears_state() {
        let mut f = BiquadFilter::new(BiquadType::Peaking, 1000.0, 1.4, 44100);
        f.set_gain_db(6.0);
        let mut buf = vec![1.0f32; 100];
        f.process(&mut buf, 1);
        f.reset();
        assert_eq!(f.state[0].z1, 0.0);
        assert_eq!(f.state[0].z2, 0.0);
    }

    #[test]
    fn corrupt_samples_and_gain_do_not_leave_a_channel_permanently_silent() {
        let mut filter = BiquadFilter::new(BiquadType::Peaking, 1000.0, 1.4, 48000);
        filter.set_gain_db(6.0);
        let mut corrupt = [f32::NAN, 0.1, f32::INFINITY, 0.1];
        filter.process(&mut corrupt, 2);
        assert_eq!(corrupt[0], 0.0);
        assert_eq!(corrupt[2], 0.0);
        let mut later = [0.1; 128];
        filter.process(&mut later, 2);
        assert!(later.iter().all(|value| value.is_finite()));
        assert!(later.chunks_exact(2).any(|frame| frame[0] > 0.05));
        filter.set_gain_db(f64::NAN);
        let mut flat = [0.1; 128];
        filter.process(&mut flat, 2);
        assert_eq!(flat, [0.1; 128]);
    }

    #[test]
    fn all_output_channels_receive_independent_eq_processing() {
        let mut filter = BiquadFilter::new(BiquadType::Peaking, 1000.0, 1.4, 48000);
        filter.set_gain_db(12.0);
        let mut audio = vec![0.0; 32 * 1024];
        audio[..32].fill(0.1);
        filter.process(&mut audio, 32);
        for frame in audio.chunks_exact(32) {
            assert!(frame
                .iter()
                .all(|value| value.is_finite() && (*value - frame[0]).abs() < 1e-6));
        }
        filter.reset();
        audio.fill(0.0);
        audio[31] = 0.1;
        filter.process(&mut audio, 32);
        assert!(audio
            .chunks_exact(32)
            .all(|frame| frame[..31].iter().all(|value| *value == 0.0)));
        assert!(audio.chunks_exact(32).any(|frame| frame[31].abs() > 0.1));
    }
}
