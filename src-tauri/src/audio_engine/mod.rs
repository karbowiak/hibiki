//! Rust audio engine — complete replacement for the Web Audio API engine.
//!
//! Architecture (lock-free audio path):
//! - **Audio callback** (cpal, real-time): owns DeckManager + DspChain + Scheduler.
//!   Reads commands via lock-free channel, reads samples via per-deck channels.
//!   Writes position to atomics. Zero mutexes.
//! - **Control task** (tokio): receives Tauri commands, spawns HTTP fetch + decode
//!   threads, sends AudioCommands to the audio callback.
//! - **Background decode threads** (std::thread): symphonia decode, sends SampleBatch
//!   via per-deck channels to the audio callback.

mod analysis;
pub mod bridge;
pub mod cache;
pub mod callback;
pub mod command;
pub mod crossfade;
pub mod deck;
pub(crate) mod diagnostics;
pub(crate) mod download;
pub mod dsp;
pub(crate) mod event;
pub mod loudness;
pub mod output;
mod preparation;
mod request;
pub(crate) mod source;
pub mod state;
pub mod types;
pub mod visualizer;
mod waveform;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crossbeam_channel::{bounded, Sender};
use tauri::Emitter;
use tracing::{debug, info, warn};

use self::analysis::LoudnessAnalysis;
use self::cache::AudioCache;
use self::callback::{AudioCallbackState, SharedAtomics};
use self::command::{AudioCommand, Command, ControlCommand, PlaybackControl, SampleBatch, SeekRequest};
use self::crossfade::types::{parse_ramp, CrossfadeSettings, TrackRamps};
use self::deck::decode;
use self::event::EngineEvent;
use self::output::channelmap::StereoDownmix;
use self::output::owner::OutputThread;
use self::output::resample::StreamingResampler;
use self::output::CpalDriver;
use self::request::PlaybackRequest;
use self::source::MediaSource;
use self::types::{DeckId, EngineState, TrackMeta};
use self::visualizer::VisualizerProcessor;

/// The main audio engine handle, held as Tauri managed state.
///
/// Only holds the command channel and shared atomics — both are Send+Sync.
/// The cpal output stream lives on a dedicated holder thread.
pub struct AudioEngine {
    cmd_tx: Sender<ControlCommand>,
    command_admission: Mutex<()>,
    audio_cmd_tx: Sender<AudioCommand>,
    atomics: Arc<SharedAtomics>,
    cache: Arc<AudioCache>,
    _output: Option<OutputThread>,
    lifetime: EngineLifetime,
    startup_error: Option<String>,
    pub(crate) history: Arc<crate::listening_history::NativeHistory>,
    closing: AtomicBool,
}

/// Stops auxiliary tasks if engine startup fails or the handle is released.
struct EngineLifetime(Arc<AtomicBool>);

impl EngineLifetime {
    fn new() -> Self {
        Self(Arc::new(AtomicBool::new(true)))
    }
}

impl Drop for EngineLifetime {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl Drop for AudioEngine {
    fn drop(&mut self) {
        self.lifetime.0.store(false, Ordering::Release);
        let _ = self.send(Command::Shutdown);
    }
}

impl AudioEngine {
    /// Keep native commands available when no output device could be opened.
    pub fn unavailable(app_handle: &tauri::AppHandle, error: String) -> Self {
        let (cmd_tx, _) = crossbeam_channel::unbounded();
        let (audio_cmd_tx, _) = crossbeam_channel::bounded(1);
        Self {
            cmd_tx,
            command_admission: Mutex::new(()),
            audio_cmd_tx,
            atomics: Arc::new(SharedAtomics::new()),
            cache: Self::open_cache(app_handle),
            _output: None,
            lifetime: EngineLifetime::new(),
            startup_error: Some(error),
            history: crate::listening_history::NativeHistory::new(),
            closing: AtomicBool::new(false),
        }
    }

    fn open_cache(app_handle: &tauri::AppHandle) -> Arc<AudioCache> {
        use tauri::Manager;
        let cache_dir = app_handle
            .path()
            .app_cache_dir()
            .map(|d| d.join("audiocache"))
            .unwrap_or_else(|_| std::path::PathBuf::from("audiocache"));
        Arc::new(AudioCache::new(cache_dir, None))
    }

    /// Create and start the audio engine.
    ///
    /// Creates the audio callback state, opens the cpal output (which consumes
    /// the callback state), and spawns the control task and auxiliary tasks.
    pub fn start(app_handle: tauri::AppHandle) -> Result<Self, String> {
        let atomics = Arc::new(SharedAtomics::new());
        let lifetime = EngineLifetime::new();
        let history = crate::listening_history::NativeHistory::new();
        let history_tx = history
            .start(app_handle.clone())
            .map_err(|error| error.to_string())?;

        // Audio file cache (raw FLAC/MP3/AAC from Plex, stored on disk)
        let audio_cache = Self::open_cache(&app_handle);

        // Bridge → control task
        let (cmd_tx, cmd_rx) = crossbeam_channel::unbounded::<ControlCommand>();

        // Control task → audio callback (commands)
        let (audio_cmd_tx, audio_cmd_rx) = crossbeam_channel::bounded::<AudioCommand>(256);

        // Bg decode → audio callback (per-deck sample channels)
        let (deck_a_tx, deck_a_rx) = crossbeam_channel::bounded::<SampleBatch>(4);
        let (deck_b_tx, deck_b_rx) = crossbeam_channel::bounded::<SampleBatch>(4);

        // Audio callback → event relay (events to JS)
        let (event_tx, event_rx) = bounded::<EngineEvent>(256);

        // Audio callback → visualizer task (PCM chunks for FFT)
        let (vis_tx, vis_rx) = visualizer::transport::channel();

        // Create the callback state — it will be moved into the cpal closure
        let mut cb_state = AudioCallbackState::new(
            audio_cmd_rx,
            deck_a_rx,
            deck_b_rx,
            event_tx.clone(),
            vis_tx,
            atomics.clone(),
        );

        let mix = output::initial_mix_params();
        cb_state.device_sample_rate = mix.sample_rate;
        cb_state.device_channels = mix.channels;
        cb_state.dsp_chain.set_sample_rate(mix.sample_rate);
        atomics
            .device_sample_rate
            .store(mix.sample_rate, Ordering::Relaxed);
        let output_app = app_handle.clone();
        let output_atomics = atomics.clone();
        // Keep callback state when replacing or temporarily losing the physical device.
        cb_state.set_history_sender(history_tx);
        let output = OutputThread::start(cb_state, move || {
            CpalDriver::new(output_app, output_atomics)
        })
        .map_err(|e| format!("failed to open audio output: {e}"))?;

        let device_sample_rate = output.params.sample_rate;
        let device_channels = output.params.channels;

        info!(
            sample_rate = device_sample_rate,
            channels = device_channels,
            "audio engine started"
        );

        // Event relay thread (blocking recv, sends Tauri events to JS)
        let app_for_events = app_handle.clone();
        std::thread::Builder::new()
            .name("audio-events".into())
            .spawn(move || {
                while let Ok(event) = event_rx.recv() {
                    let event_name = match &event {
                        EngineEvent::TransitionScheduled { .. } => "audio://transition-scheduled",
                        EngineEvent::Position { .. } => "audio://position",
                        EngineEvent::State { .. } => "audio://state",
                        EngineEvent::TrackStarted { .. } => "audio://track-started",
                        EngineEvent::TrackEnded { .. } => "audio://track-ended",
                        EngineEvent::Error { .. } => "audio://error",
                    };
                    let _ = app_for_events.emit(event_name, &event);
                }
            })
            .ok();

        // Position polling task (reads atomics — zero locks)
        let atomics_pos = atomics.clone();
        let event_tx_pos = event_tx.clone();
        let running_pos = lifetime.0.clone();
        tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(250));
            loop {
                interval.tick().await;
                if !running_pos.load(Ordering::Acquire) {
                    break;
                }
                if atomics_pos.get_state() != EngineState::Playing {
                    continue;
                }
                let Some((pos_ms, dur_ms, playback_id)) = atomics_pos.position_snapshot() else {
                    continue;
                };
                let _ = event_tx_pos.try_send(EngineEvent::Position {
                    request_id: atomics_pos.active_request_id.load(Ordering::SeqCst),
                    playback_id,
                    position_ms: if dur_ms > 0 {
                        pos_ms.min(dur_ms)
                    } else {
                        pos_ms
                    },
                    duration_ms: dur_ms,
                });
            }
        });

        // Visualizer task (~60fps, receives PCM from audio callback via channel,
        // accumulates into a rolling buffer, computes FFT, emits events)
        let app_for_visualizer = app_handle.clone();
        let running_vis = lifetime.0.clone();
        tauri::async_runtime::spawn(async move {
            let mut vis = VisualizerProcessor::new(device_channels);
            let mut interval = tokio::time::interval(Duration::from_millis(16));
            loop {
                interval.tick().await;
                if !running_vis.load(Ordering::Acquire) {
                    break;
                }
                // Drain all pending PCM chunks into the rolling buffer
                let mut got_data = false;
                while let Ok(samples) = vis_rx.try_recv() {
                    vis.push_samples(&samples);
                    vis_rx.recycle(samples);
                    got_data = true;
                }
                if !got_data {
                    continue;
                }
                if let Some(frame) = vis.compute() {
                    let _ = app_for_visualizer.emit("audio://vis-frame", &frame);
                }
            }
        });

        let analysis = LoudnessAnalysis::start(
            atomics.clone(), lifetime.0.clone(),
        ).map_err(|error| {
            warn!(%error, "cannot start loudness preparation");
            error
        }).ok();

        // Control task — receives Commands, spawns decode work, sends AudioCommands
        let audio_cmd_for_control = audio_cmd_tx.clone();
        let atomics_control = atomics.clone();
        let cache_control = audio_cache.clone();
        std::thread::Builder::new()
            .name("audio-control".into())
            .spawn(move || {
                control_thread_main(
                    cmd_rx,
                    audio_cmd_for_control,
                    deck_a_tx,
                    deck_b_tx,
                    event_tx,
                    atomics_control,
                    cache_control,
                    analysis,
                    device_sample_rate,
                    device_channels,
                );
            })
            .map_err(|e| format!("failed to spawn control thread: {}", e))?;

        Ok(Self {
            cmd_tx,
            command_admission: Mutex::new(()),
            audio_cmd_tx,
            atomics,
            cache: audio_cache,
            _output: Some(output),
            lifetime,
            startup_error: None,
            history: history.clone(),
            closing: AtomicBool::new(false),
        })
    }

    pub(crate) fn prepare_shutdown(
        &self,
    ) -> Result<Vec<crate::listening_history::PlaybackEnd>, String> {
        if self.startup_error.is_some() {
            return self.history.pending();
        }
        let (reply, receive) = crossbeam_channel::bounded(1);
        {
            let _admission = self
                .command_admission
                .lock()
                .map_err(|_| "Audio admission unavailable")?;
            self.closing.store(true, Ordering::Release);
            let request_id = self.atomics.request_epoch.fetch_add(1, Ordering::SeqCst) + 1;
            self.audio_cmd_tx
                .send_timeout(
                    AudioCommand::PrepareShutdown { request_id, reply },
                    Duration::from_millis(250),
                )
                .map_err(|_| "Audio shutdown could not reach the callback")?;
        }
        receive
            .recv_timeout(Duration::from_secs(3))
            .map_err(|_| "Audio shutdown acknowledgement timed out".to_owned())?
    }
    pub(crate) fn primary_timeline_allowed(&self, end: &crate::listening_history::PlaybackEnd) -> bool {
        self.closing.load(Ordering::Acquire)
            && self.atomics.get_state() == self::types::EngineState::Stopped
            && self.atomics.request_epoch.load(Ordering::Acquire) == end.request_id
    }
    pub(crate) fn cancel_shutdown(&self) {
        self.closing.store(false, Ordering::Release);
    }

    /// Playback intent is invalidated here, before queued I/O can observe it.
    /// Interactive controls bypass the I/O worker so a slow server cannot block pause/seek.
    pub fn send(&self, mut cmd: Command) -> Result<u64, String> {
        // Only admission is serialized; the real-time callback never locks.
        // Publishing Stop and admitting a subsequent Play must have one order.
        let _admission = self
            .command_admission
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if self.closing.load(Ordering::Acquire)
            && matches!(
                &cmd,
                Command::Play { .. } | Command::PreloadNext { .. } | Command::Resume
            )
        {
            return Err("Hibiki is preparing to close".into());
        }
        if let Some(error) = &self.startup_error {
            if !matches!(&cmd, Command::Stop | Command::Shutdown) {
                return Err(error.clone());
            }
        }
        let epoch = if matches!(
            &cmd,
            Command::Play { .. } | Command::Stop | Command::Shutdown
        ) {
            self.atomics.request_epoch.fetch_add(1, Ordering::SeqCst) + 1
        } else {
            self.atomics.request_epoch.load(Ordering::SeqCst)
        };
        if let Command::Play { source, meta } | Command::PreloadNext { source, meta } = &mut cmd {
            meta.reporting_binding
                .get_or_insert_with(Default::default)
                .plex = source.plex_scope.clone();
        }
        if matches!(&cmd, Command::Stop | Command::Shutdown) {
            self.atomics.stop_revision.store(epoch, Ordering::SeqCst);
            if matches!(&cmd, Command::Stop) {
                return Ok(epoch);
            }
        }
        if matches!(&cmd, Command::ClearPreload) {
            self.atomics.preload_revision.fetch_add(1, Ordering::SeqCst);
            self.atomics.preparation_revision.fetch_add(1, Ordering::SeqCst);
        }
        let preload_revision = self.atomics.preload_revision.load(Ordering::SeqCst);
        let audio = match cmd {
            Command::Play { .. } => {
                self.audio_cmd_tx
                    .try_send(AudioCommand::BeginPlay { request_id: epoch })
                    .map_err(|_| "audio callback is unavailable".to_string())?;
                return self
                    .cmd_tx
                    .send(ControlCommand {
                        epoch,
                        preload_revision,
                        command: cmd,
                    })
                    .map(|_| epoch)
                    .map_err(|_| "audio engine is unavailable".into());
            }
            Command::ClearPreload => AudioCommand::PlaybackControl {
                request_id: epoch,
                control: PlaybackControl::ClearPreload,
            },
            Command::Pause => AudioCommand::PlaybackControl {
                request_id: epoch,
                control: PlaybackControl::Pause,
            },
            Command::Resume => AudioCommand::PlaybackControl {
                request_id: epoch,
                control: PlaybackControl::Resume,
            },
            Command::Seek { position_ms } => AudioCommand::PlaybackControl {
                request_id: epoch,
                control: PlaybackControl::SeekInBuffer {
                    position: position_ms as usize,
                },
            },
            Command::SetVolume { gain } => AudioCommand::SetVolume(gain),
            Command::SetNormalization { enabled } => {
                let _preference_admission=self.atomics.normalization_admission.lock().map_err(|_|"Audio preference unavailable".to_string())?;
                self.audio_cmd_tx.try_send(AudioCommand::SetNormalization(enabled))
                    .map_err(|_|"audio callback is unavailable".to_string())?;
                self.atomics.normalization_enabled.store(enabled, Ordering::SeqCst);
                return Ok(epoch);
            },
            Command::SetPreampGain { db } => AudioCommand::SetPreampGain(db),
            Command::SetEq { gains_db } => AudioCommand::SetEq(gains_db),
            Command::SetEqEnabled { enabled } => AudioCommand::SetEqEnabled(enabled),
            Command::SetEqPostgain { db } => AudioCommand::SetEqPostgain(db),
            Command::ConfigureEq {
                gains_db,
                enabled,
                postgain_db,
                duck_ms,
            } => AudioCommand::ConfigureEq {
                gains_db,
                enabled,
                postgain_db,
                duck_ms,
            },
            Command::SetVisualizerEnabled { enabled } => {
                AudioCommand::SetVisualizerEnabled(enabled)
            }
            Command::DuckAndApply { duck_ms } => AudioCommand::DuckAndApply { duck_ms },
            _ => {
                return self
                    .cmd_tx
                    .send(ControlCommand {
                        epoch,
                        preload_revision,
                        command: cmd,
                    })
                    .map(|_| epoch)
                    .map_err(|_| "audio engine is unavailable".into())
            }
        };
        self.audio_cmd_tx
            .try_send(audio)
            .map(|_| epoch)
            .map_err(|_| "audio callback is unavailable".into())
    }

    pub(crate) fn normalization_enabled(&self)->bool {
        self.atomics.normalization_is_enabled()
    }

    pub(super) fn begin_queue_preparation(
        &self,
        request_id: u64,
        batch: u64,
    ) -> Result<Option<u64>, String> {
        let _admission = self
            .command_admission
            .lock()
            .map_err(|_| "Audio admission unavailable")?;
        if self.closing.load(Ordering::Acquire)
            || self.startup_error.is_some()
            || request_id != self.atomics.request_epoch.load(Ordering::SeqCst)
        {
            return Ok(None);
        }
        let mut order = self
            .atomics
            .preparation_order
            .lock()
            .map_err(|_| "Audio preparation unavailable")?;
        if *order >= (request_id, batch) {
            return Ok(None);
        }
        *order = (request_id, batch);
        Ok(Some(
            self.atomics
                .preparation_revision
                .fetch_add(1, Ordering::SeqCst)
                + 1,
        ))
    }

    pub(super) fn finish_queue_preparation(
        &self,
        request_id: u64,
        revision: u64,
        tracks: Vec<preparation::Track>,
    ) -> Result<(), String> {
        let _admission = self
            .command_admission
            .lock()
            .map_err(|_| "Audio admission unavailable")?;
        if self.closing.load(Ordering::Acquire)
            || request_id != self.atomics.request_epoch.load(Ordering::SeqCst)
            || revision != self.atomics.preparation_revision.load(Ordering::SeqCst)
        {
            return Ok(());
        }
        self.cmd_tx
            .send(ControlCommand {
                epoch: request_id,
                preload_revision: self.atomics.preload_revision.load(Ordering::SeqCst),
                command: Command::PrepareQueue { revision, tracks },
            })
            .map_err(|_| "Audio engine unavailable".into())
    }

    pub fn cache(&self) -> &Arc<AudioCache> {
        &self.cache
    }

    pub(super) fn waveform_request(&self, request_id: u64) -> Result<PlaybackRequest, String> {
        if self.closing.load(Ordering::Acquire)
            || request_id != self.atomics.request_epoch.load(Ordering::SeqCst)
        {
            return Err("Waveform superseded".into());
        }
        let running = self.lifetime.0.clone();
        Ok(PlaybackRequest::new(
            request_id,
            self.atomics.request_epoch.clone(),
            Arc::new(std::sync::atomic::AtomicU64::new(0)),
        )
        .while_background(move || running.load(Ordering::Acquire)))
    }

    pub(crate) fn diagnostics(&self) -> Option<diagnostics::Snapshot> {
        self.atomics.diagnostics.snapshot(&self.atomics)
    }

    pub fn output_available(&self) -> bool {
        self.atomics.output_available.load(Ordering::Acquire)
    }

    pub fn sample_rate(&self) -> Result<u32, String> {
        if let Some(error) = &self.startup_error {
            return Err(error.clone());
        }
        Ok(self.atomics.device_sample_rate.load(Ordering::Relaxed))
    }

    /// Prepare headroom without occupying the real-time callback or I/O worker.
    pub fn configure_eq(
        &self,
        gains_db: [f32; 10],
        enabled: bool,
        postgain_db: Option<f32>,
        duck_ms: u32,
    ) -> Result<f32, String> {
        let rate = self.sample_rate()?;
        let postgain_db = match postgain_db {
            Some(db) if db.is_finite() => db.clamp(-24.0, 24.0),
            Some(_) => return Err("Invalid EQ postgain".into()),
            None => dsp::equalizer::Equalizer::auto_postgain_db(&gains_db, rate),
        };
        self.send(Command::ConfigureEq {
            gains_db,
            enabled,
            postgain_db,
            duck_ms: duck_ms.min(100),
        })?;
        Ok(postgain_db)
    }
}

