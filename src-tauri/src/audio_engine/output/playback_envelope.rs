//! Short playback fades, independent of deck transitions and master volume.

pub(crate) const FADE_MS: u64 = 150;

#[derive(Debug)]
pub struct PlaybackEnvelope {
    gain: f32,
    start: f32,
    target: f32,
    position: u32,
    frames: u32,
}

impl PlaybackEnvelope {
    pub fn new() -> Self {
        Self {
            gain: 1.0,
            start: 1.0,
            target: 1.0,
            position: 0,
            frames: 0,
        }
    }

    pub fn silence(&mut self) {
        self.gain = 0.0;
        self.start = 0.0;
        self.target = 0.0;
        self.position = 0;
        self.frames = 0;
    }

    pub fn fade_in(&mut self, sample_rate: u32) {
        self.fade_to(1.0, sample_rate);
    }

    pub fn fade_out(&mut self, sample_rate: u32) {
        self.fade_to(0.0, sample_rate);
    }

    pub(crate) fn fade_to(&mut self, target: f32, sample_rate: u32) {
        // Duplicate controls must not restart or cut short an existing fade.
        if self.target == target {
            return;
        }
        self.start = self.gain;
        self.target = target;
        self.position = 0;
        self.frames = ((u64::from(sample_rate) * FADE_MS / 1000) as u32).max(1);
    }

    pub fn remaining_frames(&self) -> u32 {
        self.frames.saturating_sub(self.position)
    }

    pub fn is_silent(&self) -> bool {
        self.gain == 0.0
    }

    pub fn is_fading_out(&self) -> bool {
        self.target == 0.0 && self.remaining_frames() > 0
    }

    pub(crate) fn set_gain(&mut self, gain: f32) {
        self.gain = gain;
        self.start = gain;
        self.target = gain;
        self.position = 0;
        self.frames = 0;
    }

    /// Read and advance one frame. Used for per-deck normalization as well as
    /// the final play/pause envelope; neither fade allocates on the callback.
    pub(crate) fn next_gain(&mut self) -> f32 {
        let gain = self.gain;
        if self.position < self.frames {
            self.position += 1;
            let t = self.position as f64 / self.frames as f64;
            let eased = t * t * (3.0 - 2.0 * t);
            self.gain =
                (self.start as f64 + (self.target as f64 - self.start as f64) * eased) as f32;
            if self.position == self.frames {
                self.gain = self.target;
            }
        }
        gain
    }

    /// Advance only through rendered PCM, once per interleaved audio frame.
    /// No allocations, locks, or timers on the device callback.
    pub fn apply(&mut self, samples: &mut [f32], channels: u16) {
        if self.remaining_frames() == 0 {
            if self.gain == 0.0 {
                samples.fill(0.0);
            } else if self.gain != 1.0 {
                for sample in samples {
                    *sample *= self.gain;
                }
            }
            return;
        }
        for frame in samples.chunks_exact_mut(usize::from(channels.max(1))) {
            let gain = self.next_gain();
            if gain == 0.0 {
                frame.fill(0.0);
            } else {
                for sample in frame {
                    *sample *= gain;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fade_duration_and_gain_are_independent_of_channels_and_callback_size() {
        for rate in [8000, 44100, 48000, 192000] {
            for channels in [1, 2, 8] {
                let frames = rate as usize * FADE_MS as usize / 1000;
                let mut envelope = PlaybackEnvelope::new();
                envelope.fade_out(rate);
                let mut output = vec![1.0; (frames + 20) * channels as usize];
                for batch in output.chunks_mut(17 * channels as usize) {
                    envelope.apply(batch, channels);
                }
                assert_eq!(output[0], 1.0);
                assert!(output
                    .chunks_exact(channels as usize)
                    .all(|f| f.iter().all(|v| *v == f[0])));
                assert!(output.windows(2).all(|w| w[1] <= w[0]));
                assert!(output[frames * channels as usize..]
                    .iter()
                    .all(|v| *v == 0.0));
                assert_eq!(envelope.remaining_frames(), 0);
                envelope.fade_in(rate);
                let mut output = vec![1.0; (frames + 1) * channels as usize];
                envelope.apply(&mut output, channels);
                assert_eq!(output[0], 0.0);
                assert!(output.windows(2).all(|w| w[1] >= w[0]));
                assert_eq!(*output.last().unwrap(), 1.0);
            }
        }
    }

    #[test]
    fn rapid_reversal_and_duplicate_controls_preserve_the_current_gain() {
        let mut envelope = PlaybackEnvelope::new();
        envelope.fade_out(48000);
        envelope.apply(&mut [1.0; 960], 2);
        let gain = envelope.gain;
        envelope.fade_out(48000);
        assert_eq!(
            envelope.remaining_frames(),
            48000 * FADE_MS as u32 / 1000 - 480
        );
        envelope.fade_in(48000);
        let mut output = [1.0; 960];
        envelope.apply(&mut output, 2);
        assert_eq!(output[0], gain);
        assert!(output.windows(2).all(|w| w[1] >= w[0]));
        let gain = envelope.gain;
        envelope.fade_out(48000);
        let mut output = [1.0; 960];
        envelope.apply(&mut output, 2);
        assert_eq!(output[0], gain);
        assert!(output.windows(2).all(|w| w[1] <= w[0]));
    }
}
