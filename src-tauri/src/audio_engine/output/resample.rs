//! Stateful, band-limited sample-rate conversion on the decoder thread.
//! Preserve filter history across batches, trim startup delay and flush the
//! final tail to the exact rational frame count. Never run FFTs in the callback.

use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::{Async, Fft, FixedAsync, FixedSync, Resampler, SincInterpolationParameters};

pub struct StreamingResampler {
    processor: Box<dyn Resampler<f32>>,
    channels: usize,
    source_rate: u32,
    target_rate: u32,
    pending: Vec<f32>,
    scratch: Vec<f32>,
    delay_remaining: usize,
    input_frames: u64,
    output_frames: u64,
    finished: bool,
}

impl StreamingResampler {
    pub fn new(channels: u16, source_rate: u32, target_rate: u32) -> Result<Self, String> {
        if !(1..=32).contains(&channels)
            || !(8000..=768000).contains(&source_rate)
            || !(8000..=768000).contains(&target_rate)
        {
            return Err("Unsupported audio channel count or sample rate".into());
        }
        let mut a = source_rate;
        let mut b = target_rate;
        while b != 0 {
            (a, b) = (b, a % b);
        }
        // FFT conversion is fast for standard rate ratios. For unusual coprime
        // rates, sinc avoids an FFT as large as the sample rate itself.
        let processor: Box<dyn Resampler<f32>> =
            if source_rate / a <= 4096 && target_rate / a <= 4096 {
                Box::new(
                    Fft::<f32>::new(
                        source_rate as usize,
                        target_rate as usize,
                        1024,
                        channels as usize,
                        FixedSync::Both,
                    )
                    .map_err(|e| format!("Audio resampler: {e}"))?,
                )
            } else {
                Box::new(
                    Async::<f32>::new_sinc(
                        target_rate as f64 / source_rate as f64,
                        1.0,
                        &SincInterpolationParameters::default(),
                        1024,
                        channels as usize,
                        FixedAsync::Input,
                    )
                    .map_err(|e| format!("Audio resampler: {e}"))?,
                )
            };
        let scratch = vec![0.0; processor.output_frames_max() * channels as usize];
        let delay_remaining = processor.output_delay();
        Ok(Self {
            processor,
            channels: channels as usize,
            source_rate,
            target_rate,
            pending: Vec::new(),
            scratch,
            delay_remaining,
            input_frames: 0,
            output_frames: 0,
            finished: false,
        })
    }

    pub fn reset(&mut self) {
        self.processor.reset();
        self.pending.clear();
        self.delay_remaining = self.processor.output_delay();
        self.input_frames = 0;
        self.output_frames = 0;
        self.finished = false;
    }

    pub fn process(&mut self, samples: &[f32], finish: bool) -> Result<Vec<f32>, String> {
        if samples.len() % self.channels != 0 {
            return Err("Incomplete audio frame".into());
        }
        if self.finished {
            return if samples.is_empty() {
                Ok(Vec::new())
            } else {
                Err("Audio resampler has already finished".into())
            };
        }
        self.input_frames += (samples.len() / self.channels) as u64;
        self.pending.extend_from_slice(samples);
        let target_frames = ((self.input_frames as u128 * self.target_rate as u128
            + self.source_rate as u128 / 2)
            / self.source_rate as u128)
            .min(u64::MAX as u128) as u64;
        let mut output = Vec::new();
        let mut offset = 0;
        loop {
            if finish && self.output_frames >= target_frames {
                break;
            }
            let needed = self.processor.input_frames_next() * self.channels;
            if self.pending.len() - offset < needed {
                if !finish {
                    break;
                }
                self.pending.resize(offset + needed, 0.0);
            }
            let input = InterleavedSlice::new(
                &self.pending[offset..offset + needed],
                self.channels,
                needed / self.channels,
            )
            .map_err(|e| format!("Audio resampler input: {e}"))?;
            let scratch_frames = self.scratch.len() / self.channels;
            let mut out =
                InterleavedSlice::new_mut(&mut self.scratch, self.channels, scratch_frames)
                    .map_err(|e| format!("Audio resampler output: {e}"))?;
            let (consumed, produced) = self
                .processor
                .process_into_buffer(&input, &mut out, None)
                .map_err(|e| format!("Audio resampling failed: {e}"))?;
            if consumed == 0 && produced == 0 {
                return Err("Audio resampler made no progress".into());
            }
            offset += consumed * self.channels;
            let skip = self.delay_remaining.min(produced);
            self.delay_remaining -= skip;
            let count = if finish {
                (produced - skip).min(target_frames.saturating_sub(self.output_frames) as usize)
            } else {
                produced - skip
            };
            output.extend_from_slice(
                &self.scratch[skip * self.channels..(skip + count) * self.channels],
            );
            self.output_frames += count as u64;
        }
        self.pending.drain(..offset);
        if finish {
            self.pending.clear();
            self.finished = true;
        }
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(rate: u32, hz: f32, frames: usize) -> Vec<f32> {
        (0..frames)
            .map(|frame| {
                (frame as f64 * hz as f64 * std::f64::consts::TAU / rate as f64).sin() as f32
            })
            .collect()
    }

    #[test]
    fn batch_boundaries_do_not_change_samples_or_accumulate_duration_error() {
        for (source, target) in [
            (44100, 48000),
            (48000, 44100),
            (96000, 48000),
            (44101, 48000),
        ] {
            let input = tone(source, 997.0, source as usize * 3 + 137);
            let whole = StreamingResampler::new(1, source, target)
                .unwrap()
                .process(&input, true)
                .unwrap();
            let mut streaming = StreamingResampler::new(1, source, target).unwrap();
            let mut output = Vec::new();
            for chunk in input.chunks(337) {
                output.extend(streaming.process(chunk, false).unwrap());
            }
            output.extend(streaming.process(&[], true).unwrap());
            assert_eq!(
                whole.len(),
                ((input.len() as f64 * target as f64 / source as f64).round()) as usize
            );
            assert_eq!(output, whole);
            streaming.reset();
            assert_eq!(streaming.process(&input, true).unwrap(), whole);
        }
    }

    #[test]
    fn downsampling_preserves_music_and_rejects_above_nyquist_aliases() {
        let rms = |samples: &[f32]| {
            (samples.iter().map(|x| x * x).sum::<f32>() / samples.len() as f32).sqrt()
        };
        let pass = StreamingResampler::new(1, 96000, 48000)
            .unwrap()
            .process(&tone(96000, 1000.0, 96000), true)
            .unwrap();
        let reject = StreamingResampler::new(1, 96000, 48000)
            .unwrap()
            .process(&tone(96000, 30000.0, 96000), true)
            .unwrap();
        assert!((rms(&pass[1000..47000]) - 0.7071).abs() < 0.001);
        assert!(rms(&reject[1000..47000]) < 0.001);
    }

    #[test]
    fn flushes_a_short_clip_and_preserves_stereo_channel_isolation() {
        let input: Vec<f32> = (0..441).flat_map(|_| [0.5, -0.25]).collect();
        let output = StreamingResampler::new(2, 44100, 48000)
            .unwrap()
            .process(&input, true)
            .unwrap();
        assert_eq!(output.len(), 960);
        assert!(output.iter().all(|x| x.is_finite()));
        assert!(output[400..600]
            .chunks_exact(2)
            .all(|frame| (frame[0] - 0.5).abs() < 0.001 && (frame[1] + 0.25).abs() < 0.001));
        assert!(StreamingResampler::new(0, 44100, 48000).is_err());
        assert!(StreamingResampler::new(2, 0, 48000).is_err());
    }
}
