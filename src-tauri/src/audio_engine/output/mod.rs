//! Audio output — cpal device stream.

pub(super) mod format;
pub mod mixer;
pub mod owner;
pub mod playback_envelope;
pub mod resample;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SampleRate, SizedSample, Stream, StreamConfig};
use tracing::{debug, error};

use super::callback::AudioCallbackState;

/// Holds the cpal output stream and related state.
pub struct CpalOutput {
    stream: Option<Stream>,
    pub sample_rate: u32,
    pub channels: u16,
}

impl CpalOutput {
    /// Open the default audio output device and create a stream.
    ///
    /// The `AudioCallbackState` is moved into the cpal closure — it owns all
    /// audio state directly. Zero mutexes on the audio path.
    pub fn open(mut cb_state: AudioCallbackState) -> Result<Self, String> {
        let host = cpal::default_host();
        let device = host
            .default_output_device()
            .ok_or("no default output device")?;

        let config = device
            .default_output_config()
            .map_err(|e| format!("default output config: {}", e))?;

        let sample_rate = config.sample_rate().0;
        let channels = config.channels();
        let sample_format = config.sample_format();
        if sample_rate == 0 || channels == 0 || usize::from(channels) > format::SCRATCH_SAMPLES {
            return Err("invalid audio output rate or channel count".into());
        }

        debug!(
            device = device.name().unwrap_or_default(),
            sample_rate,
            channels,
            ?sample_format,
            "opening audio output"
        );

        // Configure callback state with device params
        cb_state.device_sample_rate = sample_rate;
        cb_state.device_channels = channels;
        cb_state.dsp_chain.set_sample_rate(sample_rate);
        cb_state
            .atomics
            .device_sample_rate
            .store(sample_rate, std::sync::atomic::Ordering::Relaxed);

        let stream_config = StreamConfig {
            channels,
            sample_rate: SampleRate(sample_rate),
            buffer_size: cpal::BufferSize::Default,
        };

        let stream = match sample_format {
            SampleFormat::F32 => device.build_output_stream(
                &stream_config,
                move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                    cb_state.process_callback(data);
                    for sample in data {
                        *sample = format::safe_sample(*sample);
                    }
                },
                stream_error,
                None,
            ),
            SampleFormat::F64 => build_converted::<f64>(&device, &stream_config, cb_state),
            SampleFormat::I8 => build_converted::<i8>(&device, &stream_config, cb_state),
            SampleFormat::I16 => build_converted::<i16>(&device, &stream_config, cb_state),
            SampleFormat::I32 => build_converted::<i32>(&device, &stream_config, cb_state),
            SampleFormat::I64 => build_converted::<i64>(&device, &stream_config, cb_state),
            SampleFormat::U8 => build_converted::<u8>(&device, &stream_config, cb_state),
            SampleFormat::U16 => build_converted::<u16>(&device, &stream_config, cb_state),
            SampleFormat::U32 => build_converted::<u32>(&device, &stream_config, cb_state),
            SampleFormat::U64 => build_converted::<u64>(&device, &stream_config, cb_state),
            other => return Err(format!("unsupported output sample format: {other}")),
        }
        .map_err(|e| format!("build output stream: {e}"))?;

        stream.play().map_err(|e| format!("stream play: {}", e))?;

        Ok(Self {
            stream: Some(stream),
            sample_rate,
            channels,
        })
    }
}

fn stream_error(error: cpal::StreamError) {
    error!("cpal stream error: {error}");
}

fn build_converted<T: SizedSample + FromSample<f32>>(
    device: &cpal::Device,
    config: &StreamConfig,
    mut cb_state: AudioCallbackState,
) -> Result<Stream, cpal::BuildStreamError> {
    let channels = config.channels;
    let mut scratch = [0.0; format::SCRATCH_SAMPLES];
    device.build_output_stream(
        config,
        move |data: &mut [T], _: &cpal::OutputCallbackInfo| {
            format::render(data, channels, &mut scratch, |pcm| {
                cb_state.process_callback(pcm)
            });
        },
        stream_error,
        None,
    )
}

impl Drop for CpalOutput {
    fn drop(&mut self) {
        self.stream.take();
    }
}
