//! Deck manager — orchestrates dual decks with active/pending role swapping.
//!
//! Mirrors the TypeScript DeckManager: two reusable decks, one active (playing)
//! and one pending (preloaded with next track). Transitions swap roles.

use std::collections::VecDeque;

use super::super::crossfade::types::TrackRamps;
use super::super::output::playback_envelope::PlaybackEnvelope;
use super::super::types::{DeckId, TrackMeta};

/// Active crossfade curve state — the mixer steps through this per-frame.
#[derive(Debug, Clone)]
pub struct FadeCurve {
    /// Gain values at each step (e.g., 400 steps for a 4s crossfade).
    pub values: Vec<f32>,
    /// Current index into `values`.
    pub index: usize,
    /// Number of audio frames between each curve step.
    /// Computed as `(duration_sec * sample_rate) / values.len()`.
    pub frames_per_step: f32,
    /// Accumulated fractional frames since last step advance.
    pub frame_accum: f32,
}

impl FadeCurve {
    pub fn new(values: Vec<f32>, total_frames: usize) -> Self {
        let frames_per_step = if values.is_empty() {
            1.0
        } else {
            total_frames as f32 / values.len() as f32
        };
        Self {
            values,
            index: 0,
            frames_per_step,
            frame_accum: 0.0,
        }
    }

    /// Get the current fade gain, or `None` if the curve is finished/empty.
    pub fn current_gain(&self) -> Option<f32> {
        self.values.get(self.index).copied()
    }

    /// Advance the curve by one audio frame. Call once per mixer frame.
    pub fn advance_frame(&mut self) {
        if self.index >= self.values.len() {
            return;
        }
        self.frame_accum += 1.0;
        while self.frame_accum >= self.frames_per_step && self.index < self.values.len() {
            self.frame_accum -= self.frames_per_step;
            self.index += 1;
        }
    }

    /// Is the curve finished (all steps consumed)?
    pub fn is_finished(&self) -> bool {
        self.values.is_empty() || self.index >= self.values.len()
    }
}

/// State of a single deck.
#[derive(Debug)]
pub struct DeckState {
    pub playback_id: u64,
    pub played_frames: u64,
    pub start_reported: bool,
    pub end_reported: bool,
    pub history_start_reported: bool,
    pub history_end_reported: bool,
    /// Decoded interleaved PCM. A ring releases history without moving the tail.
    pub samples: VecDeque<f32>,
    /// Current read position in samples (interleaved index).
    pub position: usize,
    /// Track metadata (None if deck is empty).
    pub meta: Option<TrackMeta>,
    /// Parsed ramps belonging to this exact accepted source/load.
    pub ramps: TrackRamps,
    /// Sample rate of the decoded audio.
    pub sample_rate: u32,
    /// Number of channels in the decoded audio.
    pub channels: u16,
    /// Whether the deck has finished loading.
    pub loaded: bool,
    /// Whether playback has started on this deck.
    pub has_started_playing: bool,
    /// Current fade gain (for crossfade). 1.0 = full volume, 0.0 = silent.
    pub fade_gain: f32,
    /// Per-track normalization gain (from ReplayGain dB). 1.0 = no normalization.
    pub norm_gain: f32,
    pub norm_fade: Option<PlaybackEnvelope>,
    /// Active crossfade curve (if any). The mixer reads and advances this.
    pub fade_curve: Option<FadeCurve>,
    /// True once the entire track has been decoded into `samples`.
    pub fully_decoded: bool,
    pub decode_error: Option<String>,
    /// Sample offset — after a seek, the buffer is cleared and this is set to
    /// the sample index where the new buffer starts. `position_ms()` adds
    /// this offset to compute the real track position.
    pub sample_offset: usize,
    /// Seek generation counter — incremented on each seek. Background decode
    /// threads stamp their `SampleBatch` with the generation at the time of
    /// decode. The audio callback rejects batches with a stale generation.
    pub generation: u64,
    pub seek_tx: Option<crossbeam_channel::Sender<super::super::command::SeekRequest>>,
}

impl DeckState {
    pub fn new(_id: DeckId) -> Self {
        Self {
            playback_id: 0,
            played_frames: 0,
            start_reported: false,
            end_reported: false,
            history_start_reported: false,
            history_end_reported: false,
            samples: VecDeque::new(),
            position: 0,
            meta: None,
            ramps: TrackRamps::default(),
            sample_rate: 44100,
            channels: 2,
            loaded: false,
            has_started_playing: false,
            fade_gain: 1.0,
            norm_gain: 1.0,
            norm_fade: None,
            fade_curve: None,
            fully_decoded: false,
            decode_error: None,
            sample_offset: 0,
            generation: 0,
            seek_tx: None,
        }
    }

