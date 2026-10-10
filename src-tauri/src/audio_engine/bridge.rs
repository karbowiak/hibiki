//! Tauri command bridge — connects JS invoke() calls to the Rust audio engine.

use std::sync::Arc;
use tauri::State;

use super::command::Command;
use super::types::TrackMeta;
use super::AudioEngine;

/// Tauri managed state wrapper.
pub struct AudioEngineState(pub Arc<AudioEngine>);

// ---------------------------------------------------------------------------
// Playback commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn audio_play(
    url: String,
    rating_key: i64,
    duration_ms: u64,
    parent_key: String,
    gain_db: Option<f32>,
    skip_crossfade: Option<bool>,
    start_ramp: Option<String>,
    end_ramp: Option<String>,
    album_playback: Option<bool>,
    state: State<'_, AudioEngineState>,
) -> Result<u64, String> {
    state.0.send(Command::Play {
        url,
        meta: TrackMeta {
            rating_key,
            duration_ms,
            parent_key,
            album_playback: album_playback.unwrap_or(false),
            gain_db,
            skip_crossfade: skip_crossfade.unwrap_or(false),
            start_ramp,
            end_ramp,
        },
    })
}

#[tauri::command]
pub async fn audio_preload_next(
    url: String,
    rating_key: i64,
    duration_ms: u64,
    parent_key: String,
    gain_db: Option<f32>,
    skip_crossfade: Option<bool>,
    start_ramp: Option<String>,
    end_ramp: Option<String>,
    album_playback: Option<bool>,
    state: State<'_, AudioEngineState>,
) -> Result<(), String> {
    state
        .0
        .send(Command::PreloadNext {
            url,
            meta: TrackMeta {
                rating_key,
                duration_ms,
                parent_key,
                album_playback: album_playback.unwrap_or(false),
                gain_db,
                skip_crossfade: skip_crossfade.unwrap_or(false),
                start_ramp,
                end_ramp,
            },
        })
        .map(|_| ())
}

#[tauri::command]
pub async fn audio_clear_preload(state: State<'_, AudioEngineState>) -> Result<(), String> {
    state.0.send(Command::ClearPreload).map(|_| ())
}

#[tauri::command]
pub async fn audio_pause(state: State<'_, AudioEngineState>) -> Result<(), String> {
    state.0.send(Command::Pause).map(|_| ())
}

#[tauri::command]
pub async fn audio_resume(state: State<'_, AudioEngineState>) -> Result<(), String> {
    state.0.send(Command::Resume).map(|_| ())
}

#[tauri::command]
pub async fn audio_stop(state: State<'_, AudioEngineState>) -> Result<(), String> {
    state.0.send(Command::Stop).map(|_| ())
}

#[tauri::command]
pub async fn audio_seek(
    position_ms: f64,
    state: State<'_, AudioEngineState>,
) -> Result<(), String> {
    state
        .0
        .send(Command::Seek {
            position_ms: position_ms as u64,
        })
        .map(|_| ())
}

// ---------------------------------------------------------------------------
// Volume & gain
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn audio_set_volume(gain: f32, state: State<'_, AudioEngineState>) -> Result<(), String> {
    state.0.send(Command::SetVolume { gain }).map(|_| ())
}

#[tauri::command]
pub async fn audio_set_normalization(
    enabled: bool,
    state: State<'_, AudioEngineState>,
) -> Result<(), String> {
    state
        .0
        .send(Command::SetNormalization { enabled })
        .map(|_| ())
}

// ---------------------------------------------------------------------------
// DSP
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn audio_set_preamp_gain(
    db: f32,
    state: State<'_, AudioEngineState>,
) -> Result<(), String> {
    state.0.send(Command::SetPreampGain { db }).map(|_| ())
}

#[tauri::command]
pub async fn audio_set_eq(
    gains_db: [f32; 10],
    state: State<'_, AudioEngineState>,
) -> Result<(), String> {
    state.0.send(Command::SetEq { gains_db }).map(|_| ())
}

#[tauri::command]
pub async fn audio_set_eq_enabled(
    enabled: bool,
    state: State<'_, AudioEngineState>,
) -> Result<(), String> {
    state.0.send(Command::SetEqEnabled { enabled }).map(|_| ())
}

#[tauri::command]
pub async fn audio_set_eq_postgain(
    db: f32,
    state: State<'_, AudioEngineState>,
) -> Result<(), String> {
    state.0.send(Command::SetEqPostgain { db }).map(|_| ())
}

#[tauri::command]
pub async fn audio_duck_and_apply(
    duck_ms: Option<u32>,
    state: State<'_, AudioEngineState>,
) -> Result<(), String> {
    state
        .0
        .send(Command::DuckAndApply {
            duck_ms: duck_ms.unwrap_or(30),
        })
        .map(|_| ())
}

// ---------------------------------------------------------------------------
// Crossfade settings
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn audio_set_crossfade_window(
    ms: u32,
    state: State<'_, AudioEngineState>,
) -> Result<(), String> {
    state.0.send(Command::SetCrossfadeWindow { ms }).map(|_| ())
}

#[tauri::command]
pub async fn audio_set_same_album_crossfade(
    enabled: bool,
    state: State<'_, AudioEngineState>,
) -> Result<(), String> {
    state
        .0
        .send(Command::SetSameAlbumCrossfade { enabled })
        .map(|_| ())
}

#[tauri::command]
pub async fn audio_set_smart_crossfade(
    enabled: bool,
    state: State<'_, AudioEngineState>,
) -> Result<(), String> {
    state
        .0
        .send(Command::SetSmartCrossfade { enabled })
        .map(|_| ())
}

#[tauri::command]
pub async fn audio_set_smart_crossfade_max(
    ms: u32,
    state: State<'_, AudioEngineState>,
) -> Result<(), String> {
    state
        .0
        .send(Command::SetSmartCrossfadeMax { ms })
        .map(|_| ())
}

#[tauri::command]
pub async fn audio_set_mixramp_db(
    db: f32,
    state: State<'_, AudioEngineState>,
) -> Result<(), String> {
    state.0.send(Command::SetMixrampDb { db }).map(|_| ())
}

// ---------------------------------------------------------------------------
// Visualizer
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn audio_set_visualizer_enabled(
    enabled: bool,
    state: State<'_, AudioEngineState>,
) -> Result<(), String> {
    state
        .0
        .send(Command::SetVisualizerEnabled { enabled })
        .map(|_| ())
}

#[tauri::command]
pub async fn audio_get_sample_rate(state: State<'_, AudioEngineState>) -> Result<u32, String> {
    state.0.sample_rate()
}

#[tauri::command]
pub async fn audio_get_output_available(
    state: State<'_, AudioEngineState>,
) -> Result<bool, String> {
    Ok(state.0.output_available())
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn audio_set_cache_max_bytes(
    bytes: u64,
    state: State<'_, AudioEngineState>,
) -> Result<(), String> {
    state
        .0
        .send(Command::SetCacheMaxBytes { bytes })
        .map(|_| ())
}

#[tauri::command]
pub async fn audio_clear_cache(state: State<'_, AudioEngineState>) -> Result<(), String> {
    state.0.send(Command::ClearCache).map(|_| ())
}

#[tauri::command]
pub async fn audio_get_cache_stats(
    state: State<'_, AudioEngineState>,
) -> Result<super::cache::CacheStats, String> {
    Ok(state.0.cache().stats())
}
