//! Recoverable CPAL output. Device streams stay on their owning thread.

pub mod channelmap;
pub mod device_render;
pub(super) mod format;
pub mod mixer;
pub mod owner;
pub mod playback_envelope;
pub mod resample;

use super::callback::{AudioCallbackState, SharedAtomics};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample, Stream, StreamConfig};
use device_render::RenderSource;
use owner::{CallbackOwner, DeviceSpec, OutputDriver, OutputParams};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::Emitter;
use tracing::{debug, warn};

/// The mixing clock is stable for the lifetime of the playback engine.
/// A later physical rate change is handled by the prepared output adapter.
pub fn initial_mix_params() -> OutputParams {
    let sample_rate = cpal::default_host()
        .default_output_device()
        .and_then(|device| device.default_output_config().ok())
        .map(|config| config.sample_rate().0)
        .filter(|rate| (8000..=768000).contains(rate))
        // Starting on a call/headset output must not discard music bandwidth.
        .map(|rate| rate.max(44100))
        .unwrap_or(48000);
    OutputParams {
        sample_rate,
        channels: 2,
    }
}

impl RenderSource for AudioCallbackState {
    fn params(&self) -> OutputParams {
        OutputParams {
            sample_rate: self.device_sample_rate,
            channels: self.device_channels,
        }
    }
    fn render(&mut self, samples: &mut [f32]) {
        self.process_callback(samples);
    }
    fn poll(&mut self) {
        self.poll_without_output();
    }
    fn has_audio_history(&self) -> bool {
        self.deck_mgr.deck(super::types::DeckId::A).played_frames > 0
            || self.deck_mgr.deck(super::types::DeckId::B).played_frames > 0
    }
}

/// Constructed inside the output owner; CPAL devices and streams never cross threads.
pub struct CpalDriver {
    app: Option<tauri::AppHandle>,
    atomics: Arc<SharedAtomics>,
    probed: Option<cpal::Device>,
    last_error: Option<String>,
}

impl CpalDriver {
    pub fn new(app: tauri::AppHandle, atomics: Arc<SharedAtomics>) -> Self {
        Self {
            app: Some(app),
            atomics,
            probed: None,
            last_error: None,
        }
    }

    fn report_error(&mut self, error: String) {
        if self.last_error.as_ref() != Some(&error) {
            warn!(error = %error, "audio output unavailable; will retry");
            self.last_error = Some(error);
        }
    }
}

impl OutputDriver<AudioCallbackState> for CpalDriver {
    type Stream = Stream;

    fn probe(&mut self) -> Result<DeviceSpec, String> {
        let result: Result<DeviceSpec, String> = (|| {
            let device = cpal::default_host()
                .default_output_device()
                .ok_or("no default output device")?;
            let config = device
                .default_output_config()
                .map_err(|error| format!("default output config: {error}"))?;
            let spec = DeviceSpec {
                name: device.name().unwrap_or_else(|_| "System default".into()),
                params: OutputParams {
                    sample_rate: config.sample_rate().0,
                    channels: config.channels(),
                },
                format: config.sample_format(),
            };
            if !(8000..=768000).contains(&spec.params.sample_rate)
                || spec.params.channels == 0
                || usize::from(spec.params.channels) > format::SCRATCH_SAMPLES
            {
                return Err("unsupported audio output rate or channel count".into());
            }
            self.probed = Some(device);
            Ok(spec)
        })();
        if let Err(error) = &result {
            self.report_error(error.clone());
        }
        result
    }

    fn open(
        &mut self,
        spec: &DeviceSpec,
        callback: CallbackOwner<AudioCallbackState>,
        failed: Arc<AtomicBool>,
    ) -> Result<Stream, String> {
        let result = (|| {
            let device = self
                .probed
                .take()
                .ok_or("audio output device disappeared")?;
            let config = StreamConfig {
                channels: spec.params.channels,
                sample_rate: cpal::SampleRate(spec.params.sample_rate),
                buffer_size: cpal::BufferSize::Default,
            };
            let stream = match spec.format {
                SampleFormat::F32 => build_stream::<f32>(&device, &config, callback, failed),
                SampleFormat::F64 => build_stream::<f64>(&device, &config, callback, failed),
                SampleFormat::I8 => build_stream::<i8>(&device, &config, callback, failed),
                SampleFormat::I16 => build_stream::<i16>(&device, &config, callback, failed),
                SampleFormat::I32 => build_stream::<i32>(&device, &config, callback, failed),
                SampleFormat::I64 => build_stream::<i64>(&device, &config, callback, failed),
                SampleFormat::U8 => build_stream::<u8>(&device, &config, callback, failed),
                SampleFormat::U16 => build_stream::<u16>(&device, &config, callback, failed),
                SampleFormat::U32 => build_stream::<u32>(&device, &config, callback, failed),
                SampleFormat::U64 => build_stream::<u64>(&device, &config, callback, failed),
                other => return Err(format!("unsupported output sample format: {other}")),
            }
            .map_err(|error| format!("build output stream: {error}"))?;
            stream
                .play()
                .map_err(|error| format!("stream play: {error}"))?;
            Ok(stream)
        })();
        match &result {
            Ok(_) => {
                debug!(device = %spec.name, rate = spec.params.sample_rate, channels = spec.params.channels, "audio output opened");
                self.last_error = None;
                if let Some(app) = &self.app {
                    let _ = app.emit("audio-device-changed", &spec.name);
                }
            }
            Err(error) => self.report_error(error.clone()),
        }
        result
    }

