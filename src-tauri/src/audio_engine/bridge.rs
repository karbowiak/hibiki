//! Tauri command bridge — connects JS invoke() calls to the Rust audio engine.

use std::sync::Arc;
use tauri::State;

use super::command::Command;
use super::types::TrackMeta;
use super::AudioEngine;

/// Tauri managed state wrapper.
pub struct AudioEngineState(pub Arc<AudioEngine>);

fn reporting_binding(app: &tauri::AppHandle) -> Result<crate::listening_history::Binding, String> {
    use tauri::Manager;
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|_| "Listening account settings unavailable")?;
    let settings = crate::plex::load_settings(&directory)
        .map_err(|_| "Listening account settings could not be loaded")?;
    Ok(crate::listening_history::Binding::capture(&settings, None))
}

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
    labels: Option<crate::listening_history::TrackLabels>,
    context: Option<crate::commands::PlexRequestContext>,
    plex_state: State<'_, crate::commands::PlexState>,
    state: State<'_, AudioEngineState>,
    db: State<'_, crate::db::DbState>,
    downloads: State<'_, crate::offline_audio::AudioDownloads>,
    app: tauri::AppHandle,
) -> Result<u64, String> {
    let binding = reporting_binding(&app)?;
    crate::offline_audio::dispatch(&plex_state, &db, &downloads, state.0.cache(), context.as_ref(), &url, rating_key, |source| {
            state.0.send(Command::Play {
                source,
                meta: TrackMeta {
                    rating_key,
                    duration_ms,
                    parent_key,
                    album_playback: album_playback.unwrap_or(false),
                    gain_db,
                    skip_crossfade: skip_crossfade.unwrap_or(false),
                    start_ramp,
                    end_ramp,
                    labels,
                    reporting_binding: Some(binding),
                },
            })
        }).await
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
    labels: Option<crate::listening_history::TrackLabels>,
    context: Option<crate::commands::PlexRequestContext>,
    plex_state: State<'_, crate::commands::PlexState>,
    state: State<'_, AudioEngineState>,
    db: State<'_, crate::db::DbState>,
    downloads: State<'_, crate::offline_audio::AudioDownloads>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let binding = reporting_binding(&app)?;
    crate::offline_audio::dispatch(&plex_state, &db, &downloads, state.0.cache(), context.as_ref(), &url, rating_key, |source| {
            state.0.send(Command::PreloadNext {
                source,
                meta: TrackMeta {
                    rating_key,
                    duration_ms,
                    parent_key,
                    album_playback: album_playback.unwrap_or(false),
                    gain_db,
                    skip_crossfade: skip_crossfade.unwrap_or(false),
                    start_ramp,
                    end_ramp,
                    labels,
                    reporting_binding: Some(binding),
                },
            })
        }).await
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
pub async fn audio_configure_eq(
    gains_db: [f32; 10],
    enabled: bool,
    postgain_db: Option<f32>,
    duck_ms: Option<u32>,
    state: State<'_, AudioEngineState>,
) -> Result<f32, String> {
    state
        .0
        .configure_eq(gains_db, enabled, postgain_db, duck_ms.unwrap_or(0))
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

async fn cache_work<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| "Audio cache worker failed".to_string())?
}

#[cfg(test)]
mod cache_tests {
    use super::cache_work;

    #[tokio::test]
    async fn cache_reply_waits_for_worker_completion_and_preserves_errors() {
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, receiver) = std::sync::mpsc::channel();
        let mut operation = tokio::spawn(cache_work(move || {
            started.send(()).unwrap();
            receiver.recv().unwrap();
            Ok(42)
        }));
        ready.await.unwrap();
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), &mut operation)
                .await
                .is_err()
        );
        release.send(()).unwrap();
        assert_eq!(operation.await.unwrap().unwrap(), 42);
        assert_eq!(
            cache_work::<()>(|| Err("storage unavailable".into()))
                .await
                .unwrap_err(),
            "storage unavailable"
        );
    }
}

#[tauri::command]
pub async fn audio_set_cache_max_bytes(
    bytes: u64,
    state: State<'_, AudioEngineState>,
) -> Result<super::cache::CacheStats, String> {
    let cache = state.0.cache().clone();
    cache_work(move || cache.set_max_bytes(bytes)).await
}

#[tauri::command]
pub async fn audio_clear_cache(
    state: State<'_, AudioEngineState>,
) -> Result<super::cache::CacheStats, String> {
    let cache = state.0.cache().clone();
    cache_work(move || cache.clear()).await
}

#[tauri::command]
pub async fn audio_get_cache_stats(
    state: State<'_, AudioEngineState>,
) -> Result<super::cache::CacheStats, String> {
    let cache = state.0.cache().clone();
    cache_work(move || Ok(cache.stats())).await
}
