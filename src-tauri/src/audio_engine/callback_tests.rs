use super::super::crossfade::types::{RampPoint, TrackRamps};
use super::super::output::playback_envelope::FADE_MS;
use super::super::types::TrackMeta;
use super::*;

const FADE_FRAMES: usize = 48000 * FADE_MS as usize / 1000;
const FADE_SAMPLES: usize = FADE_FRAMES * 2;

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
    cb.process_callback(&mut [0.0; 96000]); // 150ms pause tail, then silence
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
            assert_eq!(*listened_ms, 20 + FADE_MS);
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
    cb.process_callback(&mut [0.0; 960]);
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
    assert_eq!(output[0], 0.0);
    assert!(output.last().unwrap() > &0.0);
    assert_eq!(cb.deck_mgr.active_deck().rating_key(), 2);
    cb.process_callback(&mut [0.0; FADE_SAMPLES]);
    cb.process_callback(&mut output);
    assert!(output.iter().all(|sample| (*sample - 0.4).abs() < 1e-6));
}

fn audible_callback() -> AudioCallbackState {
    let (mut cb, _) = callback();
    cb.handle_load_deck(DeckId::A, meta(1), 48000, 2, 1.0, 0);
    let deck = cb.deck_mgr.active_deck_mut();
    deck.samples = vec![0.3; 960000];
    deck.fully_decoded = true;
    deck.has_started_playing = true;
    cb.set_state(EngineState::Playing);
    cb.process_callback(&mut [0.0; 960]);
    cb
}

#[test]
fn pause_fades_to_silence_then_freezes_at_the_exact_audio_frame() {
    let mut cb = audible_callback();
    cb.handle_command(AudioCommand::SetVolume(0.5));
    cb.handle_command(AudioCommand::Pause);
    let mut output = [1.0; FADE_SAMPLES * 2]; // 300ms callback, but only the pause fade may advance
    cb.process_callback(&mut output);
    assert!((output[0] - 0.15).abs() < 1e-6);
    assert!(output[..FADE_SAMPLES].windows(2).all(|w| w[1] <= w[0]));
    assert!(output[FADE_SAMPLES..].iter().all(|sample| *sample == 0.0));
    assert_eq!(cb.deck_mgr.active_deck().position_ms(), 10 + FADE_MS);
    let played = cb.deck_mgr.active_deck().played_frames;
    cb.process_callback(&mut output);
    assert!(output.iter().all(|sample| *sample == 0.0));
    assert_eq!(cb.deck_mgr.active_deck().position_ms(), 10 + FADE_MS);
    assert_eq!(cb.deck_mgr.active_deck().played_frames, played);
    cb.handle_command(AudioCommand::Resume);
    cb.process_callback(&mut output);
    assert_eq!(output[0], 0.0);
    assert!(output[..FADE_SAMPLES].windows(2).all(|w| w[1] >= w[0]));
    assert!(output[FADE_SAMPLES..]
        .iter()
        .all(|sample| (*sample - 0.15).abs() < 1e-6));
    assert_eq!(cb.dsp_chain.volume.gain(), 0.5);
}

#[test]
fn initial_play_and_buffered_resume_begin_the_fade_only_with_pcm() {
    let (mut cb, _) = callback();
    cb.handle_load_deck(DeckId::B, meta(2), 48000, 2, 1.0, 0);
    cb.handle_command(AudioCommand::TransitionToActive {
        user_skip: true,
        request_id: 0,
    });
    let mut output = [1.0; FADE_SAMPLES * 2];
    for _ in 0..10 {
        cb.process_callback(&mut output);
    }
    assert!(output.iter().all(|sample| *sample == 0.0));
    cb.deck_mgr
        .active_deck_mut()
        .samples
        .extend_from_slice(&[0.3; FADE_SAMPLES * 2]);
    cb.process_callback(&mut output);
    assert_eq!(output[0], 0.0);
    assert!(output[FADE_SAMPLES..]
        .iter()
        .all(|sample| (*sample - 0.3).abs() < 1e-6));
    cb.handle_command(AudioCommand::Pause);
    cb.process_callback(&mut output);
    cb.handle_command(AudioCommand::Resume);
    for _ in 0..10 {
        cb.process_callback(&mut output);
    }
    cb.deck_mgr
        .active_deck_mut()
        .samples
        .extend_from_slice(&[0.3; FADE_SAMPLES * 2]);
    cb.process_callback(&mut output);
    assert_eq!(output[0], 0.0);
    assert!(output[FADE_SAMPLES..]
        .iter()
        .all(|sample| (*sample - 0.3).abs() < 1e-6));
}

