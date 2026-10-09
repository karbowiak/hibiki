//! Commands sent between threads.
//!
//! Two command types:
//! - `Command`: Tauri bridge → control task (high-level, may trigger I/O)
//! - `AudioCommand`: control task → audio callback (lock-free, no I/O)

use super::crossfade::types::{CrossfadeSettings, TrackRamps};
use super::types::{DeckId, TrackMeta};

pub struct ControlCommand {
    pub epoch: u64,
    pub preload_revision: u64,
    pub command: Command,
}

/// Commands from Tauri bridge → control task.
pub enum Command {
    // -- Playback --
    Play { url: String, meta: TrackMeta },
    ClearPreload,
    PreloadNext { url: String, meta: TrackMeta },
    Pause,
    Resume,
    Stop,
    Seek { position_ms: u64 },

    // -- Volume & gain --
    SetVolume { gain: f32 },
    SetNormalization { enabled: bool },

    // -- DSP --
    SetPreampGain { db: f32 },
    SetEq { gains_db: [f32; 10] },
    SetEqEnabled { enabled: bool },
    SetEqPostgain { db: f32 },

    // -- Crossfade --
    SetCrossfadeWindow { ms: u32 },
    SetSameAlbumCrossfade { enabled: bool },
    SetSmartCrossfade { enabled: bool },
    SetSmartCrossfadeMax { ms: u32 },
    SetMixrampDb { db: f32 },

    // -- Visualizer --
    SetVisualizerEnabled { enabled: bool },

    // -- Cache --
    SetCacheMaxBytes { bytes: u64 },
    ClearCache,

    // -- Lifecycle --
    DuckAndApply { duck_ms: u32 },
    Shutdown,
}

/// Commands from control task → audio callback (processed via lock-free try_recv).
///
/// These must be cheap to handle — no I/O, no blocking, no allocation in hot paths.
pub enum AudioCommand {
    FailPlay {
        request_id: u64,
        message: String,
    },
    ClearPreload,
    BeginPlay {
        request_id: u64,
    },
    PreparePreload {
        request_id: u64,
        deck: DeckId,
    },
    // -- Deck loading --
    /// Prepare a deck for a new track (resets buffer, sets metadata).
    LoadDeck {
        deck: DeckId,
        meta: TrackMeta,
        sample_rate: u32,
        channels: u16,
        norm_gain: f32,
        expected_samples: usize,
        request_id: u64,
        preload_revision: Option<u64>,
        load_id: u64,
        generation: u64,
        initial_samples: Vec<f32>,
        fully_decoded: bool,
    },
    // -- Playback --
    Pause,
    Resume,
    Stop,
    /// Swap pending → active. Audio callback computes crossfade plan internally.
    TransitionToActive {
        user_skip: bool,
        request_id: u64,
    },

    // -- Seek --
    /// Seek within the already-decoded buffer (instant).
    SeekInBuffer {
        position: usize,
    },
    // -- DSP --
    SetVolume(f32),
    SetPreampGain(f32),
    SetEq([f32; 10]),
    SetEqEnabled(bool),
    SetEqPostgain(f32),
    ResetDsp,
    SetNormalization(bool),

    // -- Crossfade settings (for scheduler) --
    UpdateCrossfadeSettings(CrossfadeSettings),
    CacheRamps {
        rating_key: i64,
        ramps: TrackRamps,
    },

    // -- Visualizer --
    SetVisualizerEnabled(bool),

    // -- Duck and apply (brief volume mute for filter changes) --
    DuckAndApply {
        duck_ms: u32,
    },
}

/// A batch of decoded samples sent from a bg decode thread to the audio callback.
pub struct SampleBatch {
    pub rating_key: i64,
    pub generation: u64,
    pub samples: Vec<f32>,
    pub fully_decoded: bool,
}
