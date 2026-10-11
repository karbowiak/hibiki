//! 10-band parametric EQ matching the JS engine's BiquadFilterNode configuration.
//!
//! Bands: 32, 64, 125, 250, 500, 1K, 2K, 4K, 8K, 16K Hz
//! Types: lowshelf (32Hz), peaking (64-8000Hz), highshelf (16kHz)
//! Q values: 0.7 (shelves), 1.4 (peaking)

use super::biquad::{BiquadFilter, BiquadType};
use super::traits::DspBlock;

pub const NUM_BANDS: usize = 10;

const EQ_FREQS: [f64; NUM_BANDS] = [
    32.0, 64.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0,
];

pub struct Equalizer {
    enabled: bool,
    filters: [BiquadFilter; NUM_BANDS],
    gains_db: [f32; NUM_BANDS],
}

impl Equalizer {
    /// Compensate the peak response of the complete cascade, including band
    /// overlap and shelf responses. Preparation runs outside the audio callback.
    pub fn auto_postgain_db(gains_db: &[f32; NUM_BANDS], sample_rate: u32) -> f32 {
        let mut eq = Self::new(sample_rate);
        eq.set_enabled(true);
        eq.set_gains(gains_db);
        let response = |frequency: f64| {
            let omega = 2.0 * std::f64::consts::PI * frequency / f64::from(sample_rate.max(1));
            let (sin, cos) = omega.sin_cos();
            let power: f64 = eq
                .filters
                .iter()
                .map(|filter| filter.response_power(cos, sin))
                .product();
            10.0 * power.log10()
        };
        let nyquist = f64::from(sample_rate) / 2.0;
        let mut peak = response(0.0).max(response(nyquist)).max(0.0);
        // A dense logarithmic grid resolves the fixed Q=1.4 bands at both low
        // and high rates; also include every exact band center.
        let low = 0.1_f64.min(nyquist.max(0.1));
        for index in 0..=4096 {
            let frequency = low * (nyquist.max(low) / low).powf(f64::from(index) / 4096.0);
            peak = peak.max(response(frequency));
        }
        for frequency in EQ_FREQS {
            if frequency < nyquist {
                peak = peak.max(response(frequency));
            }
        }
        if peak <= 0.001 {
            0.0
        } else {
            -(peak as f32 + 0.05)
        }
    }

    pub fn new(sample_rate: u32) -> Self {
        let filters = std::array::from_fn(|i| {
            let (ftype, q) = match i {
                0 => (BiquadType::Lowshelf, 0.7),
                9 => (BiquadType::Highshelf, 0.7),
                _ => (BiquadType::Peaking, 1.4),
            };
            BiquadFilter::new(ftype, EQ_FREQS[i], q, sample_rate)
        });
        Self {
            enabled: false,
            filters,
            gains_db: [0.0; NUM_BANDS],
        }
    }

    /// Set all 10 band gains at once (in dB).
    pub fn set_gains(&mut self, gains_db: &[f32; NUM_BANDS]) {
        self.gains_db = gains_db.map(|db| {
            if db.is_finite() {
                db.clamp(-12.0, 12.0)
            } else {
                0.0
            }
        });
        self.apply_gains();
    }

    fn apply_gains(&mut self) {
        for (filter, &db) in self.filters.iter_mut().zip(self.gains_db.iter()) {
            filter.set_gain_db(if self.enabled { db as f64 } else { 0.0 });
        }
    }

    /// Update sample rate on all filters (e.g., when output device changes).
    pub fn set_sample_rate(&mut self, rate: u32) {
        for f in &mut self.filters {
            f.set_sample_rate(rate);
        }
    }

    /// Reset all filter states (call on track change or seek).
    pub fn reset(&mut self) {
        for f in &mut self.filters {
            f.reset();
        }
    }
}

impl DspBlock for Equalizer {
    fn set_enabled(&mut self, enabled: bool) {
        if self.enabled == enabled {
            return;
        }
        self.enabled = enabled;
        self.reset();
        self.apply_gains();
    }

