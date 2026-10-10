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

#[test]
fn listening_time_excludes_seeks_pauses_and_unplayed_preloads() {
    let (mut cb, events) = callback();
    cb.handle_load_deck(DeckId::A, meta(1), 48000, 2, 1.0, 0);
    cb.handle_load_deck(DeckId::B, meta(2), 48000, 2, 1.0, 0);
    cb.deck_mgr.active_deck_mut().samples = vec![0.1; 960000];
    cb.deck_mgr.active_deck_mut().fully_decoded = true;
    cb.deck_mgr.active_deck_mut().has_started_playing = true;
    cb.set_state(EngineState::Playing);
    cb.process_callback(&mut [0.0; 960]); // 10ms heard
    cb.handle_command(AudioCommand::Pause);
    cb.process_callback(&mut [0.0; 96000]); // One second paused
    cb.handle_command(AudioCommand::ClearPreload);
    cb.handle_command(AudioCommand::SeekInBuffer { position: 9000 });
    cb.handle_command(AudioCommand::Resume);
    cb.process_callback(&mut [0.0; 960]); // Another 10ms heard
    cb.handle_command(AudioCommand::Stop);
    cb.handle_command(AudioCommand::Stop);
    let ended: Vec<_> = events
        .try_iter()
        .filter(|event| matches!(event, EngineEvent::TrackEnded { .. }))
        .collect();
    assert_eq!(
        ended.len(),
        1,
        "preloads and repeated Stop must not create listens"
    );
    match &ended[0] {
        EngineEvent::TrackEnded {
            listened_ms,
            position_ms,
            reason,
            rating_key,
            playback_id,
            ..
        } => {
            assert_eq!(*listened_ms, 20);
            assert_eq!(*position_ms, 9010);
            assert_eq!(*rating_key, 1);
            assert_eq!(*playback_id, 1);
            assert_eq!(*reason, TrackEndReason::Stopped);
        }
        _ => unreachable!(),
    }
}

#[test]
fn a_paused_deck_reports_start_only_after_its_first_rendered_frame() {
    let (mut cb, events) = callback();
    cb.handle_load_deck(DeckId::A, meta(1), 48000, 2, 1.0, 0);
    cb.deck_mgr.active_deck_mut().samples = vec![0.1; 96000];
    cb.deck_mgr.active_deck_mut().has_started_playing = true;
    cb.handle_command(AudioCommand::Pause);
    cb.process_callback(&mut [0.0; 960]);
    assert!(!events
        .try_iter()
        .any(|event| matches!(event, EngineEvent::TrackStarted { .. })));
    cb.handle_command(AudioCommand::Resume);
    cb.process_callback(&mut [0.0; 960]);
    cb.process_callback(&mut [0.0; 960]);
    assert_eq!(
        events
            .try_iter()
            .filter(|event| matches!(event, EngineEvent::TrackStarted { playback_id: 1, .. }))
            .count(),
        1
    );
}

#[test]
fn resuming_while_an_incoming_track_is_loading_keeps_the_outgoing_audio_audible() {
    let (mut cb, _) = callback();
    cb.handle_load_deck(DeckId::A, meta(1), 48000, 2, 1.0, 0);
    cb.deck_mgr.active_deck_mut().samples = vec![0.3; 96000];
    cb.deck_mgr.active_deck_mut().has_started_playing = true;
    cb.set_state(EngineState::Playing);
    cb.atomics.request_epoch.store(1, Ordering::SeqCst);
    cb.handle_command(AudioCommand::BeginPlay { request_id: 1 });
    cb.handle_command(AudioCommand::Pause);
    cb.handle_command(AudioCommand::Resume);
    let mut output = [0.0; 960];
    cb.process_callback(&mut output);
    assert!(output.iter().all(|sample| (*sample - 0.3).abs() < 1e-6));
    assert!(cb.waiting_for_play);
}