// ---------------------------------------------------------------------------
// Control thread — translates Commands into AudioCommands + spawns decode work
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn control_thread_main(
    cmd_rx: crossbeam_channel::Receiver<ControlCommand>,
    audio_cmd_tx: Sender<AudioCommand>,
    deck_a_tx: Sender<SampleBatch>,
    deck_b_tx: Sender<SampleBatch>,
    event_tx: Sender<EngineEvent>,
    atomics: Arc<SharedAtomics>,
    cache: Arc<AudioCache>,
    analysis: Option<LoudnessAnalysis>,
    device_sample_rate: u32,
    device_channels: u16,
) {
    let rt = tauri::async_runtime::handle().inner().clone();
    let mut crossfade_settings = CrossfadeSettings::default();
    // Track what's preloaded on the pending deck so we can skip re-fetching
    let mut pending_source_key = String::new();
    let mut pending_owner: Option<(DeckId, u64)> = None;

    /// Read which deck is currently active from the shared atomic.
    /// The pending deck (for preloads/next play) is always the other one.
    fn pending_deck(atomics: &SharedAtomics) -> DeckId {
        let active = atomics.active_deck_id.load(Ordering::Relaxed);
        if active == 0 {
            DeckId::B
        } else {
            DeckId::A
        }
    }

    let mut preparation: Option<(u64, u64, std::collections::VecDeque<preparation::Track>)> = None;
    loop {
        // Commands always take priority over speculative transfers and measurement.
        // Interrupted work remains queued so a new preload cannot lose the rest
        // of the warming batch. No background job owns a physical playback deck.
        if cmd_rx.is_empty() {
            if let Some((epoch, revision, tracks)) = preparation.as_mut() {
                if *epoch != atomics.request_epoch.load(Ordering::SeqCst)
                    || *revision != atomics.preparation_revision.load(Ordering::SeqCst)
                {
                    preparation = None;
                } else if let Some(track) = tracks.pop_front() {
                    let commands = cmd_rx.clone();
                    let revoked = AtomicBool::new(false);
                    let request = PlaybackRequest::new(
                        *epoch,
                        atomics.request_epoch.clone(),
                        Arc::new(std::sync::atomic::AtomicU64::new(0)),
                    )
                    .for_preload(atomics.preparation_revision.clone(), *revision)
                    .while_background(move || {
                        if !commands.is_empty() {
                            revoked.store(true, Ordering::SeqCst);
                        }
                        !revoked.load(Ordering::SeqCst)
                    });
                    if let Err(error) =
                        preparation::prepare(&track, &cache, &rt, &request, analysis.as_ref())
                    {
                        if !request.is_current() {
                            tracks.push_front(track);
                        } else {
                            debug!(%error, "queue audio preparation unavailable");
                        }
                    }
                    continue;
                } else {
                    preparation = None;
                }
            }
        }
        let Ok(ControlCommand {
            epoch,
            preload_revision,
            command,
        }) = cmd_rx.recv()
        else {
            break;
        };
        if epoch != atomics.request_epoch.load(Ordering::SeqCst) {
            continue;
        }
        match command {
            Command::PrepareQueue { revision, tracks } => {
                if revision == atomics.preparation_revision.load(Ordering::SeqCst) {
                    preparation = Some((epoch, revision, tracks.into()));
                }
            }
            Command::Play { source, meta } => {
                pending_source_key.clear();
                // Keep an existing overlap audible before reusing its outgoing
                // physical deck. A newer selection can cancel this wait.
                while atomics.crossfading.load(Ordering::SeqCst)
                    && epoch == atomics.request_epoch.load(Ordering::SeqCst)
                {
                    std::thread::sleep(Duration::from_millis(5));
                }
                if epoch != atomics.request_epoch.load(Ordering::SeqCst) {
                    continue;
                }
                let deck = pending_deck(&atomics);
                let request = make_request(epoch, deck, &atomics);
                let source = match source.resolve(&rt, &request) {
                    Ok(source) => source,
                    Err(message) => {
                        if request.is_current() {
                            let _ = audio_cmd_tx.send(AudioCommand::FailPlay { request_id: epoch, message });
                        }
                        continue;
                    }
                };
                handle_play(
                    &source,
                    &meta,
                    deck,
                    &audio_cmd_tx,
                    deck_tx(deck, &deck_a_tx, &deck_b_tx),
                    &event_tx,
                    &rt,
                    &atomics,
                    &cache,
                    analysis.as_ref(),
                    &crossfade_settings,
                    device_sample_rate,
                    device_channels,
                    &request,
                );
                // Only the callback owns deck swaps. Wait for acknowledgement before
                // choosing a deck for the next preload, with cancellation and a bound.
                let deadline = std::time::Instant::now() + Duration::from_secs(1);
                while request.is_current()
                    && atomics.active_request_id.load(Ordering::SeqCst) != epoch
                    && std::time::Instant::now() < deadline
                {
                    std::thread::sleep(Duration::from_millis(5));
                }
            }
            Command::PreloadNext { source, meta } => {
                if preload_revision != atomics.preload_revision.load(Ordering::SeqCst) {
                    continue;
                }
                let pending = pending_deck(&atomics);
                let owner = match pending {
                    DeckId::A => &atomics.deck_a_load_id,
                    DeckId::B => &atomics.deck_b_load_id,
                };
                if source.cache_key == pending_source_key
                    && pending_owner == Some((pending, owner.load(Ordering::SeqCst)))
                    && atomics.preload_error_rk.load(Ordering::SeqCst) != meta.rating_key
                {
                    continue;
                }
                // The pending physical deck still holds audible outgoing samples
                // during an overlap. Do not replace it until the fade has finished.
                while atomics.crossfading.load(Ordering::SeqCst)
                    && epoch == atomics.request_epoch.load(Ordering::SeqCst)
                    && preload_revision == atomics.preload_revision.load(Ordering::SeqCst)
                {
                    std::thread::sleep(Duration::from_millis(5));
                }
                if epoch != atomics.request_epoch.load(Ordering::SeqCst) {
                    continue;
                }
                let deck = pending_deck(&atomics);
                let request = make_request(epoch, deck, &atomics)
                    .for_preload(atomics.preload_revision.clone(), preload_revision);
                let source_key = source.cache_key.clone();
                if source.requires_resolution() {
                    // Clear the previous next song before a potentially slow
                    // lookup, so it cannot transition while its replacement loads.
                    let _ = audio_cmd_tx.send(AudioCommand::PreparePreload { request_id: epoch, deck });
                }
                let source = match source.resolve(&rt, &request) {
                    Ok(source) => source,
                    Err(error) => {
                        if request.is_current() {
                            atomics.preload_error_rk.store(meta.rating_key, Ordering::SeqCst);
                            warn!(%error, "preload media lookup failed");
                        }
                        continue;
                    }
                };
                handle_preload(
                    &source,
                    &meta,
                    deck,
                    &audio_cmd_tx,
                    deck_tx(deck, &deck_a_tx, &deck_b_tx),
                    &event_tx,
                    &rt,
                    &atomics,
                    &cache,
                    analysis.as_ref(),
                    &crossfade_settings,
                    device_sample_rate,
                    device_channels,
                    &request,
                );
                let loaded = match deck {
                    DeckId::A => &atomics.deck_a_loaded_id,
                    DeckId::B => &atomics.deck_b_loaded_id,
                };
                if request.is_current() && loaded.load(Ordering::SeqCst) == request.load_id {
                    pending_source_key = source_key;
                    pending_owner = Some((deck, request.load_id));
                }
            }
            Command::SetCrossfadeWindow { ms } => {
                crossfade_settings.crossfade_window_ms = ms;
                let _ = audio_cmd_tx.send(AudioCommand::UpdateCrossfadeSettings(
                    crossfade_settings.clone(),
                ));
            }
            Command::SetSameAlbumCrossfade { enabled } => {
                crossfade_settings.same_album_crossfade = enabled;
                let _ = audio_cmd_tx.send(AudioCommand::UpdateCrossfadeSettings(
                    crossfade_settings.clone(),
                ));
            }
            Command::SetSmartCrossfade { enabled } => {
                crossfade_settings.smart_crossfade = enabled;
                let _ = audio_cmd_tx.send(AudioCommand::UpdateCrossfadeSettings(
                    crossfade_settings.clone(),
                ));
            }
            Command::SetSmartCrossfadeMax { ms } => {
                crossfade_settings.smart_crossfade_max_ms = ms;
                let _ = audio_cmd_tx.send(AudioCommand::UpdateCrossfadeSettings(
                    crossfade_settings.clone(),
                ));
            }
            Command::SetMixrampDb { db } => {
                crossfade_settings.mixramp_db = db;
                let _ = audio_cmd_tx.send(AudioCommand::UpdateCrossfadeSettings(
                    crossfade_settings.clone(),
                ));
            }
            Command::Shutdown => break,
            _ => unreachable!("interactive commands are dispatched directly to the callback"),
        }
    }
}

