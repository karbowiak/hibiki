//! Events emitted from the engine back to the JS frontend via Tauri events.

use super::crossfade::types::TransitionInfo;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TrackEndReason {
    Natural,
    Skipped,
    Stopped,
    Error,
}

/// Events the engine emits to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum EngineEvent {
    TransitionScheduled {
        request_id: u64,
        transition: Option<TransitionInfo>,
    },
    Position {
        request_id: u64,
        playback_id: u64,
        position_ms: u64,
        duration_ms: u64,
    },
    State {
        request_id: u64,
        state: String,
    },
    TrackStarted {
        request_id: u64,
        playback_id: u64,
        rating_key: i64,
        duration_ms: u64,
        source_format: Option<super::types::SourceAudioFormat>,
    },
    TrackEnded {
        request_id: u64,
        playback_id: u64,
        rating_key: i64,
        position_ms: u64,
        duration_ms: u64,
        listened_ms: u64,
        reason: TrackEndReason,
    },
    Error {
        request_id: u64,
        message: String,
    },
}
