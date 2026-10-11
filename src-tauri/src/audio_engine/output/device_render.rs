//! Preserve the engine's mixing clock when the physical output format changes.
//! Sinc tables and all buffers are prepared on the output owner, outside callbacks.

use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::{Async, FixedAsync, Resampler, SincInterpolationParameters};

use super::owner::OutputParams;
use super::playback_envelope::PlaybackEnvelope;

pub trait RenderSource: Send {
    fn params(&self) -> OutputParams;
    fn render(&mut self, samples: &mut [f32]);
    fn poll(&mut self);
    /// True only after source pause/stop fades have finished.
    fn is_idle(&self) -> bool {
        false
    }
    fn has_audio_history(&self) -> bool {
        false
    }
}

pub struct DeviceRenderer<S> {
    pub source: S,
    target: OutputParams,
    resampler: Option<SincOutput>,
    scratch: [f32; 4096],
    device_fade: PlaybackEnvelope,
    primed: bool,
}

impl<S: RenderSource> DeviceRenderer<S> {
    pub fn new(source: S) -> Self {
        let target = source.params();
        Self {
            source,
            target,
            resampler: None,
            scratch: [0.0; 4096],
            device_fade: PlaybackEnvelope::new(),
            primed: false,
        }
    }

    pub fn configure(&mut self, target: OutputParams) -> Result<(), String> {
        let source = self.source.params();
        if source.channels != 2
            || !(8000..=768000).contains(&source.sample_rate)
            || !(8000..=768000).contains(&target.sample_rate)
            || target.channels == 0
            || usize::from(target.channels) > super::format::SCRATCH_SAMPLES
        {
            return Err("unsupported audio output format".into());
        }
        let resampler = if source.sample_rate == target.sample_rate {
            None
        } else {
            Some(SincOutput::new(source.sample_rate, target.sample_rate)?)
        };
        self.resampler = resampler;
        self.target = target;
        self.primed = false;
        if self.source.has_audio_history() {
            self.device_fade.silence();
            self.device_fade.fade_in(target.sample_rate);
        }
        Ok(())
    }

    pub fn render(&mut self, samples: &mut [f32]) {
        if !self.primed {
            // Apply controls queued while opening/preparing the new device.
            self.source.poll();
            self.primed = true;
        }
        self.render_audio(samples);
        self.device_fade.apply(samples, self.target.channels);
    }

    fn render_audio(&mut self, samples: &mut [f32]) {
        let channels = usize::from(self.target.channels);
        if self.resampler.is_none() && channels == 2 {
            self.source.render(samples);
            return;
        }
        let frames = samples.len() / channels;
        samples[frames * channels..].fill(0.0);
        let mut offset = 0;
        while offset < frames {
            let (pcm, count) = if let Some(adapter) = &mut self.resampler {
                if adapter.read_frame == adapter.ready_frames
                    && adapter.fill(&mut self.source).is_err()
                {
                    samples[offset * channels..].fill(0.0);
                    return;
                }
                let count = (frames - offset).min(adapter.ready_frames - adapter.read_frame);
                let start = adapter.read_frame * 2;
                adapter.read_frame += count;
                (&adapter.output[start..start + count * 2], count)
            } else {
                let count = (frames - offset).min(self.scratch.len() / 2);
                let pcm = &mut self.scratch[..count * 2];
                self.source.render(pcm);
                (&*pcm, count)
            };
            for (input, output) in pcm.chunks_exact(2).zip(
                samples[offset * channels..(offset + count) * channels].chunks_exact_mut(channels),
            ) {
                output.fill(0.0);
                if channels == 1 {
                    output[0] = (input[0] + input[1]) * 0.5;
                } else {
                    output[0] = input[0];
                    output[1] = input[1];
                }
            }
            offset += count;
        }
    }
}

struct SincOutput {
    processor: Async<f32>,
    input: Vec<f32>,
    output: Vec<f32>,
    pending_frames: usize,
    ready_frames: usize,
    read_frame: usize,
    silent_frames: usize,
    flush_frames: usize,
    idle: bool,
    #[cfg(test)]
    processing_calls: usize,
}

impl SincOutput {
    fn new(source_rate: u32, target_rate: u32) -> Result<Self, String> {
        // At most 10 ms of extra control latency at low output rates.
        let chunk = (target_rate as usize / 100).clamp(64, 512);
        let mut parameters = SincInterpolationParameters::default();
        let factor = (source_rate as usize).div_ceil(target_rate as usize).max(1);
        // Keep the transition band relative to the output clock when decimating.
        // The maximum validated rate ratio is 96, so preparation stays bounded.
        parameters.f_cutoff = Some(rubato::calculate_cutoff(
            parameters.sinc_len,
            parameters.window,
        ));
        parameters.sinc_len *= factor;
        let processor = Async::new_sinc(
            target_rate as f64 / source_rate as f64,
            1.0,
            &parameters,
            chunk,
            2,
            FixedAsync::Output,
        )
        .map_err(|error| format!("output resampler: {error}"))?;
        let flush_frames = parameters.sinc_len + processor.input_frames_max();
        let input = vec![0.0; processor.input_frames_max() * 2];
        let output = vec![0.0; processor.output_frames_max() * 2];
        Ok(Self {
            processor,
            input,
            output,
            pending_frames: 0,
            ready_frames: 0,
            read_frame: 0,
            silent_frames: 0,
            flush_frames,
            idle: false,
            #[cfg(test)]
            processing_calls: 0,
        })
    }

