//! Experimental YouTube Music website session. Credentials stay in native code.
mod api;
mod discovery;
mod discovery_cache;
mod lyrics;
mod playlists;
mod rate_limit;
mod extractor;
mod main_window_plugin;
mod playback;
mod session;
mod tools;

pub(crate) use main_window_plugin::app_only as app_only_plugin;
pub(crate) use playback::source as playback_source;
pub(crate) use playback::valid_track_id;

use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

pub(crate) const WINDOW: &str = "youtube-music-session";
pub(crate) const ORIGIN: &str = "https://music.youtube.com";
const HOUR: i64 = 3600;

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Disconnected,
    Connecting,
    Connected,
    Refreshing,
    ReauthRequired,
    Unavailable,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub enabled: bool,
    pub phase: Phase,
    pub last_checked_at: Option<i64>,
    pub next_refresh_at: Option<i64>,
    pub message: Option<String>,
    pub account_id: Option<String>,
}

struct Current {
    status: Status,
    generation: u64,
    interactive: bool,
}

pub struct YoutubeMusic {
    current: Mutex<Current>,
    refresh: tokio::sync::Mutex<()>,
    renewal: tokio::sync::Mutex<()>,
    extraction: tokio::sync::Mutex<()>,
    discovery_cache: discovery_cache::Cache,
    tools: tools::Installer,
}

impl Default for YoutubeMusic {
    fn default() -> Self {
        Self {
            current: Mutex::new(Current {
                status: Status {
                    enabled: false,
                    phase: Phase::Disconnected,
                    last_checked_at: None,
                    next_refresh_at: None,
                    message: None,
                    account_id: None,
                },
                generation: 0,
                interactive: false,
            }),
            refresh: tokio::sync::Mutex::new(()),
            renewal: tokio::sync::Mutex::new(()),
            extraction: tokio::sync::Mutex::new(()),
            discovery_cache: discovery_cache::Cache::default(),
            tools: tools::Installer::default(),
        }
    }
}

pub(crate) fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

impl YoutubeMusic {
    fn generation(&self) -> Result<u64, String> {
        let current = self
            .current
            .lock()
            .map_err(|_| "YouTube Music session unavailable")?;
        if !current.status.enabled {
            return Err("Connect YouTube Music first.".into());
        }
        Ok(current.generation)
    }

    fn owns(&self, generation: u64) -> bool {
        self.current
            .lock()
            .is_ok_and(|current| current.status.enabled && current.generation == generation)
    }

    fn update(&self, app: &tauri::AppHandle, generation: u64, change: impl FnOnce(&mut Current)) {
        let status = {
            let Ok(mut current) = self.current.lock() else {
                return;
            };
            if !current.status.enabled || current.generation != generation {
                return;
            }
            change(&mut current);
            current.status.clone()
        };
        // Send only to the trusted Hibiki window; the remote login has no IPC grants.
        let _ = app.emit_to("main", "ytmusic://status", status);
    }

    fn failure(&self, app: &tauri::AppHandle, generation: u64, auth: bool, message: &str) {
        self.update(app, generation, |current| {
            current.status.phase = if auth {
                Phase::ReauthRequired
            } else {
                Phase::Unavailable
            };
            current.status.message = Some(message.into());
            current.status.next_refresh_at = Some(now() + if auth { HOUR } else { 300 });
        });
    }
}

fn settings_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|_| "YouTube Music settings unavailable")?
        .join("youtube-music-enabled"))
}

pub fn start(app: tauri::AppHandle) {
    if let Ok(directory) = app.path().app_config_dir() {
        rate_limit::REQUESTS.restore(directory.join("youtube-music-request-pace.json"));
    }
    let state = Arc::new(YoutubeMusic::default());
    if settings_path(&app).is_ok_and(|path| path.is_file()) {
        let mut current = state.current.lock().unwrap();
        current.status.enabled = true;
        current.status.phase = Phase::Refreshing;
        current.status.next_refresh_at = Some(now());
    }
    app.manage(state.clone());
    tauri::async_runtime::spawn(async move {
        let _ = crate::background_jobs::every(&app, crate::background_jobs::Task::YoutubeSessionMaintenance, std::time::Duration::from_secs(30)).await;
    });
}

pub(crate) fn session_due(app: &tauri::AppHandle) -> bool {
    let Some(state) = app.try_state::<Arc<YoutubeMusic>>() else { return false; };
    let due = state.current.lock().is_ok_and(|current| current.status.enabled && !current.interactive
        && current.status.next_refresh_at.is_some_and(|next| now() >= next));
    due
}
pub(crate) async fn background_session(app: &tauri::AppHandle) -> Result<(), String> {
    if session_due(app) { session::renew(app).await?; }
    Ok(())
}

#[tauri::command]
pub fn ytmusic_status(state: tauri::State<'_, Arc<YoutubeMusic>>) -> Result<Status, String> {
    Ok(state
        .current
        .lock()
        .map_err(|_| "YouTube Music session unavailable")?
        .status
        .clone())
}