#[test]
fn selecting_a_new_track_while_paused_does_not_briefly_resume_the_outgoing_song() {
    let (mut cb, _) = callback();
    cb.handle_load_deck(DeckId::A, meta(1), 48000, 2, 1.0, 0);
    cb.handle_load_deck(DeckId::B, meta(2), 48000, 2, 1.0, 0);
    cb.deck_mgr.active_deck_mut().samples = vec![0.1; 96000];
    cb.deck_mgr.active_deck_mut().has_started_playing = true;
    cb.deck_mgr.pending_deck_mut().samples = vec![0.4; 96000];
    cb.set_state(EngineState::Playing);
    cb.process_callback(&mut [0.0; 960]);
    cb.handle_command(AudioCommand::Pause);
    cb.handle_command(AudioCommand::TransitionToActive {
        user_skip: true,
        request_id: 0,
    });
    assert!(!cb.is_crossfading);
    let mut output = [0.0; 960];
    cb.process_callback(&mut output);
    assert!(output.iter().all(|sample| (*sample - 0.4).abs() < 1e-6));
}

#[test]
fn fading_between_two_occurrences_of_one_song_finishes_only_the_outgoing_identity() {
    for key in [0, 1] {
        let (mut cb, events) = callback();
        for deck_id in [DeckId::A, DeckId::B] {
            let mut metadata = meta(key);
            metadata.duration_ms = 2000;
            cb.handle_load_deck(deck_id, metadata, 48000, 2, 1.0, 0);
            let deck = cb.deck_mgr.deck_mut(deck_id);
            deck.samples = vec![0.1; 192000];
            deck.fully_decoded = true;
        }
        cb.deck_mgr.active_deck_mut().has_started_playing = true;
        cb.crossfade_settings.smart_crossfade = false;
        cb.crossfade_settings.crossfade_window_ms = 400;
        cb.set_state(EngineState::Playing);
        cb.compute_and_set_schedule();
        cb.process_callback(&mut vec![0.0; 48000 * 2 * 17 / 10]);
        let starts: Vec<_> = events
            .try_iter()
            .filter_map(|event| match event {
                EngineEvent::TrackStarted {
                    playback_id,
                    rating_key,
                    ..
                } => Some((playback_id, rating_key)),
                _ => None,
            })
            .collect();
        assert_eq!(starts, [(1, key), (2, key)]);
        cb.process_callback(&mut vec![0.0; 48000 * 2 * 3 / 10]);
        let ends: Vec<_> = events
            .try_iter()
            .filter_map(|event| match event {
                EngineEvent::TrackEnded {
                    playback_id,
                    listened_ms,
                    reason,
                    ..
                } => Some((playback_id, listened_ms, reason)),
                _ => None,
            })
            .collect();
        assert_eq!(ends, [(1, 2000, TrackEndReason::Natural)]);
        assert_eq!(cb.deck_mgr.active_deck().playback_id, 2);
    }
}

#[test]
fn position_snapshots_do_not_mix_id_duration_and_position_from_different_plays() {
    let (mut cb, _) = callback();
    cb.handle_load_deck(DeckId::A, meta(1), 48000, 2, 1.0, 0);
    let atomics = cb.atomics.clone();
    let writer = std::thread::spawn(move || {
        for id in 1..20000u64 {
            let deck = cb.deck_mgr.active_deck_mut();
            deck.playback_id = id;
            deck.position = id as usize * 96000;
            deck.meta.as_mut().unwrap().duration_ms = id * 10000;
            cb.update_position_atomics();
        }
    });
    for _ in 0..40000 {
        if let Some((position, duration, playback)) = atomics.position_snapshot() {
            assert_eq!(position, playback * 1000);
            assert_eq!(duration, playback * 10000);
        }
    }
    writer.join().unwrap();
}

fn meta(key: i64) -> TrackMeta {
    TrackMeta {
        rating_key: key,
        duration_ms: 10000,
        parent_key: key.to_string(),
        album_playback: false,
        gain_db: Some(-6.0206),
        skip_crossfade: false,
        start_ramp: None,
        end_ramp: None,
    }
}