#[test]
fn pausing_across_a_scheduled_transition_does_not_stall_the_fade() {
    let mut cb = audible_callback();
    cb.handle_load_deck(DeckId::B, meta(2), 48000, 2, 1.0, 0);
    cb.deck_mgr.pending_deck_mut().samples = vec![0.2; 960000];
    cb.crossfade_settings.smart_crossfade = false;
    cb.crossfade_settings.crossfade_window_ms = 1000;
    cb.compute_and_set_schedule();
    // Put the planned transition inside the pause tail.
    let start = cb.scheduler.frames_until_crossfade(0, 48000).unwrap();
    cb.deck_mgr.active_deck_mut().position = (start as usize - 480) * 2;
    cb.handle_command(AudioCommand::Pause);
    cb.process_callback(&mut [0.0; FADE_SAMPLES * 2]);
    assert_eq!(
        cb.deck_mgr.active_deck().position,
        (start as usize - 480 + FADE_FRAMES) * 2
    );
    assert!(!cb.playback_envelope.is_fading_out());
    assert_eq!(cb.deck_mgr.active_deck().rating_key(), 1);
}

#[test]
fn pausing_a_crossfade_freezes_both_decks_and_its_remaining_overlap() {
    let mut cb = audible_callback();
    cb.handle_load_deck(DeckId::B, meta(2), 48000, 2, 1.0, 0);
    cb.deck_mgr.pending_deck_mut().samples = vec![0.1; 960000];
    cb.handle_transition_to_active(true, true);
    cb.process_callback(&mut [0.0; 960]);
    assert!(cb.is_crossfading);
    cb.handle_command(AudioCommand::Pause);
    let a = cb.deck_mgr.deck(DeckId::A).position;
    let b = cb.deck_mgr.deck(DeckId::B).position;
    let overlap = cb.crossfade_remaining_frames;
    let mut output = [1.0; FADE_SAMPLES * 2];
    cb.process_callback(&mut output);
    assert!(output[FADE_SAMPLES..].iter().all(|sample| *sample == 0.0));
    assert_eq!(cb.deck_mgr.deck(DeckId::A).position, a + FADE_SAMPLES);
    assert_eq!(cb.deck_mgr.deck(DeckId::B).position, b + FADE_SAMPLES);
    assert_eq!(cb.crossfade_remaining_frames, overlap - FADE_FRAMES as u64);
    cb.process_callback(&mut output);
    assert_eq!(cb.crossfade_remaining_frames, overlap - FADE_FRAMES as u64);
    assert!(output.iter().all(|sample| *sample == 0.0));
    cb.handle_command(AudioCommand::Resume);
    cb.process_callback(&mut output);
    assert_eq!(output[0], 0.0);
    assert!(output.iter().any(|sample| sample.abs() > 0.01));
}

