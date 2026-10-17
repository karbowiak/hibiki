//! Dual-deck mixer — reads from both decks, applies fade gains, writes to output.

use super::super::deck::manager::DeckState;

/// Mix samples from two decks into the output buffer.
///
/// Each deck contributes `deck.fade_gain * deck.norm_gain` of its samples.
/// If a deck has an active fade curve, the mixer reads the current gain from
/// the curve and advances it per-frame, providing smooth crossfade ramping.
pub fn mix_decks(
    active: &mut DeckState,
    pending: &mut DeckState,
    output: &mut [f32],
    output_channels: u16,
    is_crossfading: bool,
) {
    let out_ch = output_channels as usize;
    if out_ch == 0 {
        return;
    }

    for frame_start in (0..output.len()).step_by(out_ch) {
        // Get current fade gains — from curve if active, else from static value
        let a_fade = active
            .fade_curve
            .as_ref()
            .and_then(|c| c.current_gain())
            .unwrap_or(active.fade_gain);
        let a_gain = a_fade * active.next_normalization_gain();

        let (b_active, b_gain) = if is_crossfading && pending.has_started_playing {
            let b_fade = pending
                .fade_curve
                .as_ref()
                .and_then(|c| c.current_gain())
                .unwrap_or(pending.fade_gain);
            (true, b_fade * pending.next_normalization_gain())
        } else {
            (false, 0.0)
        };

        for ch in 0..out_ch {
            let idx = frame_start + ch;
            if idx >= output.len() {
                break;
            }

            let a = read_sample(active, ch);
            let b = if b_active {
                read_sample(pending, ch)
            } else {
                0.0
            };

            output[idx] = a * a_gain + b * b_gain;
        }

        // Advance positions and fade curves
        advance_position(active);
        if let Some(ref mut curve) = active.fade_curve {
            curve.advance_frame();
            if curve.is_finished() {
                // Curve done — latch the final gain value
                active.fade_gain = *curve.values.last().unwrap_or(&1.0);
            }
        }

        if b_active {
            advance_position(pending);
            if let Some(ref mut curve) = pending.fade_curve {
                curve.advance_frame();
                if curve.is_finished() {
                    pending.fade_gain = *curve.values.last().unwrap_or(&1.0);
                }
            }
        }
    }

    // Clean up finished curves
    if active
        .fade_curve
        .as_ref()
        .map_or(false, |c| c.is_finished())
    {
        active.fade_curve = None;
    }
    if pending
        .fade_curve
        .as_ref()
        .map_or(false, |c| c.is_finished())
    {
        pending.fade_curve = None;
    }
}

/// Read a single sample from a deck for the given output channel.
fn read_sample(deck: &DeckState, output_ch: usize) -> f32 {
    if !deck.loaded || deck.position >= deck.samples.len() {
        return 0.0;
    }

    let deck_ch = deck.channels as usize;
    if deck_ch == 0 {
        return 0.0;
    }

    // Map output channel to deck channel (handles stereo→surround, mono→stereo)
    let src_ch = if output_ch < deck_ch {
        output_ch
    } else {
        0 // duplicate first channel for extra output channels
    };

    let sample_idx = deck.position + src_ch;
    if sample_idx < deck.samples.len() {
        deck.samples[sample_idx]
    } else {
        0.0
    }
}

/// Advance deck position by one frame (all channels).
fn advance_position(deck: &mut DeckState) {
    if !deck.loaded || deck.position >= deck.samples.len() {
        return;
    }
    let deck_ch = deck.channels as usize;
    if deck_ch == 0 {
        return;
    }
    deck.position += deck_ch;
    deck.played_frames = deck.played_frames.saturating_add(1);
}

#[cfg(test)]
mod tests {
    use super::super::super::deck::manager::{DeckState, FadeCurve};
    use super::super::super::types::DeckId;
    use super::*;

