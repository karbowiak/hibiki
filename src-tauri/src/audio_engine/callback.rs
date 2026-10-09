//! Audio callback state — owned exclusively by the cpal audio callback closure.
//!
//! Zero mutexes on the audio path. All communication is lock-free:
//! - Commands arrive via `crossbeam_channel::Receiver<AudioCommand>`
//! - Decoded samples arrive via per-deck `crossbeam_channel::Receiver<SampleBatch>`
//! - Position/state written to atomics
//! - Events and visualizer data sent via `crossbeam_channel::Sender`

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;

use crossbeam_channel::{Receiver, Sender};
use tracing::debug;

use super::command::{AudioCommand, SampleBatch};
use super::crossfade::scheduler::{Scheduler, SchedulerAction, SchedulerMode};
use super::crossfade::types::{CrossfadeParams, CrossfadeSettings, TrackRamps, TransitionPlan};
use super::crossfade::{compute_skip_duck, compute_transition};
use super::deck::manager::{DeckManager, DeckState, FadeCurve};
use super::dsp::DspChain;
use super::event::EngineEvent;
use super::output::mixer;
use super::types::{DeckId, EngineState};

#[cfg(test)]
#[path = "callback_tests.rs"]
mod tests;

/// Atomics shared between the audio callback and other threads.
/// The audio callback WRITES, other threads READ.
pub struct SharedAtomics {
    pub request_epoch: Arc<AtomicU64>,
    pub preload_revision: Arc<AtomicU64>,
    pub active_request_id: Arc<AtomicU64>,
    pub deck_a_load_id: Arc<AtomicU64>,
    pub deck_b_load_id: Arc<AtomicU64>,
    pub deck_a_loaded_id: Arc<AtomicU64>,
    pub deck_b_loaded_id: Arc<AtomicU64>,
    pub crossfading: Arc<AtomicBool>,
    pub engine_state: Arc<AtomicU8>,
    pub position_samples: Arc<AtomicU64>,
    pub duration_ms: Arc<AtomicU64>,
    pub active_rating_key: Arc<AtomicI64>,
    pub device_sample_rate: Arc<AtomicU32>,
    /// Which physical deck is currently active (0 = A, 1 = B).
    /// Written by the audio callback on every swap, read by the control thread
    /// to determine which deck is pending for preloads.
    pub active_deck_id: Arc<AtomicU8>,
    // Decode generations are assigned per load and per seek.
    pub deck_a_generation: Arc<AtomicU64>,
    pub deck_b_generation: Arc<AtomicU64>,
    /// Rating key of the last preload that failed (stream error / truncated).
    /// Written by bg decode or control thread on error, read by PLAY handler
    /// to avoid using a broken preload.
    pub preload_error_rk: Arc<AtomicI64>,
}

impl SharedAtomics {
    pub fn new() -> Self {
        Self {
            request_epoch: Arc::new(AtomicU64::new(0)),
            preload_revision: Arc::new(AtomicU64::new(0)),
            active_request_id: Arc::new(AtomicU64::new(0)),
            deck_a_load_id: Arc::new(AtomicU64::new(0)),
            deck_b_load_id: Arc::new(AtomicU64::new(0)),
            deck_a_loaded_id: Arc::new(AtomicU64::new(0)),
            deck_b_loaded_id: Arc::new(AtomicU64::new(0)),
            crossfading: Arc::new(AtomicBool::new(false)),
            engine_state: Arc::new(AtomicU8::new(EngineState::Stopped.to_u8())),
            position_samples: Arc::new(AtomicU64::new(0)),
            duration_ms: Arc::new(AtomicU64::new(0)),
            active_rating_key: Arc::new(AtomicI64::new(0)),
            device_sample_rate: Arc::new(AtomicU32::new(44100)),
            active_deck_id: Arc::new(AtomicU8::new(0)), // A = 0

            deck_a_generation: Arc::new(AtomicU64::new(0)),
            deck_b_generation: Arc::new(AtomicU64::new(0)),
            preload_error_rk: Arc::new(AtomicI64::new(0)),
        }
    }

    pub fn get_state(&self) -> EngineState {
        EngineState::from_u8(self.engine_state.load(Ordering::Relaxed))
    }

    pub fn set_state(&self, state: EngineState) {
        self.engine_state.store(state.to_u8(), Ordering::Relaxed);
    }
}

/// All state owned exclusively by the cpal audio callback closure.
/// No Arc, no Mutex — the callback is the sole owner.
pub struct AudioCallbackState {
    // ---- Owned audio state ----
    pub deck_mgr: DeckManager,
    pub dsp_chain: DspChain,
    pub scheduler: Scheduler,
    pub crossfade_settings: CrossfadeSettings,
    pub ramp_cache: HashMap<i64, TrackRamps>,
    pub is_crossfading: bool,
    /// Rating key of the track being faded OUT during crossfade.
    /// Used by check_crossfade_complete to avoid resetting a newly preloaded deck.
    crossfade_out_rk: i64,
    crossfade_remaining_frames: u64,
    pub normalization_enabled: bool,
    paused: bool,
    waiting_for_play: bool,
    event_request_id: u64,
    pending_seek_ms: Option<u64>,
    pending_play_paused: bool,