#[test]
fn device_format_conversion_keeps_fade_boundaries_and_track_positions() {
    use super::super::output::format::{render, SCRATCH_SAMPLES};
    let prepare = || {
        let mut cb = audible_callback();
        cb.handle_load_deck(DeckId::B, meta(2), 48000, 2, 1.0, 0);
        cb.deck_mgr.pending_deck_mut().samples = vec![0.1; 960000];
        cb.handle_transition_to_active(true, true);
        cb
    };
    let mut direct = prepare();
    let mut converted = prepare();
    let mut scratch = [0.0; SCRATCH_SAMPLES];
    for command in [
        AudioCommand::Pause,
        AudioCommand::Resume,
        AudioCommand::Pause,
    ] {
        // Commands contain no borrowed data and these toggles have no payload.
        let second = if matches!(command, AudioCommand::Pause) {
            AudioCommand::Pause
        } else {
            AudioCommand::Resume
        };
        direct.handle_command(command);
        converted.handle_command(second);
        let mut floats = vec![0.0; 32768];
        let mut device_samples = vec![0.0_f64; floats.len()];
        direct.process_callback(&mut floats);
        render(&mut device_samples, 2, &mut scratch, |pcm| {
            converted.process_callback(pcm)
        });
        for (sample, reference) in device_samples.iter().zip(&floats) {
            assert!((*sample - f64::from(*reference)).abs() < 1e-6);
        }
        assert_eq!(
            direct.deck_mgr.deck(DeckId::A).position,
            converted.deck_mgr.deck(DeckId::A).position
        );
        assert_eq!(
            direct.deck_mgr.deck(DeckId::B).position,
            converted.deck_mgr.deck(DeckId::B).position
        );
        assert_eq!(
            direct.crossfade_remaining_frames,
            converted.crossfade_remaining_frames
        );
        assert_eq!(direct.paused, converted.paused);
    }
}

#[test]
fn invalid_normalization_metadata_cannot_silence_a_track_or_break_its_crossfade_schedule() {
    let mut cb = audible_callback();
    cb.deck_mgr.active_deck_mut().meta.as_mut().unwrap().gain_db = Some(f32::NAN);
    let mut incoming = meta(2);
    incoming.gain_db = Some(f32::INFINITY);
    cb.handle_load_deck(DeckId::B, incoming, 48000, 2, f32::NAN, 0);
    cb.deck_mgr.pending_deck_mut().samples = vec![0.1; 960000];
    cb.handle_command(AudioCommand::SetNormalization(true));
    assert_eq!(cb.deck_mgr.deck(DeckId::A).norm_gain, 1.0);
    assert_eq!(cb.deck_mgr.deck(DeckId::B).norm_gain, 1.0);
    cb.handle_transition_to_active(true, true);
    let mut audio = [0.0; 9600];
    cb.process_callback(&mut audio);
    assert!(audio.iter().all(|sample| sample.is_finite()));
    assert!(audio.iter().any(|sample| sample.abs() > 0.05));
    assert_eq!(cb.deck_mgr.active_deck().rating_key(), 2);
}

#[test]
fn recovering_a_device_retains_native_playback_identity_pause_seek_and_listening_time() {
    use super::super::output::device_render::DeviceRenderer;
    use super::super::output::owner::{CallbackOwner, OutputParams};
    let mut renderer = DeviceRenderer::new(audible_callback());
    let id = renderer.source.deck_mgr.active_deck().playback_id;
    renderer
        .configure(OutputParams {
            sample_rate: 48000,
            channels: 2,
        })
        .unwrap();
    renderer.render(&mut [0.0; 9600]);
    let before = renderer.source.deck_mgr.active_deck().played_frames;
    let (returned, recovery) = crossbeam_channel::bounded(1);
    let mut callback = CallbackOwner::new(renderer, returned);
    callback.render(&mut [0.0; 9600]);
    drop(callback);
    let mut renderer = recovery.recv().unwrap();
    assert_eq!(renderer.source.deck_mgr.active_deck().playback_id, id);
    assert!(renderer.source.deck_mgr.active_deck().played_frames > before);
    renderer.source.handle_command(AudioCommand::Pause);
    renderer.source.poll_without_output();
    let listened = renderer.source.deck_mgr.active_deck().played_frames;
    let position = renderer.source.deck_mgr.active_deck().position;
    for _ in 0..10 {
        renderer.source.poll_without_output();
    }
    renderer
        .configure(OutputParams {
            sample_rate: 44100,
            channels: 1,
        })
        .unwrap();
    let mut paused = [1.0; 4410];
    renderer.render(&mut paused);
    assert!(paused.iter().all(|sample| *sample == 0.0));
    assert_eq!(renderer.source.deck_mgr.active_deck().position, position);
    assert_eq!(
        renderer.source.deck_mgr.active_deck().played_frames,
        listened
    );
    renderer
        .source
        .handle_command(AudioCommand::SeekInBuffer { position: 5000 });
    renderer.source.poll_without_output();
    assert_eq!(renderer.source.deck_mgr.active_deck().position_ms(), 5000);
    assert_eq!(
        renderer.source.deck_mgr.active_deck().played_frames,
        listened
    );
    renderer
        .configure(OutputParams {
            sample_rate: 8000,
            channels: 2,
        })
        .unwrap();
    renderer.source.handle_command(AudioCommand::Resume);
    let mut resumed = [0.0; 1600];
    renderer.render(&mut resumed);
    assert!(resumed.iter().any(|sample| sample.abs() > 0.01));
    assert_eq!(renderer.source.deck_mgr.active_deck().playback_id, id);
    assert!((5100..=5120).contains(&renderer.source.deck_mgr.active_deck().position_ms()));
}

