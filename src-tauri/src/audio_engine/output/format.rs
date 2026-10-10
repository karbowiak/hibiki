//! Bounded conversion from the engine's f32 PCM to the device's sample format.

use cpal::{FromSample, Sample};

pub const SCRATCH_SAMPLES: usize = 4096;

#[inline]
pub fn safe_sample(sample: f32) -> f32 {
    if sample.is_finite() {
        sample.clamp(-1.0, 1.0)
    } else {
        0.0
    }
}

pub fn render<T: Sample + FromSample<f32>>(
    output: &mut [T],
    channels: u16,
    scratch: &mut [f32; SCRATCH_SAMPLES],
    mut process: impl FnMut(&mut [f32]),
) {
    let channels = usize::from(channels);
    // Never advance a deck through an incomplete output frame.
    if channels == 0 || channels > SCRATCH_SAMPLES {
        output.fill(T::EQUILIBRIUM);
        return;
    }
    let complete = output.len() / channels * channels;
    output[complete..].fill(T::EQUILIBRIUM);
    let chunk_samples = SCRATCH_SAMPLES / channels * channels;
    for chunk in output[..complete].chunks_mut(chunk_samples) {
        let pcm = &mut scratch[..chunk.len()];
        pcm.fill(0.0);
        process(pcm);
        for (sample, value) in chunk.iter_mut().zip(pcm) {
            *sample = T::from_sample(safe_sample(*value));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integer_output_saturates_at_full_scale_and_maps_silence_to_its_midpoint() {
        let input = [
            -2.0,
            -1.0,
            -0.5,
            0.0,
            0.5,
            1.0,
            2.0,
            f32::NAN,
            f32::INFINITY,
        ];
        let mut scratch = [0.0; SCRATCH_SAMPLES];
        let mut signed = [42_i16; 9];
        render(&mut signed, 1, &mut scratch, |pcm| {
            pcm.copy_from_slice(&input)
        });
        assert_eq!(
            signed,
            [
                i16::MIN,
                i16::MIN,
                -16384,
                0,
                16384,
                i16::MAX,
                i16::MAX,
                0,
                0
            ]
        );
        let mut unsigned = [42_u16; 9];
        render(&mut unsigned, 1, &mut scratch, |pcm| {
            pcm.copy_from_slice(&input)
        });
        assert_eq!(
            unsigned,
            [0, 0, 16384, 32768, 49152, u16::MAX, u16::MAX, 32768, 32768]
        );
    }

    fn check_format<T: Sample + FromSample<f32> + std::fmt::Debug>() {
        let mut output = [T::EQUILIBRIUM; 3];
        render(&mut output, 1, &mut [0.0; SCRATCH_SAMPLES], |pcm| {
            pcm.copy_from_slice(&[-1.0, 0.0, 1.0])
        });
        assert!(output[0] < T::EQUILIBRIUM);
        assert_eq!(output[1], T::EQUILIBRIUM);
        assert!(output[2] > T::EQUILIBRIUM);
    }

    #[test]
    fn every_supported_device_format_has_the_correct_polarity_and_silence() {
        check_format::<i8>();
        check_format::<i16>();
        check_format::<i32>();
        check_format::<i64>();
        check_format::<u8>();
        check_format::<u16>();
        check_format::<u32>();
        check_format::<u64>();
        check_format::<f32>();
        check_format::<f64>();
    }

    #[test]
    fn large_variable_callbacks_keep_all_frames_in_order_without_scratch_growth() {
        for channels in [1_u16, 2, 3, 8, 32] {
            let channels = usize::from(channels);
            let mut output = vec![99.0_f64; channels * 9000 + usize::from(channels > 1)];
            let mut processed = 0;
            render(
                &mut output,
                channels as u16,
                &mut [0.0; SCRATCH_SAMPLES],
                |pcm| {
                    assert!(pcm.len() <= SCRATCH_SAMPLES);
                    assert_eq!(pcm.len() % channels, 0);
                    for sample in pcm {
                        *sample = (processed % 1000) as f32 / 1000.0;
                        processed += 1;
                    }
                },
            );
            assert_eq!(processed, channels * 9000);
            for (index, sample) in output[..processed].iter().enumerate() {
                assert_eq!(*sample, f64::from((index % 1000) as f32 / 1000.0));
            }
            assert!(output[processed..].iter().all(|sample| *sample == 0.0));
        }
    }
}