#[test]
fn reports_the_native_short_mixramp_plan_with_a_zero_second_intro_crossing() {
    let (mut cb, events) = callback();
    cb.handle_load_deck(DeckId::A, meta(1), 48000, 2, 1.0, 0);
    cb.handle_load_deck(DeckId::B, meta(2), 48000, 2, 1.0, 0);
    cb.ramp_cache.insert(
        1,
        TrackRamps {
            start_ramp: vec![],
            end_ramp: super::super::crossfade::types::parse_ramp(Some("-17 0.12;-3 4")),
        },
    );
    cb.ramp_cache.insert(
        2,
        TrackRamps {
            start_ramp: super::super::crossfade::types::parse_ramp(Some("-16 0;-3 1")),
            end_ramp: vec![],
        },
    );
    cb.compute_and_set_schedule();
    let event = events.try_recv().unwrap();
    match &event {
        EngineEvent::TransitionScheduled {
            transition: Some(plan),
            ..
        } => {
            assert_eq!(plan.mode, "mixRamp");
            assert_eq!(plan.reason, None);
            assert_eq!(plan.outgoing_rating_key, 1);
            assert_eq!(plan.incoming_rating_key, 2);
            assert_eq!(plan.start_time_ms, 9880);
            assert_eq!(plan.duration_ms, 120);
        }
        _ => panic!("expected a native transition plan"),
    }
    let json = serde_json::to_value(event).unwrap();
    assert_eq!(json["transition"]["duration_ms"], 120);
    cb.handle_command(AudioCommand::ClearPreload);
    assert!(matches!(
        events.try_recv().unwrap(),
        EngineEvent::TransitionScheduled {
            transition: None,
            ..
        }
    ));
}

#[test]
fn reports_missing_ramps_as_a_timed_fade_and_album_tracks_as_gapless() {
    use super::super::crossfade::types::TransitionReason;
    let (mut cb, events) = callback();
    cb.handle_load_deck(DeckId::A, meta(1), 48000, 2, 1.0, 0);
    cb.handle_load_deck(DeckId::B, meta(2), 48000, 2, 1.0, 0);
    cb.compute_and_set_schedule();
    match events.try_recv().unwrap() {
        EngineEvent::TransitionScheduled {
            transition: Some(plan),
            ..
        } => {
            assert_eq!(plan.mode, "timed");
            assert_eq!(plan.reason, Some(TransitionReason::MissingRamps));
            assert_eq!(plan.duration_ms, 4000);
        }
        _ => panic!("expected timed fallback"),
    }
    cb.deck_mgr
        .pending_deck_mut()
        .meta
        .as_mut()
        .unwrap()
        .parent_key = "1".into();
    cb.deck_mgr
        .active_deck_mut()
        .meta
        .as_mut()
        .unwrap()
        .album_playback = true;
    cb.deck_mgr
        .pending_deck_mut()
        .meta
        .as_mut()
        .unwrap()
        .album_playback = true;
    cb.compute_and_set_schedule();
    match events.try_recv().unwrap() {
        EngineEvent::TransitionScheduled {
            transition: Some(plan),
            ..
        } => {
            assert_eq!(plan.mode, "gapless");
            assert_eq!(plan.reason, Some(TransitionReason::SameAlbum));
            assert_eq!(plan.duration_ms, 0);
        }
        _ => panic!("expected album gapless transition"),
    }
}

#[test]
fn same_album_tracks_in_a_mix_use_mixramp_unless_both_decks_have_explicit_album_intent() {
    let (mut cb, events) = callback();
    for (deck_id, key) in [(DeckId::A, 1), (DeckId::B, 2)] {
        let mut metadata = meta(key);
        metadata.parent_key = "album".into();
        cb.handle_load_deck(deck_id, metadata, 48000, 2, 1.0, 0);
        cb.ramp_cache.insert(
            key,
            TrackRamps {
                start_ramp: super::super::crossfade::types::parse_ramp(Some("-17 0;-3 1")),
                end_ramp: super::super::crossfade::types::parse_ramp(Some("-17 1;-3 2")),
            },
        );
    }
    for (out_intent, in_intent, expected_mode) in [
        (false, false, "mixRamp"),
        (true, false, "mixRamp"),
        (true, true, "gapless"),
    ] {
        cb.deck_mgr
            .active_deck_mut()
            .meta
            .as_mut()
            .unwrap()
            .album_playback = out_intent;
        cb.deck_mgr
            .pending_deck_mut()
            .meta
            .as_mut()
            .unwrap()
            .album_playback = in_intent;
        cb.compute_and_set_schedule();
        match events.try_recv().unwrap() {
            EngineEvent::TransitionScheduled {
                transition: Some(plan),
                ..
            } => assert_eq!(plan.mode, expected_mode),
            _ => panic!("expected a native transition plan"),
        }
    }
}

