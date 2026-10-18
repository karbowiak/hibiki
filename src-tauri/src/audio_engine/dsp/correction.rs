//! Faithful, bounded parametric device correction, prepared off the callback.
//! The ordinary ten-band tone EQ retains its existing controls and limits.
use super::biquad::{BiquadFilter, BiquadType};
use serde::{Deserialize, Serialize};

pub const MAX_FILTERS: usize = 20;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub enum FilterKind {
    #[serde(rename = "PK")]
    Peak,
    #[serde(rename = "LSC")]
    LowShelf,
    #[serde(rename = "HSC")]
    HighShelf,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Filter {
    pub kind: FilterKind,
    pub frequency: f64,
    pub gain_db: f64,
    pub q: f64,
    pub enabled: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile {
    pub preamp_db: f64,
    pub filters: Vec<Filter>,
}

/// Fixed storage avoids allocation/deallocation when a prepared bank is adopted
/// or bypassed by the callback. Filter state remains independent per channel.
#[derive(Debug, Clone)]
pub struct PreparedCorrection {
    filters: [BiquadFilter; MAX_FILTERS],
    count: usize,
    gain: f32,
    pub preamp_db: f64,
    pub sample_rate: u32,
}
impl Profile {
    pub fn validate(&self) -> Result<(), String> {
        if !self.preamp_db.is_finite() || !(-60.0..=12.0).contains(&self.preamp_db) {
            return Err("Correction preamp must be between -60 and +12 dB".into());
        }
        if self.filters.is_empty() || self.filters.len() > MAX_FILTERS {
            return Err("Correction needs between 1 and 20 filters".into());
        }
        for filter in &self.filters {
            if !filter.frequency.is_finite()
                || !(10.0..=24000.0).contains(&filter.frequency)
                || !filter.gain_db.is_finite()
                || !(-30.0..=30.0).contains(&filter.gain_db)
                || !filter.q.is_finite()
                || !(0.1..=30.0).contains(&filter.q)
            {
                return Err(
                    "Correction filters require 10–24,000 Hz, -30–+30 dB and Q 0.1–30".into(),
                );
            }
        }
        Ok(())
    }
    pub fn prepare(&self, sample_rate: u32) -> Result<PreparedCorrection, String> {
        self.validate()?;
        if !(8000..=768000).contains(&sample_rate) {
            return Err("Unsupported correction sample rate".into());
        }
        let mut prepared = PreparedCorrection::bypassed(sample_rate);
        prepared.preamp_db = self.preamp_db;
        prepared.gain = 10.0_f64.powf(self.preamp_db / 20.0) as f32;
        for filter in self.filters.iter().filter(|filter| filter.enabled) {
            if filter.frequency >= f64::from(sample_rate) / 2.0 {
                return Err("This correction needs a higher mixer sample rate; filters were not approximated".into());
            }
            let kind = match filter.kind {
                FilterKind::Peak => BiquadType::Peaking,
                FilterKind::LowShelf => BiquadType::Lowshelf,
                FilterKind::HighShelf => BiquadType::Highshelf,
            };
            prepared.filters[prepared.count] = BiquadFilter::parametric(
                kind,
                filter.frequency,
                filter.q,
                filter.gain_db,
                sample_rate,
            );
            prepared.count += 1;
        }
        Ok(prepared)
    }
}
impl PreparedCorrection {
    /// No coefficient work is needed to bypass a retired output on the callback.
    pub fn bypass(&mut self, sample_rate: u32) {
        self.count = 0;
        self.gain = 1.0;
        self.preamp_db = 0.0;
        self.sample_rate = sample_rate;
    }
    pub fn bypassed(sample_rate: u32) -> Self {
        Self {
            filters: std::array::from_fn(|_| {
                BiquadFilter::new(BiquadType::Peaking, 1000.0, 1.0, sample_rate)
            }),
            count: 0,
            gain: 1.0,
            preamp_db: 0.0,
            sample_rate,
        }
    }
    pub fn reset(&mut self) {
        for filter in &mut self.filters[..self.count] {
            filter.reset();
        }
    }
    pub fn process(&mut self, samples: &mut [f32], channels: u16) {
        if self.gain != 1.0 {
            for sample in samples.iter_mut() {
                *sample *= self.gain;
            }
        }
        for filter in &mut self.filters[..self.count] {
            filter.process(samples, channels);
        }
    }
    pub fn response_db(&self, frequency: f64) -> f64 {
        let (sin, cos) =
            (2.0 * std::f64::consts::PI * frequency / f64::from(self.sample_rate)).sin_cos();
        self.preamp_db
            + self.filters[..self.count]
                .iter()
                .map(|filter| 10.0 * filter.response_power(cos, sin).log10())
                .sum::<f64>()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn filter(kind: FilterKind, frequency: f64, gain_db: f64, q: f64) -> Filter {
        Filter {
            kind,
            frequency,
            gain_db,
            q,
            enabled: true,
        }
    }
    #[test]
    fn arbitrary_parametric_peaks_keep_gain_frequency_and_q_at_supported_rates() {
        for rate in [32000, 44100, 48000, 88200, 96000, 176400, 192000] {
            for q in [0.1, 0.7, 3.96, 30.0] {
                let profile = Profile {
                    preamp_db: -6.1,
                    filters: vec![filter(FilterKind::Peak, 3169.0, 18.0, q)],
                };
                let prepared = profile.prepare(rate).unwrap();
                assert!((prepared.response_db(3169.0) - 11.9).abs() < 1e-7);
                assert!((prepared.response_db(0.0) + 6.1).abs() < 1e-7);
            }
        }
    }
    #[test]
    fn shelves_and_original_preamp_are_preserved_without_slider_fitting() {
        for rate in [44100, 48000, 96000, 192000] {
            let profile = Profile {
                preamp_db: -6.1,
                filters: vec![
                    filter(FilterKind::LowShelf, 105.0, 6.4, 0.7),
                    filter(FilterKind::HighShelf, 10000.0, -2.1, 0.7),
                ],
            };
            let prepared = profile.prepare(rate).unwrap();
            assert!((prepared.response_db(0.0) - 0.3).abs() < 1e-7);
            assert!((prepared.response_db(f64::from(rate) / 2.0) + 8.2).abs() < 1e-7);
        }
    }
    #[test]
    fn invalid_profiles_are_rejected_and_out_of_band_filters_are_not_silently_replaced() {
        let base = Profile {
            preamp_db: -6.0,
            filters: vec![filter(FilterKind::Peak, 10000.0, 4.0, 0.7)],
        };
        assert!(base.prepare(16000).is_err());
        assert!(base.prepare(48000).is_ok());
        for value in [f64::NAN, f64::INFINITY, -61.0, 13.0] {
            let mut p = base.clone();
            p.preamp_db = value;
            assert!(p.validate().is_err());
        }
        for value in [f64::NAN, f64::INFINITY, -1.0, 0.0, 0.09, 31.0] {
            let mut p = base.clone();
            p.filters[0].q = value;
            assert!(p.validate().is_err());
        }
        assert!(Profile {
            preamp_db: 0.0,
            filters: vec![]
        }
        .validate()
        .is_err());
        assert!(Profile {
            preamp_db: 0.0,
            filters: vec![base.filters[0].clone(); 21]
        }
        .validate()
        .is_err());
    }
    #[test]
    fn bypass_disabled_filters_and_channel_state_remain_independent() {
        let mut bypass = PreparedCorrection::bypassed(48000);
        let mut samples = [0.4, -0.2, 0.3, -0.1];
        let original = samples;
        bypass.process(&mut samples, 2);
        assert_eq!(samples, original);
        let mut spec = Profile {
            preamp_db: -6.0,
            filters: vec![filter(FilterKind::Peak, 2000.0, 12.0, 2.5)],
        };
        spec.filters[0].enabled = false;
        let mut disabled = spec.prepare(48000).unwrap();
        disabled.process(&mut samples, 2);
        assert!((samples[0] - original[0] * 10.0_f32.powf(-6.0 / 20.0)).abs() < 1e-7);
        spec.filters[0].enabled = true;
        let mut prepared = spec.prepare(48000).unwrap();
        let mut impulse = [0.0; 256];
        impulse[0] = 0.1;
        prepared.process(&mut impulse, 2);
        assert!(impulse.chunks_exact(2).all(|frame| frame[1] == 0.0));
        prepared.reset();
        let mut silence = [0.0; 256];
        prepared.process(&mut silence, 2);
        assert_eq!(silence, [0.0; 256]);
    }
}