#[test]
fn reopening_an_audible_output_fades_in_without_restarting_the_playback_envelope() {
    use super::super::output::device_render::DeviceRenderer;
    use super::super::output::owner::OutputParams;
    let mut renderer = DeviceRenderer::new(audible_callback());
    let listened = renderer.source.deck_mgr.active_deck().played_frames;
    renderer
        .configure(OutputParams {
            sample_rate: 48000,
            channels: 2,
        })
        .unwrap();
    let mut output = [0.0; FADE_SAMPLES * 2];
    renderer.render(&mut output);
    assert_eq!(output[0], 0.0);
    assert!(output[FADE_SAMPLES..]
        .iter()
        .all(|sample| (*sample - 0.3).abs() < 1e-6));
    assert_eq!(
        renderer.source.deck_mgr.active_deck().played_frames,
        listened + FADE_FRAMES as u64 * 2
    );
}

#[test]
fn paused_seeks_and_starved_pause_tails_do_not_play_delayed_audio() {
    let mut cb = audible_callback();
    cb.handle_command(AudioCommand::Pause);
    cb.handle_command(AudioCommand::SeekInBuffer { position: 5000 });
    let mut output = [1.0; FADE_SAMPLES * 2];
    cb.process_callback(&mut output);
    assert!(output.iter().all(|sample| *sample == 0.0));
    assert_eq!(cb.deck_mgr.active_deck().position_ms(), 5000);
    cb.handle_command(AudioCommand::Resume);
    cb.process_callback(&mut output);
    let deck = cb.deck_mgr.active_deck_mut();
    deck.fully_decoded = false;
    deck.samples.truncate(deck.position + 960);
    cb.handle_command(AudioCommand::Pause);
    cb.process_callback(&mut output);
    let position = cb.deck_mgr.active_deck().position;
    cb.deck_mgr
        .active_deck_mut()
        .samples
        .extend_from_slice(&[0.3; FADE_SAMPLES * 2]);
    cb.process_callback(&mut output);
    assert!(output.iter().all(|sample| *sample == 0.0));
    assert_eq!(cb.deck_mgr.active_deck().position, position);
}

#[test]
fn a_pause_tail_can_cross_the_end_of_an_overlap_without_advancing_extra_frames() {
    let mut cb = audible_callback();
    cb.handle_load_deck(DeckId::B, meta(2), 48000, 2, 1.0, 0);
    cb.deck_mgr.pending_deck_mut().samples = vec![0.1; 960000];
    cb.handle_transition_to_active(true, true); // 500ms manual skip
    cb.process_callback(&mut vec![0.0; 48000 * 2 * 480 / 1000]);
    assert_eq!(cb.crossfade_remaining_frames, 960);
    cb.handle_command(AudioCommand::Pause);
    let mut output = [1.0; FADE_SAMPLES * 2];
    cb.process_callback(&mut output);
    assert_eq!(cb.deck_mgr.active_deck().position_ms(), 480 + FADE_MS);
    assert!(!cb.is_crossfading);
    assert!(output[FADE_SAMPLES..].iter().all(|sample| *sample == 0.0));
    cb.process_callback(&mut output);
    assert_eq!(cb.deck_mgr.active_deck().position_ms(), 480 + FADE_MS);
}

