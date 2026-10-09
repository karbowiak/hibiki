//! Events emitted from the engine back to the JS frontend via Tauri events.

use serde::Serialize;

/// Events the engine emits to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum EngineEvent {
    Position {
        request_id: u64,
        position_ms: u64,
        duration_ms: u64,
    },
    State {
        request_id: u64,
        state: String,
    },
    TrackStarted {
        request_id: u64,
        rating_key: i64,
        duration_ms: u64,
    },
    TrackEnded {
        request_id: u64,
        rating_key: i64,
    },
    Error {
        request_id: u64,
        message: String,
    },
    VisFrame {
        /// Time-domain samples (interleaved f32, but sent as Vec<f32> for serde).
        samples: Vec<f32>,
        /// FFT frequency bins in dB.
        frequency_bins: Vec<f32>,
    },
}
