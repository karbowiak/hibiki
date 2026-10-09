//! MixRamp crossfade strategy — overlap tracks at loudness threshold crossing points.
//!
//! Plex provides per-track prolog/epilog ramps: sequences of (dB, timeSec) pairs
//! describing the loudness envelope at the track's start and end. MixRamp finds
//! where each ramp crosses a configurable threshold (default -17 dB) and overlaps
//! the tracks at those points with no gain curves (both tracks at full volume).

use super::types::{CrossfadeParams, RampPoint, TransitionPlan};

/// Linear interpolation: find the time (seconds) where the ramp crosses `threshold_db`.
/// Returns `None` if the threshold is never reached.
pub fn mixramp_interpolate(ramp: &[RampPoint], threshold_db: f32) -> Option<f32> {
    if ramp.is_empty()
        || !threshold_db.is_finite()
        || ramp.iter().any(|point| {
            !point.db.is_finite() || !point.time_sec.is_finite() || point.time_sec < 0.0
        })
        || ramp
            .windows(2)
            .any(|points| points[1].db < points[0].db || points[1].time_sec < points[0].time_sec)
    {
        return None;
    }

    // Threshold at or below the first point — return the first time
    if threshold_db <= ramp[0].db {
        return Some(ramp[0].time_sec);
    }
    // Above the last point — never crossed. An exact match is valid.
    if threshold_db > ramp[ramp.len() - 1].db {
        return None;
    }

    for i in 0..ramp.len() - 1 {
        let a = &ramp[i];
        let b = &ramp[i + 1];
        if a.db <= threshold_db && threshold_db <= b.db {
            let range = b.db - a.db;
            if range.abs() < 1e-9 {
                return Some(a.time_sec);
            }
            let ratio = (threshold_db - a.db) / range;
            return Some(a.time_sec + ratio * (b.time_sec - a.time_sec));
        }
    }

    None
}

/// Compute a MixRamp transition plan.
/// Falls back to timed crossfade if ramps are unavailable or interpolation fails.
pub fn compute_mixramp_transition(params: &CrossfadeParams) -> Option<TransitionPlan> {
    let limit = super::types::overlap_limit(params)?;
    let out_end_ramp = params.out_end_ramp.as_deref();
    let in_start_ramp = params.in_start_ramp.as_deref();

    // Need both ramps
    let out_ramp = match out_end_ramp {
        Some(r) if !r.is_empty() => r,
        _ => return compute_timed_fallback(params),
    };
    let in_ramp = match in_start_ramp {
        Some(r) if !r.is_empty() => r,
        _ => return compute_timed_fallback(params),
    };

    let end_overlap = match mixramp_interpolate(out_ramp, params.mixramp_db - params.out_gain_db) {
        Some(t) => t,
        None => return compute_timed_fallback(params),
    };
    let start_overlap = match mixramp_interpolate(in_ramp, params.mixramp_db - params.in_gain_db) {
        Some(t) => t,
        None => return compute_timed_fallback(params),
    };

    let overlap_duration = (end_overlap + start_overlap).min(limit);
    if overlap_duration <= 0.0 {
        return None;
    }

    Some(TransitionPlan {
        // Start the intro early enough that both loudness crossings meet.
        // The outgoing deck then plays its complete tail until the overlap ends.
        start_time_sec: params.out_duration_sec - overlap_duration,
        duration_sec: overlap_duration,
        fade_out_curve: None, // MixRamp: both at full volume
        fade_in_curve: None,
    })
}

