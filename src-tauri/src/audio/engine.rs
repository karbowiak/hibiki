#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::thread;

use cpal::traits::DeviceTrait;
use cpal::Stream;
use crossbeam_channel::{bounded, Receiver, Sender};
use ringbuf::traits::Split;
use ringbuf::HeapRb;
use tauri::{AppHandle, Emitter};
use tracing::{error, info, warn};

use super::decoder::decoder_thread;
use super::state::DecoderShared;
use super::output::{start_output, RING_BUFFER_SIZE};
use super::types::{AudioCommand, AudioEvent, PlaybackState};

/// Wrapper for cpal::Stream that is !Send+!Sync on macOS due to PhantomData<*mut ()>.
/// The stream is only ever accessed behind a Mutex so concurrent access is safe.
struct StreamHandle(Stream);

// SAFETY: The Stream is accessed only through a Mutex, so only one thread
// accesses it at a time. On macOS, cpal marks Stream as !Send due to
// PropertyListenerCallbackWrapper containing a Box<dyn FnMut()>, but our
// callbacks capture only Send+Sync state (Arc<DecoderShared>).
unsafe impl Send for StreamHandle {}
unsafe impl Sync for StreamHandle {}

/// The audio engine state managed by Tauri
pub struct AudioEngine {
    cmd_tx: Sender<AudioCommand>,
    shared: Arc<DecoderShared>,
    app_handle: AppHandle,
    /// The cpal output stream — stored so it can be dropped and recreated on device switch.
    /// Arc-shared with the device monitor thread so it can rebuild the stream when
    /// the OS default device changes.
    _stream: Arc<Mutex<Option<StreamHandle>>>,
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
        let (_stream, device_sample_rate, device_name) = start_output(consumer, shared_for_output)?;

        shared
            .device_sample_rate
            .store(device_sample_rate as i64, Ordering::Relaxed);
        *shared.current_device_name.lock().unwrap() = device_name.clone();

        info!(
            device_sample_rate = device_sample_rate,
            device_name = %device_name,
            "Audio output started"
        );