#[test]
fn gapless_preserves_every_tail_sample_and_starts_the_next_deck_inside_the_callback() {
    let (mut cb, events) = callback();
    for (deck_id, key, value) in [(DeckId::A, 1, 0.2), (DeckId::B, 2, 0.4)] {
        let mut metadata = meta(key);
        metadata.duration_ms = 900; // Real PCM is one second; metadata is approximate.
        metadata.parent_key = "album".into();
        metadata.album_playback = true;
        cb.handle_load_deck(deck_id, metadata, 48000, 2, 1.0, 0);
        let deck = cb.deck_mgr.deck_mut(deck_id);
        deck.samples = vec![value; 96000];
        deck.fully_decoded = true;
        deck.has_started_playing = deck_id == DeckId::A;
    }
    cb.set_state(EngineState::Playing);
    cb.compute_and_set_schedule();
    let mut output = vec![0.0; 96000 + 960];
    cb.process_callback(&mut output);
    assert!(output[..96000]
        .iter()
        .all(|sample| (*sample - 0.2).abs() < 1e-6));
    assert!(output[96000..]
        .iter()
        .all(|sample| (*sample - 0.4).abs() < 1e-6));
    assert_eq!(cb.deck_mgr.active_deck().rating_key(), 2);
    assert_eq!(cb.atomics.position_ms.load(Ordering::Relaxed), 10);
    assert_eq!(
        events
            .try_iter()
            .filter(|event| matches!(event, EngineEvent::TrackEnded { rating_key: 1, .. }))
            .count(),
        1
    );
}

#[test]
fn a_mixramp_boundary_inside_the_output_buffer_aligns_the_first_incoming_sample() {
    let (mut cb, _) = callback();
    cb.device_sample_rate = 1000;
    cb.dsp_chain.set_sample_rate(1000);
    for (deck_id, key, value) in [(DeckId::A, 1, 0.2), (DeckId::B, 2, 0.4)] {
        cb.handle_load_deck(deck_id, meta(key), 1000, 2, 1.0, 0);
        let deck = cb.deck_mgr.deck_mut(deck_id);
        deck.samples = vec![value; 20000];
        deck.fully_decoded = true;
        deck.has_started_playing = deck_id == DeckId::A;
    }
    cb.ramp_cache.insert(
        1,
        TrackRamps {
            start_ramp: vec![],
            end_ramp: super::super::crossfade::types::parse_ramp(Some("-17 0.12;-3 4")),
        },
    );
    cb.ramp_cache.insert(
        2,
        TrackRamps {
            start_ramp: super::super::crossfade::types::parse_ramp(Some("-16 0;-3 1")),
            end_ramp: vec![],
        },
    );
    cb.deck_mgr.active_deck_mut().position = 9875 * 2;
    cb.set_state(EngineState::Playing);
    cb.compute_and_set_schedule();
    let mut output = [0.0; 40];
    cb.process_callback(&mut output);
    assert!(output[..10]
        .iter()
        .all(|sample| (*sample - 0.2).abs() < 1e-6));
    assert!(output[10..]
        .iter()
        .all(|sample| (*sample - 0.6).abs() < 1e-6));
    assert_eq!(cb.atomics.position_ms.load(Ordering::Relaxed), 15);
}

#[test]
fn incoming_buffer_starvation_freezes_fade_time_until_more_pcm_arrives() {
    let (mut cb, _) = callback();
    cb.handle_load_deck(DeckId::A, meta(1), 48000, 2, 1.0, 0);
    cb.handle_load_deck(DeckId::B, meta(2), 48000, 2, 1.0, 0);
    cb.deck_mgr.active_deck_mut().samples = vec![0.2; 100];
    cb.deck_mgr.active_deck_mut().has_started_playing = true;
    cb.deck_mgr.pending_deck_mut().samples = vec![0.1; 96000];
    cb.deck_mgr.pending_deck_mut().has_started_playing = true;
    cb.is_crossfading = true;
    cb.crossfade_remaining_frames = 100;
    cb.set_state(EngineState::Playing);
    cb.process_callback(&mut [0.0; 400]);
    assert_eq!(cb.crossfade_remaining_frames, 50);
    assert_eq!(cb.state(), EngineState::Buffering);
    cb.deck_mgr
        .active_deck_mut()
        .samples
        .extend_from_slice(&[0.2; 100]);
    cb.process_callback(&mut [0.0; 100]);
    assert!(!cb.is_crossfading);
    assert_eq!(cb.deck_mgr.active_deck().position, 200);
}

