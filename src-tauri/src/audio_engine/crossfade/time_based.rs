//! Fixed-duration equal-power crossfade strategy.
//!
//! Used when smart crossfade is off, or as fallback when MixRamp fails.

use super::curves::{generate_fade_in, generate_fade_out, steps_for_duration};
use super::types::{CrossfadeParams, TransitionPlan};

/// Compute a timed equal-power crossfade transition.
pub fn compute_timed_transition(params: &CrossfadeParams) -> Option<TransitionPlan> {
    // Smart mode uses a loudness-dependent overlap. Its timed fallback uses
    // the ordinary window, bounded by the smart maximum, rather than always
    // mixing for the longest allowed duration.
    let duration_sec =
        (params.crossfade_window_ms as f32 / 1000.0).min(super::types::overlap_limit(params)?);
    if duration_sec <= 0.0 {
        return None;
    }
    let start_time = (params.out_duration_sec - duration_sec).max(0.0);
    let steps = steps_for_duration(duration_sec);

    Some(TransitionPlan {
        start_time_sec: start_time,
        duration_sec,
        fade_out_curve: Some(generate_fade_out(steps, 1.0)),
        fade_in_curve: Some(generate_fade_in(steps, 1.0)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timed_crossfade_basic() {
        let params = CrossfadeParams {
            in_duration_sec: 300.0,
            out_gain_db: 0.0,
            in_gain_db: 0.0,
            out_duration_sec: 300.0,
            out_parent_key: "a".into(),
            in_parent_key: "b".into(),
            out_end_ramp: None,
            in_start_ramp: None,
            crossfade_window_ms: 4000,
            smart_crossfade_max_ms: 20000,
            mixramp_db: -17.0,
            smart_crossfade_enabled: false,
            same_album_crossfade: false,
        };
        let plan = compute_timed_transition(&params).unwrap();
        assert!((plan.duration_sec - 4.0).abs() < 0.01);
        assert!((plan.start_time_sec - 296.0).abs() < 0.01);
        assert!(plan.fade_out_curve.is_some());
        assert!(plan.fade_in_curve.is_some());
        let out = plan.fade_out_curve.unwrap();
        let in_ = plan.fade_in_curve.unwrap();
        assert_eq!(out.len(), 400); // 4s * 100 steps/s
        assert_eq!(in_.len(), 400);
    }

    #[test]
    fn smart_fallback_uses_the_timed_window_bounded_by_the_smart_max() {
        let params = CrossfadeParams {
            in_duration_sec: 300.0,
            out_gain_db: 0.0,
            in_gain_db: 0.0,
            out_duration_sec: 300.0,
            out_parent_key: "a".into(),
            in_parent_key: "b".into(),
            out_end_ramp: None,
            in_start_ramp: None,
            crossfade_window_ms: 4000,
            smart_crossfade_max_ms: 10000,
            mixramp_db: -17.0,
            smart_crossfade_enabled: true,
            same_album_crossfade: false,
        };
        let plan = compute_timed_transition(&params).unwrap();
        assert!((plan.duration_sec - 4.0).abs() < 0.01);
    }

    #[test]
    fn zero_duration_returns_none() {
        let params = CrossfadeParams {
            in_duration_sec: 300.0,
            out_gain_db: 0.0,
            in_gain_db: 0.0,
            out_duration_sec: 300.0,
            out_parent_key: "a".into(),
            in_parent_key: "b".into(),
            out_end_ramp: None,
            in_start_ramp: None,
            crossfade_window_ms: 0,
            smart_crossfade_max_ms: 0,
            mixramp_db: -17.0,
            smart_crossfade_enabled: false,
            same_album_crossfade: false,
        };
        assert!(compute_timed_transition(&params).is_none());
    }

    #[test]
    fn a_short_incoming_track_is_not_consumed_entirely_by_the_fade() {
        let params = CrossfadeParams {
            out_duration_sec: 300.0,
            in_duration_sec: 2.0,
            out_gain_db: 0.0,
            in_gain_db: 0.0,
            out_parent_key: "a".into(),
            in_parent_key: "b".into(),
            out_end_ramp: None,
            in_start_ramp: None,
            crossfade_window_ms: 4000,
            smart_crossfade_max_ms: 15000,
            mixramp_db: -17.0,
            smart_crossfade_enabled: true,
            same_album_crossfade: false,
        };
        let plan = compute_timed_transition(&params).unwrap();
        assert_eq!(plan.duration_sec, 1.0);
        assert_eq!(plan.start_time_sec, 299.0);
    }
}
