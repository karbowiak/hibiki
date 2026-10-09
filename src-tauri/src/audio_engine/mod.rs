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
pub mod dsp;
pub mod event;
pub mod loudness;
pub mod output;
mod request;
pub mod state;
pub mod types;
pub mod visualizer;

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use crossbeam_channel::{bounded, Sender};
use tauri::Emitter;
use tracing::{debug, info, warn};

use self::cache::AudioCache;
use self::callback::{AudioCallbackState, SharedAtomics};
use self::command::{AudioCommand, Command, ControlCommand, SampleBatch, SeekRequest};
use self::crossfade::types::{parse_ramp, CrossfadeSettings, TrackRamps};
use self::deck::decode;
use self::event::EngineEvent;
use self::output::resample::resample_buffer;
use self::output::CpalOutput;
use self::request::PlaybackRequest;
use self::types::{DeckId, EngineState, TrackMeta};
use self::visualizer::VisualizerProcessor;

use crate::commands::PlexState;

/// The main audio engine handle, held as Tauri managed state.
///
/// Only holds the command channel and shared atomics — both are Send+Sync.
/// The cpal output stream lives on a dedicated holder thread.
pub struct AudioEngine {
    cmd_tx: Sender<ControlCommand>,
    audio_cmd_tx: Sender<AudioCommand>,
    atomics: Arc<SharedAtomics>,
    cache: Arc<AudioCache>,
}

// SAFETY: AudioEngine only contains a crossbeam Sender (Send+Sync) and Arc (Send+Sync).
unsafe impl Send for AudioEngine {}
unsafe impl Sync for AudioEngine {}

impl Drop for AudioEngine {
    fn drop(&mut self) {
        let _ = self.send(Command::Shutdown);
    }
}