    fn availability(&mut self, available: bool) {
        self.atomics
            .output_available
            .store(available, Ordering::Release);
        if let Some(app) = &self.app {
            let _ = app.emit("audio-output-availability", available);
        }
    }
}

fn build_stream<T: SizedSample + FromSample<f32>>(
    device: &cpal::Device,
    config: &StreamConfig,
    mut callback: CallbackOwner<AudioCallbackState>,
    failed: Arc<AtomicBool>,
) -> Result<Stream, cpal::BuildStreamError> {
    let channels = config.channels;
    let mut scratch = [0.0; format::SCRATCH_SAMPLES];
    device.build_output_stream(
        config,
        move |data: &mut [T], _: &cpal::OutputCallbackInfo| {
            format::render(data, channels, &mut scratch, |pcm| callback.render(pcm));
        },
        move |_| {
            failed.store(true, Ordering::Release);
        },
        None,
    )
}

#[cfg(test)]
mod tests {
    use super::owner::OutputThread;
    use super::*;
    use crate::audio_engine::types::{EngineState, TrackMeta};
    use crossbeam_channel::{bounded, Sender};
    use std::time::{Duration, Instant};

    struct ProbeDriver {
        inner: CpalDriver,
        opened: Sender<Arc<AtomicBool>>,
    }
    impl OutputDriver<AudioCallbackState> for ProbeDriver {
        type Stream = Stream;
        fn probe(&mut self) -> Result<DeviceSpec, String> {
            self.inner.probe()
        }
        fn open(
            &mut self,
            spec: &DeviceSpec,
            callback: CallbackOwner<AudioCallbackState>,
            failed: Arc<AtomicBool>,
        ) -> Result<Stream, String> {
            let stream = self.inner.open(spec, callback, failed.clone())?;
            let _ = self.opened.send(failed);
            Ok(stream)
        }
        fn availability(&mut self, available: bool) {
            self.inner.availability(available);
        }
    }

    #[test]
    #[ignore = "opens the real default device using silent PCM; run explicitly on a desktop"]
    fn physical_output_returns_the_native_callback_and_reopens_after_a_stream_failure() {
        let mix = initial_mix_params();
        let atomics = Arc::new(SharedAtomics::new());
        let (_, commands) = bounded(32);
        let (_, samples_a) = bounded(4);
        let (_, samples_b) = bounded(4);
        let (events, _event_rx) = bounded(256);
        let (vis, _vis_rx) = bounded(16);
        let mut source =
            AudioCallbackState::new(commands, samples_a, samples_b, events, vis, atomics.clone());
        source.device_sample_rate = mix.sample_rate;
        source.device_channels = 2;
        source.dsp_chain.set_sample_rate(mix.sample_rate);
        let active = source.deck_mgr.active_deck_mut();
        active.loaded = true;
        active.has_started_playing = true;
        active.sample_rate = mix.sample_rate;
        active.channels = 2;
        active.playback_id = 123;
        active.samples = vec![0.0; mix.sample_rate as usize * 20];
        active.meta = Some(TrackMeta {
            rating_key: -1,
            duration_ms: 10000,
            parent_key: String::new(),
            album_playback: false,
            gain_db: None,
            skip_crossfade: false,
            start_ramp: None,
            end_ramp: None,
            labels: None,
            reporting_binding: None,
        });
        atomics.set_state(EngineState::Playing);
        let (opened, openings) = bounded(4);
        let driver_atomics = atomics.clone();
        let output = OutputThread::start(source, move || ProbeDriver {
            inner: CpalDriver {
                app: None,
                atomics: driver_atomics,
                probed: None,
                last_error: None,
            },
            opened,
        })
        .unwrap();
        let first = openings
            .recv_timeout(Duration::from_secs(3))
            .expect("default audio output did not open");
        let deadline = Instant::now() + Duration::from_secs(3);
        while atomics.position_ms.load(Ordering::Acquire) < 20 {
            assert!(
                Instant::now() < deadline,
                "physical audio callback did not run"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        let position = atomics.position_ms.load(Ordering::Acquire);
        first.store(true, Ordering::Release);
        let replacement = openings
            .recv_timeout(Duration::from_secs(3))
            .expect("stream did not recover its callback after being closed");
        assert!(!Arc::ptr_eq(&first, &replacement));
        let recovered_position = atomics.position_ms.load(Ordering::Acquire);
        assert!(recovered_position >= position);
        let deadline = Instant::now() + Duration::from_secs(3);
        while atomics.position_ms.load(Ordering::Acquire) <= recovered_position + 20 {
            assert!(
                Instant::now() < deadline,
                "replacement stream did not continue playback"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(atomics.active_playback_id.load(Ordering::Acquire), 123);
        assert!(atomics.output_available.load(Ordering::Acquire));
        drop(output);
        let deadline = Instant::now() + Duration::from_secs(3);
        while atomics.output_available.load(Ordering::Acquire) {
            assert!(Instant::now() < deadline, "output owner did not close");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
