#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::thread;

use cpal::traits::DeviceTrait;
use crossbeam_channel::{bounded, Receiver, Sender};
use ringbuf::traits::Split;
use ringbuf::HeapRb;
use tauri::{AppHandle, Emitter};
use tracing::info;

use super::decoder::{decoder_thread, DecoderShared};
use super::output::{start_output, RING_BUFFER_SIZE};
use super::types::{AudioCommand, AudioEvent, PlaybackState};

/// The audio engine state managed by Tauri
pub struct AudioEngine {
    cmd_tx: Sender<AudioCommand>,
    shared: Arc<DecoderShared>,
    app_handle: AppHandle,
}

impl AudioEngine {
    /// Create and start the audio engine.
    /// Spawns the decoder thread, starts the cpal output, and begins the event emitter.
    pub fn start(app_handle: AppHandle, cache_dir: Option<PathBuf>) -> Result<Self, String> {
        let (cmd_tx, cmd_rx) = bounded::<AudioCommand>(32);
        let (event_tx, event_rx) = bounded::<AudioEvent>(128);

        let shared = Arc::new(DecoderShared::new(cache_dir));

        // Create ring buffer (SPSC)
        let rb = HeapRb::<f32>::new(RING_BUFFER_SIZE);
        let (producer, consumer) = rb.split();

        // Start cpal output
        let shared_for_output = Arc::clone(&shared);
        let (_stream, device_sample_rate) = start_output(consumer, shared_for_output)?;

        // Store device sample rate so the decoder can resample to match
        shared
            .device_sample_rate
            .store(device_sample_rate as i64, Ordering::Relaxed);

        // We need to keep the stream alive — leak it into a static.
        // cpal drops the stream (and stops audio) when the Stream is dropped.
        // This is fine because the audio engine lives for the app lifetime.
        let stream = Box::new(_stream);
        std::mem::forget(stream);

        info!(
            device_sample_rate = device_sample_rate,
            "Audio output started"
        );

        // Spawn decoder thread
        let shared_for_decoder = Arc::clone(&shared);
        thread::Builder::new()
            .name("audio-decode".into())
            .spawn(move || {
                decoder_thread(cmd_rx, event_tx, producer, shared_for_decoder);
            })
            .map_err(|e| format!("Failed to spawn decoder thread: {e}"))?;

        // Spawn event emitter — forwards AudioEvents to Tauri frontend
        let shared_for_events = Arc::clone(&shared);
        Self::spawn_event_emitter(app_handle.clone(), event_rx, shared_for_events);

        Ok(Self { cmd_tx, shared, app_handle })
    }

    /// Send a command to the audio engine
    pub fn send(&self, cmd: AudioCommand) -> Result<(), String> {
        self.cmd_tx
            .send(cmd)
            .map_err(|e| format!("Failed to send audio command: {e}"))
    }

    /// Get current playback position in milliseconds
    pub fn position_ms(&self) -> i64 {
        self.shared.position_ms()
    }

    /// Check if playback is paused
    pub fn is_paused(&self) -> bool {
        self.shared.paused.load(Ordering::Relaxed)
    }

    /// Check if current track has finished
    pub fn is_finished(&self) -> bool {
        self.shared.finished.load(Ordering::Relaxed)
    }

    /// Warm the audio disk cache for a URL in the background.
    pub fn prefetch_url(&self, url: String) {
        super::decoder::prefetch_url_bg(url, Arc::clone(&self.shared));
    }

    /// Set the crossfade window duration in milliseconds. Pass 0 to disable crossfade.
    pub fn set_crossfade_window(&self, ms: u64) {
        let _ = self.cmd_tx.send(AudioCommand::SetCrossfadeWindow(ms));
    }

    /// Enable or disable ReplayGain audio normalization.
    pub fn set_normalization_enabled(&self, enabled: bool) {
        let _ = self.cmd_tx.send(AudioCommand::SetNormalizationEnabled(enabled));
    }

    /// Set all 10 EQ band gains (in dB). Recomputes biquad coefficients immediately.
    pub fn set_eq(&self, gains_db: [f32; 10]) {
        let _ = self.cmd_tx.send(AudioCommand::SetEq { gains_db });
    }

    /// Enable or disable the 10-band graphic EQ.
    pub fn set_eq_enabled(&self, enabled: bool) {
        let _ = self.cmd_tx.send(AudioCommand::SetEqEnabled(enabled));
    }

    /// Set pre-amp gain in dB (−12..+3). Applied before EQ in the output callback.
    pub fn set_preamp_gain(&self, db: f32) {
        let _ = self.cmd_tx.send(AudioCommand::SetPreampGain(db));
    }

    /// Enable or disable crossfade for consecutive same-album tracks.
    /// When false (default), gapless transitions are used for same-album tracks.
    pub fn set_same_album_crossfade(&self, enabled: bool) {
        let _ = self.cmd_tx.send(AudioCommand::SetSameAlbumCrossfade(enabled));
    }