#[tauri::command]
pub async fn ytmusic_playlist_read(
    app: tauri::AppHandle,
    playlist_id: String,
    expected_account: String,
    source_only: Option<bool>,
) -> Result<playlists::Snapshot, String> {
    let generation = app.state::<Arc<YoutubeMusic>>().generation()?;
    let value = crate::background_jobs::call(&app, crate::background_jobs::Task::YoutubePlaylistRead {
        playlist_id, account: expected_account, generation, source_only: source_only.unwrap_or(false),
    }).await?;
    serde_json::from_value(value).map_err(|_| "Background playlist read was incomplete".into())
}

#[tauri::command]
pub async fn ytmusic_playlist_write(
    app: tauri::AppHandle,
    playlist_id: Option<String>,
    expected_account: String,
    expected: Vec<playlists::Handle>,
    operation: playlists::Operation,
) -> Result<String, String> {
    let owned_app = app.clone();
    crate::background_jobs::mutation(&app, async move {
        playlists::ytmusic_playlist_write(owned_app, playlist_id, expected_account, expected, operation).await
    }).await
}

#[tauri::command]
pub async fn ytmusic_connect(app: tauri::AppHandle) -> Result<(), String> {
    let path = settings_path(&app)?;
    std::fs::create_dir_all(path.parent().unwrap())
        .map_err(|_| "Could not save YouTube Music connection")?;
    std::fs::write(path, b"1\n").map_err(|_| "Could not save YouTube Music connection")?;
    let state = app.state::<Arc<YoutubeMusic>>();
    let (generation, was_interactive) = {
        let mut current = state
            .current
            .lock()
            .map_err(|_| "YouTube Music session unavailable")?;
        if !current.status.enabled {
            current.generation += 1;
        }
        let was_interactive = current.interactive;
        current.status.enabled = true;
        current.interactive = true;
        current.status.phase = Phase::Connecting;
        current.status.message = None;
        (current.generation, was_interactive)
    };
    state.update(&app, generation, |_| {});
    let opened: Result<(), String> = async {
        let window = session::window(&app).await?;
        if !state.owns(generation) {
            return Err("YouTube Music session changed.".into());
        }
        if !was_interactive {
            window
                .navigate(url::Url::parse(ORIGIN).unwrap())
                .map_err(|_| "Could not load YouTube Music sign-in")?;
        }
        window
            .show()
            .map_err(|_| "Could not open YouTube Music sign-in")?;
        window
            .set_focus()
            .map_err(|_| "Could not focus YouTube Music sign-in")?;
        Ok(())
    }
    .await;
    if let Err(message) = opened {
        state.update(&app, generation, |current| current.interactive = false);
        state.failure(&app, generation, false, &message);
        return Err(message);
    }
    if was_interactive {
        return Ok(());
    }
    // Observe sign-in even when Google updates the page without a navigation.
    tauri::async_runtime::spawn(async move {
        for attempt in 0..120 {
            tokio::time::sleep(std::time::Duration::from_secs(if attempt < 12 {
                5
            } else {
                15
            }))
            .await;
            let state = app.state::<Arc<YoutubeMusic>>();
            if !state.owns(generation) {
                break;
            }
            let interactive = state
                .current
                .lock()
                .is_ok_and(|current| current.interactive);
            if !interactive {
                break;
            }
            let _ = session::check(&app, generation).await;
        }
        app.state::<Arc<YoutubeMusic>>()
            .update(&app, generation, |current| {
                if current.interactive {
                    current.interactive = false;
                    current.status.phase = Phase::Unavailable;
                    current.status.message = Some(
                        "Sign-in has not finished. Open the sign-in window to continue.".into(),
                    );
                    current.status.next_refresh_at = Some(now() + HOUR);
                }
            });
    });
    Ok(())
}

#[tauri::command]
pub async fn ytmusic_refresh(app: tauri::AppHandle) -> Result<(), String> {
    session::renew(&app).await
}