    pub fn set_normalization_gain(&mut self, target: f32) {
        if self.has_started_playing {
            let fade = self.norm_fade.get_or_insert_with(|| {
                let mut fade = PlaybackEnvelope::new();
                fade.set_gain(self.norm_gain);
                fade
            });
            fade.fade_to(target, self.sample_rate);
        } else {
            self.norm_fade = None;
        }
        self.norm_gain = target;
    }

    pub fn next_normalization_gain(&mut self) -> f32 {
        let Some(fade) = self.norm_fade.as_mut() else {
            return self.norm_gain;
        };
        let gain = fade.next_gain();
        if fade.remaining_frames() == 0 {
            self.norm_fade = None;
        }
        gain
    }

    /// Reset deck for reuse with a new track.
    pub fn reset(&mut self) {
        self.playback_id = 0;
        self.played_frames = 0;
        self.start_reported = false;
        self.end_reported = false;
        self.history_start_reported = false;
        self.history_end_reported = false;
        self.samples.clear();
        self.position = 0;
        self.sample_offset = 0;
        self.meta = None;
        self.ramps = TrackRamps::default();
        self.loaded = false;
        self.has_started_playing = false;
        self.fade_gain = 1.0;
        self.norm_gain = 1.0;
        self.norm_fade = None;
        self.fade_curve = None;
        self.fully_decoded = false;
        self.decode_error = None;
        self.seek_tx = None;
        // generation is NOT reset — it's managed externally by seek logic
    }

    /// Current playback position in seconds (accounts for sample_offset after seek).
    pub fn position_ms(&self) -> u64 {
        if self.channels == 0 || self.sample_rate == 0 {
            return 0;
        }
        (((self.sample_offset as u128 + self.position as u128) * 1000)
            / (self.sample_rate as u128 * self.channels as u128))
            .min(u64::MAX as u128) as u64
    }

    /// Total duration in seconds.
    ///
    /// Uses the metadata duration (from the play command) rather than the
    /// current buffer size, because during streaming/incremental decode the
    /// buffer is still growing. The metadata duration is the authoritative
    /// track length used for scheduler transition points and position events.
    pub fn duration_secs(&self) -> f32 {
        // Prefer metadata duration — it's known from the start
        if let Some(ref meta) = self.meta {
            if meta.duration_ms > 0 {
                return meta.duration_ms as f32 / 1000.0;
            }
        }
        if !self.fully_decoded {
            return 0.0;
        }
        // Fallback to the complete decoded duration, including any seek offset.
        if self.channels == 0 || self.sample_rate == 0 {
            return 0.0;
        }
        (self.sample_offset + self.samples.len()) as f32
            / (self.sample_rate as f32 * self.channels as f32)
    }

    pub fn trim_played_samples(&mut self) {
        // Keep a small history for instant backward seeks. Older positions are
        // still available through the retained decoder's seek mailbox.
        if self.seek_tx.is_none() {
            return;
        }
        let second = self.sample_rate as usize * self.channels as usize;
        if second == 0 || self.position < second * 3 {
            return;
        }
        let remove = ((self.position - second * 2) / second) * second;
        self.samples.drain(..remove);
        self.sample_offset += remove;
        self.position -= remove;
    }

    /// Whether the deck has reached the end of the track.
    /// Only true when playback position is past the end AND the full track
    /// has been decoded. During incremental/streaming decode, the mixer may
    /// temporarily be at the end of the buffer while more samples are coming.
    pub fn is_finished(&self) -> bool {
        self.loaded && self.fully_decoded && self.position >= self.samples.len()
    }

    /// Rating key of the loaded track, or 0 if empty.
    pub fn rating_key(&self) -> i64 {
        self.meta.as_ref().map_or(0, |m| m.rating_key)
    }

    /// Parent key of the loaded track, or empty string.
    pub fn parent_key(&self) -> &str {
        self.meta.as_ref().map_or("", |m| m.parent_key.as_str())
    }
}

/// Manages two decks with active/pending role swapping.
pub struct DeckManager {
    pub deck_a: DeckState,
    pub deck_b: DeckState,
    active: DeckId,
}

impl DeckManager {
    pub fn new() -> Self {
        Self {
            deck_a: DeckState::new(DeckId::A),
            deck_b: DeckState::new(DeckId::B),
            active: DeckId::A,
        }
    }

