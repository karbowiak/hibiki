//! Soft-knee dynamics compressor / limiter.
//!
//! Matches the WebKit DynamicsCompressorNode behaviour with the "safe" settings
//! that avoid crackling: threshold=-3dB, knee=6dB, ratio=4:1, attack=10ms, release=100ms.
//!
//! Implementation: feed-forward RMS-envelope compressor operating per-sample on
//! the peak of all channels. Gain reduction is applied equally to all channels
//! to preserve stereo image.

use super::traits::DspBlock;

pub struct Limiter {
    enabled: bool,
    threshold_db: f32,
    knee_db: f32,
    ratio: f32,
    attack_coeff: f32,
    release_coeff: f32,
    envelope_db: f32,
}

impl Limiter {
    pub fn is_enabled(&self) -> bool { self.enabled }

    pub fn new(sample_rate: u32) -> Self {
        let mut l = Self {
            enabled: true,
            threshold_db: -3.0,
            knee_db: 6.0,
            ratio: 4.0,
            attack_coeff: 0.0,
            release_coeff: 0.0,
            envelope_db: -96.0,
        };
        l.update_coefficients(sample_rate);
        l
    }

    pub fn set_sample_rate(&mut self, rate: u32) {
        self.update_coefficients(rate);
    }

    pub fn reset(&mut self) {
        self.envelope_db = -96.0;
    }

    fn update_coefficients(&mut self, sample_rate: u32) {
        let sr = sample_rate.max(1) as f32;
        // attack = 10ms, release = 100ms
        self.attack_coeff = (-1.0 / (0.010 * sr)).exp();
        self.release_coeff = (-1.0 / (0.100 * sr)).exp();
    }

    /// Compute gain reduction in dB for a given input level in dB.
    /// Uses soft-knee characteristic.
    fn compute_gain_reduction(&self, input_db: f32) -> f32 {
        let t = self.threshold_db;
        let k = self.knee_db;
        let r = self.ratio;
        let half_knee = k / 2.0;

        if input_db < t - half_knee {
            // Below knee — no compression
            0.0
        } else if input_db > t + half_knee {
            // Above knee — full compression
            (input_db - t) * (1.0 - 1.0 / r)
        } else {
            // In the knee — quadratic interpolation
            let x = input_db - t + half_knee;
            x * x * (1.0 - 1.0 / r) / (2.0 * k)
        }
    }
}

impl DspBlock for Limiter {
    fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }

    fn process(&mut self, samples: &mut [f32], _sample_rate: u32, channels: u16) {
        if !self.enabled {
            return;
        }
        if channels == 0 {
            samples.fill(0.0);
            return;
        }
        if !self.envelope_db.is_finite() {
            self.reset();
        }
        let ch = channels as usize;

        for frame_start in (0..samples.len()).step_by(ch) {
            // Find peak across channels for this frame
            let mut peak = 0.0f32;
            for c in 0..ch {
                let idx = frame_start + c;
                if idx < samples.len() {
                    if !samples[idx].is_finite() {
                        samples[idx] = 0.0;
                    }
                    peak = peak.max(samples[idx].abs());
                }
            }

            // Convert to dB (floor at -96dB to avoid log(0))
            let input_db = if peak > 1e-5 {
                20.0 * peak.log10()
            } else {
                -96.0
            };

            // Envelope follower (attack/release smoothing)
            let coeff = if input_db > self.envelope_db {
                self.attack_coeff
            } else {
                self.release_coeff
            };
            self.envelope_db = coeff * self.envelope_db + (1.0 - coeff) * input_db;

            // Compute and apply gain reduction
            let reduction_db = self.compute_gain_reduction(self.envelope_db);
            if reduction_db > 0.001 {
                let gain = 10.0_f32.powf(-reduction_db / 20.0);
                for c in 0..ch {
                    let idx = frame_start + c;
                    if idx < samples.len() {
                        samples[idx] *= gain;
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quiet_signal_passes_unmodified() {
        let mut l = Limiter::new(44100);
        // -20dB signal (well below -3dB threshold)
        let level = 10.0_f32.powf(-20.0 / 20.0); // 0.1
        let mut samples = vec![level, -level, level, -level];
        let orig = samples.clone();
        l.process(&mut samples, 44100, 2);
        for (a, b) in samples.iter().zip(orig.iter()) {
            assert!(
                (a - b).abs() < 0.01,
                "quiet signal should pass mostly unmodified"
            );
        }
    }

    #[test]
    fn loud_signal_is_attenuated() {
        let mut l = Limiter::new(44100);
        // 0dBFS signal — well above -3dB threshold
        let n = 4410; // 100ms to let envelope settle
        let mut samples = vec![1.0f32; n];
        l.process(&mut samples, 44100, 1);
        // After envelope settles, last samples should be attenuated
        let last = samples[n - 1];
        assert!(
            last < 0.9,
            "0dBFS signal should be attenuated, got {}",
            last
        );
    }

    #[test]
    fn disabled_is_passthrough() {
        let mut l = Limiter::new(44100);
        l.set_enabled(false);
        let mut samples = vec![1.0f32, -1.0, 0.5, -0.5];
        let orig = samples.clone();
        l.process(&mut samples, 44100, 2);
        assert_eq!(samples, orig);
    }

    #[test]
    fn soft_knee_gain_reduction() {
        let l = Limiter::new(44100);
        // Below knee: no reduction
        assert_eq!(l.compute_gain_reduction(-10.0), 0.0);
        // Well above threshold: significant reduction
        let red = l.compute_gain_reduction(10.0);
        assert!(
            red > 5.0,
            "10dB above threshold should have significant reduction, got {}",
            red
        );
    }
}
