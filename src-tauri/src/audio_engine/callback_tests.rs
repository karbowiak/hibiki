use super::super::crossfade::types::RampPoint;
use super::super::types::TrackMeta;
use super::*;

fn callback() -> (AudioCallbackState, Receiver<EngineEvent>) {
    let (_cmd_tx, cmd_rx) = crossbeam_channel::unbounded();
    let (_a_tx, a_rx) = crossbeam_channel::unbounded();
    let (_b_tx, b_rx) = crossbeam_channel::unbounded();
    let (events_tx, events_rx) = crossbeam_channel::unbounded();
    let (vis_tx, _vis_rx) = crossbeam_channel::unbounded();
    let mut cb = AudioCallbackState::new(
        cmd_rx,
        a_rx,
        b_rx,
        events_tx,
        vis_tx,
        Arc::new(SharedAtomics::new()),
    );
    cb.device_sample_rate = 48000;
    cb.device_channels = 2;
    cb.dsp_chain.set_sample_rate(48000);
    (cb, events_rx)
}

fn meta(key: i64) -> TrackMeta {
    TrackMeta {
        rating_key: key,
        duration_ms: 10000,
        parent_key: key.to_string(),
        gain_db: Some(-6.0206),
        skip_crossfade: false,
        start_ramp: None,
        end_ramp: None,
    }
}

fn load(deck: DeckId, key: i64, epoch: u64, load_id: u64, generation: u64) -> AudioCommand {
    AudioCommand::LoadDeck {
        deck,
        meta: meta(key),
        sample_rate: 48000,
        channels: 2,
        norm_gain: 1.0,
        expected_samples: usize::MAX,
        request_id: epoch,
        preload_revision: None,
        load_id,
        generation,
        initial_samples: vec![0.1; 96000],
        fully_decoded: true,
        seek_tx: None,
    }
}

#[test]
fn stopped_or_superseded_load_cannot_restart_playback() {
    let (mut cb, _) = callback();
    cb.atomics.request_epoch.store(2, Ordering::SeqCst);
    cb.atomics.deck_b_load_id.store(2, Ordering::SeqCst);
    cb.handle_command(AudioCommand::BeginPlay { request_id: 2 });
    cb.handle_command(load(DeckId::B, 1, 1, 1, 1));
    cb.handle_command(AudioCommand::TransitionToActive {
        user_skip: true,
        request_id: 1,
    });
    assert!(!cb.deck_mgr.pending_deck().loaded);
    cb.atomics.request_epoch.store(3, Ordering::SeqCst);
    cb.handle_command(AudioCommand::Stop);
    cb.handle_command(load(DeckId::B, 2, 2, 2, 2));
    cb.handle_command(AudioCommand::TransitionToActive {
        user_skip: true,
        request_id: 2,
    });
    assert_eq!(cb.state(), EngineState::Stopped);
    assert!(!cb.deck_mgr.active_deck().loaded);
}

#[test]
fn paused_load_keeps_pause_and_acknowledges_the_actual_deck_swap() {
    let (mut cb, events) = callback();
    cb.atomics.request_epoch.store(1, Ordering::SeqCst);
    cb.atomics.deck_b_load_id.store(1, Ordering::SeqCst);
    cb.handle_command(AudioCommand::BeginPlay { request_id: 1 });
    cb.handle_command(AudioCommand::Pause);
    cb.handle_command(load(DeckId::B, 2, 1, 1, 7));
    cb.handle_command(AudioCommand::TransitionToActive {
        user_skip: true,
        request_id: 1,
    });
    assert_eq!(cb.state(), EngineState::Paused);
    assert_eq!(cb.atomics.active_deck_id.load(Ordering::SeqCst), 1);
    assert_eq!(cb.atomics.active_request_id.load(Ordering::SeqCst), 1);
    assert_eq!(cb.deck_mgr.active_deck().generation, 7);
    let mut out = [1.0; 960];
    cb.process_callback(&mut out);
    assert!(out.iter().all(|v| *v == 0.0));
    assert!(!events
        .try_iter()
        .any(|e| matches!(e, EngineEvent::State { state, .. } if state == "playing")));
}