#[test]
fn reported_position_uses_the_deck_channel_count_instead_of_the_device_layout() {
    let (mut cb, _) = callback();
    cb.device_channels = 6;
    cb.handle_load_deck(DeckId::A, meta(1), 48000, 2, 1.0, 0);
    cb.deck_mgr.active_deck_mut().position = 96000;
    cb.update_position_atomics();
    assert_eq!(cb.atomics.position_ms.load(Ordering::Relaxed), 1000);
}

#[test]
fn trimming_played_pcm_preserves_the_timeline_and_backward_seeks_reach_the_decoder() {
    let (mut cb, _) = callback();
    cb.handle_load_deck(DeckId::A, meta(1), 48000, 2, 1.0, 0);
    let (seek_tx, seeks) = crossbeam_channel::unbounded();
    let deck = cb.deck_mgr.active_deck_mut();
    deck.samples = vec![0.2; 48000 * 2 * 24];
    deck.position = 48000 * 2 * 10;
    deck.seek_tx = Some(seek_tx);
    deck.has_started_playing = true;
    cb.set_state(EngineState::Playing);
    cb.process_callback(&mut [0.0; 960]);
    let deck = cb.deck_mgr.active_deck();
    assert_eq!(deck.sample_offset, 48000 * 2 * 8);
    assert_eq!(deck.position_ms(), 10010);
    assert_eq!(deck.samples.len(), 48000 * 2 * 16);
    cb.handle_command(AudioCommand::SeekInBuffer { position: 0 });
    let seek = seeks.try_recv().unwrap();
    assert_eq!(seek.position_ms, 0);
    assert_eq!(seek.generation, 1);
    assert_eq!(cb.deck_mgr.active_deck().sample_offset, 0);
    assert!(cb.deck_mgr.active_deck().samples.is_empty());
    assert_eq!(cb.state(), EngineState::Buffering);
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
    assert_eq!(
        cb.deck_mgr.active_deck().rating_key(),
        1,
        "wait for decoder EOF before treating a growing buffer as a track end"
    );
    cb.deck_mgr.active_deck_mut().fully_decoded = true;
    cb.process_callback(&mut [0.0; 2]);
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
fn an_unknown_duration_does_not_turn_the_initial_stream_buffer_into_an_early_end() {
    let (mut cb, _) = callback();
    let mut unknown = meta(1);
    unknown.duration_ms = 0;
    cb.handle_load_deck(DeckId::A, unknown, 48000, 2, 1.0, 0);
    cb.deck_mgr.active_deck_mut().samples = vec![0.1; 96000];
    cb.handle_load_deck(DeckId::B, meta(2), 48000, 2, 1.0, 0);
    cb.deck_mgr.pending_deck_mut().samples = vec![0.1; 96000];
    cb.set_state(EngineState::Playing);
    cb.compute_and_set_schedule();
    cb.deck_mgr.active_deck_mut().position = 95000;
    cb.tick_scheduler();
    assert_eq!(cb.deck_mgr.active_deck().rating_key(), 1);
    assert_eq!(cb.deck_mgr.active_deck().duration_secs(), 0.0);
}

#[test]
fn manual_skips_between_album_tracks_fade_after_the_new_buffer_is_ready() {
    let (mut cb, _) = callback();
    let mut outgoing = meta(1);
    outgoing.parent_key = "album".into();
    outgoing.album_playback = true;
    let mut incoming = meta(2);
    incoming.parent_key = "album".into();
    incoming.album_playback = true;
    cb.handle_load_deck(DeckId::A, outgoing, 48000, 2, 1.0, 0);
    cb.handle_load_deck(DeckId::B, incoming, 48000, 2, 1.0, 0);
    cb.deck_mgr.active_deck_mut().samples = vec![0.1; 96000];
    cb.deck_mgr.active_deck_mut().has_started_playing = true;
    cb.deck_mgr.pending_deck_mut().samples = vec![0.1; 96000];
    cb.set_state(EngineState::Playing);
    cb.handle_transition_to_active(true, true);
    assert!(cb.is_crossfading);
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
