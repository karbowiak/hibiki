//! Shared types for the audio engine.

use serde::{Deserialize, Serialize};

/// Engine playback state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EngineState {
    Stopped,
    Buffering,
    Playing,
    Paused,
}

impl EngineState {
    pub fn to_u8(self) -> u8 {
        match self {
            Self::Stopped => 0,
            Self::Buffering => 1,
            Self::Playing => 2,
            Self::Paused => 3,
        }
    }

    pub fn from_u8(v: u8) -> Self {
        match v {
            0 => Self::Stopped,
            1 => Self::Buffering,
            2 => Self::Playing,
            3 => Self::Paused,
            _ => Self::Stopped,
        }
    }
}

/// Identifies which physical deck (A or B).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeckId {
    A,
    B,
}

impl DeckId {
    pub fn other(self) -> Self {
        match self {
            Self::A => Self::B,
            Self::B => Self::A,
        }
    }
}

/// Metadata for a track loaded into a deck.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackMeta {
    pub rating_key: i64,
    pub duration_ms: u64,
    pub parent_key: String,
    /// True only when the UI deliberately started this track's album.
    #[serde(default)]
    pub album_playback: bool,
    pub gain_db: Option<f32>,
    pub skip_crossfade: bool,
    pub start_ramp: Option<String>,
    pub end_ramp: Option<String>,
}