    fn make_deck(_id: DeckId, samples: Vec<f32>, channels: u16) -> DeckState {
        DeckState {
            playback_id: 0,
            played_frames: 0,
            start_reported: false,
            end_reported: false,
            history_start_reported: false,
            history_end_reported: false,
            samples: samples.into(),
            position: 0,
            meta: None,
            ramps: Default::default(),
            sample_rate: 44100,
            channels,
            loaded: true,
            has_started_playing: true,
            fade_gain: 1.0,
            norm_gain: 1.0,
            norm_fade: None,
            fade_curve: None,
            fully_decoded: true,
            decode_error: None,
            sample_offset: 0,
            generation: 0,
            seek_tx: None,
        }
    }

    #[test]
    fn mix_single_deck() {
        let mut active = make_deck(DeckId::A, vec![0.5, -0.5, 0.3, -0.3], 2);
        let mut pending = DeckState::new(DeckId::B);
        let mut output = vec![0.0f32; 4];
        mix_decks(&mut active, &mut pending, &mut output, 2, false);
        assert!((output[0] - 0.5).abs() < 1e-5);
        assert!((output[1] - -0.5).abs() < 1e-5);
        assert!((output[2] - 0.3).abs() < 1e-5);
        assert!((output[3] - -0.3).abs() < 1e-5);
    }

    #[test]
    fn mix_with_fade_gain() {
        let mut active = make_deck(DeckId::A, vec![1.0, 1.0], 2);
        active.fade_gain = 0.5;
        let mut pending = DeckState::new(DeckId::B);
        let mut output = vec![0.0f32; 2];
        mix_decks(&mut active, &mut pending, &mut output, 2, false);
        assert!((output[0] - 0.5).abs() < 1e-5);
    }

    #[test]
    fn crossfade_mix() {
        let mut active = make_deck(DeckId::A, vec![1.0, 1.0], 2);
        active.fade_gain = 0.7;
        let mut pending = make_deck(DeckId::B, vec![0.5, 0.5], 2);
        pending.fade_gain = 0.3;
        let mut output = vec![0.0f32; 2];
        mix_decks(&mut active, &mut pending, &mut output, 2, true);
        assert!((output[0] - 0.85).abs() < 1e-5);
    }

    #[test]
    fn mono_to_stereo_upmix() {
        let mut active = make_deck(DeckId::A, vec![0.5, 0.3], 1);
        let mut pending = DeckState::new(DeckId::B);
        let mut output = vec![0.0f32; 4];
        mix_decks(&mut active, &mut pending, &mut output, 2, false);
        assert!((output[0] - 0.5).abs() < 1e-5);
        assert!((output[1] - 0.5).abs() < 1e-5);
        assert!((output[2] - 0.3).abs() < 1e-5);
        assert!((output[3] - 0.3).abs() < 1e-5);
    }

    #[test]
    fn empty_deck_produces_silence() {
        let mut active = DeckState::new(DeckId::A);
        let mut pending = DeckState::new(DeckId::B);
        let mut output = vec![999.0f32; 4];
        mix_decks(&mut active, &mut pending, &mut output, 2, false);
        for s in &output {
            assert_eq!(*s, 0.0);
        }
    }

    #[test]
    fn fade_curve_ramps_gain() {
        // 4 frames of audio, fade curve with 4 steps: 0.0, 0.33, 0.67, 1.0
        let mut active = make_deck(DeckId::A, vec![1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0], 2);
        active.fade_curve = Some(FadeCurve::new(vec![0.0, 0.33, 0.67, 1.0], 4));
        let mut pending = DeckState::new(DeckId::B);
        let mut output = vec![0.0f32; 8]; // 4 frames stereo
        mix_decks(&mut active, &mut pending, &mut output, 2, false);
        // Frame 0: gain=0.0
        assert!(output[0].abs() < 0.01);
        // Frame 3: gain=1.0
        assert!((output[6] - 1.0).abs() < 0.05);
    }
}