    /// Enable or disable the PCM IPC bridge for the visualizer.
    ///
    /// Enabling creates a bounded crossbeam channel and spawns a relay thread that
    /// batches PCM chunks from the output callback and emits `audio://vis-frame` events.
    /// Disabling drops the sender so the relay thread exits naturally.
    pub fn set_visualizer_enabled(&self, enabled: bool) {
        if enabled {
            let (tx, rx) = crossbeam_channel::bounded::<Vec<f32>>(16);
            *self.shared.vis_sender.lock().unwrap() = Some(tx);
            let _ = self.cmd_tx.send(AudioCommand::SetVisualizerEnabled(true));

            let app = self.app_handle.clone();
            thread::Builder::new()
                .name("audio-vis-relay".into())
                .spawn(move || {
                    let mut batch: Vec<f32> = Vec::with_capacity(1024);
                    while let Ok(chunk) = rx.recv() {
                        batch.extend_from_slice(&chunk);
                        if batch.len() >= 512 {
                            let payload = batch.clone();
                            let _ = app.emit("audio://vis-frame", payload);
                            batch.clear();
                        }
                    }
                    // Channel dropped — relay thread exits
                })
                .expect("Failed to spawn visualizer relay thread");
        } else {
            let _ = self.cmd_tx.send(AudioCommand::SetVisualizerEnabled(false));
            // Drop the sender; the relay thread will exit when its receiver sees disconnect
            *self.shared.vis_sender.lock().unwrap() = None;
        }
    }

    /// Set the preferred CPAL output device by name.
    /// Pass `None` to revert to the system default.
    /// The new device takes effect on the next `Play` command (stream restart).
    pub fn set_preferred_device(&self, name: Option<String>) {
        let _ = self.cmd_tx.send(AudioCommand::SetPreferredDevice(name));
    }

    /// List available CPAL output device names for the default host.
    pub fn get_output_devices() -> Vec<String> {
        use cpal::traits::HostTrait;
        let host = cpal::default_host();
        host.output_devices()
            .map(|devs| devs.filter_map(|d| d.name().ok()).collect())
            .unwrap_or_default()
    }

    /// Update the maximum audio cache size. Pass 0 for unlimited.
    pub fn set_max_cache_bytes(&self, max_bytes: u64) {
        self.shared.max_cache_bytes.store(max_bytes, Ordering::Relaxed);
    }

    /// Return (total_bytes, file_count) for the audio cache directory.
    pub fn cache_info(&self) -> (u64, u32) {
        let Some(ref cache_dir) = self.shared.cache_dir else {
            return (0, 0);
        };
        let Ok(rd) = std::fs::read_dir(cache_dir) else {
            return (0, 0);
        };
        let mut total_bytes: u64 = 0;
        let mut file_count: u32 = 0;
        for entry in rd.filter_map(|e| e.ok()) {
            if entry.path().extension().and_then(|x| x.to_str()) == Some("audio") {
                if let Ok(meta) = entry.metadata() {
                    total_bytes += meta.len();
                    file_count += 1;
                }
            }
        }
        (total_bytes, file_count)
    }

    /// Delete all `.audio` files from the cache directory.
    pub fn clear_cache(&self) {
        let Some(ref cache_dir) = self.shared.cache_dir else { return; };
        let Ok(rd) = std::fs::read_dir(cache_dir) else { return; };
        for entry in rd.filter_map(|e| e.ok()) {
            if entry.path().extension().and_then(|x| x.to_str()) == Some("audio") {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

    /// Spawn the event emitter task that bridges AudioEvents to Tauri events.
    /// Also emits periodic position updates.
    fn spawn_event_emitter(
        app_handle: AppHandle,
        event_rx: Receiver<AudioEvent>,
        shared: Arc<DecoderShared>,
    ) {
        thread::Builder::new()
            .name("audio-events".into())
            .spawn(move || {
                let mut last_state = PlaybackState::Stopped;
                let mut last_position_emit = std::time::Instant::now();
                let mut current_duration_ms: i64 = 0;
                let mut _current_rating_key: i64 = 0;

                loop {
                    // Try to receive events with a 50ms timeout
                    // This allows us to emit position updates even when no events come in
                    match event_rx.recv_timeout(std::time::Duration::from_millis(50)) {
                        Ok(event) => {
                            match &event {
                                AudioEvent::TrackStarted { rating_key, duration_ms } => {
                                    _current_rating_key = *rating_key;
                                    current_duration_ms = *duration_ms;
                                    last_state = PlaybackState::Playing;
                                    let _ = app_handle.emit("audio://track-started", &event);
                                }
                                AudioEvent::TrackEnded { .. } => {
                                    last_state = PlaybackState::Stopped;
                                    let _ = app_handle.emit("audio://track-ended", &event);
                                }
                                AudioEvent::State { state } => {
                                    last_state = *state;
                                    let _ = app_handle.emit("audio://state", &event);
                                }
                                AudioEvent::Error { .. } => {
                                    let _ = app_handle.emit("audio://error", &event);
                                }
                                AudioEvent::Position { .. } => {
                                    // Position events from the emitter itself (see below)
                                    let _ = app_handle.emit("audio://position", &event);
                                }
                            }
                        }
                        Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
                            // Normal — just continue to emit position
                        }
                        Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                            info!("Event channel disconnected, event emitter exiting");
                            return;
                        }
                    }

                    // Emit position updates every ~250ms when playing
                    if last_state == PlaybackState::Playing
                        && last_position_emit.elapsed() >= std::time::Duration::from_millis(250)
                    {
                        let pos = shared.position_ms();
                        let _ = app_handle.emit(
                            "audio://position",
                            &AudioEvent::Position {
                                position_ms: pos,
                                duration_ms: current_duration_ms,
                            },
                        );
                        last_position_emit = std::time::Instant::now();
                    }
                }
            })
            .expect("Failed to spawn event emitter thread");
    }

    /// Set the duration for position reporting (called when a new track starts)
    pub fn set_current_duration(&self, _duration_ms: i64) {
        // Duration is tracked in the event emitter via TrackStarted events
        // For now this is a no-op; duration comes from the frontend
    }
}

impl Drop for AudioEngine {
    fn drop(&mut self) {
        let _ = self.cmd_tx.send(AudioCommand::Shutdown);
    }
}