#[test]
fn skip_keeps_the_current_track_audible_until_the_incoming_buffer_is_ready() {
    let (mut cb, _) = callback();
    cb.handle_load_deck(DeckId::A, meta(1), 48000, 2, 1.0, 0);
    cb.deck_mgr.active_deck_mut().samples = vec![0.2; 96000];
    cb.deck_mgr.active_deck_mut().has_started_playing = true;
    cb.set_state(EngineState::Playing);
    cb.atomics.request_epoch.store(1, Ordering::SeqCst);
    cb.atomics.deck_b_load_id.store(1, Ordering::SeqCst);
    cb.handle_command(AudioCommand::BeginPlay { request_id: 1 });
    let mut out = [0.0; 960];
    cb.process_callback(&mut out);
    assert_eq!(cb.deck_mgr.active_deck().rating_key(), 1);
    assert!(
        out.iter().any(|v| v.abs() > 0.01),
        "the outgoing song must remain audible during loading"
    );
    assert!(
        !cb.is_crossfading,
        "the fade starts only after incoming PCM is installed"
    );
    cb.handle_command(load(DeckId::B, 2, 1, 1, 1));
    cb.handle_command(AudioCommand::TransitionToActive {
        user_skip: true,
        request_id: 1,
    });
    assert_eq!(cb.deck_mgr.active_deck().rating_key(), 2);
    assert!(cb.is_crossfading);
}

#[test]
fn preloaded_samples_arm_the_gapless_scheduler() {
    let (mut cb, _) = callback();
    cb.atomics.request_epoch.store(1, Ordering::SeqCst);
    cb.atomics.deck_b_load_id.store(1, Ordering::SeqCst);
    cb.handle_load_deck(DeckId::A, meta(1), 48000, 2, 1.0, 0);
    cb.deck_mgr.active_deck_mut().samples = vec![0.1; 960000];
    cb.deck_mgr.active_deck_mut().has_started_playing = true;
    cb.crossfade_settings.crossfade_window_ms = 0;
    cb.crossfade_settings.smart_crossfade = false;
    cb.set_state(EngineState::Playing);
    cb.handle_command(load(DeckId::B, 2, 1, 1, 1));
    cb.deck_mgr.active_deck_mut().position = 960000;
    cb.tick_scheduler();
    assert_eq!(cb.deck_mgr.active_deck().rating_key(), 2);
}

#[test]
fn a_preload_cannot_replace_a_still_audible_outgoing_deck() {
    let (mut cb, _) = callback();
    cb.atomics.request_epoch.store(1, Ordering::SeqCst);
    cb.atomics.deck_b_load_id.store(1, Ordering::SeqCst);
    cb.handle_load_deck(DeckId::B, meta(2), 48000, 2, 1.0, 0);
    cb.deck_mgr.pending_deck_mut().samples = vec![0.2; 96000];
    cb.is_crossfading = true;
    cb.handle_command(load(DeckId::B, 3, 1, 1, 2));
    assert_eq!(cb.deck_mgr.pending_deck().rating_key(), 2);
    assert_eq!(cb.deck_mgr.pending_deck().samples[0], 0.2);
}

#[test]
fn clearing_a_preload_rejects_a_late_load_and_disarms_queue_advance() {
    let (mut cb, _) = callback();
    cb.atomics.request_epoch.store(1, Ordering::SeqCst);
    cb.atomics.deck_b_load_id.store(1, Ordering::SeqCst);
    cb.atomics.preload_revision.store(1, Ordering::SeqCst);
    cb.handle_command(AudioCommand::ClearPreload);
    let mut late = load(DeckId::B, 2, 1, 1, 2);
    if let AudioCommand::LoadDeck {
        preload_revision, ..
    } = &mut late
    {
        *preload_revision = Some(0);
    }
    cb.handle_command(late);
    assert!(!cb.deck_mgr.pending_deck().loaded);
}

