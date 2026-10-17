//! Crossfade types — shared across all crossfade strategies.

use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use super::curves::GainCurve;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TransitionReason {
    MissingRamps,
    NoUsableCrossing,
    SameAlbum,
    CrossfadeDisabled,
    DirectAudio,
    NoOverlap,
}

#[derive(Debug, Clone, Serialize)]
pub struct TransitionInfo {
    pub outgoing_rating_key: i64,
    pub incoming_rating_key: i64,
    pub mode: &'static str,
    pub reason: Option<TransitionReason>,
    pub start_time_ms: u64,
    pub duration_ms: u64,
}

/// A point on a loudness ramp (from Plex's prolog/epilog metadata).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RampPoint {
    pub db: f32,
    pub time_sec: f32,
}

/// Parsed start and end ramps for a track.
#[derive(Debug, Clone, Default)]
pub struct TrackRamps {
    pub start_ramp: Vec<RampPoint>,
    pub end_ramp: Vec<RampPoint>,
}

/// A computed transition plan between two tracks.
#[derive(Debug, Clone, Copy)]
pub struct TransitionPlan {
    pub fallback_reason: Option<TransitionReason>,
    /// Absolute time in the outgoing track (seconds) to start the transition.
    pub start_time_sec: f32,
    /// Duration of the overlap (seconds).
    pub duration_sec: f32,
    /// Fade-out gain curve for outgoing deck. `None` = MixRamp (no gain manipulation).
    pub fade_out_curve: Option<GainCurve>,
    /// Fade-in gain curve for incoming deck. `None` = MixRamp (no gain manipulation).
    pub fade_in_curve: Option<GainCurve>,
}

/// Parameters needed to compute a crossfade transition.
#[derive(Debug, Clone)]
pub struct CrossfadeParams<'a> {
    pub out_duration_sec: f32,
    pub in_duration_sec: f32,
    pub out_gain_db: f32,
    pub in_gain_db: f32,
    pub out_parent_key: Cow<'a, str>,
    pub in_parent_key: Cow<'a, str>,
    pub album_playback: bool,
    pub out_end_ramp: Option<Cow<'a, [RampPoint]>>,
    pub in_start_ramp: Option<Cow<'a, [RampPoint]>>,
    pub crossfade_window_ms: u32,
    pub smart_crossfade_max_ms: u32,
    pub mixramp_db: f32,
    pub smart_crossfade_enabled: bool,
    pub same_album_crossfade: bool,
}

/// Parse a Plex ramp string into RampPoint pairs.
///
/// Format: `"db time;db time;..."` e.g. `"-20.5 0.1;-15.2 0.5;-3.1 1.2"`
pub fn parse_ramp(raw: Option<&str>) -> Vec<RampPoint> {
    let raw = match raw {
        Some(s) if !s.is_empty() => s,
        _ => return Vec::new(),
    };
    raw.split(';')
        .filter(|s| !s.is_empty())
        .filter_map(|pair| {
            let mut parts = pair.trim().split_whitespace();
            let db: f32 = parts.next()?.parse().ok()?;
            let time: f32 = parts.next()?.parse().ok()?;
            if !db.is_finite() || !time.is_finite() || time < 0.0 || parts.next().is_some() {
                return None;
            }
            Some(RampPoint { db, time_sec: time })
        })
        .collect()
}

/// Crossfade settings passed from JS (via Tauri commands).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrossfadeSettings {
    pub crossfade_window_ms: u32,
    pub same_album_crossfade: bool,
    pub smart_crossfade: bool,
    pub smart_crossfade_max_ms: u32,
    pub mixramp_db: f32,
}

impl Default for CrossfadeSettings {
    fn default() -> Self {
        Self {
            crossfade_window_ms: 4000,
            same_album_crossfade: false,
            smart_crossfade: true,
            smart_crossfade_max_ms: 15000,
            mixramp_db: -16.0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ramp_basic() {
        let ramp = parse_ramp(Some("-20.5 0.1;-15.2 0.5;-3.1 1.2"));
        assert_eq!(ramp.len(), 3);
        assert!((ramp[0].db - -20.5).abs() < 1e-5);
        assert!((ramp[0].time_sec - 0.1).abs() < 1e-5);
        assert!((ramp[2].db - -3.1).abs() < 1e-5);
        assert!((ramp[2].time_sec - 1.2).abs() < 1e-5);
    }

    #[test]
    fn parse_ramp_empty() {
        assert!(parse_ramp(None).is_empty());
        assert!(parse_ramp(Some("")).is_empty());
    }

    #[test]
    fn parse_ramp_trailing_semicolon() {
        let ramp = parse_ramp(Some("-10 0.5;-5 1.0;"));
        assert_eq!(ramp.len(), 2);
    }

    #[test]
    fn parse_ramp_malformed_pair_skipped() {
        let ramp = parse_ramp(Some("-10 0.5;garbage;-5 1.0"));
        assert_eq!(ramp.len(), 2);
    }

    #[test]
    fn parse_ramp_discards_nonfinite_negative_and_extra_values() {
        assert_eq!(
            parse_ramp(Some("NaN 1;-10 inf;-20 -1;-5 1 junk;-8 0.5")),
            vec![RampPoint {
                db: -8.0,
                time_sec: 0.5
            }]
        );
    }
}

/// Overlaps must fit both tracks and remain bounded even for malformed settings.
pub fn overlap_limit(params: &CrossfadeParams) -> Option<f32> {
    if !params.out_duration_sec.is_finite()
        || params.out_duration_sec <= 0.0
        || !params.in_duration_sec.is_finite()
        || params.in_duration_sec <= 0.0
    {
        return None;
    }
    let configured = if params.smart_crossfade_enabled {
        params.smart_crossfade_max_ms
    } else {
        params.crossfade_window_ms
    };
    let limit = (configured as f32 / 1000.0)
        .min(60.0)
        // Keep short tracks from being consumed entirely by their overlaps,
        // and leave the incoming deck time to prepare its following track.
        .min(params.out_duration_sec * 0.5)
        .min(params.in_duration_sec * 0.5);
    (limit > 0.0).then_some(limit)
}
