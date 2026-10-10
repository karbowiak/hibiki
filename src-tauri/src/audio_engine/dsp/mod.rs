//! DSP processing chain.
//!
//! Blocks are processed in order: preamp → equalizer → postgain → limiter → volume.
//! Each block can be independently enabled/disabled.

pub mod biquad;
pub mod equalizer;
pub mod limiter;
pub mod postgain;
pub mod preamp;
pub mod traits;
pub mod volume;

use self::equalizer::{Equalizer, NUM_BANDS};
use self::limiter::Limiter;
use self::postgain::Postgain;
use self::preamp::Preamp;
use self::volume::Volume;

fn gain_from_db(db: f32) -> f32 {
    10.0_f32.powf(
        if db.is_finite() {
            db.clamp(-24.0, 24.0)
        } else {
            0.0
        } / 20.0,
    )
}

fn apply_gain(samples: &mut [f32], gain: f32) {
    for sample in samples {
        let value = *sample * gain;
        *sample = if value.is_finite() { value } else { 0.0 };
    }
}

/// The complete DSP chain for the audio engine.
///
/// Unlike the JS engine which uses a dynamic list of DSPBlock trait objects,
/// we use concrete types here for zero-cost abstraction — the audio thread
/// processes these per-sample and they must be as fast as possible.
pub struct DspChain {
    pub preamp: Preamp,
    pub equalizer: Equalizer,
    pub postgain: Postgain,
    pub limiter: Limiter,
    pub volume: Volume,
}

impl DspChain {
    pub fn new(sample_rate: u32) -> Self {
        Self {
            preamp: Preamp::new(),
            equalizer: Equalizer::new(sample_rate),
            postgain: Postgain::new(),
            limiter: Limiter::new(sample_rate),
            volume: Volume::new(),
        }
    }

    /// Process a buffer of interleaved f32 samples through the entire chain.
    pub fn process(&mut self, samples: &mut [f32], sample_rate: u32, channels: u16) {
        use traits::DspBlock;
        for sample in samples.iter_mut() {
            if !sample.is_finite() {
                *sample = 0.0;
            }
        }
        self.preamp.process(samples, sample_rate, channels);
        self.equalizer.process(samples, sample_rate, channels);
        self.postgain.process(samples, sample_rate, channels);
        self.limiter.process(samples, sample_rate, channels);
        self.volume.process(samples, sample_rate, channels);
    }

    /// Update sample rate on all blocks that need it.
    pub fn set_sample_rate(&mut self, rate: u32) {
        self.equalizer.set_sample_rate(rate);
        self.limiter.set_sample_rate(rate);
    }

    /// Reset all stateful blocks (call on seek / track change).
    pub fn reset(&mut self) {
        self.equalizer.reset();
        self.limiter.reset();
    }

    // -- Convenience setters that match the JS engine API --

    pub fn set_preamp_db(&mut self, db: f32) {
        self.preamp.set_gain_db(db);
    }

    pub fn set_eq_enabled(&mut self, enabled: bool) {
        use traits::DspBlock;
        self.equalizer.set_enabled(enabled);
        self.postgain.set_enabled(enabled);
    }

    pub fn set_eq_gains(&mut self, gains_db: &[f32; NUM_BANDS]) {
        self.equalizer.set_gains(gains_db);
    }

    pub fn set_postgain_db(&mut self, db: f32) {
        self.postgain.set_gain_db(db);
    }