#[tauri::command]
pub async fn ytmusic_disconnect(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<Arc<YoutubeMusic>>();
    // Revoke native admission before clearing the website store.
    let status = {
        let mut current = state
            .current
            .lock()
            .map_err(|_| "YouTube Music session unavailable")?;
        current.generation += 1;
        current.interactive = false;
        current.status = Status {
            enabled: false,
            phase: Phase::Disconnected,
            last_checked_at: None,
            next_refresh_at: None,
            message: None,
            account_id: None,
        };
        current.status.clone()
    };
    let _ = app.emit_to("main", "ytmusic://status", status);
    playback::forget_cache_owner(&app);
    if let Ok(directory) = app.path().app_cache_dir() {
        state.discovery_cache.clear(directory.join("ytmusic-discovery")).await;
    }
    if let Ok(path) = settings_path(&app) {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("Could not disable YouTube Music startup renewal.".into()),
        }
    }
    if let Some(window) = app.get_webview_window(WINDOW) {
        window
            .clear_all_browsing_data()
            .map_err(|_| "Could not clear the YouTube Music session. Try Disconnect again.")?;
        let _ = window.hide();
        let _ = window.navigate(url::Url::parse("about:blank").unwrap());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn disconnect_retires_inflight_work_even_after_reconnecting() {
        let state = YoutubeMusic::default();
        assert!(state.generation().is_err());
        {
            let mut current = state.current.lock().unwrap();
            current.status.enabled = true;
            current.generation = 1;
        }
        let first = state.generation().unwrap();
        assert!(state.owns(first));
        {
            let mut current = state.current.lock().unwrap();
            current.status.enabled = false;
            current.generation += 1;
        }
        assert!(!state.owns(first));
        state.current.lock().unwrap().status.enabled = true;
        assert!(!state.owns(first));
        assert!(state.owns(state.generation().unwrap()));
    }
}

#[tauri::command]
pub async fn ytmusic_search(
    query: String,
    app: tauri::AppHandle,
) -> Result<Vec<api::Song>, String> {
    api::search(&app, &query).await
}

#[tauri::command]
pub async fn ytmusic_test_stream(
    video_id: String,
    app: tauri::AppHandle,
) -> Result<extractor::StreamTest, String> {
    extractor::test_stream(&app, &video_id).await
}

#[tauri::command]
pub async fn ytmusic_helpers(app: tauri::AppHandle) -> tools::Helpers {
    tools::status(&app)
}

#[tauri::command]
pub async fn ytmusic_install_helpers(app: tauri::AppHandle) -> Result<tools::Helpers, String> {
    tools::install(&app).await
}

#[tauri::command]
pub async fn ytmusic_browse(browse_id: String, params: Option<String>, continuation: Option<String>, force: Option<bool>, include_performances: Option<bool>, client_revision: Option<u64>, background: Option<bool>, app: tauri::AppHandle) -> Result<discovery::BrowsePage, String> {
    if background.unwrap_or(false) {
        let state = app.state::<Arc<YoutubeMusic>>();
        let generation = state.generation()?;
        let account = state.current.lock().map_err(|_| "YouTube Music session unavailable")?.status.account_id.clone()
            .ok_or("Connect YouTube Music first.")?;
        if !force.unwrap_or(false) {
            if let Some(page) = discovery::cached_browse(&app, &browse_id, params.as_deref(), continuation.as_deref(),
                include_performances.unwrap_or(false), client_revision).await? {
                background_account(&app, &account, generation)?;
                return Ok(page);
            }
        }
        let value = crate::background_jobs::call(&app, crate::background_jobs::Task::YoutubeBrowse {
            request: crate::background_jobs::Browse { account, generation, browse_id, params, continuation,
                force: force.unwrap_or(false), include_performances: include_performances.unwrap_or(false), client_revision },
        }).await?;
        return serde_json::from_value(value).map_err(|_| "Background catalog read was incomplete".into());
    }
    discovery::browse(&app, &browse_id, params.as_deref(), continuation.as_deref(), force.unwrap_or(false), include_performances.unwrap_or(false), client_revision).await
}

fn background_account(app: &tauri::AppHandle, account: &str, generation: u64) -> Result<(), String> {
    let state = app.try_state::<Arc<YoutubeMusic>>().ok_or("YouTube Music is starting.")?;
    let current = state.current.lock().map_err(|_| "YouTube Music session unavailable")?;
    if !current.status.enabled || current.generation != generation || current.status.account_id.as_deref() != Some(account) {
        return Err("YouTube Music connection changed.".into());
    }
    Ok(())
}
pub(crate) async fn background_browse(app: &tauri::AppHandle, request: crate::background_jobs::Browse) -> Result<serde_json::Value, String> {
    background_account(app, &request.account, request.generation)?;
    let page = discovery::browse(app, &request.browse_id, request.params.as_deref(), request.continuation.as_deref(),
        request.force, request.include_performances, request.client_revision).await?;
    background_account(app, &request.account, request.generation)?;
    serde_json::to_value(page).map_err(|_| "Background catalog read was incomplete".into())
}
pub(crate) async fn background_playlist_read(app: &tauri::AppHandle, playlist_id: String, account: String, generation: u64, source_only: bool) -> Result<serde_json::Value, String> {
    background_account(app, &account, generation)?;
    let page = playlists::ytmusic_playlist_read(app.clone(), playlist_id, account.clone(), source_only).await?;
    background_account(app, &account, generation)?;
    serde_json::to_value(page).map_err(|_| "Background playlist read was incomplete".into())
}

#[tauri::command]
pub async fn ytmusic_set_song_like(video_id: String, liked: bool, expected_account: Option<String>, app: tauri::AppHandle) -> Result<(), String> {
    api::set_song_like(&app, &video_id, liked, expected_account.as_deref()).await
}