    fn process(&mut self, samples: &mut [f32], _sample_rate: u32, channels: u16) {
        if !self.enabled {
            return;
        }
        for filter in &mut self.filters {
            filter.process(samples, channels);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn automatic_headroom_accounts_for_overlapping_filters_in_actual_pcm() {
        let rate = 48000;
        let gains = [8.0, 6.0, 4.0, 2.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
        let compensation = Equalizer::auto_postgain_db(&gains, rate);
        assert!(
            compensation < -8.0,
            "Adjacent bands require additional headroom: {compensation}"
        );
        for frequency in [20.0, 32.0, 50.0, 64.0, 125.0, 250.0, 1000.0, 20000.0] {
            let mut eq = Equalizer::new(rate);
            eq.set_enabled(true);
            eq.set_gains(&gains);
            let mut samples: Vec<f32> = (0..rate * 2)
                .map(|frame| {
                    (2.0 * std::f64::consts::PI * frequency * f64::from(frame) / f64::from(rate))
                        .sin() as f32
                        * 0.1
                })
                .collect();
            let original: f64 = samples[rate as usize..]
                .iter()
                .map(|sample| f64::from(*sample).powi(2))
                .sum();
            eq.process(&mut samples, rate, 1);
            let scale = 10.0_f64.powf(f64::from(compensation) / 20.0);
            let compensated: f64 = samples[rate as usize..]
                .iter()
                .map(|sample| (f64::from(*sample) * scale).powi(2))
                .sum();
            assert!(
                compensated <= original * 1.001,
                "EQ adds gain at {frequency} Hz despite compensation"
            );
        }
    }

    #[test]
    fn automatic_headroom_is_flat_for_bypass_bands_and_never_adds_makeup_gain() {
        for rate in [0, 8000, 44100, 48000, 96000, 192000] {
            assert_eq!(Equalizer::auto_postgain_db(&[0.0; 10], rate), 0.0);
            let gain = Equalizer::auto_postgain_db(&[12.0; 10], rate);
            assert!(
                gain.is_finite() && gain <= 0.0 && gain >= -24.0,
                "Unrepresentable compensation: {gain} at {rate}"
            );
            assert!(Equalizer::auto_postgain_db(&[-12.0; 10], rate) <= 0.0);
            assert_eq!(Equalizer::auto_postgain_db(&[f32::NAN; 10], rate), 0.0);
        }
        let mut gains = [0.0; 10];
        gains[9] = 12.0;
        assert_eq!(Equalizer::auto_postgain_db(&gains, 8000), 0.0);
        assert!(Equalizer::auto_postgain_db(&gains, 48000) < -12.0);
    }

    #[test]
    fn flat_eq_is_near_passthrough() {
        let mut eq = Equalizer::new(44100);
        eq.set_enabled(true);
        eq.set_gains(&[0.0; NUM_BANDS]);

        // Generate 1 second of white-ish noise
        let n = 44100;
        let mut samples: Vec<f32> = (0..n)
            .map(|i| ((i * 7919) % 1000) as f32 / 500.0 - 1.0)
            .collect();
        let orig = samples.clone();
        eq.process(&mut samples, 44100, 1);

        // Allow small numerical difference from filter processing
        let max_diff: f32 = samples
            .iter()
            .zip(orig.iter())
            .map(|(a, b)| (a - b).abs())
            .fold(0.0f32, f32::max);
        assert!(
            max_diff < 0.01,
            "flat EQ should be near-passthrough, max_diff={}",
            max_diff
        );
    }

    #[test]
    fn disabled_is_passthrough() {
        let mut eq = Equalizer::new(44100);
        eq.set_enabled(false);
        eq.set_gains(&[12.0; NUM_BANDS]); // gains set but disabled

        let mut samples = vec![0.5f32, -0.5, 0.3, -0.3];
        let orig = samples.clone();
        eq.process(&mut samples, 44100, 2);
        assert_eq!(samples, orig);
    }

    #[test]
    fn bass_boost_increases_low_frequency_energy() {
        let mut eq = Equalizer::new(44100);
        eq.set_enabled(true);
        let mut gains = [0.0f32; NUM_BANDS];
        gains[0] = 12.0; // 32Hz lowshelf +12dB
        gains[1] = 12.0; // 64Hz +12dB
        eq.set_gains(&gains);

        // Generate low frequency sine (50Hz)
        let n = 44100;
        let mut samples: Vec<f32> = (0..n)
            .map(|i| (2.0 * std::f32::consts::PI * 50.0 * i as f32 / 44100.0).sin())
            .collect();
        let orig_energy: f32 = samples.iter().map(|s| s * s).sum();
        eq.process(&mut samples, 44100, 1);
        let boosted_energy: f32 = samples.iter().map(|s| s * s).sum();
        assert!(
            boosted_energy > orig_energy * 2.0,
            "bass boost should increase 50Hz energy"
        );
    }

    #[test]
    fn out_of_band_controls_are_bypassed_until_the_output_rate_can_represent_them() {
        let mut eq = Equalizer::new(8000);
        eq.set_enabled(true);
        let mut gains = [0.0; NUM_BANDS];
        gains[7] = 12.0;
        gains[8] = -12.0;
        gains[9] = 12.0;
        eq.set_gains(&gains);
        let mut noise: Vec<f32> = (0..16000)
            .map(|i| ((i * 7919) % 1000) as f32 / 5000.0 - 0.1)
            .collect();
        let expected = noise.clone();
        eq.process(&mut noise, 8000, 1);
        assert_eq!(noise, expected);

        gains[7] = 0.0;
        gains[8] = 0.0;
        eq.set_gains(&gains);
        eq.set_sample_rate(48000);
        let mut high: Vec<f32> = (0..4800)
            .map(|i| (2.0 * std::f32::consts::PI * 20000.0 * i as f32 / 48000.0).sin() * 0.1)
            .collect();
        let energy: f32 = high.iter().map(|sample| sample * sample).sum();
        eq.process(&mut high, 48000, 1);
        assert!(high.iter().all(|sample| sample.is_finite()));
        assert!(high.iter().map(|sample| sample * sample).sum::<f32>() > energy * 2.0);
    }

    #[test]
    fn presets_set_while_disabled_survive_enable_and_repeated_toggles() {
        let gains = [6.0; NUM_BANDS];
        let mut eq = Equalizer::new(48000);
        eq.set_gains(&gains);
        eq.set_enabled(true);
        let mut reference = Equalizer::new(48000);
        reference.set_enabled(true);
        reference.set_gains(&gains);
        let input: Vec<f32> = (0..1000).map(|i| (i % 101) as f32 / 1000.0).collect();
        let mut expected = input.clone();
        reference.process(&mut expected, 48000, 1);
        for _ in 0..3 {
            let mut actual = input.clone();
            eq.process(&mut actual, 48000, 1);
            assert_eq!(actual, expected);
            eq.set_enabled(false);
            let mut bypass = input.clone();
            eq.process(&mut bypass, 48000, 1);
            assert_eq!(bypass, input);
            eq.set_enabled(true);
        }
    }
}
