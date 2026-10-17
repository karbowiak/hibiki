//! Compact, scoped Plex matching evidence; independent of browse/offline DTOs.
pub mod row;
pub mod store;
mod transport;

use crate::{
    commands::{PlexRequestContext, PlexState},
    db::DbState,
};
use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicI64, Ordering},
        Mutex,
    },
};
use tauri::{Emitter, Manager};
pub struct IndexState {
    running: Mutex<HashSet<(u64, String)>>,
    busy_until: AtomicI64,
    network: std::sync::Arc<tokio::sync::Semaphore>,
}
impl Default for IndexState {
    fn default() -> Self {
        Self {
            running: Mutex::new(HashSet::new()),
            busy_until: AtomicI64::new(0),
            network: std::sync::Arc::new(tokio::sync::Semaphore::new(1)),
        }
    }
}
async fn client(
    app: &tauri::AppHandle,
    context: &PlexRequestContext,
) -> Result<crate::plex::PlexClient, String> {
    let state = app.state::<PlexState>();
    let guard = state.0.lock().await;
    state.checked_cache_client(context, &guard).cloned()
}
async fn snapshot(
    app: &tauri::AppHandle,
    context: &PlexRequestContext,
) -> Result<store::Status, String> {
    client(app, context).await?;
    let scope = context.cache_scope.clone();
    let status = app
        .state::<DbState>()
        .read(move |conn| store::status(conn, &scope))
        .await?;
    client(app, context).await?;
    Ok(status)
}
async fn write<T: Send + 'static>(
    app: &tauri::AppHandle,
    context: &PlexRequestContext,
    work: impl FnOnce(&rusqlite::Connection, &PlexState, &PlexRequestContext) -> Result<T, String>
        + Send
        + 'static,
) -> Result<T, String> {
    let owner = app.clone();
    let context = context.clone();
    app.state::<DbState>()
        .write(move |conn| {
            let plex = owner.state::<PlexState>();
            drop(plex.cache_commit_guard(&context)?);
            work(conn, &plex, &context)
        })
        .await
}
#[tauri::command]
pub async fn matching_index_status(
    app: tauri::AppHandle,
    context: PlexRequestContext,
) -> Result<store::Status, String> {
    snapshot(&app, &context).await
}
#[tauri::command]
pub async fn matching_index_control(
    app: tauri::AppHandle,
    context: PlexRequestContext,
    action: String,
) -> Result<store::Status, String> {
    client(&app, &context).await?;
    let scope = context.cache_scope.clone();
    // Local user intent owns its captured scope. Bulk clear must never hold the
    // Plex/audio admission mutex while SQLite removes an existing large index.
    let result = app
        .state::<DbState>()
        .write(move |conn| store::control(conn, &scope, &action))
        .await?;
    client(&app, &context).await?;
    start(&app, &context).await?;
    Ok(result)
}
#[tauri::command]
pub async fn matching_index_start(
    app: tauri::AppHandle,
    context: PlexRequestContext,
) -> Result<store::Status, String> {
    start(&app, &context).await?;
    snapshot(&app, &context).await
}
#[tauri::command]
pub async fn matching_index_yield(
    app: tauri::AppHandle,
    context: PlexRequestContext,
) -> Result<(), String> {
    client(&app, &context).await?;
    app.state::<IndexState>()
        .busy_until
        .store(store::now() + 1500, Ordering::Relaxed);
    Ok(())
}
async fn start(app: &tauri::AppHandle, context: &PlexRequestContext) -> Result<(), String> {
    let plex = client(app, context).await?;
    if plex.offline_only {
        return Ok(());
    }
    let scope = context.cache_scope.clone();
    app.state::<DbState>()
        .write(move |conn| store::ensure_scope(conn, &scope))
        .await?;
    let key = (context.connection_revision, context.cache_scope.clone());
    if !app
        .state::<IndexState>()
        .running
        .lock()
        .map_err(|_| "Matching index unavailable")?
        .insert(key.clone())
    {
        return Ok(());
    }
    let app = app.clone();
    let context = context.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(_) = worker(&app, &context).await {
            tracing::debug!("Matching index worker retired or unavailable");
        }
        if let Ok(mut running) = app.state::<IndexState>().running.lock() {
            running.remove(&key);
        }
    });
    Ok(())
}
async fn worker(app: &tauri::AppHandle, context: &PlexRequestContext) -> Result<(), String> {
    let mut verified = None;
    let mut modern = false;
    let mut next_kind = 0;
    loop {
        let plex = client(app, context).await?;
        if plex.offline_only {
            return Ok(());
        }
        let status = snapshot(app, context).await?;
        let priority = app.state::<IndexState>().busy_until.load(Ordering::Relaxed) > store::now()
            || app
                .try_state::<crate::audio_engine::bridge::AudioEngineState>()
                .is_some_and(|engine| engine.0.is_buffering());
        if status.paused || priority {
            tokio::time::sleep(std::time::Duration::from_millis(750)).await;
            continue;
        }
        let kind = ["artist", "album", "track"][next_kind % 3];
        next_kind += 1;
        let task = match crate::catalogue_commands::save_checked(app, context, |conn| {
            store::begin(conn, &context.cache_scope, kind, status.epoch)
        })
        .await
        {
            Ok(task) => task,
            Err(_) => {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                continue;
            }
        };
        if task.phase == "complete" || task.retry_at > store::now() {
            write(app, context, |conn, _, context| {
                store::tidy(conn, &context.cache_scope)
            })
            .await?;
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            continue;
        }
        let network = app
            .state::<IndexState>()
            .network
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| "Matching index stopped")?;
        if client(app, context).await?.offline_only {
            return Ok(());
        }
        let latest = snapshot(app, context).await?;
        if latest.epoch != status.epoch
            || latest.paused
            || app.state::<IndexState>().busy_until.load(Ordering::Relaxed) > store::now()
        {
            continue;
        }
        if verified.is_none_or(|(_, at): (i64, i64)| store::now() - at > 60_000) {
            match crate::catalogue_commands::fresh_library(app, context).await {
                Ok((current, library)) => {
                    if verified.is_none() {
                        modern = transport::modern(
                            &current
                                .get_identity()
                                .await
                                .map_err(|_| "Plex API capabilities unavailable")?
                                .version,
                        );
                    }
                    verified = Some((library, store::now()));
                }
                Err(_) => {
                    tokio::time::sleep(std::time::Duration::from_secs(15)).await;
                    continue;
                }
            }
        }
        let outcome = if task.phase == "prune" {
            drop(network);
            let job = task.clone();
            write(app, context, move |conn, plex, context| {
                store::prune_fenced(conn, &context.cache_scope, &job, status.epoch, || {
                    plex.cache_commit_guard(context)
                })
            })
            .await
            .map(|_| ())
        } else {
            let response = tokio::time::timeout(
                std::time::Duration::from_secs(30),
                transport::page(&plex, verified.unwrap().0, kind, task.offset, modern),
            )
            .await;
            drop(network);
            match response {
                Ok(Ok(page)) => {
                    let job = task.clone();
                    write(app, context, move |conn, plex, context| {
                        store::publish_fenced(
                            conn,
                            &context.cache_scope,
                            &job,
                            status.epoch,
                            &page.rows,
                            page.total,
                            page.bytes,
                            || plex.cache_commit_guard(context),
                        )
                    })
                    .await
                }
                Ok(Err(error)) => Err(error),
                Err(_) => Err("Plex matching listing timed out".into()),
            }
        };
        if let Err(error) = outcome {
            // Stale epochs cannot change the successor's checkpoint/error state.
            let _ = crate::catalogue_commands::save_checked(app, context, |conn| {
                store::fail(conn, &context.cache_scope, &task, status.epoch, &error)
            })
            .await;
        } else {
            let _ = app.emit(
                "matching-index-changed",
                serde_json::json!({"scope":context.cache_scope}),
            );
        }
        tokio::time::sleep(std::time::Duration::from_millis(125)).await;
    }
}
