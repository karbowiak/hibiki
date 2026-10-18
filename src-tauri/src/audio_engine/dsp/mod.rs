//! DSP processing chain.
//!
//! Blocks are processed in order: preamp → equalizer → postgain → limiter → volume.
//! Each block can be independently enabled/disabled.

pub mod biquad;
pub mod correction;
pub mod equalizer;
pub mod eq_scene;
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
use self::correction::PreparedCorrection;
use self::eq_scene::EqScene;

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
    correction: PreparedCorrection,
    previous_eq: Option<EqScene>,
    pending_eq: Option<(EqScene, u32)>,
    transition_frames: u32,
    transition_remaining: u32,
}

impl DspChain {
    pub fn new(sample_rate: u32) -> Self {
        Self {
            preamp: Preamp::new(),
            equalizer: Equalizer::new(sample_rate),
            postgain: Postgain::new(),
            limiter: Limiter::new(sample_rate),
            volume: Volume::new(),
            correction: PreparedCorrection::bypassed(sample_rate),
            previous_eq: None,
            pending_eq: None,
            transition_frames: 0,
            transition_remaining: 0,
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
        if self.transition_remaining == 0 {
            if let Some((scene, frames)) = self.pending_eq.take() { self.apply_prepared_eq(scene, frames); }
        }
        if self.transition_remaining > 0 {
            let channels_count = usize::from(channels);
            if channels_count == 0 || channels_count > biquad::MAX_CHANNELS { samples.fill(0.0); return }
            let complete = samples.len() / channels_count * channels_count;
            samples[complete..].fill(0.0);
            for frame in samples[..complete].chunks_exact_mut(channels_count) {
                let mut before = [0.0; biquad::MAX_CHANNELS];
                before[..channels_count].copy_from_slice(frame);
                self.correction.process(frame, channels);
                self.equalizer.process(frame, sample_rate, channels);
                self.postgain.process(frame, sample_rate, channels);
                if self.transition_remaining > 0 {
                    if let Some(previous) = &mut self.previous_eq {
                        previous.process(&mut before[..channels_count], sample_rate, channels);
                        let blend = 1.0 - self.transition_remaining as f32 / self.transition_frames.max(1) as f32;
                        for (sample, old) in frame.iter_mut().zip(before) { *sample = old + (*sample - old) * blend; }
                    }
                    self.transition_remaining -= 1;
                }
            }
            if self.transition_remaining == 0 { self.previous_eq = None; }
        } else {
            self.correction.process(samples, channels);
            self.equalizer.process(samples, sample_rate, channels);
            self.postgain.process(samples, sample_rate, channels);
        }
        self.limiter.process(samples, sample_rate, channels);
        self.volume.process(samples, sample_rate, channels);
    }

    /// Update sample rate on all blocks that need it.
    pub fn set_sample_rate(&mut self, rate: u32) {
        self.equalizer.set_sample_rate(rate);
        self.limiter.set_sample_rate(rate);
        self.bypass_eq(rate);
    }

    /// A new output cannot inherit the preceding output's tone/correction/gain.
    pub fn bypass_eq(&mut self, rate: u32) {
        use traits::DspBlock;
        self.equalizer.set_enabled(false);
        self.equalizer.reset();
        self.postgain = Postgain::new();
        // A configuration for another mixer rate is never reinterpreted. The
        // control side must prepare its correction again at the new rate.
        self.correction.bypass(rate);
        self.previous_eq = None;
        self.pending_eq = None;
        self.transition_remaining = 0;
    }

    /// Reset all stateful blocks (call on seek / track change).
    pub fn reset(&mut self) {
        self.equalizer.reset();
        self.limiter.reset();
        self.correction.reset();
        self.previous_eq = None;
        self.transition_remaining = 0;
    }

    // -- Convenience setters that match the JS engine API --

    /// Adopt prepared coefficients/gains together. Mid-ramp updates retain only
    /// the latest pending scene; restarting from a half-mixed filter would click.
    /// Fixed arrays keep adoption, deferral and retirement allocation-free.
    pub fn apply_prepared_eq(&mut self, scene: EqScene, transition_frames: u32) {
        if self.transition_remaining > 0 {
            self.pending_eq = Some((scene, transition_frames));
            return;
        }
        self.pending_eq = None;
        self.previous_eq = (transition_frames > 0).then(|| EqScene {
            tone: self.equalizer.clone(), correction: self.correction.clone(), gain: self.postgain.current_gain(),
        });
        self.equalizer = scene.tone;
        self.correction = scene.correction;
        self.postgain = Postgain::prepared(scene.gain);
        self.transition_frames = transition_frames;
        self.transition_remaining = transition_frames;
    }

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

    fn correction_scene(db: f64) -> EqScene {
        use correction::{Filter, FilterKind, Profile};
        EqScene::prepare([0.0;10],false,None,Some(&Profile {preamp_db:db,filters:vec![Filter {kind:FilterKind::Peak,frequency:1000.0,q:1.0,gain_db:0.0,enabled:true}]}),48000).unwrap().0
    }

    #[test]
    fn complete_prepared_eq_changes_ramp_without_an_instant_gain_step() {
        let mut chain = DspChain::new(48000);
        chain.apply_prepared_eq(correction_scene(-12.0), 480);
        let mut audio = vec![0.2;4096];
        chain.process(&mut audio,48000,2);
        assert!((audio[0]-0.2).abs()<1e-7);
        let expected=0.2*10.0_f32.powf(-12.0/20.0);
        assert!((audio[audio.len()-1]-expected).abs()<1e-7);
        assert!(audio.chunks_exact(2).all(|frame|frame[0]==frame[1]));
        assert!(audio.windows(3).step_by(2).all(|values|(values[2]-values[0]).abs()<0.001));
    }

    #[test]
    fn rapid_profile_changes_finish_the_current_ramp_then_adopt_only_the_latest_snapshot() {
        let mut chain=DspChain::new(48000);
        chain.apply_prepared_eq(correction_scene(-6.0),480);
        chain.process(&mut [0.2;320],48000,2);
        chain.apply_prepared_eq(correction_scene(-12.0),480);
        chain.apply_prepared_eq(correction_scene(-18.0),480);
        chain.process(&mut [0.2;1280],48000,2);
        let mut audio=[0.2;2048];chain.process(&mut audio,48000,2);
        let expected=0.2*10.0_f32.powf(-18.0/20.0);
        assert!((audio[audio.len()-1]-expected).abs()<1e-7);
        assert_eq!(chain.transition_remaining,0);
        assert!(chain.pending_eq.is_none());
    }

    #[test]
    fn a_new_snapshot_after_a_finished_ramp_supersedes_its_previously_deferred_update() {
        let mut chain=DspChain::new(48000);
        chain.apply_prepared_eq(correction_scene(-6.0),80);
        chain.apply_prepared_eq(correction_scene(-12.0),80);
        chain.process(&mut [0.2;320],48000,2);
        chain.apply_prepared_eq(correction_scene(-18.0),80);
        let mut audio=[0.2;640];chain.process(&mut audio,48000,2);
        assert!((audio[audio.len()-1]-0.2*10.0_f32.powf(-18.0/20.0)).abs()<1e-7);
        assert!(chain.pending_eq.is_none());
    }

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
