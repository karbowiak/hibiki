//! Saved browsing is admitted only under a trusted native account/library owner.
use crate::commands::{PlexRequestContext, PlexState};
use crate::db::{DbState, offline};
use crate::plex::{PlexClient, PlexClientConfig, PlexSettings};
use tauri::{Manager, State};

fn now() -> Result<i64, String> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|time| time.as_millis().min(i64::MAX as u128) as i64)
        .map_err(|_| "The system clock is unavailable".into())
}

/// Acquire the writer on a blocking worker, then take native ownership only
/// when available. Never wait for either mutex while holding the other.
pub(crate) async fn owned_write<T: Send + 'static>(
    app: &tauri::AppHandle,
    context: &PlexRequestContext,
    online: bool,
    work: impl Fn(&rusqlite::Connection, &str) -> Result<T, String> + Send + Sync + 'static,
) -> Result<T, String> {
    let work = std::sync::Arc::new(work);
    loop {
        let owner = app.clone();
        let captured = context.clone();
        let operation = work.clone();
        let result = app
            .state::<DbState>()
            .write(move |conn| {
                let state = owner.state::<PlexState>();
                let Ok(guard) = state.0.try_lock() else {
                    return Ok(None);
                };
                let client = if online {
                    state.checked_client(&captured, &guard)?
                } else {
                    state.checked_cache_client(&captured, &guard)?
                };
                operation(conn, &client.library_scope).map(Some)
            })
            .await?;
        if let Some(value) = result {
            return Ok(value);
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
}

#[tauri::command]
pub async fn offline_cache_get(
    context: PlexRequestContext,
    key: String,
    state: State<'_, PlexState>,
    db: State<'_, DbState>,
    app: tauri::AppHandle,
) -> Result<Option<offline::Snapshot>, String> {
    let mut timing = crate::performance::Timer::new("offline_cache_get");
    let guard = state.0.lock().await;
    timing.phase("owner_wait");
    let scope = state
        .checked_cache_client(&context, &guard)?
        .library_scope
        .clone();
    drop(guard);
    let read_key = key.clone();
    let result = db
        .read(move |conn| {
            let mut sql = crate::performance::Timer::new("offline_cache_get");
            let result = offline::peek(conn, &scope, &read_key);
            sql.phase("sql");
            result
        })
        .await?;
    timing.phase("database_read");
    let guard = state.0.lock().await;
    state.checked_cache_client(&context, &guard)?;
    drop(guard);
    if result.is_some() {
        tauri::async_runtime::spawn(async move {
            if let Ok(at) = now() {
                let _ = owned_write(&app, &context, false, move |conn, scope| {
                    offline::touch(conn, scope, &key, at)
                })
                .await;
            }
        });
    }
    Ok(result)
}

#[tauri::command]
pub async fn offline_cache_put(
    context: PlexRequestContext,
    key: String,
    payload: serde_json::Value,
    state: State<'_, PlexState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let mut timing = crate::performance::Timer::new("offline_cache_put");
    let guard = state.0.lock().await;
    timing.phase("owner_wait");
    state.checked_client(&context, &guard)?;
    drop(guard);
    owned_write(&app, &context, true, move |conn, scope| {
        let mut sql = crate::performance::Timer::new("offline_cache_put");
        let result = offline::put(conn, scope, &key, &payload, now()?);
        sql.phase("sql");
        result
    })
    .await
}

#[tauri::command]
pub async fn offline_cache_invalidate(
    context: PlexRequestContext,
    prefixes: Vec<String>,
    state: State<'_, PlexState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let guard = state.0.lock().await;
    state.checked_client(&context, &guard)?;
    drop(guard);
    owned_write(&app, &context, true, move |conn, scope| {
        offline::invalidate(conn, scope, &prefixes)
    }).await
}

#[tauri::command]
pub async fn offline_cache_info(
    context: PlexRequestContext,
    state: State<'_, PlexState>,
    db: State<'_, DbState>,
) -> Result<offline::CacheInfo, String> {
    let guard = state.0.lock().await;
    let scope = state
        .checked_cache_client(&context, &guard)?
        .library_scope
        .clone();
    drop(guard);
    let result = db.read(move |conn| offline::info(conn, &scope)).await?;
    let guard = state.0.lock().await;
    state.checked_cache_client(&context, &guard)?;
    Ok(result)
}

#[tauri::command]
pub async fn offline_cache_clear(
    context: PlexRequestContext,
    state: State<'_, PlexState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let guard = state.0.lock().await;
    state.checked_cache_client(&context, &guard)?;
    drop(guard);
    owned_write(&app, &context, false, |conn, scope| {
        offline::clear(conn, scope)
    })
    .await
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfflineContext {
    revision: u64,
    cache_scope: String,
    base_url: String,
    machine_identifier: String,
    section_id: i64,
    section_uuid: String,
    section_title: &'static str,
}

fn saved_client(settings: &PlexSettings) -> Result<PlexClient, String> {
    if settings.base_url.is_empty()
        || settings.token.is_empty()
        || settings.client_id.is_empty()
        || settings.machine_identifier.is_empty()
        || settings.section_id <= 0
        || settings.section_uuid.is_empty()
    {
        return Err("Connect to a Plex music library before browsing saved items.".into());
    }
    let mut client = PlexClient::new(PlexClientConfig {
        base_url: settings.base_url.clone(),
        token: settings.token.clone(),
        client_id: settings.client_id.clone(),
        // Saved browsing performs no network requests, so it needs no TLS exception.
        ..Default::default()
    })
    .map_err(|_| "The saved Plex connection is invalid")?;
    client.machine_identifier = settings.machine_identifier.clone();
    client.library_scope =
        client.cache_scope_for_library(settings.section_id, Some(&settings.section_uuid));
    client.offline_only = true;
    Ok(client)
}

async fn restore_saved(
    state: &PlexState,
    db: &DbState,
    directory: &std::path::Path,
    revision: u64,
) -> Result<OfflineContext, String> {
    if !state.is_current(revision) {
        return Err("Plex connection was superseded".into());
    }
    let settings = crate::plex::load_settings(directory)
        .map_err(|_| "Cannot read the saved Plex connection")?;
    let mut client = saved_client(&settings)?;
    {
        let conn =
            db.0.lock()
                .map_err(|_| "Saved browsing storage is unavailable")?;
        let mut endpoints = settings.all_urls.clone();
        endpoints.push(settings.base_url.clone());
        crate::plex::cache_scope::restore_endpoint_aliases(&mut client,&conn,&[(settings.section_id,Some(settings.section_uuid.clone()))],&endpoints)?;
        client.library_scope = client.cache_scope_for_library(settings.section_id,Some(&settings.section_uuid));
        let audio_tracks: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM local_audio WHERE scope=?1",
                [&client.library_scope],
                |row| row.get(0),
            )
            .map_err(|_| "Cannot read saved audio")?;
        let catalogue_tracks: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM plex_catalogue WHERE scope=?1 AND removed=0",
                [&client.library_scope],
                |r| r.get(0),
            )
            .map_err(|_| "Cannot read saved catalogue")?;
        if offline::info(&conn, &client.library_scope)?.entries == 0
            && audio_tracks == 0
            && catalogue_tracks == 0
        {
            return Err("There are no saved pages for this Plex music library yet.".into());
        }
    }
    // A settings edit/logout during restoration cannot resurrect an older account.
    let latest = crate::plex::load_settings(directory)
        .map_err(|_| "Cannot read the saved Plex connection")?;
    let mut latest_client = saved_client(&latest)?;
    latest_client.scope_bases = client.scope_bases.clone();
    if latest_client.cache_scope_for_library(latest.section_id,Some(&latest.section_uuid)) != client.library_scope {
        return Err("The saved Plex music library changed. Try again.".into());
    }
    let response = OfflineContext {
        revision,
        cache_scope: client.library_scope.clone(),
        base_url: client.base_url().into(),
        machine_identifier: client.machine_identifier.clone(),
        section_id: settings.section_id,
        section_uuid: settings.section_uuid,
        section_title: "Saved music library",
    };
    state.publish_offline(revision, client).await?;
    Ok(response)
}

#[tauri::command]
pub async fn restore_offline_context(
    app: tauri::AppHandle,
    revision: u64,
    state: State<'_, PlexState>,
    db: State<'_, DbState>,
) -> Result<OfflineContext, String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|_| "Cannot find private settings")?;
    restore_saved(&state, &db, &directory, revision).await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixtures() -> (tempfile::TempDir, DbState, PlexSettings) {
        let dir = tempfile::tempdir().unwrap();
        let db = DbState::open(&dir.path().join("test.sqlite")).unwrap();
        let settings = PlexSettings {
            base_url: "http://127.0.0.1:1".into(),
            token: "fixture-token".into(),
            client_id: "fixture-installation".into(),
            machine_identifier: "fixture-server".into(),
            section_id: 7,
            section_uuid: "fixture-library".into(),
            ..Default::default()
        };
        crate::plex::update_settings(dir.path(), |current| {
            *current = settings.clone();
            Ok(())
        })
        .unwrap();
        (dir, db, settings)
    }
    fn save(db: &DbState, settings: &PlexSettings) {
        offline::put(
            &db.0.lock().unwrap(),
            &saved_client(settings).unwrap().library_scope,
            "fixture",
            &serde_json::json!({"title":"Saved music"}),
            1,
        )
        .unwrap();
    }
    #[tokio::test]
    async fn restore_is_local_scoped_and_credential_free() {
        let (dir, db, settings) = fixtures();
        save(&db, &settings);
        let state = PlexState::new();
        let result = restore_saved(&state, &db, dir.path(), 0).await.unwrap();
        let payload = serde_json::to_string(&result).unwrap();
        assert!(!payload.contains("fixture-token"));
        assert!(!payload.contains("token"));
        let context = PlexRequestContext {
            connection_revision: 0,
            cache_scope: result.cache_scope.clone(),
        };
        let guard = state.0.lock().await;
        assert!(
            state
                .checked_cache_client(&context, &guard)
                .unwrap()
                .offline_only
        );
        assert!(state.checked_client(&context, &guard).is_err());
        assert!(
            state
                .checked_cache_client(
                    &PlexRequestContext {
                        cache_scope: "other".into(),
                        ..context
                    },
                    &guard
                )
                .is_err()
        );
    }
    #[tokio::test]
    async fn restore_rejects_absent_wrong_scope_and_active_owner() {
        let (dir, db, settings) = fixtures();
        let state = PlexState::new();
        assert!(restore_saved(&state, &db, dir.path(), 0).await.is_err());
        let mut other = settings.clone();
        other.token = "other-account".into();
        save(&db, &other);
        assert!(restore_saved(&state, &db, dir.path(), 0).await.is_err());
        save(&db, &settings);
        let mut online = saved_client(&settings).unwrap();
        online.offline_only = false;
        *state.0.lock().await = Some(online);
        assert!(restore_saved(&state, &db, dir.path(), 0).await.is_err());
        assert!(!state.0.lock().await.as_ref().unwrap().offline_only);
    }
    #[tokio::test]
    async fn restore_rejects_retired_revision() {
        let (dir, db, settings) = fixtures();
        save(&db, &settings);
        assert!(
            restore_saved(&PlexState::new(), &db, dir.path(), 1)
                .await
                .is_err()
        );
    }
}