fn make_request(epoch: u64, deck: DeckId, atomics: &SharedAtomics) -> PlaybackRequest {
    let owner = match deck {
        DeckId::A => atomics.deck_a_load_id.clone(),
        DeckId::B => atomics.deck_b_load_id.clone(),
    };
    let loaded = match deck {
        DeckId::A => atomics.deck_a_loaded_id.clone(),
        DeckId::B => atomics.deck_b_loaded_id.clone(),
    };
    PlaybackRequest::new(epoch, atomics.request_epoch.clone(), owner)
        .with_stop_guard(atomics.stop_revision.clone())
        .with_audible_deck(
            atomics.active_deck_id.clone(),
            if deck == DeckId::A { 0 } else { 1 },
            atomics.crossfading.clone(),
            loaded,
        )
}

fn wait_for_load(deck: DeckId, request: &PlaybackRequest, atomics: &SharedAtomics) {
    let loaded = match deck {
        DeckId::A => &atomics.deck_a_loaded_id,
        DeckId::B => &atomics.deck_b_loaded_id,
    };
    let deadline = std::time::Instant::now() + Duration::from_secs(1);
    while request.is_current()
        && loaded.load(Ordering::SeqCst) != request.load_id
        && std::time::Instant::now() < deadline
    {
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// Get the sample channel sender for the given deck.
fn deck_tx<'a>(
    deck: DeckId,
    a: &'a Sender<SampleBatch>,
    b: &'a Sender<SampleBatch>,
) -> &'a Sender<SampleBatch> {
    match deck {
        DeckId::A => a,
        DeckId::B => b,
    }
}