#[test]
fn unrecoverable_stream_exhaustion_reports_an_error_once_instead_of_buffering_forever() {
    let (mut cb, events) = callback();
    cb.handle_load_deck(DeckId::A, meta(1), 48000, 2, 1.0, 0);
    cb.deck_mgr.active_deck_mut().decode_error = Some("Interrupted stream".into());
    cb.set_state(EngineState::Buffering);
    let mut output = [0.0; 960];
    cb.process_callback(&mut output);
    cb.process_callback(&mut output);
    assert_eq!(cb.state(), EngineState::Stopped);
    assert_eq!(
        events
            .try_iter()
            .filter(|e| matches!(e, EngineEvent::Error { .. }))
            .count(),
        1
    );
}

#[test]
fn failed_preload_does_not_stop_or_retry_the_active_song() {
    let (mut cb, events) = callback();
    cb.handle_load_deck(DeckId::A, meta(1), 48000, 2, 1.0, 0);
    cb.deck_mgr.active_deck_mut().samples = vec![0.1; 96000];
    cb.handle_load_deck(DeckId::B, meta(2), 48000, 2, 1.0, 0);
    cb.deck_mgr.pending_deck_mut().decode_error = Some("Interrupted preload".into());
    cb.set_state(EngineState::Playing);
    cb.check_decode_failure();
    assert_eq!(cb.state(), EngineState::Playing);
    assert!(!cb.deck_mgr.pending_deck().loaded);
    assert!(!events
        .try_iter()
        .any(|e| matches!(e, EngineEvent::Error { .. })));
}

#[test]
fn a_paused_backward_seek_can_reload_pcm_before_a_previous_seek_offset() {
    let (mut cb, _) = callback();
    let (seek_tx, seek_rx) = crossbeam_channel::unbounded();
    cb.handle_load_deck(DeckId::A, meta(1), 48000, 2, 1.0, 0);
    let active = cb.deck_mgr.active_deck_mut();
    active.sample_offset = 48000 * 2 * 5;
    active.samples = vec![0.1; 96000];
    active.fully_decoded = true;
    active.seek_tx = Some(seek_tx);
    cb.handle_command(AudioCommand::Pause);
    cb.handle_command(AudioCommand::SeekInBuffer { position: 2000 });
    let seek = seek_rx.recv().unwrap();
    assert_eq!(seek.position_ms, 2000);
    assert_eq!(seek.generation, cb.deck_mgr.active_deck().generation);
    assert_eq!(cb.state(), EngineState::Paused);
    assert_eq!(cb.deck_mgr.active_deck().sample_offset, 48000 * 2 * 2);
    assert!(!cb.deck_mgr.active_deck().fully_decoded);
}

#[test]
fn a_seek_requested_during_loading_applies_to_the_new_track() {
    let (mut cb, _) = callback();
    cb.atomics.request_epoch.store(1, Ordering::SeqCst);
    cb.atomics.deck_b_load_id.store(1, Ordering::SeqCst);
    cb.handle_command(AudioCommand::BeginPlay { request_id: 1 });
    cb.handle_command(AudioCommand::SeekInBuffer { position: 2500 });
    let (seek_tx, seek_rx) = crossbeam_channel::unbounded();
    let mut incoming = load(DeckId::B, 2, 1, 1, 1);
    if let AudioCommand::LoadDeck {
        seek_tx: sender, ..
    } = &mut incoming
    {
        *sender = Some(seek_tx);
    }
    cb.handle_command(incoming);
    cb.handle_command(AudioCommand::TransitionToActive {
        user_skip: true,
        request_id: 1,
    });
    let seek = seek_rx.recv().unwrap();
    assert_eq!(seek.position_ms, 2500);
    assert_eq!(cb.deck_mgr.active_deck().rating_key(), 2);
    assert_eq!(cb.deck_mgr.active_deck().sample_offset, 48000 * 2 * 5 / 2);
}

#[test]
fn skipping_during_a_paused_overlap_does_not_wait_forever_for_the_outgoing_deck() {
    let (mut cb, _) = callback();
    cb.handle_load_deck(DeckId::A, meta(1), 48000, 2, 1.0, 0);
    cb.handle_load_deck(DeckId::B, meta(2), 48000, 2, 1.0, 0);
    cb.is_crossfading = true;
    cb.crossfade_out_rk = 2;
    cb.crossfade_remaining_frames = 48000;
    cb.paused = true;
    cb.set_state(EngineState::Paused);
    cb.atomics.request_epoch.store(1, Ordering::SeqCst);
    cb.handle_command(AudioCommand::BeginPlay { request_id: 1 });
    assert!(!cb.is_crossfading);
    assert!(!cb.deck_mgr.pending_deck().loaded);
    assert!(cb.waiting_for_play);
}

