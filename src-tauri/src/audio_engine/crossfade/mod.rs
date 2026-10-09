//! Crossfade — all transition strategies and scheduling.

pub mod album_aware;
pub mod curves;
pub mod mixramp;
pub mod scheduler;
pub mod time_based;
pub mod types;

use self::album_aware::should_suppress_crossfade;
use self::curves::{generate_fade_in, generate_fade_out, steps_for_duration};
use self::mixramp::compute_mixramp_transition;
use self::time_based::compute_timed_transition;
use self::types::{CrossfadeParams, TransitionPlan};

/// Compute the best transition plan for the given parameters and settings.
///
/// Strategy selection:
/// 1. If crossfade is suppressed (same album), returns `None`.
/// 2. If smart crossfade is enabled, tries MixRamp first, falls back to timed.
/// 3. Otherwise, uses timed crossfade.
pub fn compute_transition(params: &CrossfadeParams) -> Option<TransitionPlan> {
    if should_suppress_crossfade(
        &params.out_parent_key,
        &params.in_parent_key,
        params.same_album_crossfade,
    ) {
        return None;
    }

    if params.smart_crossfade_enabled {
        compute_mixramp_transition(params)
    } else {
        compute_timed_transition(params)
    }
}

/// Compute a short equal-power duck for user-initiated skips (next/prev/click).
pub fn compute_skip_duck(duck_ms: u32) -> TransitionPlan {
    let duration_sec = duck_ms as f32 / 1000.0;
    let steps = steps_for_duration(duration_sec);
    TransitionPlan {
        fallback_reason: None,
        start_time_sec: 0.0, // immediate
        duration_sec,
        fade_out_curve: Some(generate_fade_out(steps, 1.0)),
        fade_in_curve: Some(generate_fade_in(steps, 1.0)),
    }
}