    pub fn set_volume(&mut self, gain: f32) {
        self.volume.set_gain(gain);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_chain_passthrough_at_defaults() {
        let mut chain = DspChain::new(44100);
        let mut samples = vec![0.5f32, -0.5, 0.3, -0.3, 0.1, -0.1];
        let orig = samples.clone();
        chain.process(&mut samples, 44100, 2);
        // At defaults (all flat, EQ disabled), output should equal input
        assert_eq!(samples, orig);
    }

    #[test]
    fn volume_at_half_halves_output() {
        let mut chain = DspChain::new(44100);
        chain.set_volume(0.5);
        let mut samples = vec![1.0f32, -1.0];
        chain.process(&mut samples, 44100, 2);
        assert!((samples[0] - 0.5).abs() < 1e-5);
        assert!((samples[1] - -0.5).abs() < 1e-5);
    }

    #[test]
    fn volume_at_zero_silences() {
        let mut chain = DspChain::new(44100);
        chain.set_volume(0.0);
        let mut samples = vec![1.0f32, -1.0, 0.5, -0.5];
        chain.process(&mut samples, 44100, 2);
        for s in &samples {
            assert_eq!(*s, 0.0);
        }
    }

    #[test]
    fn corrupt_controls_and_pcm_cannot_poison_later_playback() {
        let mut chain = DspChain::new(48000);
        chain.set_eq_enabled(true);
        chain.set_preamp_db(f32::NAN);
        chain.set_postgain_db(f32::INFINITY);
        chain.set_eq_gains(&[f32::NAN; NUM_BANDS]);
        chain.set_volume(f32::NAN);
        let mut corrupt = [f32::NAN, f32::INFINITY, f32::NEG_INFINITY, f32::NAN];
        chain.process(&mut corrupt, 48000, 2);
        assert_eq!(corrupt, [0.0; 4]);

        chain.set_volume(1.0);
        chain.set_preamp_db(3.0);
        chain.set_postgain_db(-3.0);
        let gains = [6.0, 3.0, 0.0, -2.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
        chain.set_eq_gains(&gains);
        let mut reference = DspChain::new(48000);
        reference.set_eq_enabled(true);
        reference.set_eq_gains(&gains);
        reference.set_preamp_db(3.0);
        reference.set_postgain_db(-3.0);
        let mut audio = vec![0.1, -0.1].repeat(2400);
        let mut expected = audio.clone();
        chain.process(&mut audio, 48000, 2);
        reference.process(&mut expected, 48000, 2);
        assert!(audio
            .iter()
            .zip(expected)
            .all(|(a, b)| a.is_finite() && (*a - b).abs() < 1e-6));
        assert!(audio.iter().any(|sample| sample.abs() > 0.05));
    }

    #[test]
    fn excessive_finite_gains_and_samples_never_overflow_the_chain() {
        for db in [
            f32::MAX,
            -f32::MAX,
            f32::INFINITY,
            f32::NEG_INFINITY,
            f32::NAN,
        ] {
            let mut chain = DspChain::new(48000);
            chain.set_eq_enabled(true);
            chain.set_eq_gains(&[db; NUM_BANDS]);
            chain.set_preamp_db(db);
            chain.set_postgain_db(db);
            let mut audio = [f32::MAX, -f32::MAX, 0.1, -0.1, 0.0, 0.0];
            chain.process(&mut audio, 48000, 2);
            assert!(audio.iter().all(|sample| sample.is_finite()));
            chain.set_eq_enabled(false);
            chain.set_preamp_db(0.0);
            chain.set_postgain_db(0.0);
            chain.reset();
            let mut audio = [0.2, -0.2];
            chain.process(&mut audio, 48000, 2);
            assert_eq!(audio, [0.2, -0.2]);
        }
    }

    #[test]
    fn resetting_after_a_loud_signal_clears_compressor_reduction() {
        let mut chain = DspChain::new(48000);
        chain.process(&mut vec![16.0; 96000], 48000, 1);
        chain.reset();
        let mut quiet = [0.1; 128];
        chain.process(&mut quiet, 48000, 1);
        assert_eq!(quiet, [0.1; 128]);
    }

    #[test]
    fn eq_disabled_never_applies_makeup_gain_and_enable_restores_it() {
        let mut chain = DspChain::new(48000);
        chain.set_postgain_db(6.0);
        let mut disabled = [0.1; 128];
        chain.process(&mut disabled, 48000, 2);
        assert_eq!(disabled, [0.1; 128]);
        chain.set_eq_enabled(true);
        let mut enabled = [0.1; 128];
        chain.process(&mut enabled, 48000, 2);
        assert!(enabled
            .iter()
            .all(|sample| (*sample - 0.1 * 10.0_f32.powf(6.0 / 20.0)).abs() < 1e-6));
        chain.set_eq_enabled(false);
        let mut disabled_again = [0.1; 128];
        chain.process(&mut disabled_again, 48000, 2);
        assert_eq!(disabled_again, disabled);
        chain.set_eq_enabled(true);
        let mut enabled_again = [0.1; 128];
        chain.process(&mut enabled_again, 48000, 2);
        assert_eq!(enabled_again, enabled);
    }
}