// ---------------------------------------------------------------------------
// Play / Preload handlers
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn handle_play(
    source: &MediaSource,
    meta: &TrackMeta,
    deck: DeckId,
    audio_cmd_tx: &Sender<AudioCommand>,
    sample_tx: &Sender<SampleBatch>,
    _event_tx: &Sender<EngineEvent>,
    rt: &tokio::runtime::Handle,
    atomics: &Arc<SharedAtomics>,
    cache: &Arc<AudioCache>,
    analysis: Option<&LoudnessAnalysis>,
    _xfade: &CrossfadeSettings,
    device_rate: u32,
    device_channels: u16,
    request: &PlaybackRequest,
) {
    if !request.is_current() {
        return;
    }
    debug!(rating_key = meta.rating_key, ?deck, "play command");
    let preparation_started = std::time::Instant::now();

    // The callback owns playback state, including pause during loading.

    let norm_enabled = true; // Callback applies the current normalization preference.

    // Increment generation to invalidate any old bg decode threads writing to this deck
    let generation = match deck {
        DeckId::A => atomics.deck_a_generation.fetch_add(1, Ordering::Relaxed) + 1,
        DeckId::B => atomics.deck_b_generation.fetch_add(1, Ordering::Relaxed) + 1,
    };

    match fetch_and_decode_incremental(
        source,
        meta.rating_key,
        cache,
        rt,
        device_rate,
        device_channels,
        request,
    ) {
        Ok(result) => {
            if !request.is_current() {
                return;
            }
            if result.aborted {
                let _ = audio_cmd_tx.send(AudioCommand::FailPlay {
                    request_id: request.epoch,
                    message: "The media stream was interrupted before playback could start".into(),
                });
                return;
            }
            let source_rate = result.source_rate;
            let source_channels = result.source_channels;
            let has_more = result.has_more;
            let decode_ms = preparation_started.elapsed().as_millis() as u64;
            let gain_started = std::time::Instant::now();
            let gain_db = match prepare_gain_db(meta, source, deck, request, cache, atomics, analysis, &result) {
                Ok(gain)=>gain,
                Err(error)=>{if request.is_current(){let _=audio_cmd_tx.send(AudioCommand::FailPlay{request_id:request.epoch,message:format!("Could not prepare track loudness: {error}")});}return}
            };
            if !request.is_current() {
                return;
            }
            tracing::info!(rating_key = meta.rating_key, decode_ms, normalization_ms = gain_started.elapsed().as_millis() as u64,
                "Audio prepared for playback");
            let source_kind = if result.cached_stamp.is_some() {
                if source.local_cache.as_ref().is_some_and(|local| !Arc::ptr_eq(local, cache)) { "download" } else { "cache" }
            } else { "network" };
            atomics.diagnostics.record_source(deck, request.load_id, source_kind, result.source_bytes, result.spool.as_ref().map(|spool| spool.transfer_progress()));
            let mut resolved_meta = meta.clone();
            resolved_meta.gain_db = gain_db;
            resolved_meta.source_format = result.source_format;
            let norm_gain = if norm_enabled {
                loudness::replay_gain(gain_db)
            } else {
                1.0
            };

            // Pre-compute expected samples for pre-allocation
            let expected_total =
                if meta.duration_ms > 0 && result.sample_rate > 0 && result.channels > 0 {
                    (meta.duration_ms as f64 / 1000.0
                        * result.sample_rate as f64
                        * result.channels as f64) as usize
                } else {
                    result.initial_samples.len()
                };

            let (seek_tx, seek_rx) = crossbeam_channel::unbounded();
            let can_seek = result.decoder.is_some();
            // Tell audio callback to prepare the deck
            let _ = audio_cmd_tx.send(AudioCommand::LoadDeck {
                deck,
                meta: resolved_meta,
                ramps: track_ramps(meta),
                sample_rate: result.sample_rate,
                channels: result.channels,
                norm_gain,
                expected_samples: expected_total,
                request_id: request.epoch,
                preload_revision: request.preload_revision(),
                load_id: request.load_id,
                generation,
                initial_samples: result.initial_samples,
                fully_decoded: !has_more && !result.aborted,
                seek_tx: if can_seek { Some(seek_tx) } else { None },
            });

            // Tell audio callback to swap pending → active
            let _ = audio_cmd_tx.send(AudioCommand::TransitionToActive {
                user_skip: true,
                request_id: request.epoch,
            });

            wait_for_load(deck, request, atomics);

            // Continue decoding in background
            if let Some(decoder) = result.decoder {
                if !request.is_current() {
                    return;
                }
                if let Err(error) = spawn_background_decode(
                    decoder,
                    meta.rating_key,
                    source_rate,
                    source_channels,
                    deck,
                    generation,
                    sample_tx.clone(),
                    atomics.clone(),
                    device_rate,
                    device_channels,
                    request.clone(),
                    seek_rx,
                ) {
                    let _ = sample_tx.send(SampleBatch {
                        rating_key: meta.rating_key,
                        generation,
                        samples: Vec::new(),
                        fully_decoded: false,
                        error: Some(format!("Cannot start audio decoder: {error}")),
                    });
                }
            }

            if result.aborted {
                warn!(
                    rating_key = meta.rating_key,
                    "stream was truncated during play"
                );
            }
        }
        Err(e) => {
            if !request.is_current() {
                return;
            }
            warn!(rating_key = meta.rating_key, error = %e, "play failed");
            let _ = audio_cmd_tx.send(AudioCommand::FailPlay {
                request_id: request.epoch,
                message: format!("load failed: {}", e),
            });
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn handle_preload(
    source: &MediaSource,
    meta: &TrackMeta,
    deck: DeckId,
    audio_cmd_tx: &Sender<AudioCommand>,
    sample_tx: &Sender<SampleBatch>,
    _event_tx: &Sender<EngineEvent>,
    rt: &tokio::runtime::Handle,
    atomics: &Arc<SharedAtomics>,
    cache: &Arc<AudioCache>,
    analysis: Option<&LoudnessAnalysis>,
    _xfade: &CrossfadeSettings,
    device_rate: u32,
    device_channels: u16,
    request: &PlaybackRequest,
) {
    if !request.is_current() {
        return;
    }
    debug!(rating_key = meta.rating_key, ?deck, "preload command");

    let _ = audio_cmd_tx.send(AudioCommand::PreparePreload {
        request_id: request.epoch,
        deck,
    });

    let norm_enabled = true;

    // Increment generation to invalidate any old bg decode threads writing to this deck
    let generation = match deck {
        DeckId::A => atomics.deck_a_generation.fetch_add(1, Ordering::Relaxed) + 1,
        DeckId::B => atomics.deck_b_generation.fetch_add(1, Ordering::Relaxed) + 1,
    };

    match fetch_and_decode_incremental(
        source,
        meta.rating_key,
        cache,
        rt,
        device_rate,
        device_channels,
        request,
    ) {
        Ok(result) => {
            if !request.is_current() {
                return;
            }
            if result.aborted {
                atomics
                    .preload_error_rk
                    .store(meta.rating_key, Ordering::SeqCst);
                return;
            }
            let source_rate = result.source_rate;
            let source_channels = result.source_channels;
            let has_more = result.has_more;

            let gain_db = match prepare_gain_db(meta, source, deck, request, cache, atomics, analysis, &result) {
                Ok(gain)=>gain,
                Err(error)=>{if request.is_current(){atomics.preload_error_rk.store(meta.rating_key,Ordering::SeqCst);warn!(%error,"required preload loudness preparation failed");}return}
            };
            if !request.is_current() {
                return;
            }
            let source_kind = if result.cached_stamp.is_some() {
                if source.local_cache.as_ref().is_some_and(|local| !Arc::ptr_eq(local, cache)) { "download" } else { "cache" }
            } else { "network" };
            atomics.diagnostics.record_source(deck, request.load_id, source_kind, result.source_bytes, result.spool.as_ref().map(|spool| spool.transfer_progress()));
            let mut resolved_meta = meta.clone();
            resolved_meta.gain_db = gain_db;
            resolved_meta.source_format = result.source_format;
            let norm_gain = if norm_enabled {
                loudness::replay_gain(gain_db)
            } else {
                1.0
            };

            let expected_total =
                if meta.duration_ms > 0 && result.sample_rate > 0 && result.channels > 0 {
                    (meta.duration_ms as f64 / 1000.0
                        * result.sample_rate as f64
                        * result.channels as f64) as usize
                } else {
                    result.initial_samples.len()
                };

            let (seek_tx, seek_rx) = crossbeam_channel::unbounded();
            let can_seek = result.decoder.is_some();
            let _ = audio_cmd_tx.send(AudioCommand::LoadDeck {
                deck,
                meta: resolved_meta,
                ramps: track_ramps(meta),
                sample_rate: result.sample_rate,
                channels: result.channels,
                norm_gain,
                expected_samples: expected_total,
                request_id: request.epoch,
                preload_revision: request.preload_revision(),
                load_id: request.load_id,
                generation,
                initial_samples: result.initial_samples,
                fully_decoded: !has_more && !result.aborted,
                seek_tx: if can_seek { Some(seek_tx) } else { None },
            });

            if result.aborted {
                warn!(rating_key = meta.rating_key, "preload stream was truncated");
                atomics
                    .preload_error_rk
                    .store(meta.rating_key, Ordering::Relaxed);
            }

            debug!(rating_key = meta.rating_key, "preload initial batch ready");
            // The callback schedules the preloaded track after installation.
            wait_for_load(deck, request, atomics);


            if let Some(decoder) = result.decoder {
                if !request.is_current() {
                    return;
                }
                if let Err(error) = spawn_background_decode(
                    decoder,
                    meta.rating_key,
                    source_rate,
                    source_channels,
                    deck,
                    generation,
                    sample_tx.clone(),
                    atomics.clone(),
                    device_rate,
                    device_channels,
                    request.clone(),
                    seek_rx,
                ) {
                    let _ = sample_tx.send(SampleBatch {
                        rating_key: meta.rating_key,
                        generation,
                        samples: Vec::new(),
                        fully_decoded: false,
                        error: Some(format!("Cannot start audio decoder: {error}")),
                    });
                }
            }
        }
        Err(e) => {
            if !request.is_current() {
                return;
            }
            warn!(rating_key = meta.rating_key, error = %e, "preload failed");
        }
    }
}

// ---------------------------------------------------------------------------
// Background decode
// ---------------------------------------------------------------------------

fn send_sample_batch(
    sample_tx: &Sender<SampleBatch>,
    request: &PlaybackRequest,
    mut batch: SampleBatch,
) -> Result<(), ()> {
    loop {
        if !request.is_current() {
            return Err(());
        }
        match sample_tx.send_timeout(batch, Duration::from_millis(10)) {
            Ok(()) => return Ok(()),
            Err(crossbeam_channel::SendTimeoutError::Timeout(returned)) => batch = returned,
            Err(crossbeam_channel::SendTimeoutError::Disconnected(_)) => return Err(()),
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn spawn_background_decode(
    mut decoder: decode::DecoderSetup,
    rating_key: i64,
    source_rate: u32,
    source_channels: u16,
    deck: DeckId,
    generation: u64,
    sample_tx: Sender<SampleBatch>,
    atomics: Arc<SharedAtomics>,
    device_sample_rate: u32,
    device_channels: u16,
    request: PlaybackRequest,
    seek_rx: crossbeam_channel::Receiver<SeekRequest>,
) -> std::io::Result<std::thread::JoinHandle<()>> {
    std::thread::Builder::new()
        .name(format!("audio-bgdec-{}", rating_key))
        .spawn(move || {
            let batch_size = ((source_rate as usize * source_channels as usize) / 2).min(262144);
            let out_channels = device_channels;
            let downmix = match StereoDownmix::new(decoder.channel_layout) {
                Ok(downmix) if out_channels == 2 => downmix,
                _ => {
                    let _ = send_sample_batch(
                        &sample_tx,
                        &request,
                        SampleBatch {
                            rating_key,
                            generation,
                            samples: Vec::new(),
                            fully_decoded: false,
                            error: Some("Unsupported engine mixing format".into()),
                        },
                    );
                    return;
                }
            };
            let ahead_limit = (device_sample_rate as u64 * 20)
                .min(32 * 1024 * 1024 / (4 * out_channels.max(1) as u64));
            let playhead = match deck {
                DeckId::A => &atomics.deck_a_playhead_frames,
                DeckId::B => &atomics.deck_b_playhead_frames,
            };
            let mut produced_frames = decoder.output_frames_decoded;
            let mut current_gen = generation;
            let mut finished_reported = false;
            let mut failure_message = None;

            loop {
                if !request.is_current() {
                    return;
                }
                let mut latest_seek = None;
                loop {
                    match seek_rx.try_recv() {
                        Ok(seek) => latest_seek = Some(seek),
                        Err(crossbeam_channel::TryRecvError::Empty) => break,
                        Err(crossbeam_channel::TryRecvError::Disconnected) => return,
                    }
                }
                if let Some(seek) = latest_seek {
                    current_gen = seek.generation;
                    produced_frames =
                        seek.position_ms.saturating_mul(device_sample_rate as u64) / 1000;
                    if let Err(error) = decode::seek_to_ms(&mut decoder, seek.position_ms) {
                        decoder.finished = true;
                        decoder.aborted = true;
                        failure_message = Some(format!("Audio seek failed: {error}"));
                    }
                    finished_reported = false;
                }
                if decoder.finished {
                    if !finished_reported {
                        let error = if decoder.aborted {
                            atomics.preload_error_rk.store(rating_key, Ordering::SeqCst);
                            Some(failure_message.take().unwrap_or_else(|| {
                                "The media stream was interrupted and could not be resumed".into()
                            }))
                        } else {
                            None
                        };
                        let _ = send_sample_batch(
                            &sample_tx,
                            &request,
                            SampleBatch {
                                rating_key,
                                generation: current_gen,
                                samples: Vec::new(),
                                fully_decoded: !decoder.aborted,
                                error,
                            },
                        );
                        finished_reported = true;
                        if decoder.aborted {
                            return;
                        }
                    }
                    // Keep the decoder available for backward seeks outside a
                    // buffer cleared by an earlier seek. Ownership cancels it.
                    std::thread::sleep(Duration::from_millis(10));
                    continue;
                }

                if produced_frames > playhead.load(Ordering::Acquire).saturating_add(ahead_limit) {
                    // Re-check ownership and the seek mailbox on every pass.
                    // A paused deck never needs minutes of decoded PCM ahead.
                    std::thread::sleep(Duration::from_millis(10));
                    continue;
                }

                match decode::decode_batch_interruptible(&mut decoder, batch_size, || {
                    !request.is_current() || !seek_rx.is_empty()
                }) {
                    Ok(batch) => {
                        if !request.is_current() {
                            return;
                        }
                        if !seek_rx.is_empty() {
                            continue;
                        }
                        let mut samples = match downmix.process(batch) {
                            Ok(samples) => samples,
                            Err(error) => {
                                let _ = send_sample_batch(
                                    &sample_tx,
                                    &request,
                                    SampleBatch {
                                        rating_key,
                                        generation: current_gen,
                                        samples: Vec::new(),
                                        fully_decoded: false,
                                        error: Some(error),
                                    },
                                );
                                return;
                            }
                        };

                        if source_rate != device_sample_rate {
                            if decoder.resampler.is_none() {
                                match StreamingResampler::new(
                                    out_channels,
                                    source_rate,
                                    device_sample_rate,
                                ) {
                                    Ok(resampler) => decoder.resampler = Some(resampler),
                                    Err(error) => {
                                        let _ = send_sample_batch(
                                            &sample_tx,
                                            &request,
                                            SampleBatch {
                                                rating_key,
                                                generation: current_gen,
                                                samples: Vec::new(),
                                                fully_decoded: false,
                                                error: Some(error),
                                            },
                                        );
                                        return;
                                    }
                                }
                            }
                            match decoder
                                .resampler
                                .as_mut()
                                .unwrap()
                                .process(&samples, decoder.finished)
                            {
                                Ok(resampled) => samples = resampled,
                                Err(error) => {
                                    let _ = send_sample_batch(
                                        &sample_tx,
                                        &request,
                                        SampleBatch {
                                            rating_key,
                                            generation: current_gen,
                                            samples: Vec::new(),
                                            fully_decoded: false,
                                            error: Some(error),
                                        },
                                    );
                                    return;
                                }
                            }
                        }
                        if samples.is_empty() {
                            continue;
                        }

                        produced_frames += (samples.len() / out_channels.max(1) as usize) as u64;

                        if send_sample_batch(
                            &sample_tx,
                            &request,
                            SampleBatch {
                                rating_key,
                                generation: current_gen,
                                samples,
                                fully_decoded: false,
                                error: None,
                            },
                        )
                        .is_err()
                        {
                            return; // Channel closed
                        }
                    }
                    Err(e) => {
                        if !request.is_current() {
                            return;
                        }
                        warn!(rating_key, error = %e, "bg decode: error");
                        atomics
                            .preload_error_rk
                            .store(rating_key, Ordering::Relaxed);
                        let _ = send_sample_batch(
                            &sample_tx,
                            &request,
                            SampleBatch {
                                rating_key,
                                generation: current_gen,
                                samples: Vec::new(),
                                fully_decoded: false,
                                error: Some(format!("Audio decoding failed: {e}")),
                            },
                        );
                        return;
                    }
                }
            }
        })
}

// ---------------------------------------------------------------------------
// Streaming fetch + decode
// ---------------------------------------------------------------------------

/// Result of fetch + incremental decode.
struct IncrementalDecodeResult {
    provider_gain_db: Option<f32>,
    source_format: Option<types::SourceAudioFormat>,
    source_bytes: Option<u64>,
    cached_stamp: Option<cache::CacheStamp>,
    spool: Option<Arc<deck::streaming::SharedBuffer>>,
    initial_samples: Vec<f32>,
    sample_rate: u32,
    channels: u16,
    /// Whether more samples need to be decoded (bg thread needed).
    has_more: bool,
    /// The live decoder setup (for bg continuation). None on cache hit with
    /// streaming reader, present for HTTP streaming path.
    decoder: Option<decode::DecoderSetup>,
    source_rate: u32,
    source_channels: u16,
    /// True if the stream was aborted (download error). The initial samples
    /// are valid but the track is truncated — don't treat as fully decoded.
    aborted: bool,
}

/// Fetch and decode audio — checks disk cache first, falls back to HTTP streaming.
/// On cache miss, tees the HTTP body to disk while streaming to the decoder.
/// Obsolete downloads are cancelled so they cannot hold up the next track.
fn fetch_and_decode_incremental(
    source: &MediaSource,
    rating_key: i64,
    cache: &Arc<AudioCache>,
    rt: &tokio::runtime::Handle,
    device_rate: u32,
    device_channels: u16,
    request: &PlaybackRequest,
) -> Result<IncrementalDecodeResult, String> {
    use symphonia::core::io::MediaSourceStream;

    let cache = source.local_cache.as_ref().unwrap_or(cache);
    let ext = &source.extension;
    let cache_key = &source.cache_key;
    let fill = cache.fill_lock(cache_key);
    let fill_guard = rt.block_on(async {
        tokio::select! {
            biased;
            _ = request.cancelled() => Err("Audio request superseded".to_owned()),
            guard = fill.lock_owned() => Ok(guard),
        }
    })?;

    // ---- Cache HIT: decode from local file ----
    if let Some((file, stamp)) = cache.open_with_stamp(cache_key) {
        debug!(rating_key, "cache hit — decoding from file");
        let source_bytes = file.metadata().ok().map(|metadata| metadata.len());
        let cached: Result<IncrementalDecodeResult, String> = (|| {
            let mss = MediaSourceStream::new(Box::new(file), Default::default());
            let mut setup = decode::probe_from_source(mss, Some(ext)).map_err(|error| format!("{error}"))?;
            setup.attach_cached_file(cache.clone(), cache_key.clone(), stamp.clone());
            let mut result = decode_initial_batch(&mut setup, device_rate, device_channels)?;
            result.provider_gain_db = source.gain_db;
            if setup.aborted || setup.had_decode_errors { return Err("cached audio contains incomplete or invalid frames".into()); }
            result.cached_stamp = Some(stamp.clone());
            result.source_bytes = source_bytes;
            result.decoder = if setup.finished { None } else { Some(setup) };
            Ok(result)
        })();
        match cached {
            Ok(result) => {
                if source.prepare_waveform { waveform::schedule(cache.clone(), cache_key.clone(), request.clone()); }
                return Ok(result);
            },
            Err(error) => {
                if !request.is_current() { return Err("audio request superseded".into()); }
                warn!(rating_key, %error, "cached audio failed; retrying original media source");
                cache.discard(cache_key, &stamp);
            }
        }
    }

    // ---- Cache MISS: stream from HTTP, tee to disk ----
    if source.request.is_none() && source.requires_resolution() {
        // A completed cached file can be evicted or prove corrupt after initial
        // admission. Resolve a fresh transport only when the file is unavailable.
        drop(fill_guard);
        let resolved = source.resolve_network(rt, request)?;
        return fetch_and_decode_incremental(&resolved, rating_key, cache, rt, device_rate, device_channels, request);
    }
    debug!(rating_key, "cache miss — streaming audio");

    use self::deck::streaming::{SharedBuffer, StreamingReader};
    let media_request = source.request.as_ref().ok_or("This track is no longer available offline. Reconnect to download it again.")?
        .try_clone().ok_or("Cannot clone media request")?;
    let cache_writer = cache.begin_write(cache_key, ext).ok();
    let declared_cache_size = cache_writer.as_ref().map(|writer| writer.declared_size());
    let cache_for_task = cache.clone();
    let request = request.clone();
    let plex_fetch_lock = source.plex_fetch_lock.clone();
    let provider_gain = source.gain_db.filter(|gain| gain.is_finite());
    let gain_key = source.cache_key.clone();
    let prepare_waveform = source.prepare_waveform;

    let shared_buf = rt.block_on(async {
        let shared = SharedBuffer::new(None).map_err(|error| format!("Cannot create audio spool: {error}"))?;
        let shared_w = shared.clone();
        let shared_return = shared.clone();

        tauri::async_runtime::spawn(async move {
            let _fill_guard = fill_guard;
            let download = async {
                let mut writer = cache_writer;
                let result = download::download(
                    // This bodyless GET always supports cloning. Retries retain
                    // the originating credentials and TLS policy.
                    || media_request.try_clone().expect("cloneable media GET"),
                    |length| {
                        shared_w.set_content_length(length);
                        if let Some(size) = &declared_cache_size { size.store(length, Ordering::Release); }
                    },
                    |chunk| {
                        shared_w.push(chunk).map_err(|error| format!("Audio spool write failed: {error}"))?;
                        if let Some(ref mut cache_writer) = writer {
                            if let Err(error) = cache_writer.write_chunk(chunk) {
                                tracing::warn!(%error, "audio cache write failed; continuing playback");
                                if let Some(writer) = writer.take() { writer.abort(); }
                            }
                        }
                        Ok(())
                    },
                    plex_fetch_lock.as_deref(),
                ).await;
                if let Err(error) = result {
                    if request.is_current() {
                        tracing::warn!(rating_key, %error, "media transfer failed");
                    }
                    shared_w.abort();
                    return; // Dropping the writer removes its incomplete file.
                }
                if let Some(writer) = writer {
                    if let Err(error) = writer.finish(&cache_for_task) {
                        tracing::warn!(%error, "audio cache finalization failed");
                    } else {
                        if let Some(gain) = provider_gain {
                            if let Some((_, stamp)) = cache_for_task.open_with_stamp(&gain_key) {
                                let _ = cache_for_task.set_computed_gain_for_stamp(&gain_key, &stamp, gain);
                            }
                        }
                        if prepare_waveform { waveform::schedule(cache_for_task.clone(), gain_key.clone(), request.clone()); }
                    }
                }
                shared_w.finish();
            };
            tokio::select! {
                biased;
                _ = request.cancelled() => { shared.abort(); }
                _ = download => {}
            }
        });

        Ok::<_, String>(shared_return)
    })?;

    let reader = StreamingReader::new(shared_buf.clone());
    let mut setup = decode::probe_stream(reader, Some(ext)).map_err(|e| format!("{}", e))?;
    let mut result = decode_initial_batch(&mut setup, device_rate, device_channels)?;
    result.provider_gain_db = source.gain_db;
    result.spool = Some(shared_buf);
    result.decoder = if setup.finished { None } else { Some(setup) };
    Ok(result)
}

/// Decode the initial batch from a setup, resample, upmix. Returns partial result
/// (caller sets `decoder` field based on whether more decoding is needed).
fn decode_initial_batch(
    setup: &mut decode::DecoderSetup,
    device_rate: u32,
    device_channels: u16,
) -> Result<IncrementalDecodeResult, String> {
    let initial_batch_size = (setup.sample_rate as usize * setup.channels as usize).min(262144);
    let mut samples =
        decode::decode_batch(setup, initial_batch_size).map_err(|e| format!("{e}"))?;
    if samples.is_empty() {
        return Err("No decodable audio frames were found".into());
    }
    let source_rate = setup.sample_rate;
    let source_channels = setup.channels;

    debug!(
        source_rate,
        source_channels,
        initial_samples = samples.len(),
        finished = setup.finished,
        "initial decode batch ready"
    );

    if device_channels != 2 {
        return Err("Unsupported engine mixing format".into());
    }
    samples = StereoDownmix::new(setup.channel_layout)?.process(samples)?;
    let out_channels = device_channels;
    if source_rate != device_rate {
        let mut resampler = StreamingResampler::new(out_channels, source_rate, device_rate)?;
        samples = resampler.process(&samples, setup.finished)?;
        setup.resampler = Some(resampler);
    }

    // Allocate the bounded deck working set on the decoder worker. VecDeque
    // adopts this allocation when the callback installs the initial PCM.
    if !setup.finished {
        let channels = out_channels.max(1) as usize;
        let ahead = (device_rate as usize * 20 * channels).min(32 * 1024 * 1024 / 4);
        let capacity = ahead + device_rate as usize * channels * 5;
        samples.reserve(capacity.saturating_sub(samples.len()));
    }

    setup.output_frames_decoded = (samples.len() / out_channels.max(1) as usize) as u64;
    Ok(IncrementalDecodeResult {
        provider_gain_db: None,
        source_format: Some(setup.source_format()),
        source_bytes: None,
        cached_stamp: None,
        spool: None,
        initial_samples: samples,
        sample_rate: device_rate,
        channels: out_channels,
        has_more: !setup.finished,
        decoder: None, // caller fills this
        source_rate,
        source_channels,
        aborted: setup.aborted,
    })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Parse on the control thread; accepted metadata and ramps install together.
fn track_ramps(meta: &TrackMeta) -> TrackRamps {
    TrackRamps {
        start_ramp: parse_ramp(meta.start_ramp.as_deref()),
        end_ramp: parse_ramp(meta.end_ramp.as_deref()),
    }
}

/// Finite normalized tracks are not installed until an integrated measurement is ready.
/// This waits on control only; CPU-heavy R128 runs on the bounded analysis worker. Request
/// epochs, preload ownership and normalization-off cancel waits without blocking realtime controls.
#[allow(clippy::too_many_arguments)]
fn prepare_gain_db(
    meta: &TrackMeta,
    source: &MediaSource,
    deck: DeckId,
    request: &PlaybackRequest,
    default_cache: &Arc<AudioCache>,
    atomics: &Arc<SharedAtomics>,
    analysis: Option<&LoudnessAnalysis>,
    decoded: &IncrementalDecodeResult,
) -> Result<Option<f32>, String> {
    let cache = source.local_cache.as_ref().unwrap_or(default_cache);
    if !request.is_current() {
        return Err("request superseded".into());
    }
    if decoded
        .cached_stamp
        .as_ref()
        .is_some_and(|stamp| !cache.stamp_is_current(&source.cache_key, stamp))
    {
        return Err("audio file changed during preparation".into());
    }
    if let Some(gain) = meta.gain_db.filter(|gain| gain.is_finite())
        .or(decoded.provider_gain_db).or(source.gain_db).filter(|gain| gain.is_finite()) {
        return Ok(Some(gain));
    }
    if decoded.cached_stamp.is_some() {
        if let Some(gain) = cache
            .get_computed_gain(&source.cache_key)
            .filter(|gain| gain.is_finite())
        {
            return Ok(Some(gain));
        }
    }
    // Integrated loudness is undefined before EOF for live/unknown-duration streams.
    // Their occurrence keeps a fixed metadata gain or unity, with no late analysis update.
    if !atomics.normalization_is_enabled() || meta.duration_ms == 0 {
        return Ok(None);
    }
    let service = analysis.ok_or("Loudness preparation is unavailable. Retry playback.")?;
    let current = || request.is_current() && atomics.normalization_is_enabled();
    let prepared = if let Some(expected) = &decoded.cached_stamp {
        let (file, stamp) = cache
            .open_with_stamp(&source.cache_key)
            .ok_or("Audio file unavailable during preparation")?;
        if &stamp != expected {
            return Err("Audio file changed during preparation".into());
        }
        Ok((file, Some(stamp)))
    } else {
        let spool = decoded
            .spool
            .as_ref()
            .ok_or("Complete media unavailable for loudness preparation")?;
        spool.completed_file(&current).map(|file| {
            // Download completion is signalled after its cache writer commits. Prefer
            // a separately opened descriptor; never share a cached decoder's file offset.
            cache
                .open_with_stamp(&source.cache_key)
                .map_or((file, None), |(cached, stamp)| (cached, Some(stamp)))
        })
    };
    if !request.is_current() {
        return Err("request superseded".into());
    }
    if !atomics.normalization_is_enabled() {
        return Ok(None);
    }
    let (file, stamp) = prepared?;
    let accepted_stamp=stamp.clone();
    match service.prepare(source, deck, request, cache.clone(), file, stamp) {
        // This exact result occurs only after complete, valid decoding. Silence and
        // clips shorter than the R128 integration window have no meaningful scalar;
        // keep unity for this occurrence, never persist a guessed zero adjustment.
        Err(error) if error == "No integrated loudness measurement available"
            && request.is_current()
            && accepted_stamp.as_ref().is_none_or(|stamp|cache.stamp_is_current(&source.cache_key,stamp)) => Ok(None),
        result => result,
    }
}

#[cfg(test)]
mod control_tests {
    use super::*;

    fn engine_with_callback(
        directory: &std::path::Path,
        capacity: usize,
    ) -> (
        AudioEngine,
        crossbeam_channel::Receiver<ControlCommand>,
        AudioCallbackState,
        crossbeam_channel::Receiver<EngineEvent>,
    ) {
        let atomics = Arc::new(SharedAtomics::new());
        atomics.request_epoch.store(1, Ordering::SeqCst);
        let (cmd_tx, cmd_rx) = crossbeam_channel::unbounded();
        let (audio_cmd_tx, audio_rx) = crossbeam_channel::bounded(capacity);
        let engine = AudioEngine {
            cmd_tx,
            command_admission: Mutex::new(()),
            audio_cmd_tx,
            atomics: atomics.clone(),
            cache: Arc::new(AudioCache::new(directory.into(), None)),
            _output: None,
            lifetime: EngineLifetime::new(),
            startup_error: None,
            history: crate::listening_history::NativeHistory::new(),
            closing: AtomicBool::new(false),
        };
        let (_a_tx, a_rx) = crossbeam_channel::bounded(4);
        let (_b_tx, b_rx) = crossbeam_channel::bounded(4);
        let (events, event_rx) = crossbeam_channel::unbounded();
        let (visualizer, _vis_rx) = visualizer::transport::channel();
        let callback = AudioCallbackState::new(audio_rx, a_rx, b_rx, events, visualizer, atomics);
        (engine, cmd_rx, callback, event_rx)
    }

    #[test]
    fn queue_preparation_rejects_stale_batches_and_work_retired_by_stop_or_clear() {
        let directory = tempfile::tempdir().unwrap();
        let (engine, commands, _callback, _events) = engine_with_callback(directory.path(), 8);
        let first = engine.begin_queue_preparation(1, 1).unwrap().unwrap();
        let next = engine.begin_queue_preparation(1, 2).unwrap().unwrap();
        assert!(engine.begin_queue_preparation(1, 1).unwrap().is_none());
        engine.finish_queue_preparation(1, first, vec![]).unwrap();
        assert!(commands.is_empty());
        engine.finish_queue_preparation(1, next, vec![]).unwrap();
        assert!(
            matches!(commands.recv().unwrap().command, Command::PrepareQueue { revision, .. } if revision == next)
        );
        let cleared = engine.begin_queue_preparation(1, 3).unwrap().unwrap();
        engine.send(Command::ClearPreload).unwrap();
        engine.finish_queue_preparation(1, cleared, vec![]).unwrap();
        assert!(commands.is_empty());
        let stopped = engine.begin_queue_preparation(1, 4).unwrap().unwrap();
        engine.send(Command::Stop).unwrap();
        engine.finish_queue_preparation(1, stopped, vec![]).unwrap();
        assert!(engine.begin_queue_preparation(1, 5).unwrap().is_none());
        assert!(commands.is_empty());
    }

    #[test]
    fn a_foreground_command_preempts_slow_queue_preparation_and_the_job_then_resumes() {
        use std::sync::atomic::AtomicUsize;
        let directory = tempfile::tempdir().unwrap();
        let cache = Arc::new(AudioCache::new(directory.path().into(), None));
        let atomics = Arc::new(SharedAtomics::new());
        atomics.request_epoch.store(1, Ordering::SeqCst);
        atomics.preparation_revision.store(1, Ordering::SeqCst);
        let (commands, control) = crossbeam_channel::unbounded();
        let (audio, received) = crossbeam_channel::unbounded();
        let (samples_a, _a) = crossbeam_channel::unbounded();
        let (samples_b, _b) = crossbeam_channel::unbounded();
        let (events, _events) = crossbeam_channel::unbounded();
        let (entered, waiting) = crossbeam_channel::bounded(1);
        let (prepared, completed) = crossbeam_channel::bounded(1);
        let count = Arc::new(AtomicUsize::new(0));
        let observed = count.clone();
        let owned_cache = cache.clone();
        let mut source = MediaSource::deferred("s1-background".into(), move || {
            if observed.fetch_add(1, Ordering::SeqCst) == 0 {
                let _ = entered.send(());
                Box::pin(async { std::future::pending().await })
            } else {
                let mut writer = owned_cache.begin_write("s1-background", "wav").unwrap();
                writer
                    .write_chunk(&decode::tests::generate_test_wav(44100, 2, 1.0))
                    .unwrap();
                writer.finish(&owned_cache).unwrap();
                let cached = MediaSource::cached(
                    "s1-background".into(),
                    "wav".into(),
                    "fixture".into(),
                    owned_cache.clone(),
                );
                Box::pin(async move { Ok(cached) })
            }
        });
        source.local_cache = Some(cache.clone());
        let analysis = LoudnessAnalysis::with_analyzer(
            atomics.clone(),
            Arc::new(AtomicBool::new(true)),
            Arc::new(move |_, _, _| {
                let _ = prepared.send(());
                Ok(-6.0)
            }),
        )
        .unwrap();
        let control_atomics = atomics.clone();
        let worker = std::thread::spawn(move || {
            control_thread_main(
                control,
                audio,
                samples_a,
                samples_b,
                events,
                control_atomics,
                cache,
                Some(analysis),
                44100,
                2,
            )
        });
        commands
            .send(ControlCommand {
                epoch: 1,
                preload_revision: 0,
                command: Command::PrepareQueue {
                    revision: 1,
                    tracks: vec![preparation::Track {
                        source,
                        duration_ms: 1000,
                        gain_db: None,
                    }],
                },
            })
            .unwrap();
        waiting.recv_timeout(Duration::from_secs(2)).unwrap();
        commands
            .send(ControlCommand {
                epoch: 1,
                preload_revision: 0,
                command: Command::SetCrossfadeWindow { ms: 2345 },
            })
            .unwrap();
        assert!(
            matches!(received.recv_timeout(Duration::from_secs(2)).unwrap(), AudioCommand::UpdateCrossfadeSettings(settings) if settings.crossfade_window_ms == 2345)
        );
        completed.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(
            count.load(Ordering::SeqCst),
            2,
            "Interrupted warm work must resume after foreground work"
        );
        assert_eq!(atomics.deck_a_load_id.load(Ordering::SeqCst), 0);
        assert_eq!(atomics.deck_b_load_id.load(Ordering::SeqCst), 0);
        atomics.request_epoch.store(2, Ordering::SeqCst);
        commands
            .send(ControlCommand {
                epoch: 2,
                preload_revision: 0,
                command: Command::Shutdown,
            })
            .unwrap();
        worker.join().unwrap();
    }

    fn queue_test_play(engine: &AudioEngine) -> u64 {
        engine
            .send(Command::Play {
                source: MediaSource::new(
                    crate::plex::client::public_media_request("https://test.invalid/new.wav"),
                    None,
                )
                .unwrap(),
                meta: TrackMeta {
                    rating_key: 42,
                    duration_ms: 1000,
                    parent_key: String::new(),
                    album_playback: false,
                    gain_db: None,
                    skip_crossfade: true,
                    start_ramp: None,
                    end_ramp: None,
                    labels: None,
                    reporting_binding: None,
                    source_format: None,
                },
            })
            .unwrap()
    }

    fn queue_test_load(engine: &AudioEngine, command: ControlCommand) -> PlaybackRequest {
        let Command::Play { meta, .. } = command.command else {
            panic!("Expected Play")
        };
        let request = make_request(command.epoch, DeckId::B, &engine.atomics);
        engine
            .audio_cmd_tx
            .send(AudioCommand::LoadDeck {
                deck: DeckId::B,
                ramps: track_ramps(&meta),
                meta,
                sample_rate: 44100,
                channels: 2,
                norm_gain: 1.0,
                expected_samples: 44100,
                request_id: command.epoch,
                preload_revision: None,
                load_id: request.load_id,
                generation: 1,
                initial_samples: vec![0.1; 44100],
                fully_decoded: true,
                seek_tx: None,
            })
            .unwrap();
        engine
            .audio_cmd_tx
            .send(AudioCommand::TransitionToActive {
                user_skip: true,
                request_id: command.epoch,
            })
            .unwrap();
        request
    }

    #[test]
    fn a_play_admitted_after_stop_survives_delayed_stop_acknowledgement() {
        let directory = tempfile::tempdir().unwrap();
        let (engine, io, mut callback, events) = engine_with_callback(directory.path(), 8);
        let stopped = engine.send(Command::Stop).unwrap();
        let playing = queue_test_play(&engine);
        let request = queue_test_load(&engine, io.recv().unwrap());
        assert!(playing > stopped);
        assert!(request.is_current());
        let mut output = [0.0; 1024];
        callback.process_callback(&mut output);
        assert!(
            request.is_current(),
            "Stop must not revoke a later deck owner"
        );
        assert_eq!(callback.deck_mgr.active_deck().rating_key(), 42);
        assert_eq!(engine.atomics.get_state(), EngineState::Playing);
        assert_eq!(
            engine.atomics.active_request_id.load(Ordering::SeqCst),
            playing
        );
        assert!(output.iter().any(|value| *value > 0.0));
        let ids: Vec<_> = events
            .try_iter()
            .filter_map(|event| match event {
                EngineEvent::State { request_id, .. } => Some(request_id),
                _ => None,
            })
            .collect();
        assert_eq!(ids.first(), Some(&stopped));
        assert_eq!(ids.last(), Some(&playing));
    }

    #[test]
    fn stop_rejects_a_late_load_and_transition_from_the_retired_play() {
        let directory = tempfile::tempdir().unwrap();
        let (engine, io, mut callback, _) = engine_with_callback(directory.path(), 8);
        queue_test_play(&engine);
        let request = queue_test_load(&engine, io.recv().unwrap());
        engine.send(Command::Stop).unwrap();
        assert!(!request.is_current());
        let mut output = [1.0; 1024];
        callback.process_callback(&mut output);
        assert!(output.iter().all(|value| *value == 0.0));
        assert!(!callback.deck_mgr.active_deck().loaded);
        assert!(!callback.deck_mgr.pending_deck().loaded);
        assert_eq!(engine.atomics.get_state(), EngineState::Stopped);
    }

    #[test]
    fn eq_configuration_applies_bands_enable_and_headroom_in_one_callback_command() {
        let directory = tempfile::tempdir().unwrap();
        let (engine, _io, mut callback, _) = engine_with_callback(directory.path(), 1);
        let gains = [8.0, 6.0, 4.0, 2.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
        let postgain = engine.configure_eq(gains, true, None, 0).unwrap();
        assert!(postgain < -8.0);
        // A one-slot queue can admit the entire update with no partial settings.
        callback.poll_without_output();
        let mut expected = dsp::DspChain::new(44100);
        expected.set_eq_gains(&gains);
        expected.set_postgain_db(postgain);
        expected.set_eq_enabled(true);
        let input: Vec<f32> = (0..44100)
            .map(|frame| {
                (2.0 * std::f64::consts::PI * 50.0 * f64::from(frame) / 44100.0).sin() as f32 * 0.05
            })
            .collect();
        let mut actual = input.clone();
        let mut reference = input.clone();
        callback.dsp_chain.process(&mut actual, 44100, 1);
        expected.process(&mut reference, 44100, 1);
        assert_eq!(actual, reference);
        engine.configure_eq(gains, false, Some(6.0), 0).unwrap();
        callback.poll_without_output();
        let mut bypass = input.clone();
        callback.dsp_chain.process(&mut bypass, 44100, 1);
        assert_eq!(
            bypass, input,
            "Disabled EQ must bypass its positive manual gain too"
        );
    }

    #[test]
    fn eq_admission_failure_has_no_partial_update_and_does_not_block_stop() {
        let directory = tempfile::tempdir().unwrap();
        let (engine, _io, mut callback, _) = engine_with_callback(directory.path(), 1);
        engine.send(Command::SetVolume { gain: 0.4 }).unwrap();
        assert!(engine.configure_eq([12.0; 10], true, None, 30).is_err());
        assert!(engine
            .configure_eq([12.0; 10], true, Some(f32::NAN), 30)
            .is_err());
        engine.send(Command::Stop).unwrap();
        callback.poll_without_output();
        let mut samples = [0.1; 128];
        callback.dsp_chain.process(&mut samples, 44100, 2);
        assert!(samples.iter().all(|sample| (*sample - 0.04).abs() < 1e-7));
        assert_eq!(engine.atomics.get_state(), EngineState::Stopped);
    }

    #[test]
    fn corrupt_cached_audio_is_downloaded_again_and_replaced_with_valid_bytes() {
        use std::io::{Read, Write};
        let directory = tempfile::tempdir().unwrap();
        let cache = Arc::new(AudioCache::new(directory.path().into(), None));
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}/track.wav", listener.local_addr().unwrap());
        let body = decode::tests::generate_test_wav(44100, 2, 0.5);
        let reference = body.clone();
        let server = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            let mut socket = loop {
                if let Ok((socket, _)) = listener.accept() { break socket; }
                if std::time::Instant::now() >= deadline { return false; }
                std::thread::sleep(Duration::from_millis(5));
            };
            socket.set_nonblocking(false).unwrap();
            socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut header = Vec::new();
            while !header.ends_with(b"\r\n\r\n") {
                let mut byte = [0]; socket.read_exact(&mut byte).unwrap(); header.push(byte[0]);
                assert!(header.len() < 16384);
            }
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes()).unwrap();
            socket.write_all(&body).unwrap();
            true
        });
        let source = MediaSource::new(crate::plex::client::public_media_request(&url), None).unwrap();
        let mut stale = cache.begin_write(&source.cache_key, "wav").unwrap();
        stale.write_chunk(&vec![0; reference.len()]).unwrap();
        stale.finish(&cache).unwrap();
        let atomics = SharedAtomics::new();
        atomics.request_epoch.store(1, Ordering::SeqCst);
        let request = PlaybackRequest::new(1, atomics.request_epoch.clone(), atomics.deck_a_load_id.clone());
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let decoded = fetch_and_decode_incremental(&source, 42, &cache, runtime.handle(), 44100, 2, &request);
        let downloaded = server.join().unwrap();
        let decoded = decoded.expect("bad cache bytes must fall back to the original HTTP source");
        assert!(downloaded && !decoded.aborted);
        assert_eq!(decoded.initial_samples.len(), 22050 * 2);
        // Finalization follows EOF on the download task, independently of probing.
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            if cache.lookup(&source.cache_key).is_some_and(|path| std::fs::read(path).ok().as_ref() == Some(&reference)) { break; }
            assert!(std::time::Instant::now() < deadline, "fresh complete bytes were not cached");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn cache_budget_rejection_does_not_truncate_http_playback() {
        use std::io::{Read, Write};
        let directory = tempfile::tempdir().unwrap();
        let cache = Arc::new(AudioCache::new(directory.path().into(), Some(10)));
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/track.wav", listener.local_addr().unwrap());
        let body = decode::tests::generate_test_wav(44100, 2, 0.5);
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut header = Vec::new();
            while !header.ends_with(b"\r\n\r\n") { let mut byte = [0]; socket.read_exact(&mut byte).unwrap(); header.push(byte[0]); }
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes()).unwrap();
            socket.write_all(&body).unwrap();
        });
        let source = MediaSource::new(crate::plex::client::public_media_request(&url), None).unwrap();
        let atomics = SharedAtomics::new();
        atomics.request_epoch.store(1, Ordering::SeqCst);
        let request = PlaybackRequest::new(1, atomics.request_epoch.clone(), atomics.deck_a_load_id.clone());
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let decoded = fetch_and_decode_incremental(&source, 42, &cache, runtime.handle(), 44100, 2, &request).unwrap();
        server.join().unwrap();
        assert!(!decoded.aborted);
        assert_eq!(decoded.initial_samples.len(), 22050 * 2);
        assert!(decoded.initial_samples.iter().any(|sample| sample.abs() > 0.05));
        assert!(cache.lookup(&source.cache_key).is_none());
        assert_eq!(cache.stats().total_bytes, 0);
    }

    #[test]
    fn cached_play_and_preload_wait_for_required_gain_and_install_it_once() {
        for preload in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let cache = Arc::new(AudioCache::new(dir.path().into(), None));
            let url = "https://test.invalid/startup.wav";
            let source =
                MediaSource::new(crate::plex::client::public_media_request(url), None).unwrap();
            let mut writer = cache.begin_write(&source.cache_key, "wav").unwrap();
            writer
                .write_chunk(&decode::tests::generate_test_wav(44100, 2, 3.0))
                .unwrap();
            writer.finish(&cache).unwrap();
            let atomics = Arc::new(SharedAtomics::new());
            atomics.request_epoch.store(1, Ordering::SeqCst);
            let request = PlaybackRequest::new(
                1,
                atomics.request_epoch.clone(),
                atomics.deck_b_load_id.clone(),
            );
            atomics
                .deck_b_loaded_id
                .store(request.load_id, Ordering::SeqCst);
            let (commands, received) = crossbeam_channel::unbounded();
            let (analysis_started_tx, analysis_started) = crossbeam_channel::bounded(1);
            let (release, released) = crossbeam_channel::bounded(1);
            let alive = Arc::new(AtomicBool::new(true));
            let analysis = LoudnessAnalysis::with_analyzer(
                atomics.clone(),
                alive.clone(),
                Arc::new(move |_, _, _| {
                    analysis_started_tx.send(()).unwrap();
                    released.recv().unwrap();
                    Ok(-6.0)
                }),
            )
            .unwrap();
            let (samples, _sample_rx) = crossbeam_channel::unbounded();
            let (events, _event_rx) = crossbeam_channel::unbounded();
            let runtime = tokio::runtime::Runtime::new().unwrap();
            let meta = TrackMeta {
                rating_key: 42,
                duration_ms: 3000,
                parent_key: String::new(),
                album_playback: false,
                gain_db: None,
                skip_crossfade: true,
                start_ramp: None,
                end_ramp: None,
                labels: None,
                reporting_binding: None,
                source_format: None,
            };
            std::thread::scope(|scope| {
                let playing = scope.spawn(|| {
                    if preload {
                        handle_preload(
                            &source,
                            &meta,
                            DeckId::B,
                            &commands,
                            &samples,
                            &events,
                            runtime.handle(),
                            &atomics,
                            &cache,
                            Some(&analysis),
                            &CrossfadeSettings::default(),
                            44100,
                            2,
                            &request,
                        )
                    } else {
                        handle_play(
                            &source,
                            &meta,
                            DeckId::B,
                            &commands,
                            &samples,
                            &events,
                            runtime.handle(),
                            &atomics,
                            &cache,
                            Some(&analysis),
                            &CrossfadeSettings::default(),
                            44100,
                            2,
                            &request,
                        )
                    }
                });
                analysis_started
                    .recv_timeout(Duration::from_secs(2))
                    .unwrap();
                if preload {
                    assert!(matches!(
                        received.recv().unwrap(),
                        AudioCommand::PreparePreload { .. }
                    ));
                }
                assert!(
                    received.try_recv().is_err(),
                    "No deck or transition may install before required gain"
                );
                release.send(()).unwrap();
                playing.join().unwrap();
            });
            assert!(
                matches!(received.recv().unwrap(),AudioCommand::LoadDeck{norm_gain,meta,initial_samples,..} if (norm_gain-loudness::replay_gain(Some(-6.0))).abs()<1e-6 && meta.gain_db==Some(-6.0) && !initial_samples.is_empty())
            );
            if !preload {
                assert!(matches!(
                    received.recv().unwrap(),
                    AudioCommand::TransitionToActive { .. }
                ));
            }
            assert!(
                received.try_recv().is_err(),
                "Gain must not be updated after activation"
            );
            alive.store(false, Ordering::SeqCst);
            atomics.deck_b_load_id.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[test]
    fn known_gain_disabled_normalization_and_live_sources_never_wait_for_full_media() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Arc::new(AudioCache::new(dir.path().into(), None));
        let source = MediaSource::new(
            crate::plex::client::public_media_request("https://fixture.invalid/never-finishes.wav"),
            None,
        )
        .unwrap();
        let atomics = Arc::new(SharedAtomics::new());
        atomics.request_epoch.store(1, Ordering::SeqCst);
        let request = PlaybackRequest::new(
            1,
            atomics.request_epoch.clone(),
            atomics.deck_b_load_id.clone(),
        );
        let decoded = IncrementalDecodeResult {
            provider_gain_db: None,
            source_format: None,
            source_bytes: None,
            cached_stamp: None,
            spool: Some(deck::streaming::SharedBuffer::new(None).unwrap()),
            initial_samples: vec![1.0, 1.0],
            sample_rate: 44100,
            channels: 2,
            has_more: true,
            decoder: None,
            source_rate: 44100,
            source_channels: 2,
            aborted: false,
        };
        let mut meta = TrackMeta {
            rating_key: 42,
            duration_ms: 1000,
            parent_key: String::new(),
            album_playback: false,
            gain_db: Some(-3.0),
            skip_crossfade: true,
            start_ramp: None,
            end_ramp: None,
            labels: None,
            reporting_binding: None,
            source_format: None,
        };
        assert_eq!(
            prepare_gain_db(
                &meta,
                &source,
                DeckId::B,
                &request,
                &cache,
                &atomics,
                None,
                &decoded
            )
            .unwrap(),
            Some(-3.0)
        );
        meta.gain_db = None;
        let decoded = IncrementalDecodeResult { provider_gain_db: Some(-8.0), ..decoded };
        assert_eq!(prepare_gain_db(&meta, &source, DeckId::B, &request, &cache, &atomics, None, &decoded).unwrap(),
            Some(-8.0), "Provider loudness must skip full-file analysis while the spool is still downloading");
        let decoded = IncrementalDecodeResult { provider_gain_db: None, ..decoded };
        atomics.normalization_enabled.store(false, Ordering::SeqCst);
        assert_eq!(
            prepare_gain_db(
                &meta,
                &source,
                DeckId::B,
                &request,
                &cache,
                &atomics,
                None,
                &decoded
            )
            .unwrap(),
            None
        );
        atomics.normalization_enabled.store(true, Ordering::SeqCst);
        meta.duration_ms = 0;
        assert_eq!(
            prepare_gain_db(
                &meta,
                &source,
                DeckId::B,
                &request,
                &cache,
                &atomics,
                None,
                &decoded
            )
            .unwrap(),
            None
        );
    }

    #[test]
    fn an_owned_offline_cached_gain_uses_the_source_cache_without_analyzer() {
        let global_dir = tempfile::tempdir().unwrap();
        let global = Arc::new(AudioCache::new(global_dir.path().into(), None));
        let local_dir = tempfile::tempdir().unwrap();
        let local = Arc::new(AudioCache::new(local_dir.path().into(), None));
        let mut source = MediaSource::new(
            crate::plex::client::public_media_request("https://fixture.invalid/local.wav"),
            None,
        )
        .unwrap();
        source.local_cache = Some(local.clone());
        let mut writer = local.begin_write(&source.cache_key, "wav").unwrap();
        writer
            .write_chunk(&decode::tests::generate_test_wav(44100, 2, 1.0))
            .unwrap();
        writer.finish(&local).unwrap();
        local.set_computed_gain(&source.cache_key, -6.0);
        let atomics = Arc::new(SharedAtomics::new());
        atomics.request_epoch.store(1, Ordering::SeqCst);
        let request = PlaybackRequest::new(
            1,
            atomics.request_epoch.clone(),
            atomics.deck_b_load_id.clone(),
        );
        let rt = tokio::runtime::Runtime::new().unwrap();
        let decoded =
            fetch_and_decode_incremental(&source, 42, &global, rt.handle(), 44100, 2, &request)
                .unwrap();
        let meta = TrackMeta {
            rating_key: 42,
            duration_ms: 1000,
            parent_key: String::new(),
            album_playback: false,
            gain_db: None,
            skip_crossfade: true,
            start_ramp: None,
            end_ramp: None,
            labels: None,
            reporting_binding: None,
            source_format: None,
        };
        assert_eq!(
            prepare_gain_db(
                &meta,
                &source,
                DeckId::B,
                &request,
                &global,
                &atomics,
                None,
                &decoded
            )
            .unwrap(),
            Some(-6.0)
        );
        assert!(global.get_computed_gain(&source.cache_key).is_none());
    }

    #[test]
    fn completed_temporary_spool_can_be_normalized_when_persistent_cache_is_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Arc::new(AudioCache::new(dir.path().into(), Some(1)));
        let source = MediaSource::new(
            crate::plex::client::public_media_request("https://fixture.invalid/spool.wav"),
            None,
        )
        .unwrap();
        let atomics = Arc::new(SharedAtomics::new());
        atomics.request_epoch.store(1, Ordering::SeqCst);
        let request = PlaybackRequest::new(
            1,
            atomics.request_epoch.clone(),
            atomics.deck_b_load_id.clone(),
        );
        let analysis =
            LoudnessAnalysis::start(atomics.clone(), Arc::new(AtomicBool::new(true))).unwrap();
        let spool = deck::streaming::SharedBuffer::new(None).unwrap();
        spool
            .push(&decode::tests::generate_test_wav(44100, 2, 3.0))
            .unwrap();
        spool.finish();
        let decoded = IncrementalDecodeResult {
            provider_gain_db: None,
            source_format: None,
            source_bytes: None,
            cached_stamp: None,
            spool: Some(spool),
            initial_samples: vec![1.0, 1.0],
            sample_rate: 44100,
            channels: 2,
            has_more: true,
            decoder: None,
            source_rate: 44100,
            source_channels: 2,
            aborted: false,
        };
        let meta = TrackMeta {
            rating_key: 42,
            duration_ms: 3000,
            parent_key: String::new(),
            album_playback: false,
            gain_db: None,
            skip_crossfade: true,
            start_ramp: None,
            end_ramp: None,
            labels: None,
            reporting_binding: None,
            source_format: None,
        };
        assert!(prepare_gain_db(
            &meta,
            &source,
            DeckId::B,
            &request,
            &cache,
            &atomics,
            Some(&analysis),
            &decoded
        )
        .unwrap()
        .unwrap()
        .is_finite());
        assert!(cache.lookup(&source.cache_key).is_none());
    }

    #[test]
    fn transient_r128_preparation_does_not_lose_the_incremental_decoder_tail() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Arc::new(AudioCache::new(dir.path().into(), Some(1)));
        let source = MediaSource::new(
            crate::plex::client::public_media_request("https://fixture.invalid/transient.wav"),
            None,
        )
        .unwrap();
        let bytes = decode::tests::generate_test_wav(44100, 2, 3.0);
        let spool = deck::streaming::SharedBuffer::new(Some(bytes.len() as u64)).unwrap();
        spool.push(&bytes).unwrap();
        spool.finish();
        let mut setup = decode::probe_stream(
            deck::streaming::StreamingReader::new(spool.clone()),
            Some("wav"),
        )
        .unwrap();
        let mut initial = decode_initial_batch(&mut setup, 44100, 2).unwrap();
        initial.spool = Some(spool);
        let atomics = Arc::new(SharedAtomics::new());
        atomics.request_epoch.store(1, Ordering::SeqCst);
        let request = PlaybackRequest::new(
            1,
            atomics.request_epoch.clone(),
            atomics.deck_b_load_id.clone(),
        );
        let analysis =
            LoudnessAnalysis::start(atomics.clone(), Arc::new(AtomicBool::new(true))).unwrap();
        let meta = TrackMeta {
            rating_key: 42,
            duration_ms: 3000,
            parent_key: String::new(),
            album_playback: false,
            gain_db: None,
            skip_crossfade: true,
            start_ramp: None,
            end_ramp: None,
            labels: None,
            reporting_binding: None,
            source_format: None,
        };
        assert!(prepare_gain_db(
            &meta,
            &source,
            DeckId::B,
            &request,
            &cache,
            &atomics,
            Some(&analysis),
            &initial
        )
        .unwrap()
        .unwrap()
        .is_finite());
        let mut actual = initial.initial_samples;
        while !setup.finished {
            actual.extend(decode::decode_batch(&mut setup, 262144).unwrap());
        }
        let mut reference = decode::probe_audio(bytes).unwrap();
        let mut expected = Vec::new();
        while !reference.finished {
            expected.extend(decode::decode_batch(&mut reference, 262144).unwrap());
        }
        assert_eq!(
            actual, expected,
            "Full-file measurement must not move playback's logical read cursor"
        );
    }

    #[test]
    fn a_rejected_normalization_command_cannot_change_the_preparation_preference() {
        let dir = tempfile::tempdir().unwrap();
        let (engine, _commands, _callback, _events) = engine_with_callback(dir.path(), 1);
        engine.send(Command::SetVolume { gain: 0.5 }).unwrap();
        assert!(engine
            .send(Command::SetNormalization { enabled: false })
            .is_err());
        assert!(engine.normalization_enabled());
    }

    #[test]
    fn complete_silence_and_short_jingles_install_at_fixed_unity_but_incomplete_or_empty_files_do_not() {
        use symphonia::core::audio::Position as Channels;
        let layout=Channels::FRONT_LEFT|Channels::FRONT_RIGHT;
        let silence=decode::tests::generate_layout_wav(44100,layout,44100,|_,_|0.0);
        let short=decode::tests::generate_layout_wav(44100,layout,4410,|frame,_|(frame as f32*0.08).sin()*0.2);
        let mut truncated=decode::tests::generate_test_wav(44100,2,3.0);truncated.truncate(truncated.len()*3/4);
        let empty=decode::tests::generate_test_wav(44100,2,0.0);
        for (bytes,valid,duration_ms) in [(silence,true,1000),(short,true,100),(truncated,false,3000),(empty,false,1000)] {
            let dir=tempfile::tempdir().unwrap();let cache=Arc::new(AudioCache::new(dir.path().into(),None));
            let mut source=MediaSource::new(crate::plex::client::public_media_request("https://fixture.invalid/no-network.wav"),None).unwrap();source.request=None;
            let mut writer=cache.begin_write(&source.cache_key,"wav").unwrap();writer.write_chunk(&bytes).unwrap();writer.finish(&cache).unwrap();
            let atomics=Arc::new(SharedAtomics::new());atomics.request_epoch.store(1,Ordering::SeqCst);let request=PlaybackRequest::new(1,atomics.request_epoch.clone(),atomics.deck_b_load_id.clone());atomics.deck_b_loaded_id.store(request.load_id,Ordering::SeqCst);
            let analysis=LoudnessAnalysis::start(atomics.clone(),Arc::new(AtomicBool::new(true))).unwrap();
            let (commands,received)=crossbeam_channel::unbounded();let(samples,_)=crossbeam_channel::unbounded();let(events,_)=crossbeam_channel::unbounded();let rt=tokio::runtime::Runtime::new().unwrap();
            let meta=TrackMeta{rating_key:42,duration_ms,parent_key:String::new(),album_playback:false,gain_db:None,skip_crossfade:true,start_ramp:None,end_ramp:None,labels:None,reporting_binding:None,source_format:None};
            handle_play(&source,&meta,DeckId::B,&commands,&samples,&events,rt.handle(),&atomics,&cache,Some(&analysis),&CrossfadeSettings::default(),44100,2,&request);
            let command=received.recv_timeout(Duration::from_secs(2)).unwrap();
            if valid {
                assert!(matches!(command,AudioCommand::LoadDeck{norm_gain,meta,initial_samples,..} if norm_gain==1.0 && meta.gain_db.is_none() && !initial_samples.is_empty()));
                assert!(matches!(received.recv_timeout(Duration::from_secs(2)).unwrap(),AudioCommand::TransitionToActive{..}));
                assert!(cache.lookup(&source.cache_key).is_some(),"Valid unmeasurable encoded media must remain reusable");
            } else {assert!(matches!(command,AudioCommand::FailPlay{..}));assert!(received.try_recv().is_err());}
            assert!(cache.get_computed_gain(&source.cache_key).is_none(),"Unity fallback must not be cached as measured gain");
            atomics.deck_b_load_id.fetch_add(1,Ordering::SeqCst);
        }
    }

    #[test]
    fn empty_audio_is_rejected_before_a_deck_is_loaded() {
        let mut decoder =
            decode::probe_audio(decode::tests::generate_test_wav(44100, 2, 0.0)).unwrap();
        assert!(decode_initial_batch(&mut decoder, 48000, 2)
            .err()
            .unwrap()
            .contains("No decodable audio"));
    }

    #[test]
    fn paused_decoding_stays_bounded_and_seeks_and_cancellation_bypass_backpressure() {
        let decoder =
            decode::probe_audio(decode::tests::generate_test_wav(44100, 2, 60.0)).unwrap();
        let atomics = Arc::new(SharedAtomics::new());
        let epoch = Arc::new(std::sync::atomic::AtomicU64::new(1));
        let request = PlaybackRequest::new(
            1,
            epoch.clone(),
            Arc::new(std::sync::atomic::AtomicU64::new(0)),
        );
        let (sample_tx, samples) = crossbeam_channel::bounded(4);
        let (seek_tx, seek_rx) = crossbeam_channel::unbounded();
        let worker = spawn_background_decode(
            decoder,
            42,
            44100,
            2,
            DeckId::A,
            1,
            sample_tx,
            atomics.clone(),
            44100,
            2,
            request,
            seek_rx,
        )
        .unwrap();
        let mut decoded_frames = 0;
        loop {
            match samples.recv_timeout(Duration::from_millis(200)) {
                Ok(batch) => {
                    assert!(!batch.fully_decoded);
                    decoded_frames += batch.samples.len() / 2;
                }
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => break,
                Err(error) => panic!("decoder disconnected: {error}"),
            }
        }
        assert!(decoded_frames >= 44100 * 20 && decoded_frames < 44100 * 21);
        // A decoder stopped by the ahead limit must still service a seek.
        seek_tx
            .send(SeekRequest {
                position_ms: 40000,
                generation: 2,
            })
            .unwrap();
        atomics
            .deck_a_playhead_frames
            .store(44100 * 40, Ordering::Release);
        let batch = samples.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(batch.generation, 2);
        assert!(batch.error.is_none());
        // Now leave its bounded channel full. Cancellation must wake its send.
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while samples.len() < 4 {
            assert!(
                std::time::Instant::now() < deadline,
                "decoder did not fill its bounded channel"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        let started = std::time::Instant::now();
        epoch.store(2, Ordering::SeqCst);
        worker.join().unwrap();
        assert!(started.elapsed() < Duration::from_millis(500));
    }

    #[test]
    fn equal_channel_counts_keep_distinct_center_and_lfe_assignments_from_the_file() {
        use symphonia::core::audio::Position as Channels;
        for extra in [Channels::FRONT_CENTER, Channels::LFE1] {
            let layout = Channels::FRONT_LEFT | Channels::FRONT_RIGHT | extra;
            let source = decode::tests::generate_layout_wav(48000, layout, 128, |_, channel| {
                if channel == extra {
                    0.25
                } else {
                    0.0
                }
            });
            let mut decoder = decode::probe_audio(source).unwrap();
            assert_eq!(decoder.channel_layout, layout);
            let result = decode_initial_batch(&mut decoder, 48000, 2).unwrap();
            assert_eq!(result.channels, 2);
            assert_eq!(result.source_channels, 3);
            assert_eq!(result.initial_samples.len(), 256);
            let expected = if extra == Channels::FRONT_CENTER {
                0.25 * std::f32::consts::FRAC_1_SQRT_2
            } else {
                0.0
            };
            assert!(result
                .initial_samples
                .iter()
                .all(|sample| (*sample - expected).abs() < 1e-6));
        }
    }

    #[test]
    fn surround_content_survives_initial_decode_background_src_and_seeking() {
        use symphonia::core::audio::Position as Channels;
        let layout = Channels::FRONT_LEFT
            | Channels::FRONT_RIGHT
            | Channels::FRONT_CENTER
            | Channels::LFE1
            | Channels::REAR_LEFT
            | Channels::REAR_RIGHT;
        let source = decode::tests::generate_layout_wav(44100, layout, 44100 * 3, |frame, channel| {
            let frequency = match channel {
                Channels::FRONT_CENTER => 750.0,
                Channels::REAR_LEFT => 250.0,
                Channels::REAR_RIGHT => 500.0,
                Channels::LFE1 => 80.0,
                _ => return 0.0,
            };
            (frame as f32 * frequency * std::f32::consts::TAU / 44100.0).sin() * 0.1
        });
        let mut full = decode::probe_audio(source.clone()).unwrap();
        let raw = decode::decode_all(&mut full).unwrap();
        let stereo: Vec<_> = raw
            .chunks_exact(6)
            .flat_map(|frame| {
                [
                    frame[0] + (frame[2] + frame[4]) * std::f32::consts::FRAC_1_SQRT_2,
                    frame[1] + (frame[2] + frame[5]) * std::f32::consts::FRAC_1_SQRT_2,
                ]
            })
            .collect();
        let expected = StreamingResampler::new(2, 44100, 48000)
            .unwrap()
            .process(&stereo, true)
            .unwrap();
        let mut decoder = decode::probe_audio(source).unwrap();
        let initial = decode_initial_batch(&mut decoder, 48000, 2).unwrap();
        assert_eq!(initial.channels, 2);
        let mut combined = initial.initial_samples;
        let epoch = Arc::new(std::sync::atomic::AtomicU64::new(1));
        let request = PlaybackRequest::new(
            1,
            epoch.clone(),
            Arc::new(std::sync::atomic::AtomicU64::new(0)),
        );
        let (sample_tx, samples) = crossbeam_channel::unbounded();
        let (seek_tx, seek_rx) = crossbeam_channel::unbounded();
        let worker = spawn_background_decode(
            decoder,
            42,
            44100,
            6,
            DeckId::A,
            1,
            sample_tx,
            Arc::new(SharedAtomics::new()),
            48000,
            2,
            request,
            seek_rx,
        )
        .unwrap();
        loop {
            let batch = samples.recv_timeout(Duration::from_secs(5)).unwrap();
            assert!(batch.error.is_none());
            combined.extend(batch.samples);
            if batch.fully_decoded {
                break;
            }
        }
        assert_eq!(combined.len(), 48000 * 2 * 3);
        assert!(combined.iter().any(|sample| sample.abs() > 0.1));
        assert!(combined
            .iter()
            .zip(&expected)
            .all(|(actual, expected)| (*actual - *expected).abs() < 1e-6));
        seek_tx
            .send(SeekRequest {
                position_ms: 500,
                generation: 2,
            })
            .unwrap();
        let mut after_seek = Vec::new();
        loop {
            let batch = samples.recv_timeout(Duration::from_secs(5)).unwrap();
            assert_eq!(batch.generation, 2);
            assert!(batch.error.is_none());
            after_seek.extend(batch.samples);
            if batch.fully_decoded {
                break;
            }
        }
        let expected_seek = StreamingResampler::new(2, 44100, 48000)
            .unwrap()
            .process(&stereo[22050 * 2..], true)
            .unwrap();
        assert_eq!(after_seek.len(), 48000 * 2 * 5 / 2);
        assert!(after_seek
            .iter()
            .zip(&expected_seek)
            .all(|(actual, expected)| (*actual - *expected).abs() < 1e-6));
        epoch.store(2, Ordering::SeqCst);
        worker.join().unwrap();
    }

    #[test]
    fn initial_and_background_resampling_share_history_and_flush_the_tail_after_seeking() {
        let source = decode::tests::generate_test_wav(44100, 2, 3.0);
        let mut full = decode::probe_audio(source.clone()).unwrap();
        let source_samples = decode::decode_all(&mut full).unwrap();
        let expected = StreamingResampler::new(2, 44100, 48000)
            .unwrap()
            .process(&source_samples, true)
            .unwrap();
        let mut decoder = decode::probe_audio(source).unwrap();
        let initial = decode_initial_batch(&mut decoder, 48000, 2).unwrap();
        let mut combined = initial.initial_samples;
        let epoch = Arc::new(std::sync::atomic::AtomicU64::new(1));
        let request = PlaybackRequest::new(
            1,
            epoch.clone(),
            Arc::new(std::sync::atomic::AtomicU64::new(0)),
        );
        let (sample_tx, samples) = crossbeam_channel::unbounded();
        let (seek_tx, seek_rx) = crossbeam_channel::unbounded();
        let worker = spawn_background_decode(
            decoder,
            42,
            44100,
            2,
            DeckId::A,
            1,
            sample_tx,
            Arc::new(SharedAtomics::new()),
            48000,
            2,
            request,
            seek_rx,
        )
        .unwrap();
        loop {
            let batch = samples.recv_timeout(Duration::from_secs(5)).unwrap();
            assert!(batch.error.is_none());
            combined.extend(batch.samples);
            if batch.fully_decoded {
                break;
            }
        }
        assert_eq!(combined, expected);
        assert_eq!(combined.len(), 48000 * 2 * 3);
        seek_tx
            .send(SeekRequest {
                position_ms: 500,
                generation: 2,
            })
            .unwrap();
        let mut after_seek = Vec::new();
        loop {
            let batch = samples.recv_timeout(Duration::from_secs(5)).unwrap();
            assert_eq!(batch.generation, 2);
            assert!(batch.error.is_none());
            after_seek.extend(batch.samples);
            if batch.fully_decoded {
                break;
            }
        }
        assert_eq!(after_seek.len(), 48000 * 2 * 5 / 2);
        assert!(after_seek.iter().all(|sample| sample.is_finite()));
        epoch.store(2, Ordering::SeqCst);
        worker.join().unwrap();
    }

    #[test]
    fn a_completed_background_decoder_remains_seekable_and_preserves_the_seek_generation() {
        let source = decode::tests::generate_test_wav(44100, 2, 2.0);
        let decoder = decode::probe_audio(source).unwrap();
        let atomics = Arc::new(SharedAtomics::new());
        let epoch = Arc::new(std::sync::atomic::AtomicU64::new(1));
        let request = PlaybackRequest::new(
            1,
            epoch.clone(),
            Arc::new(std::sync::atomic::AtomicU64::new(0)),
        );
        let (sample_tx, samples) = crossbeam_channel::unbounded();
        let (seek_tx, seek_rx) = crossbeam_channel::unbounded();
        let worker = spawn_background_decode(
            decoder,
            42,
            44100,
            2,
            DeckId::A,
            1,
            sample_tx,
            atomics.clone(),
            44100,
            2,
            request,
            seek_rx,
        )
        .unwrap();
        while !samples
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .fully_decoded
        {}
        // Deliberately set the shared counter to an unrelated later value.
        // Batches must use the generation paired with the actual seek target.
        atomics.deck_a_generation.store(9999, Ordering::SeqCst);
        seek_tx
            .send(SeekRequest {
                position_ms: 333,
                generation: 2,
            })
            .unwrap();
        let mut after_seek = Vec::new();
        loop {
            let batch = samples.recv_timeout(Duration::from_secs(2)).unwrap();
            assert_eq!(batch.generation, 2);
            assert!(batch.error.is_none());
            after_seek.extend_from_slice(&batch.samples);
            if batch.fully_decoded {
                break;
            }
        }
        assert_eq!(after_seek.len(), (88200 - 333 * 44100 / 1000) * 2);
        epoch.store(2, Ordering::SeqCst);
        worker.join().unwrap();
    }

    #[test]
    fn stop_survives_a_full_callback_queue_and_cancels_the_audible_source() {
        for (without_output, shutdown) in [(false, false), (true, false), (false, true), (true, true)] {
            let directory = tempfile::tempdir().unwrap();
            let (engine, _io, mut callback, event_rx) = engine_with_callback(directory.path(), 4);
            let atomics = engine.atomics.clone();
            let audible = make_request(1, DeckId::A, &atomics);
            atomics
                .deck_a_loaded_id
                .store(audible.load_id, Ordering::SeqCst);
            let deck = callback.deck_mgr.active_deck_mut();
            deck.loaded = true;
            deck.samples = vec![0.1; 44100].into();
            deck.has_started_playing = true;
            deck.played_frames = 100;
            deck.playback_id = 1;
            atomics.set_state(EngineState::Playing);
            assert!(audible.is_current());
            for _ in 0..4 {
                engine.send(Command::Resume).unwrap();
            }
            let stopped = engine
                .send(if shutdown {
                    Command::Shutdown
                } else {
                    Command::Stop
                })
                .expect("Revocation must not depend on queue capacity");
            assert!(
                !audible.is_current(),
                "Source cancellation must precede callback acknowledgement"
            );
            let mut output = [1.0; 512];
            if without_output {
                callback.poll_without_output();
            } else {
                callback.process_callback(&mut output);
                assert!(output.iter().all(|value| *value == 0.0));
            }
            assert!(!callback.deck_mgr.active_deck().loaded);
            assert!(!callback.deck_mgr.pending_deck().loaded);
            assert_eq!(atomics.get_state(), EngineState::Stopped);
            assert!(event_rx.try_iter().any(|event| matches!(event, EngineEvent::State { request_id, state } if request_id == stopped && state == "stopped")));
        }
    }

    #[test]
    fn interactive_controls_bypass_a_busy_io_worker_and_stop_invalidates_queued_play() {
        let dir = tempfile::tempdir().unwrap();
        let (cmd_tx, cmd_rx) = crossbeam_channel::unbounded();
        let (audio_cmd_tx, audio_rx) = crossbeam_channel::bounded(32);
        let engine = AudioEngine {
            cmd_tx,
            command_admission: Mutex::new(()),
            audio_cmd_tx,
            atomics: Arc::new(SharedAtomics::new()),
            cache: Arc::new(AudioCache::new(dir.path().to_path_buf(), None)),
            _output: None,
            lifetime: EngineLifetime::new(),
            startup_error: None,
            history: crate::listening_history::NativeHistory::new(),
            closing: AtomicBool::new(false),
        };
        let key = 42;
        let meta = TrackMeta {
            rating_key: key,
            duration_ms: 1000,
            album_playback: false,
            parent_key: String::new(),
            gain_db: None,
            skip_crossfade: true,
            start_ramp: None,
            end_ramp: None,
            labels: None,
            reporting_binding: None,
            source_format: None,
        };
        let play_epoch = engine
            .send(Command::Play {
                source: MediaSource::new(
                    crate::plex::client::public_media_request("https://example.com/audio"),
                    None,
                )
                .unwrap(),
                meta,
            })
            .unwrap();
        // Intentionally leave the play queued, simulating a worker doing I/O.
        engine.send(Command::Pause).unwrap();
        engine.send(Command::Seek { position_ms: 500 }).unwrap();
        let stop_epoch = engine.send(Command::Stop).unwrap();
        assert!(stop_epoch > play_epoch);
        assert!(matches!(
            audio_rx.recv().unwrap(),
            AudioCommand::BeginPlay { .. }
        ));
        assert!(
            matches!(audio_rx.recv().unwrap(), AudioCommand::PlaybackControl { request_id, control: PlaybackControl::Pause } if request_id == play_epoch)
        );
        assert!(matches!(
            audio_rx.recv().unwrap(),
            AudioCommand::PlaybackControl { request_id, control: PlaybackControl::SeekInBuffer { position: 500 } } if request_id == play_epoch
        ));
        assert!(
            audio_rx.try_recv().is_err(),
            "Stop uses its independent atomic signal"
        );
        assert_eq!(
            engine.atomics.stop_revision.load(Ordering::SeqCst),
            stop_epoch
        );
        assert_eq!(cmd_rx.recv().unwrap().epoch, play_epoch);
        assert!(
            cmd_rx.try_recv().is_err(),
            "interactive controls must not queue behind network I/O"
        );
        assert_eq!(
            engine.atomics.request_epoch.load(Ordering::SeqCst),
            stop_epoch
        );
    }

    #[test]
    fn an_unavailable_engine_returns_the_device_error_without_dispatching_commands() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<AudioEngine>();
        let dir = tempfile::tempdir().unwrap();
        let (cmd_tx, cmd_rx) = crossbeam_channel::unbounded();
        let (audio_cmd_tx, audio_rx) = crossbeam_channel::bounded(1);
        let engine = AudioEngine {
            cmd_tx,
            command_admission: Mutex::new(()),
            audio_cmd_tx,
            atomics: Arc::new(SharedAtomics::new()),
            cache: Arc::new(AudioCache::new(dir.path().to_path_buf(), None)),
            _output: None,
            lifetime: EngineLifetime::new(),
            startup_error: Some("no default output device".into()),
            history: crate::listening_history::NativeHistory::new(),
            closing: AtomicBool::new(false),
        };
        assert_eq!(
            engine.sample_rate().unwrap_err(),
            "no default output device"
        );
        assert_eq!(
            engine.send(Command::Resume).unwrap_err(),
            "no default output device"
        );
        assert_eq!(
            engine
                .send(Command::Seek { position_ms: 1000 })
                .unwrap_err(),
            "no default output device"
        );
        assert!(cmd_rx.is_empty());
        assert!(audio_rx.is_empty());
        assert_eq!(engine.atomics.request_epoch.load(Ordering::SeqCst), 0);
    }
}
