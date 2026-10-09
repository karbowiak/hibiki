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
pub mod loudness;
pub mod command;
pub mod crossfade;
pub mod deck;
pub mod dsp;
pub mod event;
pub mod output;
pub mod state;
pub mod types;
pub mod visualizer;

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use crossbeam_channel::{bounded, Sender};
use tauri::Emitter;
use tracing::{debug, error, info, warn};

use self::cache::AudioCache;
use self::callback::{AudioCallbackState, SharedAtomics};
use self::command::{AudioCommand, Command, SampleBatch};
use self::crossfade::types::{parse_ramp, CrossfadeSettings, TrackRamps};
use self::deck::decode;
use self::event::EngineEvent;
use self::output::resample::resample_buffer;
use self::output::CpalOutput;
use self::types::{DeckId, EngineState, TrackMeta};
use self::visualizer::VisualizerProcessor;

use crate::commands::PlexState;

/// The main audio engine handle, held as Tauri managed state.
///
/// Only holds the command channel and shared atomics — both are Send+Sync.
/// The cpal output stream lives on a dedicated holder thread.
pub struct AudioEngine {
    cmd_tx: Sender<Command>,
    atomics: Arc<SharedAtomics>,
    cache: Arc<AudioCache>,
}

// SAFETY: AudioEngine only contains a crossbeam Sender (Send+Sync) and Arc (Send+Sync).
unsafe impl Send for AudioEngine {}
unsafe impl Sync for AudioEngine {}