    // ---- Lock-free inputs ----
    cmd_rx: Receiver<AudioCommand>,
    deck_a_rx: Receiver<SampleBatch>,
    deck_b_rx: Receiver<SampleBatch>,

    // ---- Lock-free outputs ----
    event_tx: Sender<EngineEvent>,
    vis_tx: Sender<Vec<f32>>,

    // ---- Atomics (callback writes, others read) ----
    pub atomics: Arc<SharedAtomics>,

    // ---- Device info ----
    pub device_sample_rate: u32,
    pub device_channels: u16,

    // ---- Visualizer throttle ----
    vis_enabled: bool,
    vis_frame_accum: u64,

    // ---- Duck-and-apply state ----
    duck_saved_volume: Option<f32>,
    duck_remaining_frames: u32,
}

impl AudioCallbackState {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        cmd_rx: Receiver<AudioCommand>,
        deck_a_rx: Receiver<SampleBatch>,
        deck_b_rx: Receiver<SampleBatch>,
        event_tx: Sender<EngineEvent>,
        vis_tx: Sender<Vec<f32>>,
        atomics: Arc<SharedAtomics>,
    ) -> Self {
        Self {
            deck_mgr: DeckManager::new(),
            dsp_chain: DspChain::new(44100),
            scheduler: Scheduler::new(),
            crossfade_settings: CrossfadeSettings::default(),
            ramp_cache: HashMap::new(),
            is_crossfading: false,
            crossfade_out_rk: 0,
            crossfade_remaining_frames: 0,
            normalization_enabled: true,
            paused: false,
            waiting_for_play: false,
            event_request_id: 0,
            pending_seek_ms: None,
            pending_play_paused: false,

            cmd_rx,
            deck_a_rx,
            deck_b_rx,

            event_tx,
            vis_tx,

            atomics,

            device_sample_rate: 44100,
            device_channels: 2,

            vis_enabled: false,
            vis_frame_accum: 0,

            duck_saved_volume: None,
            duck_remaining_frames: 0,
        }
    }

    // -----------------------------------------------------------------------
    // Main callback — called by cpal every ~10ms
    // -----------------------------------------------------------------------

    pub fn process_callback(&mut self, data: &mut [f32]) {
        let frames = data.len() / self.device_channels.max(1) as usize;
        // Consume already decoded data before seeking: the decoder may have
        // finished and queued its final batch since the preceding callback.
        self.drain_sample_batches();
        // Initial samples travel in LoadDeck, so loading is atomic with metadata.
        self.process_commands();

        self.check_decode_failure();

        // 3. Check buffering → playing resume
        self.check_buffering_resume();

        // 4. Zero output buffer
        data.fill(0.0);

        // 5. Mix decks (direct access, no lock)
        let advancing_fade =
            self.is_crossfading && !self.paused && self.state() == EngineState::Playing;
        if !self.paused && self.state() == EngineState::Playing {
            let (active, pending) = self.deck_mgr.both_decks_mut();
            mixer::mix_decks(
                active,
                pending,
                data,
                self.device_channels,
                self.is_crossfading,
            );
        }

        // 6. Process DSP chain (direct access, no lock)
        self.dsp_chain
            .process(data, self.device_sample_rate, self.device_channels);

        // 7. Update position atomics
        self.update_position_atomics();

        // 8. Tick scheduler (sample-accurate)
        self.tick_scheduler();

        // 9. Check crossfade completion (replaces sleep+lock pattern)
        self.check_crossfade_complete(if advancing_fade { frames } else { 0 });

        self.atomics
            .crossfading
            .store(self.is_crossfading, Ordering::SeqCst);

        // 10. Handle duck-and-apply countdown
        self.tick_duck(frames as u32);

        // 11. Send visualizer data (~60fps)
        self.maybe_send_vis_frame(data);
    }

    // -----------------------------------------------------------------------
    // Sample batch draining
    // -----------------------------------------------------------------------

    fn drain_sample_batches(&mut self) {
        self.drain_deck_channel(&self.deck_a_rx.clone(), DeckId::A);
        self.drain_deck_channel(&self.deck_b_rx.clone(), DeckId::B);
    }

    fn drain_deck_channel(&mut self, rx: &Receiver<SampleBatch>, deck_id: DeckId) {
        while let Ok(batch) = rx.try_recv() {
            let deck = self.deck_mgr.deck_mut(deck_id);

            // Reject stale batches (wrong track or old seek generation)
            if deck.rating_key() != batch.rating_key || deck.generation != batch.generation {
                continue;
            }

            deck.samples.extend_from_slice(&batch.samples);
            if let Some(error) = batch.error {
                deck.decode_error = Some(error);
            }
            if batch.fully_decoded {
                deck.fully_decoded = true;
            }
        }
    }

    // -----------------------------------------------------------------------
    // Command processing
    // -----------------------------------------------------------------------

    fn process_commands(&mut self) {
        while let Ok(cmd) = self.cmd_rx.try_recv() {
            self.handle_command(cmd);
        }
    }

    fn handle_command(&mut self, cmd: AudioCommand) {
        match cmd {
            AudioCommand::FailPlay {
                request_id,
                message,
            } => {
                if request_id != self.atomics.request_epoch.load(Ordering::SeqCst) {
                    return;
                }
                self.emit_transition_info(request_id, None);
                self.scheduler.reset();
                self.deck_mgr.stop_all();
                self.atomics.deck_a_loaded_id.store(0, Ordering::SeqCst);
                self.atomics.deck_b_loaded_id.store(0, Ordering::SeqCst);
                self.atomics.deck_a_load_id.fetch_add(1, Ordering::SeqCst);
                self.atomics.deck_b_load_id.fetch_add(1, Ordering::SeqCst);
                self.is_crossfading = false;
                self.waiting_for_play = false;
                self.atomics
                    .active_request_id
                    .store(request_id, Ordering::SeqCst);
                self.set_state(EngineState::Stopped);
                let _ = self.event_tx.try_send(EngineEvent::State {
                    request_id,
                    state: "stopped".into(),
                });
                let _ = self.event_tx.try_send(EngineEvent::Error {
                    request_id,
                    message,
                });
            }
            AudioCommand::ClearPreload => {
                self.scheduler.reset();
                self.emit_transition_info(self.event_request_id, None);
                if !self.is_crossfading {
                    self.deck_mgr.pending_deck_mut().reset();
                }
            }
            AudioCommand::BeginPlay { request_id } => {
                if request_id != self.atomics.request_epoch.load(Ordering::SeqCst) {
                    return;
                }
                self.emit_transition_info(request_id, None);
                self.scheduler.reset();
                if self.is_crossfading && self.paused {
                    self.crossfade_remaining_frames = 0;
                    self.check_crossfade_complete(0);
                }
                if !self.is_crossfading {
                    self.deck_mgr.pending_deck_mut().reset();
                    match self.deck_mgr.active_id().other() {
                        DeckId::A => self.atomics.deck_a_loaded_id.store(0, Ordering::SeqCst),
                        DeckId::B => self.atomics.deck_b_loaded_id.store(0, Ordering::SeqCst),
                    }
                }
                self.waiting_for_play = true;
                self.pending_seek_ms = None;
                self.pending_play_paused = false;
                // Continue mixing the audible deck while the next load runs.
                if !self.deck_mgr.active_deck().loaded {
                    self.set_state(EngineState::Buffering);
                }
                let _ = self.event_tx.try_send(EngineEvent::State {
                    request_id,
                    state: "buffering".into(),
                });
            }
            AudioCommand::PreparePreload { request_id, deck } => {
                if request_id != self.atomics.request_epoch.load(Ordering::SeqCst)
                    || deck == self.deck_mgr.active_id()
                    || self.is_crossfading
                {
                    return;
                }
                self.scheduler.reset();
                self.emit_transition_info(request_id, None);
                self.deck_mgr.deck_mut(deck).reset();
            }
            AudioCommand::LoadDeck {
                deck,
                meta,
                sample_rate,
                channels,
                norm_gain,
                expected_samples,
                request_id,
                preload_revision,
                load_id,
                generation,
                initial_samples,
                fully_decoded,
                seek_tx,
            } => {
                let owner = match deck {
                    DeckId::A => &self.atomics.deck_a_load_id,
                    DeckId::B => &self.atomics.deck_b_load_id,
                };
                if request_id != self.atomics.request_epoch.load(Ordering::SeqCst)
                    || preload_revision.is_some_and(|value| {
                        value != self.atomics.preload_revision.load(Ordering::SeqCst)
                    })
                    || load_id != owner.load(Ordering::SeqCst)
                    || deck == self.deck_mgr.active_id()
                    || self.is_crossfading
                {
                    return;
                }
                self.handle_load_deck(
                    deck,
                    meta,
                    sample_rate,
                    channels,
                    norm_gain,
                    expected_samples,
                );
                let d = self.deck_mgr.deck_mut(deck);
                d.generation = generation;
                d.samples = initial_samples;
                d.fully_decoded = fully_decoded;
                d.seek_tx = seek_tx;
                match deck {
                    DeckId::A => self
                        .atomics
                        .deck_a_loaded_id
                        .store(load_id, Ordering::SeqCst),
                    DeckId::B => self
                        .atomics
                        .deck_b_loaded_id
                        .store(load_id, Ordering::SeqCst),
                }
                if !self.waiting_for_play {
                    self.compute_and_set_schedule();
                }
            }
            AudioCommand::Pause => {
                self.paused = true;
                if self.waiting_for_play {
                    self.pending_play_paused = true;
                    if self.is_crossfading {
                        self.crossfade_remaining_frames = 0;
                        self.check_crossfade_complete(0);
                    }
                }
                self.set_state(EngineState::Paused);
                let _ = self.event_tx.try_send(EngineEvent::State {
                    request_id: self.event_request_id,
                    state: "paused".into(),
                });
            }
            AudioCommand::Resume => {
                self.paused = false;
                if self.waiting_for_play {
                    self.pending_play_paused = false;
                }
                let state = if self.waiting_for_play {
                    EngineState::Buffering
                } else {
                    EngineState::Playing
                };
                self.set_state(state);
                let _ = self.event_tx.try_send(EngineEvent::State {
                    request_id: self.event_request_id,
                    state: if self.waiting_for_play {
                        "buffering"
                    } else {
                        "playing"
                    }
                    .into(),
                });
            }
            AudioCommand::Stop => {
                self.event_request_id = self.atomics.request_epoch.load(Ordering::SeqCst);
                self.emit_transition_info(self.event_request_id, None);
                self.scheduler.reset();
                self.deck_mgr.stop_all();
                self.atomics.deck_a_loaded_id.store(0, Ordering::SeqCst);
                self.atomics.deck_b_loaded_id.store(0, Ordering::SeqCst);
                self.is_crossfading = false;
                self.paused = false;
                self.waiting_for_play = false;
                self.set_state(EngineState::Stopped);
                let _ = self.event_tx.try_send(EngineEvent::State {
                    request_id: self.event_request_id,
                    state: "stopped".into(),
                });
            }
            AudioCommand::TransitionToActive {
                user_skip,
                request_id,
            } => {
                if request_id != self.atomics.request_epoch.load(Ordering::SeqCst)
                    || !self.deck_mgr.pending_deck().loaded
                {
                    return;
                }
                self.waiting_for_play = false;
                self.event_request_id = request_id;
                self.paused = self.pending_play_paused;
                self.handle_transition_to_active(user_skip);
                if self.paused {
                    self.set_state(EngineState::Paused);
                }
                self.atomics
                    .crossfading
                    .store(self.is_crossfading, Ordering::SeqCst);
                self.atomics
                    .active_request_id
                    .store(request_id, Ordering::SeqCst);
                if let Some(position_ms) = self.pending_seek_ms.take() {
                    self.handle_command(AudioCommand::SeekInBuffer {
                        position: position_ms as usize,
                    });
                }
            }
            AudioCommand::SeekInBuffer { position } => {
                // `position` is encoded as milliseconds from the control thread
                if self.waiting_for_play {
                    self.pending_seek_ms = Some(position as u64);
                    return;
                }
                let duration = self
                    .deck_mgr
                    .active_deck()
                    .meta
                    .as_ref()
                    .map_or(0, |m| m.duration_ms);
                let position_ms = if duration > 0 {
                    position.min(duration as usize)
                } else {
                    position
                };
                let active = self.deck_mgr.active_deck_mut();
                if active.loaded && active.channels > 0 && active.sample_rate > 0 {
                    let target_sample = ((position_ms as u128 * active.sample_rate as u128 / 1000)
                        * active.channels as u128)
                        .min(usize::MAX as u128) as usize;

                    let buffer_end = active.sample_offset + active.samples.len();
                    let in_buffer =
                        target_sample >= active.sample_offset && target_sample <= buffer_end;

                    if in_buffer {
                        active.position = target_sample - active.sample_offset;
                    } else if active.seek_tx.is_some() {
                        // Beyond buffer — need bg decode to seek
                        let out_ch = active.channels as usize;
                        let new_offset = (position_ms as f64 / 1000.0
                            * self.device_sample_rate as f64
                            * out_ch as f64) as usize;
                        let new_gen = active.generation + 1;
                        active.samples.clear();
                        active.sample_offset = new_offset;
                        active.position = 0;
                        active.fully_decoded = false;
                        active.generation = new_gen;

                        // Each decoder has its own mailbox. Reusing a physical
                        // deck cannot let an obsolete worker consume a new seek.
                        let seek = super::command::SeekRequest {
                            position_ms: position_ms as u64,
                            generation: new_gen,
                        };
                        if active.seek_tx.as_ref().unwrap().try_send(seek).is_err() {
                            active.decode_error =
                                Some("The audio decoder is unavailable for seeking".into());
                        }
                        match self.deck_mgr.active_id() {
                            DeckId::A => self
                                .atomics
                                .deck_a_generation
                                .store(new_gen, Ordering::SeqCst),
                            DeckId::B => self
                                .atomics
                                .deck_b_generation
                                .store(new_gen, Ordering::SeqCst),
                        }

                        self.set_state(if self.paused {
                            EngineState::Paused
                        } else {
                            EngineState::Buffering
                        });
                        let _ = self.event_tx.try_send(EngineEvent::State {
                            request_id: self.event_request_id,
                            state: if self.paused { "paused" } else { "buffering" }.into(),
                        });
                    } else {
                        // Fully decoded — clamp to buffer bounds
                        let clamped = target_sample
                            .saturating_sub(active.sample_offset)
                            .min(active.samples.len());
                        active.position = clamped;
                    }
                }
                self.dsp_chain.reset();
                self.scheduler.reset();
                self.compute_and_set_schedule();
            }
            AudioCommand::SetVolume(gain) => {
                if let Some(saved) = self.duck_saved_volume.as_mut() {
                    *saved = gain;
                } else {
                    self.dsp_chain.set_volume(gain);
                }
            }
            AudioCommand::SetPreampGain(db) => {
                self.dsp_chain.set_preamp_db(db);
            }
            AudioCommand::SetEq(gains) => {
                self.dsp_chain.set_eq_gains(&gains);
            }
            AudioCommand::SetEqEnabled(enabled) => {
                self.dsp_chain.set_eq_enabled(enabled);
            }
            AudioCommand::SetEqPostgain(db) => {
                self.dsp_chain.set_postgain_db(db);
            }
            AudioCommand::SetNormalization(enabled) => {
                self.normalization_enabled = enabled;
                for id in [DeckId::A, DeckId::B] {
                    let deck = self.deck_mgr.deck_mut(id);
                    if let Some(ref meta) = deck.meta {
                        deck.norm_gain = if enabled {
                            meta.gain_db.map_or(1.0, |db| 10.0_f32.powf(db / 20.0))
                        } else {
                            1.0
                        };
                    }
                }
                self.compute_and_set_schedule();
            }
            AudioCommand::UpdateCrossfadeSettings(settings) => {
                self.crossfade_settings = settings;
                // Recompute schedule if both decks loaded
                self.compute_and_set_schedule();
            }
            AudioCommand::CacheRamps { rating_key, ramps } => {
                self.ramp_cache.insert(rating_key, ramps);
                // Keep cache bounded
                if self.ramp_cache.len() > 100 {
                    if let Some(&key) = self.ramp_cache.keys().next() {
                        self.ramp_cache.remove(&key);
                    }
                }
            }
            AudioCommand::SetVisualizerEnabled(enabled) => {
                self.vis_enabled = enabled;
            }
            AudioCommand::DuckAndApply { duck_ms } => {
                // Save current volume, set to 0, schedule restore
                let current = self
                    .duck_saved_volume
                    .unwrap_or_else(|| self.dsp_chain.volume.gain());
                self.duck_saved_volume = Some(current);
                self.dsp_chain.set_volume(0.0);
                let frames = (duck_ms as f32 / 1000.0 * self.device_sample_rate as f32) as u32;
                self.duck_remaining_frames = frames;
            }
        }
    }

    // -----------------------------------------------------------------------
    // Deck loading
    // -----------------------------------------------------------------------

    fn handle_load_deck(
        &mut self,
        deck: DeckId,
        meta: super::types::TrackMeta,
        sample_rate: u32,
        channels: u16,
        norm_gain: f32,
        expected_samples: usize,
    ) {
        let d = self.deck_mgr.deck_mut(deck);
        d.reset();
        // Reserve only a small initial buffer; metadata can describe hours of audio.
        let _ = expected_samples; // Initial PCM arrives with LoadDeck; grow only as needed.
        d.sample_rate = sample_rate;
        d.channels = channels;
        d.meta = Some(meta);
        d.loaded = true;
        d.norm_gain = if self.normalization_enabled {
            norm_gain
        } else {
            1.0
        };
        // Inherit the current generation from atomics for new batches
        d.generation = match deck {
            DeckId::A => self.atomics.deck_a_generation.load(Ordering::Relaxed),
            DeckId::B => self.atomics.deck_b_generation.load(Ordering::Relaxed),
        };
    }

    // -----------------------------------------------------------------------
    // Transition (swap pending → active)
    // -----------------------------------------------------------------------

    fn handle_transition_to_active(&mut self, user_skip: bool) {
        self.scheduler.reset();

        let has_active =
            self.deck_mgr.active_deck().loaded && self.deck_mgr.active_deck().has_started_playing;

        let should_xfade = has_active
            && self.deck_mgr.pending_deck().loaded
            && !self
                .deck_mgr
                .pending_deck()
                .meta
                .as_ref()
                .map_or(true, |m| m.skip_crossfade)
            && self.effective_window() > 0
            && (user_skip
                || !super::crossfade::album_aware::should_suppress_crossfade(
                    self.deck_mgr.active_deck().parent_key(),
                    self.deck_mgr.pending_deck().parent_key(),
                    self.crossfade_settings.same_album_crossfade,
                ));

        if should_xfade && user_skip {
            // Short duck crossfade for user skip
            let plan = compute_skip_duck(500);
            self.deck_mgr.pending_deck_mut().has_started_playing = true;
            let new_rk = self.deck_mgr.pending_deck().rating_key();
            let new_dur = self
                .deck_mgr
                .pending_deck()
                .meta
                .as_ref()
                .map_or(0, |m| m.duration_ms);

            // Remember which track is fading out so crossfade cleanup
            // doesn't accidentally reset a newly preloaded deck.
            self.crossfade_out_rk = self.deck_mgr.active_deck().rating_key();
            self.swap_decks();
            self.is_crossfading = true;
            self.crossfade_remaining_frames =
                (plan.duration_sec * self.device_sample_rate as f32).ceil() as u64;

            let (active, old) = self.deck_mgr.both_decks_mut();
            apply_fade_start(active, old, &plan);

            self.set_state(if self.paused {
                EngineState::Paused
            } else {
                EngineState::Playing
            });
            let _ = self.event_tx.try_send(EngineEvent::TrackStarted {
                request_id: self.event_request_id,
                rating_key: new_rk,
                duration_ms: new_dur,
            });
            let _ = self.event_tx.try_send(EngineEvent::State {
                request_id: self.event_request_id,
                state: if self.paused { "paused" } else { "playing" }.into(),
            });
        } else {
            // Hard transition
            self.deck_mgr.active_deck_mut().reset();
            self.swap_decks();

            let active = self.deck_mgr.active_deck_mut();
            active.has_started_playing = true;
            active.fade_gain = 1.0;
            let new_rk = active.rating_key();
            let new_dur = active.meta.as_ref().map_or(0, |m| m.duration_ms);

            self.is_crossfading = false;
            self.set_state(if self.paused {
                EngineState::Paused
            } else {
                EngineState::Playing
            });
            let _ = self.event_tx.try_send(EngineEvent::TrackStarted {
                request_id: self.event_request_id,
                rating_key: new_rk,
                duration_ms: new_dur,
            });
            let _ = self.event_tx.try_send(EngineEvent::State {
                request_id: self.event_request_id,
                state: if self.paused { "paused" } else { "playing" }.into(),
            });
        }

        self.compute_and_set_schedule();
    }

    // -----------------------------------------------------------------------
    // Scheduler
    // -----------------------------------------------------------------------

    fn tick_scheduler(&mut self) {
        if self.waiting_for_play || self.paused || self.state() != EngineState::Playing {
            return;
        }

        let active = self.deck_mgr.active_deck();
        if !active.loaded {
            return;
        }

        let pos = active.position_secs();
        let dur = active.duration_secs();

        if let Some(action) = self.scheduler.check(pos, dur) {
            match action {
                SchedulerAction::TransitionPoint => {
                    self.handle_crossfade_transition();
                }
                SchedulerAction::GaplessPoint => {
                    self.handle_gapless_transition();
                }
            }
        } else if active.is_finished() && !self.is_crossfading {
            // Track ended naturally without a scheduled transition
            let rk = active.rating_key();
            let _ = self.event_tx.try_send(EngineEvent::TrackEnded {
                request_id: self.event_request_id,
                rating_key: rk,
            });
            self.set_state(EngineState::Stopped);
            let _ = self.event_tx.try_send(EngineEvent::State {
                request_id: self.event_request_id,
                state: "stopped".into(),
            });
        } else if active.loaded
            && !active.fully_decoded
            && !active.samples.is_empty()
            && active.position >= active.samples.len()
            && !self.is_crossfading
        {
            // Active deck ran out of samples but the track isn't fully decoded.
            // This happens when a streaming download was truncated (HTTP error).
            // Enter buffering state — if more data arrives it will resume,
            // otherwise the JS side can detect the stall.
            self.set_state(EngineState::Buffering);
            let _ = self.event_tx.try_send(EngineEvent::State {
                request_id: self.event_request_id,
                state: "buffering".into(),
            });
        }
    }

    fn handle_crossfade_transition(&mut self) {
        debug!("crossfade transition triggered by scheduler");

        if !self.deck_mgr.pending_deck().loaded {
            debug!("crossfade aborted: pending deck not loaded");
            return;
        }

        let plan = {
            let params = self.build_crossfade_params();
            compute_transition(&params)
        };

        if let Some(plan) = plan {
            debug!(
                duration_ms = (plan.duration_sec * 1000.0) as u32,
                "crossfade transition"
            );

            self.deck_mgr.pending_deck_mut().has_started_playing = true;
            let new_rk = self.deck_mgr.pending_deck().rating_key();
            let new_dur = self
                .deck_mgr
                .pending_deck()
                .meta
                .as_ref()
                .map_or(0, |m| m.duration_ms);

            self.crossfade_out_rk = self.deck_mgr.active_deck().rating_key();
            self.swap_decks();
            self.is_crossfading = true;
            self.crossfade_remaining_frames =
                (plan.duration_sec * self.device_sample_rate as f32).ceil() as u64;

            let (active, old) = self.deck_mgr.both_decks_mut();
            apply_fade_start(active, old, &plan);

            let _ = self.event_tx.try_send(EngineEvent::TrackStarted {
                request_id: self.event_request_id,
                rating_key: new_rk,
                duration_ms: new_dur,
            });

            self.compute_and_set_schedule();
        }
    }

    fn handle_gapless_transition(&mut self) {
        if !self.deck_mgr.pending_deck().loaded {
            return;
        }

        let old_rk = self.deck_mgr.active_deck().rating_key();
        self.deck_mgr.pending_deck_mut().has_started_playing = true;
        let new_rk = self.deck_mgr.pending_deck().rating_key();
        let new_dur = self
            .deck_mgr
            .pending_deck()
            .meta
            .as_ref()
            .map_or(0, |m| m.duration_ms);

        self.swap_decks();
        self.deck_mgr.pending_deck_mut().reset();

        let _ = self.event_tx.try_send(EngineEvent::TrackStarted {
            request_id: self.event_request_id,
            rating_key: new_rk,
            duration_ms: new_dur,
        });
        let _ = self.event_tx.try_send(EngineEvent::TrackEnded {
            request_id: self.event_request_id,
            rating_key: old_rk,
        });

        self.compute_and_set_schedule();
    }

    // -----------------------------------------------------------------------
    // Crossfade completion (frame-accurate, replaces sleep+lock)
    // -----------------------------------------------------------------------

    fn check_crossfade_complete(&mut self, frames: usize) {
        if !self.is_crossfading {
            return;
        }

        // MixRamp has no gain curves. Its overlap still has a real duration.
        self.crossfade_remaining_frames = self
            .crossfade_remaining_frames
            .saturating_sub(frames as u64);
        if self.crossfade_remaining_frames == 0 {
            self.is_crossfading = false;

            let pending_rk = self.deck_mgr.pending_deck().rating_key();

            // Only reset the pending deck if it still holds the fading-out track.
            // A preload may have replaced it during the crossfade — don't nuke it.
            if pending_rk == self.crossfade_out_rk || pending_rk == 0 {
                if self.crossfade_out_rk != 0 {
                    let _ = self.event_tx.try_send(EngineEvent::TrackEnded {
                        request_id: self.event_request_id,
                        rating_key: self.crossfade_out_rk,
                    });
                }
                self.deck_mgr.pending_deck_mut().reset();
            }

            self.crossfade_out_rk = 0;
            self.deck_mgr.active_deck_mut().fade_gain = 1.0;
            self.deck_mgr.active_deck_mut().fade_curve = None;
        }
    }

    // -----------------------------------------------------------------------
    // Buffering resume
    // -----------------------------------------------------------------------

    fn check_decode_failure(&mut self) {
        let active = self.deck_mgr.active_deck();
        if active.loaded && active.position >= active.samples.len() {
            if let Some(message) = active.decode_error.clone() {
                self.handle_command(AudioCommand::FailPlay {
                    request_id: self.event_request_id,
                    message,
                });
                return;
            }
        }
        if !self.is_crossfading && self.deck_mgr.pending_deck().decode_error.is_some() {
            self.deck_mgr.pending_deck_mut().reset();
            self.scheduler.reset();
            self.emit_transition_info(self.event_request_id, None);
        }
    }

    fn check_buffering_resume(&mut self) {
        if self.paused || self.state() != EngineState::Buffering {
            return;
        }
        let active = self.deck_mgr.active_deck();
        if active.loaded && !active.samples.is_empty() && active.position < active.samples.len() {
            self.set_state(EngineState::Playing);
            let _ = self.event_tx.try_send(EngineEvent::State {
                request_id: self.event_request_id,
                state: "playing".into(),
            });
        }
    }

    // -----------------------------------------------------------------------
    // Position atomics
    // -----------------------------------------------------------------------

    fn update_position_atomics(&self) {
        let active = self.deck_mgr.active_deck();
        if active.loaded {
            let pos = (active.sample_offset + active.position) as u64;
            self.atomics.position_samples.store(pos, Ordering::Relaxed);
            let dur = active.meta.as_ref().map_or(0, |m| m.duration_ms);
            self.atomics.duration_ms.store(dur, Ordering::Relaxed);
            self.atomics
                .active_rating_key
                .store(active.rating_key(), Ordering::Relaxed);
        }
    }

    // -----------------------------------------------------------------------
    // Duck-and-apply
    // -----------------------------------------------------------------------

    fn tick_duck(&mut self, frames: u32) {
        if self.duck_remaining_frames > 0 {
            self.duck_remaining_frames = self.duck_remaining_frames.saturating_sub(frames);
            if self.duck_remaining_frames == 0 {
                if let Some(vol) = self.duck_saved_volume.take() {
                    self.dsp_chain.set_volume(vol);
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // Visualizer
    // -----------------------------------------------------------------------

    fn maybe_send_vis_frame(&mut self, data: &[f32]) {
        if !self.vis_enabled {
            return;
        }
        self.vis_frame_accum += data.len() as u64;
        // ~60fps: at 48kHz stereo, 48000*2/60 = 1600 samples per vis frame
        let frames_per_vis = (self.device_sample_rate as u64 * self.device_channels as u64) / 60;
        if frames_per_vis == 0 || self.vis_frame_accum < frames_per_vis {
            return;
        }
        self.vis_frame_accum = 0;
        let _ = self.vis_tx.try_send(data.to_vec());
    }

    // -----------------------------------------------------------------------
    // Deck swap helper
    // -----------------------------------------------------------------------

    /// Swap active/pending deck roles and update ALL shared atomics immediately
    /// so the control thread always has a consistent view of the active deck.
    fn swap_decks(&mut self) {
        let old_rk = self.deck_mgr.active_deck().rating_key();
        self.deck_mgr.swap_roles();
        let active = self.deck_mgr.active_deck();
        let new_rk = active.rating_key();
        let id = match self.deck_mgr.active_id() {
            DeckId::A => 0u8,
            DeckId::B => 1u8,
        };
        debug!(old_rk, new_rk, new_active_deck = id, "SWAP decks");
        self.atomics.active_deck_id.store(id, Ordering::Relaxed);
        self.atomics
            .active_rating_key
            .store(new_rk, Ordering::Relaxed);
        if active.loaded {
            let pos = (active.sample_offset + active.position) as u64;
            self.atomics.position_samples.store(pos, Ordering::Relaxed);
            let dur = active.meta.as_ref().map_or(0, |m| m.duration_ms);
            self.atomics.duration_ms.store(dur, Ordering::Relaxed);
        }
    }

    // -----------------------------------------------------------------------
    // Crossfade helpers
    // -----------------------------------------------------------------------

    fn effective_window(&self) -> u32 {
        if self.crossfade_settings.smart_crossfade {
            self.crossfade_settings.smart_crossfade_max_ms
        } else {
            self.crossfade_settings.crossfade_window_ms
        }
    }

    fn compute_and_set_schedule(&mut self) {
        use super::crossfade::types::{TransitionInfo, TransitionReason};
        self.scheduler.reset();
        if self.waiting_for_play || self.is_crossfading {
            self.emit_transition_info(self.event_request_id, None);
            return;
        }

        let active = self.deck_mgr.active_deck();
        let pending = self.deck_mgr.pending_deck();

        if !active.loaded || !pending.loaded {
            self.emit_transition_info(self.event_request_id, None);
            return;
        }

        if active.duration_secs() <= 0.0 || pending.duration_secs() <= 0.0 {
            self.emit_transition_info(self.event_request_id, None);
            return;
        }

        let mut info = TransitionInfo {
            outgoing_rating_key: active.rating_key(),
            incoming_rating_key: pending.rating_key(),
            mode: "gapless",
            reason: None,
            start_time_ms: (active.duration_secs() * 1000.0).round() as u64,
            duration_ms: 0,
        };

        let window = self.effective_window();
        let suppress = super::crossfade::album_aware::should_suppress_crossfade(
            active.parent_key(),
            pending.parent_key(),
            self.crossfade_settings.same_album_crossfade,
        );

        if window == 0 || suppress || pending.meta.as_ref().map_or(false, |m| m.skip_crossfade) {
            info.reason = Some(if suppress {
                TransitionReason::SameAlbum
            } else if window == 0 {
                TransitionReason::CrossfadeDisabled
            } else {
                TransitionReason::DirectAudio
            });
            self.scheduler.set_mode(SchedulerMode::Gapless);
            self.scheduler.set_transition_point(active.duration_secs());
        } else {
            let params = self.build_crossfade_params();
            if let Some(plan) = compute_transition(&params) {
                info.mode = if plan.fade_out_curve.is_none() {
                    "mixRamp"
                } else {
                    "timed"
                };
                info.reason = plan.fallback_reason;
                info.start_time_ms = (plan.start_time_sec * 1000.0).round() as u64;
                info.duration_ms = (plan.duration_sec * 1000.0).round() as u64;
                self.scheduler.set_mode(SchedulerMode::Crossfade);
                self.scheduler.set_transition_point(plan.start_time_sec);
                debug!(
                    trigger_sec = format!("{:.2}", plan.start_time_sec),
                    duration_sec = format!("{:.2}", plan.duration_sec),
                    track_duration = format!("{:.2}", active.duration_secs()),
                    "scheduled crossfade"
                );
            } else {
                info.reason = Some(TransitionReason::NoOverlap);
                self.scheduler.set_mode(SchedulerMode::Gapless);
                self.scheduler.set_transition_point(active.duration_secs());
            }
        }
        self.emit_transition_info(self.event_request_id, Some(info));
    }

    fn emit_transition_info(
        &self,
        request_id: u64,
        transition: Option<super::crossfade::types::TransitionInfo>,
    ) {
        let _ = self.event_tx.try_send(EngineEvent::TransitionScheduled {
            request_id,
            transition,
        });
    }

    fn build_crossfade_params(&self) -> CrossfadeParams {
        let active = self.deck_mgr.active_deck();
        let pending = self.deck_mgr.pending_deck();
        let out_ramps = self.ramp_cache.get(&active.rating_key());
        let in_ramps = self.ramp_cache.get(&pending.rating_key());

        CrossfadeParams {
            out_duration_sec: active.duration_secs(),
            in_duration_sec: pending.duration_secs(),
            out_gain_db: if active.norm_gain.is_finite() && active.norm_gain > 0.0 {
                20.0 * active.norm_gain.log10()
            } else {
                0.0
            },
            in_gain_db: if pending.norm_gain.is_finite() && pending.norm_gain > 0.0 {
                20.0 * pending.norm_gain.log10()
            } else {
                0.0
            },
            out_parent_key: active.parent_key().to_string(),
            in_parent_key: pending.parent_key().to_string(),
            out_end_ramp: out_ramps.map(|r| r.end_ramp.clone()),
            in_start_ramp: in_ramps.map(|r| r.start_ramp.clone()),
            crossfade_window_ms: self.crossfade_settings.crossfade_window_ms,
            smart_crossfade_max_ms: self.crossfade_settings.smart_crossfade_max_ms,
            mixramp_db: self.crossfade_settings.mixramp_db,
            smart_crossfade_enabled: self.crossfade_settings.smart_crossfade,
            same_album_crossfade: self.crossfade_settings.same_album_crossfade,
        }
    }

    // -----------------------------------------------------------------------
    // State helpers
    // -----------------------------------------------------------------------

    fn state(&self) -> EngineState {
        self.atomics.get_state()
    }

    fn set_state(&self, state: EngineState) {
        self.atomics.set_state(state);
    }
}

/// Install fade curves on both decks for a transition plan.
fn apply_fade_start(new_active: &mut DeckState, old_active: &mut DeckState, plan: &TransitionPlan) {
    let total_frames = (plan.duration_sec * new_active.sample_rate as f32) as usize;

    if let (Some(fade_in), Some(fade_out)) = (&plan.fade_in_curve, &plan.fade_out_curve) {
        new_active.fade_gain = 0.0;
        new_active.fade_curve = Some(FadeCurve::new(fade_in.clone(), total_frames));

        old_active.fade_gain = 1.0;
        old_active.fade_curve = Some(FadeCurve::new(fade_out.clone(), total_frames));

        debug!(
            steps = fade_in.len(),
            total_frames,
            duration_sec = plan.duration_sec,
            "crossfade curves installed"
        );
    } else {
        // MixRamp: both at full volume during overlap
        new_active.fade_gain = 1.0;
        new_active.fade_curve = None;
        old_active.fade_gain = 1.0;
        old_active.fade_curve = None;
    }
}
