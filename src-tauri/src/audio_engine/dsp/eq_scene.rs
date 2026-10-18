//! A complete tone/correction scene with headroom calculated before admission.
use super::{correction::{PreparedCorrection, Profile}, equalizer::Equalizer, traits::DspBlock};

#[derive(Debug, Clone)]
pub struct EqScene {
    pub tone: Equalizer,
    pub correction: PreparedCorrection,
    pub gain: f32,
}
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedEq {
    pub tone_postgain_db: f32,
    pub correction_preamp_db: f64,
    pub safety_db: f64,
    pub sample_rate: u32,
}
impl EqScene {
    pub fn prepare(gains: [f32; 10], enabled: bool, postgain_db: Option<f32>, profile: Option<&Profile>, rate: u32) -> Result<(Self, AppliedEq), String> {
        if gains.iter().any(|gain| !gain.is_finite() || !(-12.0..=12.0).contains(gain))
            || postgain_db.is_some_and(|gain| !gain.is_finite() || !(-24.0..=24.0).contains(&gain))
            || !(8000..=768000).contains(&rate)
        { return Err("Invalid equalizer settings".into()) }
        let mut tone = Equalizer::new(rate);
        tone.set_gains(&gains);
        tone.set_enabled(enabled);
        let correction = match profile { Some(profile) => profile.prepare(rate)?, None => PreparedCorrection::bypassed(rate) };
        let response = |frequency: f64| tone.response_db(frequency, rate) + correction.response_db(frequency);
        let mut peak = response(0.0).max(response(f64::from(rate) / 2.0));
        if profile.is_some() {
            // Resolve narrow imported peaks as well as overlapping tone bands.
            // Include exact centers; all of this runs outside the audio callback.
            let nyquist = f64::from(rate) / 2.0;
            for index in 0..=16384 { peak = peak.max(response(0.1 * (nyquist / 0.1).powf(f64::from(index) / 16384.0))); }
            for filter in &profile.unwrap().filters { if filter.enabled { peak = peak.max(response(filter.frequency)); } }
        }
        let auto_gain = || if profile.is_some() {
            if peak > 0.001 { -(peak + 0.05) as f32 } else { 0.0 }
        } else { Equalizer::auto_postgain_db(&gains, rate) };
        let requested = if enabled { postgain_db.unwrap_or_else(auto_gain) } else if profile.is_some() { auto_gain() } else { 0.0 };
        // A supplied profile preamp is already included in `peak`. Automatic
        // gain supplies only the additional attenuation the combined scene needs.
        // Manual boosts get separate safety attenuation; their requested value
        // remains intact in saved settings and in the returned result.
        let safety = if profile.is_some() && peak + f64::from(requested) > 0.001 {
            -(peak + f64::from(requested) + 0.05)
        } else { 0.0 };
        let gain_db = f64::from(requested) + safety;
        if !peak.is_finite() || !gain_db.is_finite() || gain_db < -90.0 {
            return Err("This equalizer needs more than 90 dB of headroom".into());
        }
        let applied = AppliedEq { tone_postgain_db: requested, correction_preamp_db: correction.preamp_db, safety_db: safety, sample_rate: rate };
        Ok((Self { tone, correction, gain: 10.0_f64.powf(gain_db / 20.0) as f32 }, applied))
    }
    pub fn process(&mut self, samples: &mut [f32], rate: u32, channels: u16) {
        self.correction.process(samples, channels);
        self.tone.process(samples, rate, channels);
        for sample in samples { *sample *= self.gain; }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::correction::{Filter, FilterKind};
    fn profile() -> Profile { Profile { preamp_db: -10.0, filters: vec![Filter {kind:FilterKind::Peak,frequency:1000.0,q:2.5,gain_db:6.0,enabled:true}] } }
    #[test]
    fn supplied_headroom_is_not_compensated_twice_or_restored_by_tone_makeup() {
        let (_, result) = EqScene::prepare([0.0;10],true,None,Some(&profile()),48000).unwrap();
        assert_eq!(result.tone_postgain_db,0.0);
        assert_eq!(result.correction_preamp_db,-10.0);
        assert_eq!(result.safety_db,0.0);
    }
    #[test]
    fn manual_makeup_keeps_requested_value_but_cannot_defeat_correction_headroom() {
        let (_, result) = EqScene::prepare([0.0;10],true,Some(12.0),Some(&profile()),48000).unwrap();
        assert_eq!(result.tone_postgain_db,12.0);
        assert!((result.safety_db+8.05).abs()<1e-5);
        assert_eq!(result.correction_preamp_db,-10.0);
    }
    #[test]
    fn correction_remains_independent_of_tone_bypass_and_legacy_tone_behavior_is_preserved() {
        for rate in [44100,48000,96000,192000] {
            let gains=[8.0,6.0,4.0,2.0,0.0,0.0,0.0,0.0,0.0,0.0];
            let (_,ordinary)=EqScene::prepare(gains,true,None,None,rate).unwrap();
            assert_eq!(ordinary.tone_postgain_db,Equalizer::auto_postgain_db(&gains,rate));
            let (mut bypass,result)=EqScene::prepare(gains,false,Some(12.0),Some(&profile()),rate).unwrap();
            assert_eq!(result.correction_preamp_db,-10.0);assert_eq!(result.tone_postgain_db,0.0);
            let mut sample=[0.1;64];bypass.process(&mut sample,rate,2);
            assert!(sample.iter().all(|value|value.is_finite() && value.abs()<0.1));
        }
    }
    #[test]
    fn imported_scene_pcm_matches_its_frequency_response_without_normalization_or_limiter_makeup() {
        for rate in [44100,48000,96000,192000] {
            let (mut scene,result)=EqScene::prepare([0.0;10],true,None,Some(&profile()),rate).unwrap();
            let input:Vec<_>=(0..rate).map(|frame|(2.0*std::f64::consts::PI*1000.0*f64::from(frame)/f64::from(rate)).sin() as f32*0.1).collect();
            let mut output=input.clone();scene.process(&mut output,rate,1);
            let start=rate as usize/2;
            let energy=|values:&[f32]|values[start..].iter().map(|value|f64::from(*value).powi(2)).sum::<f64>();
            let measured=10.0*(energy(&output)/energy(&input)).log10();
            assert!((measured+4.0).abs()<0.0001,"{rate}: {measured}");
            assert_eq!(result.safety_db,0.0);
        }
    }
}
