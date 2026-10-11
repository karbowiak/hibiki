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

pub mod bridge;
pub mod cache;
pub mod callback;
pub mod command;
pub mod crossfade;
pub mod deck;
mod download;
mod analysis;
pub mod dsp;
pub mod event;
pub mod loudness;
pub mod output;
mod request;
pub(crate) mod source;
pub mod state;
pub mod types;
pub mod visualizer;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crossbeam_channel::{bounded, Sender};
use tauri::Emitter;
use tracing::{debug, info, warn};

use self::cache::AudioCache;
use self::analysis::LoudnessAnalysis;
use self::callback::{AudioCallbackState, SharedAtomics};
use self::command::{AudioCommand, Command, ControlCommand, SampleBatch, SeekRequest};
use self::crossfade::types::{parse_ramp, CrossfadeSettings, TrackRamps};
use self::deck::decode;
use self::event::EngineEvent;
use self::output::owner::OutputThread;
use self::output::resample::StreamingResampler;
use self::output::channelmap::StereoDownmix;
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
    audio_cmd_tx: Sender<AudioCommand>,
    atomics: Arc<SharedAtomics>,
    cache: Arc<AudioCache>,
    _output: Option<OutputThread>,
    lifetime: EngineLifetime,
    startup_error: Option<String>,
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
            audio_cmd_tx,
            atomics: Arc::new(SharedAtomics::new()),
            cache: Self::open_cache(app_handle),
            _output: None,
            lifetime: EngineLifetime::new(),
            startup_error: Some(error),
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
        let (vis_tx, vis_rx) = crossbeam_channel::bounded::<Vec<f32>>(16);

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
                        EngineEvent::VisFrame { .. } => "audio://vis-frame",
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
        let event_tx_vis = event_tx.clone();
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
                    got_data = true;
                }
                if !got_data {
                    continue;
                }
                if let Some((time_domain, freq_bins)) = vis.compute() {
                    let _ = event_tx_vis.try_send(EngineEvent::VisFrame {
                        samples: time_domain,
                        frequency_bins: freq_bins,
                    });
                }
            }
        });

        let analysis = LoudnessAnalysis::start(
            audio_cache.clone(), audio_cmd_tx.clone(), atomics.clone(), lifetime.0.clone(),
        ).map_err(|error| {
            warn!(%error, "cannot start optional loudness analysis");
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
            audio_cmd_tx,
            atomics,
            cache: audio_cache,
            _output: Some(output),
            lifetime,
            startup_error: None,
        })
    }

    /// Playback intent is invalidated here, before queued I/O can observe it.
    /// Interactive controls bypass the I/O worker so a slow server cannot block pause/seek.
    pub fn send(&self, cmd: Command) -> Result<u64, String> {
        if let Some(error) = &self.startup_error {
            return Err(error.clone());
        }
        let epoch = if matches!(
            &cmd,
            Command::Play { .. } | Command::Stop | Command::Shutdown
        ) {
            self.atomics.request_epoch.fetch_add(1, Ordering::SeqCst) + 1
        } else {
            self.atomics.request_epoch.load(Ordering::SeqCst)
        };
        if matches!(&cmd, Command::ClearPreload) {
            self.atomics.preload_revision.fetch_add(1, Ordering::SeqCst);
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
            Command::ClearPreload => AudioCommand::ClearPreload,
            Command::Pause => AudioCommand::Pause,
            Command::Resume => AudioCommand::Resume,
            Command::Stop => AudioCommand::Stop,
            Command::Seek { position_ms } => AudioCommand::SeekInBuffer {
                position: position_ms as usize,
            },
            Command::SetVolume { gain } => AudioCommand::SetVolume(gain),
            Command::SetNormalization { enabled } => AudioCommand::SetNormalization(enabled),
            Command::SetPreampGain { db } => AudioCommand::SetPreampGain(db),
            Command::SetEq { gains_db } => AudioCommand::SetEq(gains_db),
            Command::SetEqEnabled { enabled } => AudioCommand::SetEqEnabled(enabled),
            Command::SetEqPostgain { db } => AudioCommand::SetEqPostgain(db),
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

    /// Access the audio file cache.
    pub fn cache(&self) -> &Arc<AudioCache> {
        &self.cache
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

    loop {
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
                    pending_source_key = source.cache_key;
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
            Command::SetCacheMaxBytes { bytes } => {
                cache.set_max_bytes(bytes);
            }
            Command::ClearCache => {
                cache.clear();
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
    PlaybackRequest::new(epoch, atomics.request_epoch.clone(), owner).with_audible_deck(
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

    // Cache ramps
    cache_ramps(meta, audio_cmd_tx);

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

            // Use available gain immediately; missing measurements run in the background.
            let gain_db = resolve_gain_db(meta, &source.cache_key, cache);
            if !request.is_current() {
                return;
            }
            let mut resolved_meta = meta.clone();
            resolved_meta.gain_db = gain_db;
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
            if gain_db.is_none() {
                if let Some(analysis) = analysis {
                    analysis.submit(source, deck, request.clone());
                }
            }
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
    cache_ramps(meta, audio_cmd_tx);

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

            let gain_db = resolve_gain_db(meta, &source.cache_key, cache);
            if !request.is_current() {
                return;
            }
            let mut resolved_meta = meta.clone();
            resolved_meta.gain_db = gain_db;
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
            if gain_db.is_none() {
                if let Some(analysis) = analysis {
                    analysis.submit(source, deck, request.clone());
                }
            }

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

                match decode::decode_batch(&mut decoder, batch_size) {
                    Ok(batch) => {
                        if !request.is_current() {
                            return;
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

    let ext = &source.extension;
    let cache_key = &source.cache_key;

    // ---- Cache HIT: decode from local file ----
    if let Some(cached_path) = cache.lookup(cache_key) {
        debug!(rating_key, path = %cached_path.display(), "cache hit — decoding from file");
        let file = std::fs::File::open(&cached_path).map_err(|e| format!("cache read: {}", e))?;
        let mss = MediaSourceStream::new(Box::new(file), Default::default());
        let mut setup = decode::probe_from_source(mss, Some(ext)).map_err(|e| format!("{}", e))?;
        let mut result = decode_initial_batch(&mut setup, device_rate, device_channels)?;
        result.decoder = if setup.finished { None } else { Some(setup) };
        return Ok(result);
    }

    // ---- Cache MISS: stream from HTTP, tee to disk ----
    debug!(rating_key, "cache miss — streaming from Plex");

    use self::deck::streaming::{SharedBuffer, StreamingReader};
    let media_request = source.request.try_clone().ok_or("Cannot clone media request")?;
    let cache_writer = cache.begin_write(cache_key, ext).ok();
    let cache_for_task = cache.clone();
    let request = request.clone();

    let shared_buf = rt.block_on(async {
        let shared = SharedBuffer::new(None).map_err(|error| format!("Cannot create audio spool: {error}"))?;
        let shared_w = shared.clone();
        let shared_return = shared.clone();

        tauri::async_runtime::spawn(async move {
            let download = async {
                let mut writer = cache_writer;
                let result = download::download(
                    // This bodyless GET always supports cloning. Retries retain
                    // the originating credentials and TLS policy.
                    || media_request.try_clone().expect("cloneable media GET"),
                    |length| shared_w.set_content_length(length),
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
                ).await;
                if let Err(error) = result {
                    tracing::warn!(%error, "media transfer failed");
                    shared_w.abort();
                    return; // Dropping the writer removes its incomplete file.
                }
                shared_w.finish();
                if let Some(writer) = writer {
                    if let Err(error) = writer.finish(&cache_for_task) {
                        tracing::warn!(%error, "audio cache finalization failed");
                    }
                }
            };
            tokio::select! {
                biased;
                _ = request.cancelled() => { shared.abort(); }
                _ = download => {}
            }
        });

        Ok::<_, String>(shared_return)
    })?;

    let reader = StreamingReader::new(shared_buf);
    let mut setup = decode::probe_stream(reader, Some(ext)).map_err(|e| format!("{}", e))?;
    let mut result = decode_initial_batch(&mut setup, device_rate, device_channels)?;
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

    setup.output_frames_decoded = (samples.len() / out_channels.max(1) as usize) as u64;
    Ok(IncrementalDecodeResult {
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

fn cache_ramps(meta: &TrackMeta, audio_cmd_tx: &Sender<AudioCommand>) {
    if meta.start_ramp.is_some() || meta.end_ramp.is_some() {
        let _ = audio_cmd_tx.send(AudioCommand::CacheRamps {
            rating_key: meta.rating_key,
            ramps: TrackRamps {
                start_ramp: parse_ramp(meta.start_ramp.as_deref()),
                end_ramp: parse_ramp(meta.end_ramp.as_deref()),
            },
        });
    }
}

/// Resolve available metadata/cache gain without scanning a file on the
/// playback control thread. Missing gain is handled by the background worker.
fn resolve_gain_db(meta: &TrackMeta, cache_key: &str, cache: &Arc<AudioCache>) -> Option<f32> {
    meta.gain_db.filter(|value| value.is_finite()).or_else(|| {
        cache
            .get_computed_gain(cache_key)
            .filter(|value| value.is_finite())
    })
}

#[cfg(test)]
mod control_tests {
    use super::*;

    #[test]
    fn cached_playback_is_loaded_without_waiting_for_a_blocked_loudness_scan() {
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
            cache.clone(),
            commands.clone(),
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
        };
        let start = std::time::Instant::now();
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
        );
        assert!(
            start.elapsed() < Duration::from_secs(1),
            "Playback must not wait for the scan to finish"
        );
        analysis_started
            .recv_timeout(Duration::from_secs(2))
            .unwrap();
        assert!(
            matches!(received.recv().unwrap(), AudioCommand::LoadDeck { norm_gain, initial_samples, .. } if norm_gain == 1.0 && !initial_samples.is_empty())
        );
        assert!(matches!(
            received.recv().unwrap(),
            AudioCommand::TransitionToActive { .. }
        ));
        release.send(()).unwrap();
        assert!(matches!(
            received.recv_timeout(Duration::from_secs(2)).unwrap(),
            AudioCommand::AnalyzedGain { .. }
        ));
        alive.store(false, Ordering::SeqCst);
        atomics.deck_b_load_id.fetch_add(1, Ordering::SeqCst);
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
        use symphonia::core::audio::Channels;
        for extra in [Channels::FRONT_CENTRE, Channels::LFE1] {
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
            let expected = if extra == Channels::FRONT_CENTRE {
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
        use symphonia::core::audio::Channels;
        let layout = Channels::FRONT_LEFT
            | Channels::FRONT_RIGHT
            | Channels::FRONT_CENTRE
            | Channels::LFE1
            | Channels::REAR_LEFT
            | Channels::REAR_RIGHT;
        let source = decode::tests::generate_layout_wav(44100, layout, 44100 * 3, |frame, channel| {
            let frequency = match channel {
                Channels::FRONT_CENTRE => 750.0,
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
    fn interactive_controls_bypass_a_busy_io_worker_and_stop_invalidates_queued_play() {
        let dir = tempfile::tempdir().unwrap();
        let (cmd_tx, cmd_rx) = crossbeam_channel::unbounded();
        let (audio_cmd_tx, audio_rx) = crossbeam_channel::bounded(32);
        let engine = AudioEngine {
            cmd_tx,
            audio_cmd_tx,
            atomics: Arc::new(SharedAtomics::new()),
            cache: Arc::new(AudioCache::new(dir.path().to_path_buf(), None)),
            _output: None,
            lifetime: EngineLifetime::new(),
            startup_error: None,
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
        };
        let play_epoch = engine
            .send(Command::Play {
                source: MediaSource::new(
                    crate::plex::client::public_media_request("https://example.com/audio"),
                    None,
                ).unwrap(),
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
        assert!(matches!(audio_rx.recv().unwrap(), AudioCommand::Pause));
        assert!(matches!(
            audio_rx.recv().unwrap(),
            AudioCommand::SeekInBuffer { position: 500 }
        ));
        assert!(matches!(audio_rx.recv().unwrap(), AudioCommand::Stop));
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
            audio_cmd_tx,
            atomics: Arc::new(SharedAtomics::new()),
            cache: Arc::new(AudioCache::new(dir.path().to_path_buf(), None)),
            _output: None,
            lifetime: EngineLifetime::new(),
            startup_error: Some("no default output device".into()),
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