#[test]
fn eq_duck_lasts_milliseconds_instead_of_callback_count() {
    let (mut cb, _) = callback();
    cb.handle_command(AudioCommand::SetVolume(0.7));
    cb.handle_command(AudioCommand::DuckAndApply { duck_ms: 30 });
    let mut buffer = [0.0; 960]; // 10 ms of stereo at 48 kHz
    for _ in 0..3 {
        cb.process_callback(&mut buffer);
    }
    assert!((cb.dsp_chain.volume.gain() - 0.7).abs() < 1e-6);
}

#[test]
fn rapid_eq_changes_preserve_the_original_volume() {
    let (mut cb, _) = callback();
    cb.handle_command(AudioCommand::SetVolume(0.7));
    cb.handle_command(AudioCommand::DuckAndApply { duck_ms: 30 });
    cb.handle_command(AudioCommand::DuckAndApply { duck_ms: 30 });
    let mut buffer = [0.0; 960];
    for _ in 0..3 {
        cb.process_callback(&mut buffer);
    }
    assert!((cb.dsp_chain.volume.gain() - 0.7).abs() < 1e-6);
}

#[test]
fn changing_volume_during_eq_duck_restores_the_new_volume() {
    let (mut cb, _) = callback();
    cb.handle_command(AudioCommand::SetVolume(0.7));
    cb.handle_command(AudioCommand::DuckAndApply { duck_ms: 30 });
    cb.handle_command(AudioCommand::SetVolume(0.4));
    assert_eq!(
        cb.dsp_chain.volume.gain(),
        0.0,
        "volume updates should not end the EQ duck early"
    );
    let mut buffer = [0.0; 960];
    for _ in 0..3 {
        cb.process_callback(&mut buffer);
    }
    assert!((cb.dsp_chain.volume.gain() - 0.4).abs() < 1e-6);
}

#[test]
fn disabling_normalization_applies_to_new_and_pending_tracks() {
    let (mut cb, _) = callback();
    cb.handle_command(AudioCommand::SetNormalization(false));
    cb.handle_load_deck(DeckId::B, meta(2), 48000, 2, 0.5, 0);
    assert_eq!(cb.deck_mgr.pending_deck().norm_gain, 1.0);
    cb.handle_command(AudioCommand::SetNormalization(true));
    assert!((cb.deck_mgr.pending_deck().norm_gain - 0.5).abs() < 1e-5);
}

#[test]
fn mixramp_keeps_both_decks_for_the_entire_overlap() {
    let (mut cb, events) = callback();
    for (deck_id, key) in [(DeckId::A, 1), (DeckId::B, 2)] {
        cb.handle_load_deck(deck_id, meta(key), 48000, 2, 1.0, 0);
        let deck = cb.deck_mgr.deck_mut(deck_id);
        deck.samples = vec![0.1; 48000 * 2 * 3];
        deck.fully_decoded = true;
        let ramp = vec![
            RampPoint {
                db: -20.0,
                time_sec: 0.0,
            },
            RampPoint {
                db: -10.0,
                time_sec: 2.0,
            },
        ];
        cb.ramp_cache.insert(
            key,
            TrackRamps {
                start_ramp: ramp.clone(),
                end_ramp: ramp,
            },
        );
    }
    cb.deck_mgr.active_deck_mut().has_started_playing = true;
    cb.set_state(EngineState::Playing);
    cb.handle_crossfade_transition();
    let mut buffer = [0.0; 960];
    cb.process_callback(&mut buffer);
    assert!(
        cb.is_crossfading,
        "MixRamp must not discard the outgoing deck immediately"
    );
    for _ in 0..120 {
        cb.process_callback(&mut buffer);
    }
    assert!(!cb.is_crossfading);
    assert_eq!(
        events
            .try_iter()
            .filter(|event| matches!(event, EngineEvent::TrackEnded { rating_key: 1, .. }))
            .count(),
        1
    );
}
