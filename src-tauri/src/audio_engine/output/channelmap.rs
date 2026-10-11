//! Convert decoded speaker layouts into the engine's stable stereo format.
//! Runs on decoder threads, before SRC; the real-time mixer only reads stereo.

use symphonia::core::audio::Channels;

/// Default Lo/Ro coefficients for 5.1 follow ITU-R BS.775-4 Annex 4, Table 2.
/// LFE is omitted (Annex 7); main channels retain their full bass bandwidth.
/// Other layouts fold named left/right/center speakers into the matching side.
/// https://www.itu.int/rec/R-REC-BS.775-4-202212-I/en
pub struct StereoDownmix {
    weights: Vec<[f32; 2]>,
    passthrough: bool,
}

impl StereoDownmix {
    pub fn new(layout: Channels) -> Result<Self, String> {
        if layout.is_empty() || layout.count() > 32 {
            return Err("Unsupported audio channel layout".into());
        }
        let mono = layout.count() == 1
            && (layout == Channels::FRONT_LEFT || layout == Channels::FRONT_CENTRE);
        let left_surrounds = (layout & (Channels::REAR_LEFT | Channels::SIDE_LEFT))
            .count()
            .max(1);
        let right_surrounds = (layout & (Channels::REAR_RIGHT | Channels::SIDE_RIGHT))
            .count()
            .max(1);
        let surround = std::f32::consts::FRAC_1_SQRT_2;
        let weights = layout
            .iter()
            .map(|channel| {
                if mono {
                    return [1.0, 1.0];
                }
                match channel {
                    Channels::FRONT_LEFT => [1.0, 0.0],
                    Channels::FRONT_RIGHT => [0.0, 1.0],
                    Channels::FRONT_CENTRE
                    | Channels::TOP_FRONT_CENTRE
                    | Channels::FRONT_CENTRE_HIGH => [surround, surround],
                    Channels::REAR_LEFT | Channels::SIDE_LEFT => {
                        [surround / (left_surrounds as f32).sqrt(), 0.0]
                    }
                    Channels::REAR_RIGHT | Channels::SIDE_RIGHT => {
                        [0.0, surround / (right_surrounds as f32).sqrt()]
                    }
                    Channels::FRONT_LEFT_CENTRE
                    | Channels::FRONT_LEFT_WIDE
                    | Channels::FRONT_LEFT_HIGH
                    | Channels::TOP_FRONT_LEFT
                    | Channels::TOP_REAR_LEFT
                    | Channels::REAR_LEFT_CENTRE => [surround, 0.0],
                    Channels::FRONT_RIGHT_CENTRE
                    | Channels::FRONT_RIGHT_WIDE
                    | Channels::FRONT_RIGHT_HIGH
                    | Channels::TOP_FRONT_RIGHT
                    | Channels::TOP_REAR_RIGHT
                    | Channels::REAR_RIGHT_CENTRE => [0.0, surround],
                    Channels::REAR_CENTRE | Channels::TOP_CENTRE | Channels::TOP_REAR_CENTRE => {
                        [0.5, 0.5]
                    }
                    Channels::LFE1 | Channels::LFE2 => [0.0, 0.0],
                    _ => [surround, surround],
                }
            })
            .collect();
        Ok(Self {
            weights,
            passthrough: layout == Channels::FRONT_LEFT | Channels::FRONT_RIGHT,
        })
    }

