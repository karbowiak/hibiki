//! Audio output — cpal device stream.

pub mod mixer;
pub mod playback_envelope;
pub mod resample;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleRate, Stream, StreamConfig};
use tracing::{debug, error};

use super::callback::AudioCallbackState;

/// Holds the cpal output stream and related state.
pub struct CpalOutput {
    stream: Option<Stream>,
    pub sample_rate: u32,
    pub channels: u16,
}

// SAFETY: CpalOutput is only accessed from a single thread (the thread that
// creates it). The cpal Stream contains raw pointers which prevent auto-Send,
// but we ensure it's never sent across threads after creation.
unsafe impl Send for CpalOutput {}

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

        debug!(
            device = device.name().unwrap_or_default(),
            sample_rate,
            channels,
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

        let err_fn = |err: cpal::StreamError| {
            error!("cpal stream error: {}", err);
        };

        let stream = device
            .build_output_stream(
                &stream_config,
                move |data: &mut [f32], _info: &cpal::OutputCallbackInfo| {
                    cb_state.process_callback(data);
                },
                err_fn,
                None,
            )
            .map_err(|e| format!("build output stream: {}", e))?;

        stream.play().map_err(|e| format!("stream play: {}", e))?;

        Ok(Self {
            stream: Some(stream),
            sample_rate,
            channels,
        })
    }
}

impl Drop for CpalOutput {
    fn drop(&mut self) {
        self.stream.take();
    }
}