impl AudioEngine {
    /// Create and start the audio engine.
    ///
    /// Creates the audio callback state, opens the cpal output (which consumes
    /// the callback state), and spawns the control task and auxiliary tasks.
    pub fn start(app_handle: tauri::AppHandle) -> Result<Self, String> {
        let atomics = Arc::new(SharedAtomics::new());

        // Audio file cache (raw FLAC/MP3/AAC from Plex, stored on disk)
        let cache_dir = {
            use tauri::Manager;
            app_handle
                .path()
                .app_cache_dir()
                .map(|d| d.join("audiocache"))
                .unwrap_or_else(|_| std::path::PathBuf::from("audiocache"))
        };
        let audio_cache = Arc::new(AudioCache::new(cache_dir, None));

        // Bridge → control task
        let (cmd_tx, cmd_rx) = crossbeam_channel::unbounded::<ControlCommand>();

        // Control task → audio callback (commands)
        let (audio_cmd_tx, audio_cmd_rx) = crossbeam_channel::bounded::<AudioCommand>(256);

        // Bg decode → audio callback (per-deck sample channels)
        let (deck_a_tx, deck_a_rx) = crossbeam_channel::unbounded::<SampleBatch>();
        let (deck_b_tx, deck_b_rx) = crossbeam_channel::unbounded::<SampleBatch>();

        // Audio callback → event relay (events to JS)
        let (event_tx, event_rx) = bounded::<EngineEvent>(256);

        // Audio callback → visualizer task (PCM chunks for FFT)
        let (vis_tx, vis_rx) = crossbeam_channel::bounded::<Vec<f32>>(16);

        // Create the callback state — it will be moved into the cpal closure
        let cb_state = AudioCallbackState::new(
            audio_cmd_rx,
            deck_a_rx,
            deck_b_rx,
            event_tx.clone(),
            vis_tx,
            atomics.clone(),
        );

        // Open audio output — cb_state is consumed here (moved into cpal closure)
        let cpal_output = CpalOutput::open(cb_state)
            .map_err(|e| format!("failed to open audio output: {}", e))?;

        let device_sample_rate = cpal_output.sample_rate;
        let device_channels = cpal_output.channels;

        info!(
            sample_rate = device_sample_rate,
            channels = device_channels,
            "audio engine started"
        );

        // Hold the cpal stream alive on a dedicated thread (Stream is not Send)
        std::thread::Builder::new()
            .name("audio-stream".into())
            .spawn(move || {
                // Keep cpal_output alive until channel closes
                let _stream = cpal_output;
                // Park forever — the stream lives until this thread is dropped
                loop {
                    std::thread::park();
                }
            })
            .map_err(|e| format!("failed to spawn stream holder: {}", e))?;

        // Event relay thread (blocking recv, sends Tauri events to JS)
        let app_for_events = app_handle.clone();
        std::thread::Builder::new()
            .name("audio-events".into())
            .spawn(move || {
                while let Ok(event) = event_rx.recv() {
                    let event_name = match &event {
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
        tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(250));
            loop {
                interval.tick().await;
                if atomics_pos.get_state() != EngineState::Playing {
                    continue;
                }
                let pos_samples = atomics_pos.position_samples.load(Ordering::Relaxed);
                let dur_ms = atomics_pos.duration_ms.load(Ordering::Relaxed);
                let sr = device_sample_rate;
                let ch = device_channels;
                if sr == 0 || ch == 0 {
                    continue;
                }
                let pos_ms = (pos_samples as f64 / (sr as f64 * ch as f64) * 1000.0) as u64;
                let _ = event_tx_pos.send(EngineEvent::Position {
                    request_id: atomics_pos.active_request_id.load(Ordering::SeqCst),
                    position_ms: pos_ms.min(dur_ms),
                    duration_ms: dur_ms,
                });
            }
        });

        // Visualizer task (~60fps, receives PCM from audio callback via channel,
        // accumulates into a rolling buffer, computes FFT, emits events)
        let event_tx_vis = event_tx.clone();
        tauri::async_runtime::spawn(async move {
            let mut vis = VisualizerProcessor::new(device_channels);
            let mut interval = tokio::time::interval(Duration::from_millis(16));
            loop {
                interval.tick().await;
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
                    let _ = event_tx_vis.send(EngineEvent::VisFrame {
                        samples: time_domain,
                        frequency_bins: freq_bins,
                    });
                }
            }
        });

        // Control task — receives Commands, spawns decode work, sends AudioCommands
        let audio_cmd_for_control = audio_cmd_tx.clone();
        let app_for_control = app_handle.clone();
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
                    app_for_control,
                    atomics_control,
                    cache_control,
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
        })
    }

    /// Playback intent is invalidated here, before queued I/O can observe it.
    /// Interactive controls bypass the I/O worker so a slow server cannot block pause/seek.
    pub fn send(&self, cmd: Command) -> Result<u64, String> {
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

    /// Access shared atomics (for bridge queries like sample rate).
    pub fn atomics(&self) -> &Arc<SharedAtomics> {
        &self.atomics
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
    app_handle: tauri::AppHandle,
    atomics: Arc<SharedAtomics>,
    cache: Arc<AudioCache>,
    device_sample_rate: u32,
    device_channels: u16,
) {
    let rt = tauri::async_runtime::handle().inner().clone();
    let mut crossfade_settings = CrossfadeSettings::default();
    // Track what's preloaded on the pending deck so we can skip re-fetching
    let mut pending_url = String::new();
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
            Command::Play { url, meta } => {
                pending_url.clear();
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
                    &url,
                    &meta,
                    deck,
                    &audio_cmd_tx,
                    deck_tx(deck, &deck_a_tx, &deck_b_tx),
                    &event_tx,
                    &app_handle,
                    &rt,
                    &atomics,
                    &cache,
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
            Command::PreloadNext { url, meta } => {
                if preload_revision != atomics.preload_revision.load(Ordering::SeqCst) {
                    continue;
                }
                let pending = pending_deck(&atomics);
                let owner = match pending {
                    DeckId::A => &atomics.deck_a_load_id,
                    DeckId::B => &atomics.deck_b_load_id,
                };
                if url == pending_url
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
                    &url,
                    &meta,
                    deck,
                    &audio_cmd_tx,
                    deck_tx(deck, &deck_a_tx, &deck_b_tx),
                    &event_tx,
                    &app_handle,
                    &rt,
                    &atomics,
                    &cache,
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
                    pending_url = url;
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
    url: &str,
    meta: &TrackMeta,
    deck: DeckId,
    audio_cmd_tx: &Sender<AudioCommand>,
    sample_tx: &Sender<SampleBatch>,
    _event_tx: &Sender<EngineEvent>,
    app_handle: &tauri::AppHandle,
    rt: &tokio::runtime::Handle,
    atomics: &Arc<SharedAtomics>,
    cache: &Arc<AudioCache>,
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
        url,
        meta.rating_key,
        cache,
        app_handle,
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

            // Resolve gain: Plex metadata → cached analysis → fresh EBU R128 analysis
            let gain_db = resolve_gain_db(meta, url, cache, request);
            if !request.is_current() {
                return;
            }
            let mut resolved_meta = meta.clone();
            resolved_meta.gain_db = gain_db;
            let norm_gain = if norm_enabled {
                gain_db.map_or(1.0, |db| 10.0_f32.powf(db / 20.0))
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
    url: &str,
    meta: &TrackMeta,
    deck: DeckId,
    audio_cmd_tx: &Sender<AudioCommand>,
    sample_tx: &Sender<SampleBatch>,
    _event_tx: &Sender<EngineEvent>,
    app_handle: &tauri::AppHandle,
    rt: &tokio::runtime::Handle,
    atomics: &Arc<SharedAtomics>,
    cache: &Arc<AudioCache>,
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
        url,
        meta.rating_key,
        cache,
        app_handle,
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

            let gain_db = resolve_gain_db(meta, url, cache, request);
            if !request.is_current() {
                return;
            }
            let mut resolved_meta = meta.clone();
            resolved_meta.gain_db = gain_db;
            let norm_gain = if norm_enabled {
                gain_db.map_or(1.0, |db| 10.0_f32.powf(db / 20.0))
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

#[allow(clippy::too_many_arguments)]
fn spawn_background_decode(
    mut decoder: decode::DecoderSetup,
    rating_key: i64,
    source_rate: u32,
    source_channels: u16,
    _deck: DeckId,
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
            let batch_size = (source_rate as usize * source_channels as usize) / 2;
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
                        let _ = sample_tx.send(SampleBatch {
                            rating_key,
                            generation: current_gen,
                            samples: Vec::new(),
                            fully_decoded: !decoder.aborted,
                            error,
                        });
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

                match decode::decode_batch(&mut decoder, batch_size) {
                    Ok(batch) if !batch.is_empty() => {
                        if !request.is_current() {
                            return;
                        }
                        let mut samples = batch;

                        if source_rate != device_sample_rate {
                            if let Some(resampled) = resample_buffer(
                                &samples,
                                source_channels,
                                source_rate,
                                device_sample_rate,
                            ) {
                                samples = resampled;
                            }
                        }

                        if source_channels == 1 && device_channels >= 2 {
                            let mut stereo = Vec::with_capacity(samples.len() * 2);
                            for &s in &samples {
                                stereo.push(s);
                                stereo.push(s);
                            }
                            samples = stereo;
                        }

                        if sample_tx
                            .send(SampleBatch {
                                rating_key,
                                generation: current_gen,
                                samples,
                                fully_decoded: false,
                                error: None,
                            })
                            .is_err()
                        {
                            return; // Channel closed
                        }
                    }
                    Ok(_) => {}
                    Err(e) => {
                        if !request.is_current() {
                            return;
                        }
                        warn!(rating_key, error = %e, "bg decode: error");
                        atomics
                            .preload_error_rk
                            .store(rating_key, Ordering::Relaxed);
                        let _ = sample_tx.send(SampleBatch {
                            rating_key,
                            generation: current_gen,
                            samples: Vec::new(),
                            fully_decoded: false,
                            error: Some(format!("Audio decoding failed: {e}")),
                        });
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
    url: &str,
    rating_key: i64,
    cache: &Arc<AudioCache>,
    app_handle: &tauri::AppHandle,
    rt: &tokio::runtime::Handle,
    device_rate: u32,
    device_channels: u16,
    request: &PlaybackRequest,
) -> Result<IncrementalDecodeResult, String> {
    use symphonia::core::io::MediaSourceStream;

    let ext = cache::extract_extension(url);
    let cache_key = cache::cache_key(url);

    // ---- Cache HIT: decode from local file ----
    if let Some(cached_path) = cache.lookup(&cache_key) {
        debug!(rating_key, path = %cached_path.display(), "cache hit — decoding from file");
        let file = std::fs::File::open(&cached_path).map_err(|e| format!("cache read: {}", e))?;
        let mss = MediaSourceStream::new(Box::new(file), Default::default());
        let mut setup = decode::probe_from_source(mss, Some(&ext)).map_err(|e| format!("{}", e))?;
        let mut result = decode_initial_batch(&mut setup, device_rate, device_channels)?;
        result.decoder = if setup.finished { None } else { Some(setup) };
        return Ok(result);
    }

    // ---- Cache MISS: stream from HTTP, tee to disk ----
    debug!(rating_key, "cache miss — streaming from Plex");

    use self::deck::streaming::{SharedBuffer, StreamingReader};
    use tauri::Manager;

    let app = app_handle.clone();
    let url_owned = url.to_string();
    let ext = cache::extract_extension(url);
    let cache_writer = cache.begin_write(&cache_key, &ext).ok();
    let cache_for_task = cache.clone();
    let request = request.clone();

    let shared_buf = rt.block_on(async {
        let client = {
            let plex_state = app.state::<PlexState>();
            let guard = plex_state.0.lock().await;
            guard.as_ref().cloned()
        };

        let shared = SharedBuffer::new(None);
        let shared_w = shared.clone();
        let shared_return = shared.clone();

        tauri::async_runtime::spawn(async move {
            let download = async {
                let mut writer = cache_writer;
                let result = download::download(
                    || client.as_ref().map(|client| client.media_request(&url_owned))
                        .unwrap_or_else(|| crate::plex::client::public_media_request(&url_owned)),
                    |length| shared_w.set_content_length(length),
                    |chunk| {
                        shared_w.push(chunk);
                        if let Some(ref mut cache_writer) = writer {
                            if let Err(error) = cache_writer.write_chunk(chunk) {
                                tracing::warn!(%error, "audio cache write failed; continuing playback");
                                if let Some(writer) = writer.take() { writer.abort(); }
                            }
                        }
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
    let mut setup = decode::probe_stream(reader, Some(&ext)).map_err(|e| format!("{}", e))?;
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
    let source_rate = setup.sample_rate;
    let source_channels = setup.channels;

    let initial_batch_size = source_rate as usize * source_channels as usize;
    let mut samples =
        decode::decode_batch(setup, initial_batch_size).map_err(|e| format!("{}", e))?;

    debug!(
        source_rate,
        source_channels,
        initial_samples = samples.len(),
        finished = setup.finished,
        "initial decode batch ready"
    );

    if source_rate != device_rate {
        if let Some(resampled) =
            resample_buffer(&samples, source_channels, source_rate, device_rate)
        {
            samples = resampled;
        }
    }

    let out_channels = if source_channels == 1 && device_channels >= 2 {
        let mut stereo = Vec::with_capacity(samples.len() * 2);
        for &s in &samples {
            stereo.push(s);
            stereo.push(s);
        }
        samples = stereo;
        2
    } else {
        source_channels
    };

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

/// Resolve the normalization gain for a track.
///
/// Priority:
/// 1. Plex-provided gain_db (most tracks)
/// 2. Cached computed gain from previous EBU R128 analysis
/// 3. Fresh EBU R128 analysis (for Opus/other tracks where Plex lacks loudness data)
///    — blocks until analysis completes, result is cached for next time
fn resolve_gain_db(
    meta: &TrackMeta,
    url: &str,
    cache: &Arc<AudioCache>,
    request: &PlaybackRequest,
) -> Option<f32> {
    // 1. Plex-provided gain
    if let Some(db) = meta.gain_db {
        return Some(db);
    }

    // 2. Previously computed gain from cache
    if let Some(db) = cache.get_computed_gain(&cache::cache_key(url)) {
        debug!(
            rating_key = meta.rating_key,
            gain_db = format!("{:.1}", db),
            "using cached computed gain"
        );
        return Some(db);
    }

    // 3. Compute gain for cached files that lack Plex loudness data
    let ext = cache::extract_extension(url);
    if let Some(cached_path) = cache.lookup(&cache::cache_key(url)) {
        debug!(
            rating_key = meta.rating_key,
            "running loudness analysis (no Plex gain data)"
        );
        match loudness::analyze_loudness(&cached_path, &ext, || request.is_current()) {
            Ok(gain_db) => {
                cache.set_computed_gain(&cache::cache_key(url), gain_db);
                return Some(gain_db);
            }
            Err(e) => {
                warn!(rating_key = meta.rating_key, error = %e, "loudness analysis failed");
            }
        }
    }

    None
}

#[cfg(test)]
mod control_tests {
    use super::*;

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
        };
        let key = 42;
        let meta = TrackMeta {
            rating_key: key,
            duration_ms: 1000,
            parent_key: String::new(),
            gain_db: None,
            skip_crossfade: true,
            start_ramp: None,
            end_ramp: None,
        };
        let play_epoch = engine
            .send(Command::Play {
                url: "https://example.com/audio".into(),
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
}