    fn fill(&mut self, source: &mut impl RenderSource) -> Result<(), ()> {
        let needed = self.processor.input_frames_next();
        if self.pending_frames < needed {
            source.render(&mut self.input[self.pending_frames * 2..needed * 2]);
        }
        let quiet = source.is_idle() && self.input[..needed * 2].iter().all(|value| *value == 0.0);
        if quiet {
            self.silent_frames = self
                .silent_frames
                .saturating_add(needed.saturating_sub(self.pending_frames));
        } else {
            self.silent_frames = 0;
            self.idle = false;
        }
        if self.idle {
            // The finite sinc history and queued output have drained. Keep
            // polling/rendering controls, but freeze the silent converter phase.
            self.output.fill(0.0);
            self.ready_frames = self.processor.output_frames_next();
            self.read_frame = 0;
            return Ok(());
        }
        #[cfg(test)]
        {
            self.processing_calls += 1;
        }
        let input = InterleavedSlice::new(&self.input[..needed * 2], 2, needed).map_err(|_| ())?;
        let frames = self.output.len() / 2;
        let mut output = InterleavedSlice::new_mut(&mut self.output, 2, frames).map_err(|_| ())?;
        let (consumed, produced) = self
            .processor
            .process_into_buffer(&input, &mut output, None)
            .map_err(|_| ())?;
        if consumed > needed || produced == 0 {
            return Err(());
        }
        self.input.copy_within(consumed * 2..needed * 2, 0);
        self.pending_frames = needed - consumed;
        self.idle = quiet
            && self.silent_frames >= self.flush_frames
            && self.output[..produced * 2]
                .iter()
                .all(|value| *value == 0.0);
        self.ready_frames = produced;
        self.read_frame = 0;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Tone {
        frames: usize,
        rate: u32,
        hz: f64,
    }
    impl RenderSource for Tone {
        fn params(&self) -> OutputParams {
            OutputParams {
                sample_rate: self.rate,
                channels: 2,
            }
        }
        fn render(&mut self, samples: &mut [f32]) {
            for frame in samples.chunks_exact_mut(2) {
                let value = (self.frames as f64 * self.hz * std::f64::consts::TAU
                    / f64::from(self.rate))
                .sin() as f32
                    * 0.25;
                frame[0] = value;
                frame[1] = -value * 0.5;
                self.frames += 1;
            }
        }
        fn poll(&mut self) {}
    }

    struct PausableTone {
        tone: Tone,
        paused: bool,
        idle_hint: bool,
        renders: usize,
    }
    impl RenderSource for PausableTone {
        fn params(&self) -> OutputParams {
            self.tone.params()
        }
        fn render(&mut self, samples: &mut [f32]) {
            self.renders += 1;
            if self.paused {
                samples.fill(0.0)
            } else {
                self.tone.render(samples)
            }
        }
        fn poll(&mut self) {}
        fn is_idle(&self) -> bool {
            self.paused && self.idle_hint
        }
    }

    #[test]
    fn settled_pause_bypasses_sinc_without_cutting_tail_or_losing_resumed_signal() {
        for target_rate in [8000, 44100, 96000] {
            let make = |idle_hint| {
                let mut renderer = DeviceRenderer::new(PausableTone {
                    tone: Tone {
                        frames: 0,
                        rate: 48000,
                        hz: 440.0,
                    },
                    paused: false,
                    idle_hint,
                    renders: 0,
                });
                renderer
                    .configure(OutputParams {
                        sample_rate: target_rate,
                        channels: 2,
                    })
                    .unwrap();
                renderer
            };
            let mut optimized = make(true);
            let mut reference = make(false);
            let mut actual = vec![0.0; target_rate as usize / 10 * 2];
            let mut expected = actual.clone();
            optimized.render(&mut actual);
            reference.render(&mut expected);
            assert_eq!(actual, expected);
            optimized.source.paused = true;
            reference.source.paused = true;
            // Includes queued nonzero device output and the finite sinc tail.
            optimized.render(&mut actual);
            reference.render(&mut expected);
            assert_eq!(actual, expected, "pause tail was cut at {target_rate} Hz");
            assert!(actual.iter().any(|sample| *sample != 0.0));
            assert!(optimized.resampler.as_ref().unwrap().idle);
            let calls = optimized.resampler.as_ref().unwrap().processing_calls;
            let rendered = optimized.source.renders;
            let listened = optimized.source.tone.frames;
            for _ in 0..20 {
                optimized.render(&mut actual);
            }
            assert_eq!(
                optimized.resampler.as_ref().unwrap().processing_calls,
                calls
            );
            assert!(
                optimized.source.renders > rendered,
                "controls must still be serviced"
            );
            assert_eq!(
                optimized.source.tone.frames, listened,
                "silence is not listening"
            );
            assert!(actual.iter().all(|sample| *sample == 0.0));
            optimized.source.paused = false;
            optimized.render(&mut actual);
            assert!(optimized.resampler.as_ref().unwrap().processing_calls > calls);
            assert!(optimized.source.tone.frames > listened);
            let settled = &actual[actual.len() / 2..];
            assert!(settled.iter().all(|sample| sample.is_finite()));
            let rms = (settled
                .chunks_exact(2)
                .map(|frame| f64::from(frame[0]).powi(2))
                .sum::<f64>()
                / (settled.len() / 2) as f64)
                .sqrt();
            assert!(
                (0.16..0.19).contains(&rms),
                "resumed 440 Hz amplitude was lost: {rms}"
            );
        }
    }

    #[test]
    fn changing_rate_and_channels_preserves_the_source_clock_and_channel_polarity() {
        let mut renderer = DeviceRenderer::new(Tone {
            frames: 0,
            rate: 48000,
            hz: 1000.0,
        });
        for rate in [44100, 8000, 192000, 48000] {
            renderer
                .configure(OutputParams {
                    sample_rate: rate,
                    channels: 6,
                })
                .unwrap();
            let prefetch = renderer
                .resampler
                .as_ref()
                .map_or(0, |adapter| adapter.processor.input_frames_max());
            let before = renderer.source.frames;
            let mut output = vec![0.0; rate as usize / 5 * 6];
            for chunk in output.chunks_mut(378) {
                renderer.render(chunk);
            }
            let rendered = renderer.source.frames - before;
            assert!(
                rendered >= 9600 && rendered <= 9600 + prefetch,
                "source time must remain at 48 kHz, got {rendered}"
            );
            assert!(output.iter().all(|sample| sample.is_finite()));
            let settled = &output[rate as usize / 20 * 6..];
            assert!(settled
                .chunks_exact(6)
                .all(|frame| (frame[1] + frame[0] * 0.5).abs() < 1e-6
                    && frame[2..].iter().all(|sample| *sample == 0.0)));
            assert!(settled.iter().any(|sample| sample.abs() > 0.2));
        }
    }

    #[test]
    fn downsampling_rejects_frequencies_above_the_new_device_nyquist() {
        let mut renderer = DeviceRenderer::new(Tone {
            frames: 0,
            rate: 48000,
            hz: 17000.0,
        });
        renderer
            .configure(OutputParams {
                sample_rate: 22050,
                channels: 2,
            })
            .unwrap();
        let mut output = vec![0.0; 22050 * 2];
        renderer.render(&mut output);
        let rms = (output[2000..]
            .iter()
            .map(|sample| f64::from(*sample).powi(2))
            .sum::<f64>()
            / (output.len() - 2000) as f64)
            .sqrt();
        assert!(
            rms < 0.001,
            "output conversion must not alias 17 kHz into an audible tone: {rms}"
        );
    }

    #[test]
    fn distant_device_rates_do_not_alias_high_frequencies_into_the_voice_band() {
        for (source_rate, target_rate) in [(48000, 8000), (192000, 16000), (768000, 8000)] {
            let mut renderer = DeviceRenderer::new(Tone {
                frames: 0,
                rate: source_rate,
                hz: f64::from(target_rate) * 0.75,
            });
            renderer
                .configure(OutputParams {
                    sample_rate: target_rate,
                    channels: 2,
                })
                .unwrap();
            let mut output = vec![0.0; target_rate as usize * 2];
            renderer.render(&mut output);
            let settled = &output[target_rate as usize / 5 * 2..];
            let rms = (settled
                .iter()
                .map(|sample| f64::from(*sample).powi(2))
                .sum::<f64>()
                / settled.len() as f64)
                .sqrt();
            assert!(
                rms < 0.001,
                "{source_rate} -> {target_rate} Hz aliases out-of-band audio: RMS {rms}"
            );
        }
    }

    #[test]
    fn callback_partitioning_does_not_change_the_converted_audio_or_position() {
        let make = || {
            let mut renderer = DeviceRenderer::new(Tone {
                frames: 0,
                rate: 44100,
                hz: 440.0,
            });
            renderer
                .configure(OutputParams {
                    sample_rate: 48000,
                    channels: 1,
                })
                .unwrap();
            renderer
        };
        let mut whole = make();
        let mut divided = make();
        let mut expected = vec![0.0; 9600];
        let mut actual = expected.clone();
        whole.render(&mut expected);
        for chunk in actual.chunks_mut(19) {
            divided.render(chunk);
        }
        assert_eq!(actual, expected);
        assert_eq!(whole.source.frames, divided.source.frames);
    }
}
