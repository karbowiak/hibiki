//! Transition point scheduler — detects when the active deck position
//! reaches the trigger point for crossfade or gapless transition.

/// The type of transition to schedule.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SchedulerMode {
    Gapless,
    Crossfade,
}

/// Callback actions the scheduler can trigger.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SchedulerAction {
    TransitionPoint,
    GaplessPoint,
}

/// Event-driven transition scheduler.
///
/// Called periodically with the current deck position. Fires once when the
/// position crosses the configured trigger point.
pub struct Scheduler {
    mode: SchedulerMode,
    transition_time_sec: f32,
    fired: bool,
}

impl Scheduler {
    pub fn new() -> Self {
        Self {
            mode: SchedulerMode::Gapless,
            transition_time_sec: -1.0,
            fired: false,
        }
    }

    pub fn set_mode(&mut self, mode: SchedulerMode) {
        self.mode = mode;
    }

    /// Set the absolute trigger time (seconds into the outgoing track).
    pub fn set_transition_point(&mut self, time_sec: f32) {
        self.transition_time_sec = time_sec;
        self.fired = false;
    }

    pub fn reset(&mut self) {
        self.transition_time_sec = -1.0;
        self.fired = false;
    }

    /// Distance to the crossfade boundary, in output frames. A callback may
    /// straddle this point, so its mixer must split the buffer here.
    pub fn frames_until_crossfade(&self, position_frames: u64, sample_rate: u32) -> Option<usize> {
        if self.mode != SchedulerMode::Crossfade || self.fired || self.transition_time_sec < 0.0 {
            return None;
        }
        let target = (self.transition_time_sec as f64 * sample_rate as f64).round() as u64;
        Some(
            target
                .saturating_sub(position_frames)
                .min(usize::MAX as u64) as usize,
        )
    }

    pub fn check_crossfade_frame(
        &mut self,
        position_frames: u64,
        sample_rate: u32,
    ) -> Option<SchedulerAction> {
        if self.frames_until_crossfade(position_frames, sample_rate) == Some(0) {
            self.fired = true;
            Some(SchedulerAction::TransitionPoint)
        } else {
            None
        }
    }

    #[cfg(test)]
    pub fn has_fired(&self) -> bool {
        self.fired
    }

}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crossfade_fires_at_transition_point() {
        let mut s = Scheduler::new();
        s.set_mode(SchedulerMode::Crossfade);
        s.set_transition_point(290.0);

        assert!(s.check_crossfade_frame(100 * 48000, 48000).is_none());
        assert!(s.check_crossfade_frame(290 * 48000 - 1, 48000).is_none());
        assert_eq!(
            s.check_crossfade_frame(290 * 48000, 48000),
            Some(SchedulerAction::TransitionPoint)
        );
        // Should not fire again
        assert!(s.check_crossfade_frame(295 * 48000, 48000).is_none());
        assert!(s.has_fired());
    }

    #[test]
    fn gapless_never_cuts_the_tail() {
        let mut s = Scheduler::new();
        s.set_mode(SchedulerMode::Gapless);
        s.set_transition_point(300.0); // duration

        // Gapless advancement belongs to actual decoder EOF in the callback;
        // the crossfade scheduler cannot cut a tail at a guessed duration.
        for frame in [298 * 48000, 300 * 48000 - 1, 300 * 48000, 301 * 48000] {
            assert!(s.check_crossfade_frame(frame, 48000).is_none());
        }
    }

    #[test]
    fn reset_allows_refire() {
        let mut s = Scheduler::new();
        s.set_mode(SchedulerMode::Crossfade);
        s.set_transition_point(10.0);
        assert!(s.check_crossfade_frame(10 * 48000, 48000).is_some());
        assert!(s.check_crossfade_frame(15 * 48000, 48000).is_none()); // already fired
        s.reset();
        s.set_transition_point(18.0);
        assert!(s.check_crossfade_frame(18 * 48000, 48000).is_some());
    }
}