#[test]
fn pausing_while_loading_during_an_overlap_frees_the_old_deck_after_the_fade() {
    let mut cb = audible_callback();
    cb.handle_load_deck(DeckId::B, meta(2), 48000, 2, 1.0, 0);
    cb.deck_mgr.pending_deck_mut().samples = vec![0.1; 960000];
    cb.handle_transition_to_active(true, true);
    cb.process_callback(&mut [0.0; 960]);
    cb.atomics.request_epoch.store(1, Ordering::SeqCst);
    cb.handle_command(AudioCommand::BeginPlay { request_id: 1 });
    cb.handle_command(AudioCommand::Pause);
    assert!(
        cb.is_crossfading,
        "the old deck must contribute to the pause fade"
    );
    cb.process_callback(&mut [0.0; 960]);
    assert!(cb.is_crossfading);
    for _ in 1..FADE_MS / 10 {
        cb.process_callback(&mut [0.0; 960]);
    }
    assert!(
        !cb.is_crossfading,
        "a pending load must not wait for a paused overlap"
    );
    assert!(!cb.atomics.crossfading.load(Ordering::SeqCst));
    assert!(!cb.deck_mgr.pending_deck().loaded);
    cb.handle_command(AudioCommand::Resume);
    let mut output = [0.0; 960];
    cb.process_callback(&mut output);
    assert_eq!(output[0], 0.0);
    assert!(output.iter().any(|sample| *sample > 0.0));
    assert!(cb.waiting_for_play);
}

