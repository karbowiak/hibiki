#![allow(dead_code)]

use serde::Serialize;

/// Metadata sent with play/preload commands
#[derive(Debug, Clone)]
pub struct TrackMeta {
    pub url: String,
    pub rating_key: i64,
    pub duration_ms: i64,
    pub part_id: i64,
    pub parent_key: String,
    pub track_index: i64,
    /// Track gain from Plex loudness analysis in dB (e.g. -14.1).
    /// None if the server hasn't analysed this track yet.
    pub gain_db: Option<f32>,
}

/// Commands sent from the Tauri thread to the decoder thread
#[derive(Debug)]
pub enum AudioCommand {
    Play(TrackMeta),
    Pause,
    Resume,
    Stop,
    Seek(i64),            // position in milliseconds
    SetVolume(f32),       // 0.0 - 1.0
    PreloadNext(TrackMeta),
    SetCrossfadeWindow(u64), // milliseconds; 0 = disabled
    SetNormalizationEnabled(bool), // enable/disable ReplayGain normalization
    SetEq { gains_db: [f32; 10] }, // recompute all 10 biquad coefficients
    SetEqEnabled(bool),            // enable/disable EQ bypass
    SetPreampGain(f32),            // pre-amp in dB (−12..+3); applied before EQ
    SetSameAlbumCrossfade(bool),   // when false (default), suppress crossfade for same-album tracks
    SetVisualizerEnabled(bool),    // gate PCM IPC bridge for visualizer
    SetPreferredDevice(Option<String>), // preferred CPAL output device name (applied on next Play)
    Shutdown,
}

/// Events emitted from the audio engine back to the frontend
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum AudioEvent {
    Position {
        position_ms: i64,
        duration_ms: i64,
    },
    TrackStarted {
        rating_key: i64,
        duration_ms: i64,
    },
    TrackEnded {
        rating_key: i64,
    },
    State {
        state: PlaybackState,
    },
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PlaybackState {
    Playing,
    Paused,
    Buffering,
    Stopped,
}

/// Audio format info extracted from symphonia after probing
#[derive(Debug, Clone)]
pub struct AudioFormat {
    pub sample_rate: u32,
    pub channels: u32,
    pub codec: String,
}
