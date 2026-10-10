//! Master volume — final gain stage before output.

use super::traits::DspBlock;

pub struct Volume {
    enabled: bool,
    gain: f32,
}

impl Volume {
    pub fn new() -> Self {
        Self {
            enabled: true,
            gain: 1.0,
        }
    }

    /// Set master volume (0.0 – 1.0 linear, already cubic-curved by the UI).
    pub fn set_gain(&mut self, gain: f32) {
        self.gain = if gain.is_finite() {
            gain.clamp(0.0, 1.0)
        } else {
            0.0
        };
    }

    pub fn gain(&self) -> f32 {
        self.gain
    }
}

impl DspBlock for Volume {
    fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }

    fn process(&mut self, samples: &mut [f32], _sample_rate: u32, _channels: u16) {
        if !self.enabled || (self.gain - 1.0).abs() < 1e-7 {
            return;
        }
        super::apply_gain(samples, self.gain);
    }
}