        // Spawn decoder thread — wrapped in catch_unwind so a panic doesn't silently
        // kill the thread and leave cmd_tx disconnected ("sending on a disconnected channel").
        let shared_for_decoder = Arc::clone(&shared);
        thread::Builder::new()
            .name("audio-decode".into())
            .spawn(move || {
                if let Err(e) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    decoder_thread(cmd_rx, event_tx, producer, shared_for_decoder);
                })) {
                    let msg = if let Some(s) = e.downcast_ref::<&str>() {
                        s.to_string()
                    } else if let Some(s) = e.downcast_ref::<String>() {
                        s.clone()
                    } else {
                        "unknown panic".to_string()
                    };
                    error!(error = %msg, "Decoder thread panicked!");
                }
            })
            .map_err(|e| format!("Failed to spawn decoder thread: {e}"))?;

        // Spawn event emitter — forwards AudioEvents to Tauri frontend
        let shared_for_events = Arc::clone(&shared);
        Self::spawn_event_emitter(app_handle.clone(), event_rx, shared_for_events);

        let stream_handle = Arc::new(Mutex::new(Some(StreamHandle(_stream))));

        // Spawn device monitor thread — polls for OS default device changes every 2s
        // and rebuilds the output stream so audio follows the new default device.
        {
            let shared_mon = Arc::clone(&shared);
            let app_mon = app_handle.clone();
            let cmd_tx_mon = cmd_tx.clone();
            let stream_mon = Arc::clone(&stream_handle);
            thread::Builder::new()
                .name("device-monitor".into())
                .spawn(move || {
                    use cpal::traits::HostTrait;
                    let host = cpal::default_host();
                    let mut last_name = host.default_output_device()
                        .and_then(|d| d.name().ok())
                        .unwrap_or_default();

                    loop {
                        thread::sleep(std::time::Duration::from_secs(2));

                        let current = host.default_output_device()
                            .and_then(|d| d.name().ok())
                            .unwrap_or_default();

                        if current != last_name && !current.is_empty() {
                            info!(old = %last_name, new = %current, "Default audio device changed");
                            last_name = current.clone();

                            // Only auto-switch if user is on "System Default" (no explicit preference)
                            let is_system_default = shared_mon.preferred_device_name.lock()
                                .map(|g| g.is_none())
                                .unwrap_or(false);

                            if is_system_default {
                                // Rebuild the output stream so audio actually moves to the new device
                                let rb = HeapRb::<f32>::new(RING_BUFFER_SIZE);
                                let (new_producer, new_consumer) = rb.split();
                                let shared_out = Arc::clone(&shared_mon);
                                match start_output(new_consumer, shared_out) {
                                    Ok((new_stream, new_sr, new_name)) => {
                                        shared_mon.device_sample_rate.store(new_sr as i64, Ordering::Relaxed);
                                        *shared_mon.current_device_name.lock().unwrap() = new_name.clone();
                                        let _ = cmd_tx_mon.send(AudioCommand::SwapProducer(new_producer));
                                        if let Ok(mut guard) = stream_mon.lock() {
                                            *guard = Some(StreamHandle(new_stream));
                                        }
                                        let _ = app_mon.emit("audio-device-changed", serde_json::json!({ "name": new_name }));
                                        info!(device = %new_name, sample_rate = new_sr, "Device monitor rebuilt stream for new default");
                                    }
                                    Err(e) => {
                                        warn!(error = %e, "Device monitor failed to rebuild stream — keeping current");
                                        *shared_mon.current_device_name.lock().unwrap() = current.clone();
                                        let _ = app_mon.emit("audio-device-changed", serde_json::json!({ "name": current }));
                                    }
                                }
                            }
                        }
                    }
                })
                .ok();
        }

        Ok(Self {
            cmd_tx,
            shared,
            app_handle,
            _stream: stream_handle,
        })
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
        self.shared.paused.load(Ordering::Acquire)
    }

    /// Check if current track has finished
    pub fn is_finished(&self) -> bool {
        self.shared.finished.load(Ordering::Acquire)
    }

    /// Warm the audio disk cache for a URL in the background.
    pub fn prefetch_url(&self, url: String) {
        super::cache::prefetch_url_bg(url, Arc::clone(&self.shared));
    }

    /// Set the crossfade window duration in milliseconds. Pass 0 to disable crossfade.
    pub fn set_crossfade_window(&self, ms: u64) {
        let _ = self.cmd_tx.send(AudioCommand::SetCrossfadeWindow(ms));
    }

    /// Set the crossfade mixing style (0=Smooth, 1=DjFilter, 2=EchoOut, 3=HardCut).
    pub fn set_crossfade_style(&self, style: u64) {
        let _ = self.cmd_tx.send(AudioCommand::SetCrossfadeStyle(style));
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

    /// Set the post-EQ makeup gain in dB. Restores volume lost to pregain.
    pub fn set_eq_postgain(&self, db: f32) {
        let _ = self.cmd_tx.send(AudioCommand::SetEqPostgain(db));
    }

    /// Enable or disable auto postgain mode. When enabled, postgain = 1/pregain.
    pub fn set_eq_postgain_auto(&self, auto: bool) {
        let _ = self.cmd_tx.send(AudioCommand::SetEqPostgainAuto(auto));
    }

    /// Get the name of the actual OS audio device currently in use.
    pub fn get_current_device(&self) -> String {
        self.shared.current_device_name.lock()
            .map(|g| g.clone())
            .unwrap_or_default()
    }

    /// Enable or disable crossfade for consecutive same-album tracks.
    /// When false (default), gapless transitions are used for same-album tracks.
    pub fn set_same_album_crossfade(&self, enabled: bool) {
        let _ = self.cmd_tx.send(AudioCommand::SetSameAlbumCrossfade(enabled));
    }

    /// Enable or disable smart crossfade (track analysis for adaptive timing).
    /// When true (default), crossfade skips silence and adapts duration to track energy.
    pub fn set_smart_crossfade(&self, enabled: bool) {
        let _ = self.cmd_tx.send(AudioCommand::SetSmartCrossfade(enabled));
    }

    /// Trigger background analysis for a lookahead track.
    pub fn analyze_track(&self, url: String, rating_key: i64, duration_ms: i64) {
        super::analyzer::analyze_lookahead_bg(url, rating_key, duration_ms, Arc::clone(&self.shared));
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
    /// Takes effect immediately by creating a new output stream.
    pub fn set_preferred_device(&self, name: Option<String>) {
        // Update the preference first
        *self.shared.preferred_device_name.lock().unwrap() = name.clone();

        // Create new ring buffer + output stream for the new device
        let rb = HeapRb::<f32>::new(RING_BUFFER_SIZE);
        let (new_producer, new_consumer) = rb.split();

        let shared_for_output = Arc::clone(&self.shared);
        match start_output(new_consumer, shared_for_output) {
            Ok((new_stream, new_sample_rate, new_device_name)) => {
                self.shared
                    .device_sample_rate
                    .store(new_sample_rate as i64, Ordering::Relaxed);
                *self.shared.current_device_name.lock().unwrap() = new_device_name.clone();

                // Send the new producer to the decoder thread
                let _ = self.cmd_tx.send(AudioCommand::SwapProducer(new_producer));

                // Replace old stream — dropping it stops the old callback
                if let Ok(mut guard) = self._stream.lock() {
                    *guard = Some(StreamHandle(new_stream));
                }

                // Emit device change event so frontend can load matching EQ profile
                let _ = self.app_handle.emit("audio-device-changed", serde_json::json!({ "name": new_device_name }));

                info!(
                    device = %new_device_name,
                    sample_rate = new_sample_rate,
                    "Audio device switched"
                );
            }
            Err(e) => {
                warn!(error = %e, "Failed to switch audio device — keeping current");
            }
        }
    }

    /// List available CPAL output device names for the default host.
    pub fn get_output_devices() -> Vec<String> {
        use cpal::traits::HostTrait;
        let host = cpal::default_host();
        host.output_devices()
            .map(|devs| devs.filter_map(|d| d.name().ok()).collect())
            .unwrap_or_default()
    }

    /// Store a backend-configured HTTP client for audio fetching.
    /// The cache layer will use this client instead of the bare default.
    pub fn set_backend_http(&self, client: reqwest::Client) {
        *self.shared.backend_http.lock().unwrap() = Some(client);
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

    /// Delete all `.audio` and `.analysis` files from the cache directory.
    pub fn clear_cache(&self) {
        let Some(ref cache_dir) = self.shared.cache_dir else { return; };
        let Ok(rd) = std::fs::read_dir(cache_dir) else { return; };
        for entry in rd.filter_map(|e| e.ok()) {
            let ext = entry.path().extension().and_then(|x| x.to_str()).map(String::from);
            if ext.as_deref() == Some("audio") || ext.as_deref() == Some("analysis") {
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
