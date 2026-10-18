//! Postgain — makeup gain applied after the EQ chain.

use super::traits::DspBlock;

pub struct Postgain {
    enabled: bool,
    gain_linear: f32,
}

impl Postgain {
    /// The complete scene's validated gain is prepared off the callback. Its
    /// safety attenuation may exceed the ordinary manual slider's 24 dB range.
    pub(super) fn prepared(gain: f32) -> Self { Self { enabled: true, gain_linear: gain } }
    pub fn new() -> Self {
        Self {
            enabled: false,
            gain_linear: 1.0,
        }
    }

    pub fn current_gain(&self) -> f32 {
        if self.enabled { self.gain_linear } else { 1.0 }
    }

    pub fn set_gain_db(&mut self, db: f32) {
        self.gain_linear = super::gain_from_db(db);
    }
}

impl DspBlock for Postgain {
    fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }

    fn process(&mut self, samples: &mut [f32], _sample_rate: u32, _channels: u16) {
        if !self.enabled || (self.gain_linear - 1.0).abs() < 1e-7 {
            return;
        }
        super::apply_gain(samples, self.gain_linear);
    }
}