/// Fixed-duration equal-power crossfade fallback.
fn compute_timed_fallback(params: &CrossfadeParams) -> Option<TransitionPlan> {
    super::time_based::compute_timed_transition(params)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_ramp(pairs: &[(f32, f32)]) -> Vec<RampPoint> {
        pairs
            .iter()
            .map(|&(db, t)| RampPoint { db, time_sec: t })
            .collect()
    }

    #[test]
    fn interpolate_basic() {
        let ramp = make_ramp(&[(-30.0, 0.0), (-20.0, 0.5), (-10.0, 1.0), (0.0, 2.0)]);
        let t = mixramp_interpolate(&ramp, -17.0).unwrap();
        // Between (-20, 0.5) and (-10, 1.0): ratio = (-17 - -20) / (-10 - -20) = 0.3
        // time = 0.5 + 0.3 * (1.0 - 0.5) = 0.65
        assert!((t - 0.65).abs() < 0.01, "expected ~0.65, got {}", t);
    }

    #[test]
    fn interpolate_threshold_below_first() {
        let ramp = make_ramp(&[(-20.0, 0.5), (-10.0, 1.0)]);
        let t = mixramp_interpolate(&ramp, -25.0).unwrap();
        assert!((t - 0.5).abs() < 1e-5);
    }

    #[test]
    fn interpolate_threshold_above_last() {
        let ramp = make_ramp(&[(-30.0, 0.0), (-20.0, 1.0)]);
        assert!(mixramp_interpolate(&ramp, -10.0).is_none());
    }

    #[test]
    fn interpolate_empty_ramp() {
        assert!(mixramp_interpolate(&[], -17.0).is_none());
    }

    #[test]
    fn mixramp_transition_with_valid_ramps() {
        let params = CrossfadeParams {
            in_duration_sec: 300.0,
            out_gain_db: 0.0,
            in_gain_db: 0.0,
            out_duration_sec: 300.0,
            out_parent_key: "a".into(),
            in_parent_key: "b".into(),
            out_end_ramp: Some(make_ramp(&[(-30.0, 0.0), (-17.0, 1.5), (-5.0, 3.0)])),
            in_start_ramp: Some(make_ramp(&[(-30.0, 0.0), (-17.0, 0.8), (-5.0, 2.0)])),
            crossfade_window_ms: 4000,
            smart_crossfade_max_ms: 20000,
            mixramp_db: -17.0,
            smart_crossfade_enabled: true,
            same_album_crossfade: false,
        };
        let plan = compute_mixramp_transition(&params).unwrap();
        // MixRamp: no gain curves
        assert!(plan.fade_out_curve.is_none());
        assert!(plan.fade_in_curve.is_none());
        // Overlap = end_overlap(1.5) + start_overlap(0.8) = 2.3s
        assert!((plan.duration_sec - 2.3).abs() < 0.1);
        // Start = 300 - (1.5 + 0.8) = 297.7
        assert!((plan.start_time_sec - 297.7).abs() < 0.1);
    }

    #[test]
    fn mixramp_falls_back_without_ramps() {
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
            smart_crossfade_enabled: true,
            same_album_crossfade: false,
        };
        let plan = compute_mixramp_transition(&params).unwrap();
        // Should fall back to timed crossfade with gain curves
        assert!(plan.fade_out_curve.is_some());
        assert!(plan.fade_in_curve.is_some());
    }

    #[test]
    fn overlap_aligns_both_loudness_crossings_and_keeps_the_outgoing_tail() {
        let params = CrossfadeParams {
            in_duration_sec: 300.0,
            out_gain_db: 0.0,
            in_gain_db: 0.0,
            out_duration_sec: 300.0,
            out_parent_key: "a".into(),
            in_parent_key: "b".into(),
            out_end_ramp: Some(make_ramp(&[(-30.0, 0.0), (-17.0, 1.5), (-5.0, 3.0)])),
            in_start_ramp: Some(make_ramp(&[(-30.0, 0.0), (-17.0, 0.8), (-5.0, 2.0)])),
            crossfade_window_ms: 4000,
            smart_crossfade_max_ms: 15000,
            mixramp_db: -17.0,
            smart_crossfade_enabled: true,
            same_album_crossfade: false,
        };
        let plan = compute_mixramp_transition(&params).unwrap();
        assert!(
            (plan.start_time_sec + 0.8 - (300.0 - 1.5)).abs() < 0.001,
            "incoming and outgoing loudness thresholds should meet at the same time"
        );
        assert!(
            (plan.start_time_sec + plan.duration_sec - 300.0).abs() < 0.001,
            "overlap completion must coincide with the outgoing song's natural end"
        );
    }

    #[test]
    fn a_long_ramp_cannot_trigger_a_transition_minutes_before_the_track_ends() {
        let params = CrossfadeParams {
            in_duration_sec: 300.0,
            out_gain_db: 0.0,
            in_gain_db: 0.0,
            out_duration_sec: 180.0,
            out_parent_key: "a".into(),
            in_parent_key: "b".into(),
            out_end_ramp: Some(make_ramp(&[(-51.0, 0.0), (-17.0, 150.0), (0.0, 170.0)])),
            in_start_ramp: Some(make_ramp(&[(-51.0, 0.0), (-17.0, 20.0), (0.0, 25.0)])),
            crossfade_window_ms: 4000,
            smart_crossfade_max_ms: 15000,
            mixramp_db: -17.0,
            smart_crossfade_enabled: true,
            same_album_crossfade: false,
        };
        let plan = compute_mixramp_transition(&params).unwrap();
        assert!(plan.duration_sec <= 15.0);
        assert!(plan.start_time_sec >= 165.0);
    }

    #[test]
    fn crossing_points_account_for_the_gain_actually_applied_to_each_track() {
        let params = CrossfadeParams {
            out_duration_sec: 300.0,
            in_duration_sec: 300.0,
            out_gain_db: -3.0,
            in_gain_db: 0.0,
            out_parent_key: "a".into(),
            in_parent_key: "b".into(),
            out_end_ramp: Some(make_ramp(&[(-30.0, 0.0), (-17.0, 1.5), (-5.0, 3.0)])),
            in_start_ramp: Some(make_ramp(&[(-30.0, 0.0), (-17.0, 0.8), (-5.0, 2.0)])),
            crossfade_window_ms: 4000,
            smart_crossfade_max_ms: 15000,
            mixramp_db: -17.0,
            smart_crossfade_enabled: true,
            same_album_crossfade: false,
        };
        let plan = compute_mixramp_transition(&params).unwrap();
        assert!((plan.duration_sec - 2.675).abs() < 0.001);
        assert!((plan.start_time_sec + plan.duration_sec - 300.0).abs() < 0.001);
    }

    #[test]
    fn malformed_ramps_cannot_create_invalid_transition_points() {
        for ramp in [
            make_ramp(&[(-30.0, -1.0), (-5.0, 2.0)]),
            make_ramp(&[(-30.0, 1.0), (-5.0, 0.0)]),
            make_ramp(&[(-5.0, 0.0), (-30.0, 2.0)]),
            make_ramp(&[(f32::NAN, 0.0), (-5.0, f32::INFINITY)]),
        ] {
            assert!(mixramp_interpolate(&ramp, -17.0).is_none());
        }
        assert!(mixramp_interpolate(&make_ramp(&[(-30.0, 0.0), (-5.0, 2.0)]), f32::NAN).is_none());
    }

    #[test]
    fn valid_short_overlaps_stay_short_instead_of_becoming_long_timed_fades() {
        let params = CrossfadeParams {
            out_duration_sec: 140.0,
            in_duration_sec: 190.0,
            out_gain_db: 0.0,
            in_gain_db: 0.0,
            out_parent_key: "a".into(),
            in_parent_key: "b".into(),
            out_end_ramp: Some(make_ramp(&[(-5.61, 0.12), (0.96, 0.22), (6.4, 0.42)])),
            in_start_ramp: Some(make_ramp(&[(2.1, 0.0), (5.45, 0.1), (6.75, 0.2)])),
            crossfade_window_ms: 4000,
            smart_crossfade_max_ms: 15000,
            mixramp_db: -17.0,
            smart_crossfade_enabled: true,
            same_album_crossfade: false,
        };
        let plan = compute_mixramp_transition(&params).unwrap();
        assert!((plan.duration_sec - 0.12).abs() < 0.001);
        assert!(plan.fade_in_curve.is_none());
        assert!(plan.fade_out_curve.is_none());
    }
}