    pub fn active_deck(&self) -> &DeckState {
        match self.active {
            DeckId::A => &self.deck_a,
            DeckId::B => &self.deck_b,
        }
    }

    pub fn active_deck_mut(&mut self) -> &mut DeckState {
        match self.active {
            DeckId::A => &mut self.deck_a,
            DeckId::B => &mut self.deck_b,
        }
    }

    pub fn pending_deck(&self) -> &DeckState {
        match self.active {
            DeckId::A => &self.deck_b,
            DeckId::B => &self.deck_a,
        }
    }

    pub fn pending_deck_mut(&mut self) -> &mut DeckState {
        match self.active {
            DeckId::A => &mut self.deck_b,
            DeckId::B => &mut self.deck_a,
        }
    }

    pub fn active_id(&self) -> DeckId {
        self.active
    }

    /// Get a mutable reference to a specific deck by ID.
    pub fn deck_mut(&mut self, id: DeckId) -> &mut DeckState {
        match id {
            DeckId::A => &mut self.deck_a,
            DeckId::B => &mut self.deck_b,
        }
    }

    pub fn deck(&self, id: DeckId) -> &DeckState {
        match id {
            DeckId::A => &self.deck_a,
            DeckId::B => &self.deck_b,
        }
    }

    /// Swap active and pending roles.
    pub fn swap_roles(&mut self) {
        self.active = self.active.other();
    }

    /// Stop both decks.
    pub fn stop_all(&mut self) {
        self.deck_a.reset();
        self.deck_b.reset();
    }

    /// Get mutable references to both decks (active first, pending second).
    /// Safe because they're always different physical decks.
    pub fn both_decks_mut(&mut self) -> (&mut DeckState, &mut DeckState) {
        match self.active {
            DeckId::A => (&mut self.deck_a, &mut self.deck_b),
            DeckId::B => (&mut self.deck_b, &mut self.deck_a),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deck_position_and_duration() {
        let mut deck = DeckState::new(DeckId::A);
        deck.sample_rate = 44100;
        deck.channels = 2;
        deck.samples = vec![0.0; 44100 * 2].into(); // 1 second stereo
        deck.fully_decoded = true;
        deck.loaded = true;

        assert!((deck.duration_secs() - 1.0).abs() < 0.01);
        assert_eq!(deck.position_ms(), 0);

        deck.position = 44100; // 0.5s into stereo buffer
        assert_eq!(deck.position_ms(), 500);
    }

    #[test]
    fn swap_roles() {
        let mut dm = DeckManager::new();
        assert_eq!(dm.active_id(), DeckId::A);
        dm.swap_roles();
        assert_eq!(dm.active_id(), DeckId::B);
        dm.swap_roles();
        assert_eq!(dm.active_id(), DeckId::A);
    }

    #[test]
    fn reset_clears_deck() {
        let mut deck = DeckState::new(DeckId::A);
        deck.samples = vec![1.0; 1000].into();
        deck.position = 500;
        deck.loaded = true;
        deck.reset();
        assert!(deck.samples.is_empty());
        assert_eq!(deck.position, 0);
        assert!(!deck.loaded);
    }
    #[test]
    fn streaming_history_wraps_without_moving_the_unplayed_pcm_or_growing() {
        let mut deck = DeckState::new(DeckId::A);
        deck.sample_rate = 10;
        deck.channels = 2;
        let (seek_tx, _seeks) = crossbeam_channel::bounded(1);
        deck.seek_tx = Some(seek_tx);
        let mut initial = Vec::with_capacity(600);
        initial.extend((0..440).map(|n| n as f32));
        let address = initial.as_ptr();
        deck.samples = initial.into();
        assert_eq!(deck.samples.as_slices().0.as_ptr(),address,"install adopts worker-allocated PCM");
        deck.position = 60;
        deck.trim_played_samples();
        assert_eq!(deck.samples.as_slices().0.as_ptr(),address.wrapping_add(20),"trimming advances the ring without copying its tail");
        let mut wrapped = false;
        for next in (440..2440).step_by(10) {
            deck.samples.extend((next..next+10).map(|n| n as f32));
            deck.position += 10;
            deck.trim_played_samples();
            assert_eq!(deck.samples.capacity(),600);
            assert_eq!(deck.samples[0],deck.sample_offset as f32);
            assert_eq!(deck.samples[deck.samples.len()-1],(next+9) as f32);
            wrapped |= !deck.samples.as_slices().1.is_empty();
        }
        assert!(wrapped,"fixture exercises both sides of the ring");
    }

}
