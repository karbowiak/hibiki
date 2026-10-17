//! Preamp — input gain stage before the EQ chain.

use super::traits::DspBlock;

pub struct Preamp {
    enabled: bool,
    gain_linear: f32,
}

impl Preamp {
    pub fn new() -> Self {
        Self {
            enabled: true,
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

impl DspBlock for Preamp {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_db_is_unity() {
        let mut p = Preamp::new();
        p.set_gain_db(0.0);
        let mut buf = vec![0.5f32, -0.5, 1.0, -1.0];
        let orig = buf.clone();
        p.process(&mut buf, 44100, 2);
        assert_eq!(buf, orig);
    }

    #[test]
    fn plus_6db_doubles() {
        let mut p = Preamp::new();
        p.set_gain_db(6.0);
        let mut buf = vec![0.5f32];
        p.process(&mut buf, 44100, 1);
        // +6dB ≈ 1.995x
        assert!((buf[0] - 0.5 * 10.0_f32.powf(6.0 / 20.0)).abs() < 1e-5);
    }

    #[test]
    fn disabled_is_passthrough() {
        let mut p = Preamp::new();
        p.set_gain_db(12.0);
        p.set_enabled(false);
        let mut buf = vec![0.5f32, -0.5];
        let orig = buf.clone();
        p.process(&mut buf, 44100, 2);
        assert_eq!(buf, orig);
    }
}