#[test]
fn stop_during_a_pause_fade_is_silent_and_a_new_play_gets_its_own_fade_in() {
    let mut cb = audible_callback();
    cb.handle_command(AudioCommand::Pause);
    cb.process_callback(&mut [0.0; 960]);
    cb.handle_command(AudioCommand::Stop);
    let mut output = [1.0; FADE_SAMPLES * 2];
    cb.process_callback(&mut output);
    assert!(output.iter().all(|sample| *sample == 0.0));
    cb.handle_load_deck(cb.deck_mgr.active_id().other(), meta(2), 48000, 2, 1.0, 0);
    cb.deck_mgr.pending_deck_mut().samples = vec![0.3; 96000];
    cb.handle_command(AudioCommand::TransitionToActive {
        user_skip: true,
        request_id: 0,
    });
    cb.process_callback(&mut output);
    assert_eq!(output[0], 0.0);
    assert!(output[FADE_SAMPLES..]
        .iter()
        .all(|sample| (*sample - 0.3).abs() < 1e-6));
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
    cb.deck_mgr.deck_mut(DeckId::A).ramps = TrackRamps {
        start_ramp: vec![],
        end_ramp: super::super::crossfade::types::parse_ramp(Some("-16 0.12;-3 4")),
    };
    cb.deck_mgr.deck_mut(DeckId::B).ramps = TrackRamps {
        start_ramp: super::super::crossfade::types::parse_ramp(Some("-16 0;-3 1")),
        end_ramp: vec![],
    };
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
        cb.deck_mgr.deck_mut(deck_id).ramps = TrackRamps {
            start_ramp: super::super::crossfade::types::parse_ramp(Some("-17 0;-3 1")),
            end_ramp: super::super::crossfade::types::parse_ramp(Some("-17 1;-3 2")),
        };
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
    cb.deck_mgr.deck_mut(DeckId::A).ramps = TrackRamps {
        start_ramp: vec![],
        end_ramp: super::super::crossfade::types::parse_ramp(Some("-16 0.12;-3 4")),
    };
    cb.deck_mgr.deck_mut(DeckId::B).ramps = TrackRamps {
        start_ramp: super::super::crossfade::types::parse_ramp(Some("-16 0;-3 1")),
        end_ramp: vec![],
    };
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
        ramps: TrackRamps::default(),
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

fn deliver_ramp_load(
    cb: &mut AudioCallbackState,
    deck: DeckId,
    metadata: TrackMeta,
    epoch: u64,
    load_id: u64,
) {
    let mut command = load(deck, metadata.rating_key, epoch, load_id, 1);
    if let AudioCommand::LoadDeck { meta, ramps, .. } = &mut command {
        *ramps = super::super::track_ramps(&metadata);
        *meta = metadata;
    }
    cb.handle_command(command);
}

fn playing_ramp_source() -> AudioCallbackState {
    let (mut cb, _) = callback();
    cb.atomics.request_epoch.store(2, Ordering::SeqCst);
    cb.atomics.deck_b_load_id.store(1, Ordering::SeqCst);
    cb.handle_command(AudioCommand::BeginPlay { request_id: 2 });
    let mut metadata = meta(42);
    metadata.start_ramp = Some("-17 0.1;-3 1".into());
    metadata.end_ramp = Some("-17 0.8;-3 2".into());
    deliver_ramp_load(&mut cb, DeckId::B, metadata, 2, 1);
    cb.handle_command(AudioCommand::TransitionToActive {
        user_skip: true,
        request_id: 2,
    });
    cb
}

#[test]
fn loaded_ramps_keep_two_media_variants_with_the_same_track_id_separate() {
    let mut cb = playing_ramp_source();
    cb.atomics.deck_a_load_id.store(1, Ordering::SeqCst);
    let mut incoming = meta(42);
    incoming.start_ramp = Some("-17 0.4;-3 1".into());
    incoming.end_ramp = Some("-17 4;-3 8".into());
    deliver_ramp_load(&mut cb, DeckId::A, incoming, 2, 1);
    let params = cb.build_crossfade_params();
    assert_eq!(
        params.out_end_ramp,
        Some(super::super::crossfade::types::parse_ramp(Some(
            "-17 0.8;-3 2"
        )))
    );
    assert_eq!(
        params.in_start_ramp,
        Some(super::super::crossfade::types::parse_ramp(Some(
            "-17 0.4;-3 1"
        )))
    );
}

#[test]
fn loaded_ramps_are_cleared_when_a_reused_deck_receives_missing_metadata() {
    let mut cb = playing_ramp_source();
    cb.atomics.deck_a_load_id.store(1, Ordering::SeqCst);
    let mut incoming = meta(42);
    incoming.start_ramp = Some("-17 0.4;-3 1".into());
    deliver_ramp_load(&mut cb, DeckId::A, incoming, 2, 1);
    cb.atomics.deck_a_load_id.store(2, Ordering::SeqCst);
    deliver_ramp_load(&mut cb, DeckId::A, meta(42), 2, 2);
    let params = cb.build_crossfade_params();
    assert!(params.in_start_ramp.is_none());
    assert_eq!(
        params.out_end_ramp,
        Some(super::super::crossfade::types::parse_ramp(Some(
            "-17 0.8;-3 2"
        )))
    );
    let plan = compute_transition(&params).unwrap();
    assert_eq!(
        plan.fallback_reason,
        Some(super::super::crossfade::types::TransitionReason::MissingRamps)
    );
}

#[test]
fn loaded_ramps_from_a_retired_load_cannot_change_the_audible_sources_plan() {
    let mut cb = playing_ramp_source();
    cb.atomics.deck_a_load_id.store(2, Ordering::SeqCst);
    let mut retired = meta(42);
    retired.start_ramp = Some("-17 7;-3 8".into());
    retired.end_ramp = Some("-17 9;-3 10".into());
    deliver_ramp_load(&mut cb, DeckId::A, retired, 1, 1);
    assert!(!cb.deck_mgr.pending_deck().loaded);
    let params = cb.build_crossfade_params();
    assert_eq!(
        params.out_end_ramp,
        Some(super::super::crossfade::types::parse_ramp(Some(
            "-17 0.8;-3 2"
        )))
    );
    assert!(params.in_start_ramp.is_none());
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
        cb.deck_mgr.deck_mut(deck_id).ramps = TrackRamps {
            start_ramp: ramp.clone(),
            end_ramp: ramp,
        };
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
    // At the default -16 dB crossing, each ramp contributes 0.8 seconds.
    for _ in 0..160 {
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


#[test]
fn public_track_keys_in_the_negative_namespace_keep_native_start_and_end_identity() {
    let (mut cb, events) = callback();
    cb.handle_load_deck(DeckId::A, meta(-1), 48000, 2, 1.0, 0);
    cb.deck_mgr.active_deck_mut().samples = vec![0.1; 96000];
    cb.deck_mgr.active_deck_mut().fully_decoded = true;
    cb.deck_mgr.active_deck_mut().has_started_playing = true;
    cb.set_state(EngineState::Playing);
    cb.process_callback(&mut [0.0; 960]);
    cb.handle_command(AudioCommand::Stop);
    let emitted: Vec<_> = events.try_iter().collect();
    assert!(emitted
        .iter()
        .any(|event| matches!(event, EngineEvent::TrackStarted { rating_key: -1, .. })));
    assert!(emitted
        .iter()
        .any(|event| matches!(event, EngineEvent::TrackEnded { rating_key: -1, .. })));
}


fn filtered_callback(samples: Vec<f32>) -> AudioCallbackState {
    let (mut cb, _) = callback();
    cb.handle_load_deck(DeckId::A, meta(1), 48000, 2, 1.0, 0);
    cb.deck_mgr.active_deck_mut().samples = samples;
    cb.deck_mgr.active_deck_mut().has_started_playing = true;
    cb.dsp_chain.set_eq_enabled(true);
    cb.dsp_chain
        .set_eq_gains(&[12.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
    cb.set_state(EngineState::Playing);
    cb
}

#[test]
fn idle_pause_callbacks_preserve_the_filter_and_limiter_state_for_resume() {
    let samples = vec![0.25; 48000 * 2 * 3];
    let mut idle = filtered_callback(samples.clone());
    let mut immediate = filtered_callback(samples);
    for cb in [&mut idle, &mut immediate] {
        cb.process_callback(&mut [0.0; 960]);
        cb.handle_command(AudioCommand::Pause);
        cb.process_callback(&mut vec![0.0; FADE_SAMPLES]);
    }
    for _ in 0..100 {
        let mut silence = [1.0; 960];
        idle.process_callback(&mut silence);
        assert!(silence.iter().all(|sample| *sample == 0.0));
    }
    assert_eq!(
        idle.deck_mgr.active_deck().played_frames,
        immediate.deck_mgr.active_deck().played_frames
    );
    idle.handle_command(AudioCommand::Resume);
    immediate.handle_command(AudioCommand::Resume);
    let mut resumed_idle = vec![0.0; FADE_SAMPLES];
    let mut resumed_immediate = resumed_idle.clone();
    idle.process_callback(&mut resumed_idle);
    immediate.process_callback(&mut resumed_immediate);
    assert!(resumed_idle.iter().any(|sample| sample.abs() > 0.1));
    let difference = resumed_idle
        .iter()
        .zip(&resumed_immediate)
        .map(|(a, b)| (*a - *b).abs())
        .fold(0.0_f32, f32::max);
    assert_eq!(
        difference, 0.0,
        "Filters must follow source frames, not paused device callbacks"
    );
}

#[test]
fn an_underrun_does_not_run_filter_history_ahead_of_the_next_source_frame() {
    let samples = vec![0.25; 960];
    let mut underrun = filtered_callback(samples.clone());
    let mut continuous = filtered_callback(samples);
    let mut oversized = vec![0.0; 4800];
    underrun.process_callback(&mut oversized);
    continuous.process_callback(&mut [0.0; 960]);
    assert!(oversized[960..].iter().all(|sample| *sample == 0.0));
    for cb in [&mut underrun, &mut continuous] {
        cb.deck_mgr
            .active_deck_mut()
            .samples
            .extend_from_slice(&vec![0.25; 48000]);
    }
    let mut actual = [0.0; 960];
    let mut expected = [0.0; 960];
    underrun.process_callback(&mut actual);
    continuous.process_callback(&mut expected);
    assert!(actual.iter().any(|sample| sample.abs() > 0.1));
    let difference = actual
        .iter()
        .zip(&expected)
        .map(|(a, b)| (*a - *b).abs())
        .fold(0.0_f32, f32::max);
    assert_eq!(
        difference, 0.0,
        "Silent padding must not change filters between adjacent source frames"
    );
}


fn analysis_callback() -> AudioCallbackState {
    let (mut cb, _) = callback();
    let mut track = meta(1);
    track.gain_db = None;
    cb.handle_load_deck(DeckId::A, track, 48000, 2, 1.0, 0);
    cb.atomics.deck_a_load_id.store(7, Ordering::SeqCst);
    cb.atomics.deck_a_loaded_id.store(7, Ordering::SeqCst);
    cb.deck_mgr.active_deck_mut().has_started_playing = true;
    cb
}

#[test]
fn analyzed_gain_fades_smoothly_on_the_owned_track_and_keeps_play_pause_independent() {
    let mut cb = analysis_callback();
    cb.handle_command(AudioCommand::AnalyzedGain {
        deck: DeckId::A,
        load_id: 7,
        gain_db: -6.0206,
    });
    let mut empty = DeckState::new(DeckId::B);
    let deck = cb.deck_mgr.active_deck_mut();
    deck.samples = vec![1.0; FADE_SAMPLES + 2];
    let mut output = vec![0.0; FADE_SAMPLES + 2];
    mixer::mix_decks(deck, &mut empty, &mut output, 2, false);
    assert_eq!(output[0], 1.0);
    assert!(output.windows(2).all(|pair| pair[1] <= pair[0]));
    assert!((output[FADE_SAMPLES / 2] - 0.75).abs() < 1e-5);
    assert!((output[FADE_SAMPLES] - 0.5).abs() < 1e-5);
    assert!(deck.norm_fade.is_none());
}

#[test]
fn analysis_for_a_previous_load_cannot_change_a_replacement_or_override_plex_gain() {
    let mut cb = analysis_callback();
    for (id, gain) in [(6, -12.0), (7, f32::NAN), (7, f32::INFINITY)] {
        cb.handle_command(AudioCommand::AnalyzedGain {
            deck: DeckId::A,
            load_id: id,
            gain_db: gain,
        });
    }
    assert_eq!(cb.deck_mgr.active_deck().norm_gain, 1.0);
    assert!(cb
        .deck_mgr
        .active_deck()
        .meta
        .as_ref()
        .unwrap()
        .gain_db
        .is_none());
    cb.deck_mgr.active_deck_mut().meta.as_mut().unwrap().gain_db = Some(-3.0);
    cb.handle_command(AudioCommand::AnalyzedGain {
        deck: DeckId::A,
        load_id: 7,
        gain_db: -12.0,
    });
    assert_eq!(
        cb.deck_mgr.active_deck().meta.as_ref().unwrap().gain_db,
        Some(-3.0)
    );
}

#[test]
fn an_analysis_completed_while_normalization_is_off_is_available_for_later_enable() {
    let mut cb = analysis_callback();
    cb.handle_command(AudioCommand::SetNormalization(false));
    cb.handle_command(AudioCommand::AnalyzedGain {
        deck: DeckId::A,
        load_id: 7,
        gain_db: -6.0206,
    });
    assert_eq!(cb.deck_mgr.active_deck().norm_gain, 1.0);
    cb.handle_command(AudioCommand::SetNormalization(true));
    let mut empty = DeckState::new(DeckId::B);
    let deck = cb.deck_mgr.active_deck_mut();
    deck.samples = vec![1.0; FADE_SAMPLES + 2];
    let mut output = vec![0.0; FADE_SAMPLES + 2];
    mixer::mix_decks(deck, &mut empty, &mut output, 2, false);
    assert_eq!(output[0], 1.0);
    assert!((output[FADE_SAMPLES] - 0.5).abs() < 1e-5);
}