impl Drop for AudioEngine {
    fn drop(&mut self) {
        let _ = self.cmd_tx.send(Command::Shutdown);
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
        let (cmd_tx, cmd_rx) = bounded::<Command>(64);

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
        let cpal_output =
            CpalOutput::open(cb_state).map_err(|e| format!("failed to open audio output: {}", e))?;

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
                let pos_ms =
                    (pos_samples as f64 / (sr as f64 * ch as f64) * 1000.0) as u64;
                let _ = event_tx_pos.send(EngineEvent::Position {
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
        let app_for_control = app_handle.clone();
        let atomics_control = atomics.clone();
        let cache_control = audio_cache.clone();
        std::thread::Builder::new()
            .name("audio-control".into())
            .spawn(move || {
                control_thread_main(
                    cmd_rx,
                    audio_cmd_tx,
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
            atomics,
            cache: audio_cache,
        })
    }

    /// Send a command to the control task.
    pub fn send(&self, cmd: Command) {
        if let Err(e) = self.cmd_tx.send(cmd) {
            error!("failed to send command to engine: {}", e);
        }
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
    cmd_rx: crossbeam_channel::Receiver<Command>,
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
    let mut pending_rating_key: i64 = 0;

    /// Read which deck is currently active from the shared atomic.
    /// The pending deck (for preloads/next play) is always the other one.
    fn pending_deck(atomics: &SharedAtomics) -> DeckId {
        let active = atomics.active_deck_id.load(Ordering::Relaxed);
        if active == 0 { DeckId::B } else { DeckId::A }
    }

    /// Eagerly update active_deck_id after sending TransitionToActive, so
    /// subsequent commands see the correct pending deck without waiting for
    /// the audio callback to process the swap.
    fn set_active_eagerly(atomics: &SharedAtomics, deck: DeckId) {
        let id = match deck { DeckId::A => 0u8, DeckId::B => 1u8 };
        atomics.active_deck_id.store(id, Ordering::Relaxed);
    }

    loop {
        match cmd_rx.recv() {
            Ok(cmd) => match cmd {
                Command::Play { url, meta } => {
                    let active_rk = atomics.active_rating_key.load(Ordering::Relaxed);
                    let active_id = atomics.active_deck_id.load(Ordering::Relaxed);
                    let pending = pending_deck(&atomics);
                    info!(
                        rating_key = meta.rating_key,
                        active_rk,
                        pending_rk = pending_rating_key,
                        active_deck = active_id,
                        ?pending,
                        "PLAY command received"
                    );

                    // Check if this track is already playing (scheduler beat us to it)
                    let already_active = active_rk == meta.rating_key;
                    // Check if the preload was truncated (stream error during download)
                    let preload_broken = atomics.preload_error_rk.load(Ordering::Relaxed) == meta.rating_key;
                    if already_active {
                        info!(rating_key = meta.rating_key, "track already active, skipping play");
                        pending_rating_key = 0;
                    // If the pending deck already has this track preloaded, just transition
                    } else if pending_rating_key == meta.rating_key && pending_rating_key != 0 && !preload_broken {
                        info!(rating_key = meta.rating_key, "using preloaded deck");
                        cache_ramps(&meta, &audio_cmd_tx);
                        let _ = audio_cmd_tx.send(AudioCommand::TransitionToActive { user_skip: true });
                        set_active_eagerly(&atomics, pending);
                        pending_rating_key = 0;
                    } else {
                        if preload_broken {
                            warn!(rating_key = meta.rating_key, "preload was truncated, re-fetching");
                            atomics.preload_error_rk.store(0, Ordering::Relaxed);
                        }
                        let deck = pending;
                        handle_play(
                            &url,
                            &meta,
                            deck,
                            &audio_cmd_tx,
                            &deck_tx(deck, &deck_a_tx, &deck_b_tx),
                            &event_tx,
                            &app_handle,
                            &rt,
                            &atomics,
                            &cache,
                            &crossfade_settings,
                            device_sample_rate,
                            device_channels,
                        );
                        // Eagerly reflect the upcoming deck swap
                        set_active_eagerly(&atomics, deck);
                        pending_rating_key = 0;
                    }
                }
                Command::PreloadNext { url, meta } => {
                    let deck = pending_deck(&atomics);
                    info!(
                        rating_key = meta.rating_key,
                        ?deck,
                        active_deck = atomics.active_deck_id.load(Ordering::Relaxed),
                        "PRELOAD command"
                    );
                    pending_rating_key = meta.rating_key;
                    handle_preload(
                        &url,
                        &meta,
                        deck,
                        &audio_cmd_tx,
                        &deck_tx(deck, &deck_a_tx, &deck_b_tx),
                        &event_tx,
                        &app_handle,
                        &rt,
                        &atomics,
                        &cache,
                        &crossfade_settings,
                        device_sample_rate,
                        device_channels,
                    );
                }
                Command::Pause => {
                    let _ = audio_cmd_tx.send(AudioCommand::Pause);
                }
                Command::Resume => {
                    let _ = audio_cmd_tx.send(AudioCommand::Resume);
                }
                Command::Stop => {
                    let _ = audio_cmd_tx.send(AudioCommand::Stop);
                }
                Command::Seek { position_ms } => {
                    handle_seek(
                        position_ms,
                        &audio_cmd_tx,
                        &atomics,
                    );
                }
                Command::SetVolume { gain } => {
                    let _ = audio_cmd_tx.send(AudioCommand::SetVolume(gain));
                }
                Command::SetNormalization { enabled } => {
                    let _ = audio_cmd_tx.send(AudioCommand::SetNormalization(enabled));
                }
                Command::SetPreampGain { db } => {
                    let _ = audio_cmd_tx.send(AudioCommand::SetPreampGain(db));
                }
                Command::SetEq { gains_db } => {
                    let _ = audio_cmd_tx.send(AudioCommand::SetEq(gains_db));
                }
                Command::SetEqEnabled { enabled } => {
                    let _ = audio_cmd_tx.send(AudioCommand::SetEqEnabled(enabled));
                }
                Command::SetEqPostgain { db } => {
                    let _ = audio_cmd_tx.send(AudioCommand::SetEqPostgain(db));
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
                Command::SetVisualizerEnabled { enabled } => {
                    let _ = audio_cmd_tx.send(AudioCommand::SetVisualizerEnabled(enabled));
                }
                Command::SetCacheMaxBytes { bytes } => {
                    cache.set_max_bytes(bytes);
                }
                Command::ClearCache => {
                    cache.clear();
                }
                Command::DuckAndApply { duck_ms } => {
                    let _ = audio_cmd_tx.send(AudioCommand::DuckAndApply { duck_ms });
                }
                Command::Shutdown => {
                    info!("audio engine control thread shutting down");
                    break;
                }
            },
            Err(_) => {
                info!("command channel disconnected, control thread exiting");
                break;
            }
        }
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
    event_tx: &Sender<EngineEvent>,
    app_handle: &tauri::AppHandle,
    rt: &tokio::runtime::Handle,
    atomics: &Arc<SharedAtomics>,
    cache: &Arc<AudioCache>,
    _xfade: &CrossfadeSettings,
    device_rate: u32,
    device_channels: u16,
) {
    debug!(rating_key = meta.rating_key, ?deck, "play command");

    // Cache ramps
    cache_ramps(meta, audio_cmd_tx);

    // Set buffering state
    atomics.set_state(EngineState::Buffering);
    let _ = event_tx.send(EngineEvent::State {
        state: "buffering".into(),
    });

    let norm_enabled = true; // TODO: read from atomics if needed

    // Increment generation to invalidate any old bg decode threads writing to this deck
    let generation = match deck {
        DeckId::A => atomics.deck_a_generation.fetch_add(1, Ordering::Relaxed) + 1,
        DeckId::B => atomics.deck_b_generation.fetch_add(1, Ordering::Relaxed) + 1,
    };

    match fetch_and_decode_incremental(url, meta.rating_key, cache, app_handle, rt, device_rate, device_channels) {
        Ok(result) => {
            let source_rate = result.source_rate;
            let source_channels = result.source_channels;
            let has_more = result.has_more;

            // Resolve gain: Plex metadata → cached analysis → fresh EBU R128 analysis
            let gain_db = resolve_gain_db(meta, url, cache);
            let mut resolved_meta = meta.clone();
            resolved_meta.gain_db = gain_db;
            let norm_gain = if norm_enabled {
                gain_db.map_or(1.0, |db| 10.0_f32.powf(db / 20.0))
            } else {
                1.0
            };

            // Pre-compute expected samples for pre-allocation
            let expected_total = if meta.duration_ms > 0 && result.sample_rate > 0 && result.channels > 0 {
                (meta.duration_ms as f64 / 1000.0 * result.sample_rate as f64 * result.channels as f64) as usize
            } else {
                result.initial_samples.len()
            };

            // Tell audio callback to prepare the deck
            let _ = audio_cmd_tx.send(AudioCommand::LoadDeck {
                deck,
                meta: resolved_meta,
                sample_rate: result.sample_rate,
                channels: result.channels,
                norm_gain,
                expected_samples: expected_total,
            });

            // Don't mark as fully decoded if the stream was truncated
            let fully_decoded = !has_more && !result.aborted;

            // Send initial samples
            let _ = sample_tx.send(SampleBatch {
                rating_key: meta.rating_key,
                generation,
                samples: result.initial_samples,
                fully_decoded,
            });

            // Tell audio callback to swap pending → active
            let _ = audio_cmd_tx.send(AudioCommand::TransitionToActive { user_skip: true });

            // Continue decoding in background
            if let Some(decoder) = result.decoder {
                spawn_background_decode(
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
                );
            }

            if result.aborted {
                warn!(rating_key = meta.rating_key, "stream was truncated during play");
            }
        }
        Err(e) => {
            warn!(rating_key = meta.rating_key, error = %e, "play failed");
            let _ = event_tx.send(EngineEvent::Error {
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
    event_tx: &Sender<EngineEvent>,
    app_handle: &tauri::AppHandle,
    rt: &tokio::runtime::Handle,
    atomics: &Arc<SharedAtomics>,
    cache: &Arc<AudioCache>,
    _xfade: &CrossfadeSettings,
    device_rate: u32,
    device_channels: u16,
) {
    debug!(rating_key = meta.rating_key, ?deck, "preload command");

    cache_ramps(meta, audio_cmd_tx);

    let norm_enabled = true;

    // Increment generation to invalidate any old bg decode threads writing to this deck
    let generation = match deck {
        DeckId::A => atomics.deck_a_generation.fetch_add(1, Ordering::Relaxed) + 1,
        DeckId::B => atomics.deck_b_generation.fetch_add(1, Ordering::Relaxed) + 1,
    };

    match fetch_and_decode_incremental(url, meta.rating_key, cache, app_handle, rt, device_rate, device_channels) {
        Ok(result) => {
            let source_rate = result.source_rate;
            let source_channels = result.source_channels;
            let has_more = result.has_more;

            let gain_db = resolve_gain_db(meta, url, cache);
            let mut resolved_meta = meta.clone();
            resolved_meta.gain_db = gain_db;
            let norm_gain = if norm_enabled {
                gain_db.map_or(1.0, |db| 10.0_f32.powf(db / 20.0))
            } else {
                1.0
            };

            let expected_total = if meta.duration_ms > 0 && result.sample_rate > 0 && result.channels > 0 {
                (meta.duration_ms as f64 / 1000.0 * result.sample_rate as f64 * result.channels as f64) as usize
            } else {
                result.initial_samples.len()
            };

            let _ = audio_cmd_tx.send(AudioCommand::LoadDeck {
                deck,
                meta: resolved_meta,
                sample_rate: result.sample_rate,
                channels: result.channels,
                norm_gain,
                expected_samples: expected_total,
            });

            let fully_decoded = !has_more && !result.aborted;

            let _ = sample_tx.send(SampleBatch {
                rating_key: meta.rating_key,
                generation,
                samples: result.initial_samples,
                fully_decoded,
            });

            if result.aborted {
                warn!(rating_key = meta.rating_key, "preload stream was truncated");
                atomics.preload_error_rk.store(meta.rating_key, Ordering::Relaxed);
            }

            debug!(rating_key = meta.rating_key, "preload initial batch ready");
            // NOTE: No TransitionToActive here — the audio callback's scheduler handles it

            if let Some(decoder) = result.decoder {
                spawn_background_decode(
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
                );
            }
        }
        Err(e) => {
            warn!(rating_key = meta.rating_key, error = %e, "preload failed");
            let _ = event_tx.send(EngineEvent::Error {
                message: format!("preload failed: {}", e),
            });
        }
    }
}

// ---------------------------------------------------------------------------
// Seek handler
// ---------------------------------------------------------------------------

fn handle_seek(
    position_ms: u64,
    audio_cmd_tx: &Sender<AudioCommand>,
    atomics: &Arc<SharedAtomics>,
) {
    // We need to determine whether the seek target is within the decoded buffer
    // or beyond it. Read the current state from atomics to make a best-effort
    // decision. The audio callback will handle the actual seek.
    let sr = atomics.device_sample_rate.load(Ordering::Relaxed);
    let dur = atomics.duration_ms.load(Ordering::Relaxed);
    if sr == 0 || dur == 0 {
        return;
    }

    // For now, always send SeekInBuffer — the audio callback will handle
    // the case where position is beyond buffer by checking internally.
    // If the deck is not fully decoded and position is beyond buffer,
    // we need SeekClearAndWait. We don't know buffer size from here,
    // so we send SeekInBuffer and let the callback decide.
    //
    // Actually, we need to compute target_sample for the callback.
    // The callback knows its own deck state so we send the raw position_ms
    // and let it figure out the rest. Let's add a Seek variant.
    //
    // Simpler: send position as a sample offset. The callback reads its own
    // deck state to determine in-buffer vs out-of-buffer.

    // For out-of-buffer seeks, we need to signal the bg decode thread.
    // The audio callback can do this by writing to the seek atomics.
    // But the callback doesn't know the deck-to-atomic mapping...
    // Actually it does — it knows which deck is active.

    // Send a general seek command. The callback will determine the right action.
    let _ = audio_cmd_tx.send(AudioCommand::SeekInBuffer {
        position: position_ms as usize, // Encode as ms, callback converts
    });

    // Also reset DSP on seek
    let _ = audio_cmd_tx.send(AudioCommand::ResetDsp);
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
    deck: DeckId,
    generation: u64,
    sample_tx: Sender<SampleBatch>,
    atomics: Arc<SharedAtomics>,
    device_sample_rate: u32,
    device_channels: u16,
) {
    let seek_signal = match deck {
        DeckId::A => atomics.deck_a_seek_ms.clone(),
        DeckId::B => atomics.deck_b_seek_ms.clone(),
    };
    let gen_signal = match deck {
        DeckId::A => atomics.deck_a_generation.clone(),
        DeckId::B => atomics.deck_b_generation.clone(),
    };

    std::thread::Builder::new()
        .name(format!("audio-bgdec-{}", rating_key))
        .spawn(move || {
            let batch_size = (source_rate as usize * source_channels as usize) / 2;
            let mut current_gen = generation;

            loop {
                // Check for seek request
                let seek_ms = seek_signal.load(Ordering::Relaxed);
                if seek_ms >= 0 {
                    seek_signal.store(-1, Ordering::Relaxed);
                    let seek_secs = seek_ms as f64 / 1000.0;
                    debug!(rating_key, seek_secs = format!("{:.2}", seek_secs), "bg decode: seeking");

                    use symphonia::core::formats::{SeekMode, SeekTo};
                    use symphonia::core::units::Time;
                    match decoder.format.seek(
                        SeekMode::Coarse,
                        SeekTo::Time {
                            time: Time {
                                seconds: seek_secs as u64,
                                frac: seek_secs.fract(),
                            },
                            track_id: None,
                        },
                    ) {
                        Ok(seeked) => {
                            decoder.decoder.reset();
                            decoder.finished = false;
                            // Update generation — new batches get the new generation
                            current_gen = gen_signal.load(Ordering::Relaxed);
                            debug!(rating_key, seeked_ts = seeked.actual_ts, gen = current_gen, "bg decode: seek done");
                        }
                        Err(e) => warn!(rating_key, error = %e, "bg decode: seek failed"),
                    }
                }

                match decode::decode_batch(&mut decoder, batch_size) {
                    Ok(batch) if !batch.is_empty() => {
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
                            })
                            .is_err()
                        {
                            return; // Channel closed
                        }
                    }
                    Ok(_) => {
                        if decoder.aborted {
                            // Stream was truncated (download error) — don't mark
                            // as fully decoded so is_finished() won't fire and
                            // cause premature auto-advance.
                            warn!(rating_key, "bg decode: incomplete (stream truncated)");
                            atomics.preload_error_rk.store(rating_key, Ordering::Relaxed);
                        } else {
                            debug!(rating_key, "bg decode: complete");
                            let _ = sample_tx.send(SampleBatch {
                                rating_key,
                                generation: current_gen,
                                samples: Vec::new(),
                                fully_decoded: true,
                            });
                        }
                        return;
                    }
                    Err(e) => {
                        warn!(rating_key, error = %e, "bg decode: error");
                        atomics.preload_error_rk.store(rating_key, Ordering::Relaxed);
                        return;
                    }
                }
            }
        })
        .ok();
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
/// The download task runs to completion even if the track is skipped (caches it).
fn fetch_and_decode_incremental(
    url: &str,
    rating_key: i64,
    cache: &Arc<AudioCache>,
    app_handle: &tauri::AppHandle,
    rt: &tokio::runtime::Handle,
    device_rate: u32,
    device_channels: u16,
) -> Result<IncrementalDecodeResult, String> {
    use symphonia::core::io::MediaSourceStream;

    let ext = cache::extract_extension(url);

    // ---- Cache HIT: decode from local file ----
    if let Some(cached_path) = cache.lookup(rating_key) {
        debug!(rating_key, path = %cached_path.display(), "cache hit — decoding from file");
        let file = std::fs::File::open(&cached_path)
            .map_err(|e| format!("cache read: {}", e))?;
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
    let cache_writer = cache.begin_write(rating_key, &ext).ok();
    let cache_for_task = cache.clone();

    let shared_buf = rt.block_on(async {
        let client = {
            let plex_state = app.state::<PlexState>();
            let guard = plex_state.0.lock().await;
            guard
                .as_ref()
                .ok_or_else(|| "not connected to Plex".to_string())?
                .clone()
        };

        let (fetch_lock, media_client, token) = client.media_fetch_parts();

        let shared = SharedBuffer::new(None);
        let shared_w = shared.clone();

        tauri::async_runtime::spawn(async move {
            let _guard = fetch_lock.lock().await;
            let response = match media_client
                .get(&url_owned)
                .header("X-Plex-Token", &token)
                .send()
                .await
            {
                Ok(r) => r,
                Err(e) => {
                    tracing::warn!("stream fetch failed: {}", e);
                    shared_w.abort();
                    if let Some(w) = cache_writer { w.abort(); }
                    return;
                }
            };
            if !response.status().is_success() {
                tracing::warn!("stream fetch HTTP {}", response.status());
                shared_w.abort();
                if let Some(w) = cache_writer { w.abort(); }
                return;
            }
            if let Some(len) = response.content_length() {
                shared_w.set_content_length(len);
            }

            use futures::StreamExt;
            let mut stream = response.bytes_stream();
            let mut writer = cache_writer;
            while let Some(chunk_result) = stream.next().await {
                match chunk_result {
                    Ok(chunk) => {
                        // Feed decoder (skips memory accumulation if reader dropped)
                        shared_w.push(&chunk);
                        // Tee to disk cache
                        if let Some(ref mut w) = writer {
                            w.write_chunk(&chunk);
                        }
                    }
                    Err(e) => {
                        tracing::warn!("stream chunk error: {}", e);
                        shared_w.abort();
                        if let Some(w) = writer.take() { w.abort(); }
                        return;
                    }
                }
            }
            shared_w.finish();
            // Finalize cache file (rename .part → final, update index, evict LRU)
            if let Some(w) = writer {
                w.finish(&cache_for_task);
            }
        });

        Ok::<_, String>(shared)
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
) -> Option<f32> {
    // 1. Plex-provided gain
    if let Some(db) = meta.gain_db {
        return Some(db);
    }

    // 2. Previously computed gain from cache
    if let Some(db) = cache.get_computed_gain(meta.rating_key) {
        debug!(rating_key = meta.rating_key, gain_db = format!("{:.1}", db), "using cached computed gain");
        return Some(db);
    }

    // 3. Compute gain for cached files that lack Plex loudness data
    let ext = cache::extract_extension(url);
    if let Some(cached_path) = cache.lookup(meta.rating_key) {
        debug!(rating_key = meta.rating_key, "running loudness analysis (no Plex gain data)");
        match loudness::analyze_loudness(&cached_path, &ext) {
            Ok(gain_db) => {
                cache.set_computed_gain(meta.rating_key, gain_db);
                return Some(gain_db);
            }
            Err(e) => {
                warn!(rating_key = meta.rating_key, error = %e, "loudness analysis failed");
            }
        }
    }

    None
}