    pub fn process(&self, samples: Vec<f32>) -> Result<Vec<f32>, String> {
        if samples.len() % self.weights.len() != 0 {
            return Err("Incomplete decoded audio frame".into());
        }
        if self.passthrough {
            return Ok(samples);
        }
        let mut stereo = Vec::with_capacity(samples.len() / self.weights.len() * 2);
        for frame in samples.chunks_exact(self.weights.len()) {
            let mut output = [0.0_f64; 2];
            for (&sample, gain) in frame.iter().zip(&self.weights) {
                if !sample.is_finite() {
                    continue;
                }
                output[0] += f64::from(sample) * f64::from(gain[0]);
                output[1] += f64::from(sample) * f64::from(gain[1]);
            }
            // Float PCM can contain unusually large finite values. Summing in
            // f64 avoids introducing infinities before the DSP safety guards.
            stereo.extend(
                output.map(|value| value.clamp(-(f32::MAX as f64), f32::MAX as f64) as f32),
            );
        }
        Ok(stereo)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stereo_remains_bit_exact_and_mono_keeps_its_level_in_both_speakers() {
        let input = vec![0.25, -0.75, 0.125, -0.0625];
        let stereo = StereoDownmix::new(Channels::FRONT_LEFT | Channels::FRONT_RIGHT).unwrap();
        let allocation = input.as_ptr();
        let unchanged = stereo.process(input.clone()).unwrap();
        assert_eq!(unchanged, input);
        let moved = stereo.process(input).unwrap();
        assert_eq!(moved.as_ptr(), allocation);
        for layout in [Channels::FRONT_LEFT, Channels::FRONT_CENTRE] {
            assert_eq!(
                StereoDownmix::new(layout)
                    .unwrap()
                    .process(vec![0.25, -0.5])
                    .unwrap(),
                vec![0.25, 0.25, -0.5, -0.5]
            );
        }
    }

    #[test]
    fn each_51_speaker_reaches_the_correct_side_without_lfe_bass_duplication() {
        for surrounds in [
            Channels::REAR_LEFT | Channels::REAR_RIGHT,
            Channels::SIDE_LEFT | Channels::SIDE_RIGHT,
        ] {
            let layout = Channels::FRONT_LEFT
                | Channels::FRONT_RIGHT
                | Channels::FRONT_CENTRE
                | Channels::LFE1
                | surrounds;
            let downmix = StereoDownmix::new(layout).unwrap();
            let mut impulses = vec![0.0; 6 * 6];
            for channel in 0..6 {
                impulses[channel * 6 + channel] = 1.0;
            }
            let result = downmix.process(impulses).unwrap();
            let side = std::f32::consts::FRAC_1_SQRT_2;
            assert_eq!(
                result,
                vec![1.0, 0.0, 0.0, 1.0, side, side, 0.0, 0.0, side, 0.0, 0.0, side]
            );
        }
    }

    #[test]
    fn layouts_with_the_same_channel_count_do_not_share_speaker_assignments() {
        let front = StereoDownmix::new(
            Channels::FRONT_LEFT | Channels::FRONT_RIGHT | Channels::FRONT_CENTRE,
        )
        .unwrap();
        let bass =
            StereoDownmix::new(Channels::FRONT_LEFT | Channels::FRONT_RIGHT | Channels::LFE1)
                .unwrap();
        let center = front.process(vec![0.0, 0.0, 1.0]).unwrap();
        assert_eq!(center, vec![std::f32::consts::FRAC_1_SQRT_2; 2]);
        assert_eq!(bass.process(vec![0.0, 0.0, 1.0]).unwrap(), vec![0.0; 2]);
    }

    #[test]
    fn side_and_rear_speakers_of_71_share_surround_power_and_keep_sides_separate() {
        let layout = Channels::FRONT_LEFT
            | Channels::FRONT_RIGHT
            | Channels::FRONT_CENTRE
            | Channels::LFE1
            | Channels::REAR_LEFT
            | Channels::REAR_RIGHT
            | Channels::SIDE_LEFT
            | Channels::SIDE_RIGHT;
        let downmix = StereoDownmix::new(layout).unwrap();
        for (speaker, channel) in layout.iter().enumerate() {
            let mut frame = vec![0.0; 8];
            frame[speaker] = 1.0;
            let result = downmix.process(frame).unwrap();
            if channel == Channels::REAR_LEFT || channel == Channels::SIDE_LEFT {
                assert!((result[0] - 0.5).abs() < 1e-6);
                assert_eq!(result[1], 0.0);
            }
            if channel == Channels::REAR_RIGHT || channel == Channels::SIDE_RIGHT {
                assert_eq!(result[0], 0.0);
                assert!((result[1] - 0.5).abs() < 1e-6);
            }
        }
    }

    #[test]
    fn named_height_channels_are_folded_and_malformed_frames_remain_errors() {
        let layout =
            Channels::TOP_FRONT_LEFT | Channels::TOP_FRONT_CENTRE | Channels::TOP_FRONT_RIGHT;
        let downmix = StereoDownmix::new(layout).unwrap();
        let side = std::f32::consts::FRAC_1_SQRT_2;
        assert_eq!(
            downmix.process(vec![1.0, 0.0, 0.0]).unwrap(),
            vec![side, 0.0]
        );
        assert_eq!(
            downmix.process(vec![0.0, 1.0, 0.0]).unwrap(),
            vec![side, side]
        );
        assert_eq!(
            downmix.process(vec![0.0, 0.0, 1.0]).unwrap(),
            vec![0.0, side]
        );
        assert!(downmix.process(vec![1.0, 0.0]).is_err());
        assert!(StereoDownmix::new(Channels::empty()).is_err());
        assert!(downmix
            .process(vec![f32::MAX; 3])
            .unwrap()
            .iter()
            .all(|value| value.is_finite()));
    }
}
