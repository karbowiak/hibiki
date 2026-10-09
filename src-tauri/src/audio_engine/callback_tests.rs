use super::*;
use super::super::crossfade::types::RampPoint;
use super::super::types::TrackMeta;

fn callback() -> (AudioCallbackState, Receiver<EngineEvent>) {
    let (_cmd_tx, cmd_rx) = crossbeam_channel::unbounded();
    let (_a_tx, a_rx) = crossbeam_channel::unbounded();
    let (_b_tx, b_rx) = crossbeam_channel::unbounded();
    let (events_tx, events_rx) = crossbeam_channel::unbounded();
    let (vis_tx, _vis_rx) = crossbeam_channel::unbounded();
    let mut cb = AudioCallbackState::new(cmd_rx, a_rx, b_rx, events_tx, vis_tx, Arc::new(SharedAtomics::new()));
    cb.device_sample_rate = 48000;
    cb.device_channels = 2;
    cb.dsp_chain.set_sample_rate(48000);
    (cb, events_rx)
}

fn meta(key: i64) -> TrackMeta {
    TrackMeta { rating_key: key, duration_ms: 10000, parent_key: key.to_string(),
        gain_db: Some(-6.0206), skip_crossfade: false, start_ramp: None, end_ramp: None }
}

#[test]
fn eq_duck_lasts_milliseconds_instead_of_callback_count() {
    let (mut cb, _) = callback();
    cb.handle_command(AudioCommand::SetVolume(0.7));
    cb.handle_command(AudioCommand::DuckAndApply { duck_ms: 30 });
    let mut buffer = [0.0; 960]; // 10 ms of stereo at 48 kHz
    for _ in 0..3 { cb.process_callback(&mut buffer); }
    assert!((cb.dsp_chain.volume.gain() - 0.7).abs() < 1e-6);
}

#[test]
fn rapid_eq_changes_preserve_the_original_volume() {
    let (mut cb, _) = callback();
    cb.handle_command(AudioCommand::SetVolume(0.7));
    cb.handle_command(AudioCommand::DuckAndApply { duck_ms: 30 });
    cb.handle_command(AudioCommand::DuckAndApply { duck_ms: 30 });
    let mut buffer = [0.0; 960];
    for _ in 0..3 { cb.process_callback(&mut buffer); }
    assert!((cb.dsp_chain.volume.gain() - 0.7).abs() < 1e-6);
}

#[test]
fn changing_volume_during_eq_duck_restores_the_new_volume() {
    let (mut cb, _) = callback();
    cb.handle_command(AudioCommand::SetVolume(0.7));
    cb.handle_command(AudioCommand::DuckAndApply { duck_ms: 30 });
    cb.handle_command(AudioCommand::SetVolume(0.4));
    assert_eq!(cb.dsp_chain.volume.gain(), 0.0, "volume updates should not end the EQ duck early");
    let mut buffer = [0.0; 960];
    for _ in 0..3 { cb.process_callback(&mut buffer); }
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
        let ramp = vec![RampPoint { db: -20.0, time_sec: 0.0 }, RampPoint { db: -10.0, time_sec: 2.0 }];
        cb.ramp_cache.insert(key, TrackRamps { start_ramp: ramp.clone(), end_ramp: ramp });
    }
    cb.deck_mgr.active_deck_mut().has_started_playing = true;
    cb.set_state(EngineState::Playing);
    cb.handle_crossfade_transition();
    let mut buffer = [0.0; 960];
    cb.process_callback(&mut buffer);
    assert!(cb.is_crossfading, "MixRamp must not discard the outgoing deck immediately");
    for _ in 0..120 { cb.process_callback(&mut buffer); }
    assert!(!cb.is_crossfading);
    assert_eq!(events.try_iter().filter(|event| matches!(event, EngineEvent::TrackEnded { rating_key: 1 })).count(), 1);
}
