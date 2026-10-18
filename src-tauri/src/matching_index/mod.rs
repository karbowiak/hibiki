//! Compact, scoped Plex matching evidence; independent of browse/offline DTOs.
mod freshness;
mod resolver;
pub use freshness::Hint as MatchingHint;
pub mod row;
pub mod store;
mod transport;
#[cfg(test)]
mod live_validation;

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
    lookups: std::sync::Arc<tokio::sync::Semaphore>,
}
impl Default for IndexState {
    fn default() -> Self {
        Self {
            running: Mutex::new(HashSet::new()),
            busy_until: AtomicI64::new(0),
            network: std::sync::Arc::new(tokio::sync::Semaphore::new(1)),
            lookups: std::sync::Arc::new(tokio::sync::Semaphore::new(2)),
        }
    }
}
impl IndexState {
    pub fn foreground(&self, command: &str) {
        if foreground_command(command) {
            self.busy_until
                .store(store::now() + 1500, Ordering::Relaxed)
        }
    }
}
fn foreground_command(command: &str) -> bool {
    command.starts_with("search_")
        || command.starts_with("collection_query")
        || command.starts_with("catalogue_query")
        || matches!(
            command,
            "get_track"
                | "get_artist"
                | "get_album"
                | "get_artist_albums"
                | "get_album_tracks"
                | "get_artist_popular_tracks"
                | "get_artist_singles"
                | "get_artist_similar"
                | "get_hubs"
                | "get_discovery_page"
                | "get_recently_added"
                | "get_latest_releases"
                | "get_recently_played"
                | "get_playlist_tracks"
                | "get_playlist_items"
                | "playlist_sync_candidates"
                | "ytmusic_search"
                | "ytmusic_browse"
                | "audio_play"
                | "audio_prepare_queue"
                | "audio_seek"
        )
}
#[cfg(test)]
mod priority_tests {
    use super::*;
    #[test]
    fn real_foreground_commands_yield_without_polling_or_timeline_starvation() {
        let index = IndexState::default();
        index.foreground("audio_get_position");
        assert_eq!(index.busy_until.load(Ordering::Relaxed), 0);
        for command in [
            "get_track",
            "get_artist_albums",
            "search_library",
            "collection_query_page",
            "ytmusic_browse",
            "audio_play",
            "audio_seek",
        ] {
            assert!(foreground_command(command));
        }
        for command in [
            "matching_index_resolve",
            "matching_index_changes",
            "matching_index_status",
            "report_timeline",
            "audio_get_diagnostics",
            "audio_get_position",
            "set_now_playing_state",
        ] {
            assert!(!foreground_command(command));
        }
        index.foreground("get_track");
        assert!(index.busy_until.load(Ordering::Relaxed) > store::now());
    }
}
/// Recover an idle worker after transient storage/ownership races, including a
/// pause/resume that happened while the previous job was finishing.
pub fn start_watchdog(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            if let Some(context) = app.state::<PlexState>().current_request_context().await {
                let _ = start(&app, &context).await;
            }
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        }
    });
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
pub async fn matching_index_resolve(
    app: tauri::AppHandle,
    context: PlexRequestContext,
    source_owner: String,
    sources: Vec<resolver::Source>,
    force: bool,
) -> Result<Vec<resolver::Resolution>, String> {
    if sources.is_empty()
        || sources.len() > 32
        || source_owner.is_empty()
        || source_owner.len() > 256
    {
        return Err("Invalid bounded matching batch".into());
    }
    for source in &sources {
        resolver::validate(source)?;
    }
    client(&app, &context).await?;
    let owner = app.clone();
    let captured = context.clone();
    let result = app
        .state::<DbState>()
        .write(move |conn| {
            let tx = conn
                .unchecked_transaction()
                .map_err(|_| "Matching associations are unavailable")?;
            store::ensure_scope(&tx, &captured.cache_scope)?;
            let result = sources
                .iter()
                .map(|source| {
                    resolver::resolve(&tx, &captured.cache_scope, &source_owner, source, force)
                })
                .collect::<Result<Vec<_>, _>>()?;
            let state = owner.state::<PlexState>();
            let _guard = state.cache_identity_guard(&captured)?;
            tx.commit()
                .map_err(|_| "Matching associations are unavailable")?;
            Ok(result)
        })
        .await?;
    client(&app, &context).await?;
    Ok(result)
}
#[tauri::command]
pub async fn matching_index_rows(app:tauri::AppHandle,context:PlexRequestContext,kind:String,ids:Vec<i64>)->Result<Vec<resolver::Entry>,String> {
    client(&app,&context).await?;
    let scope=context.cache_scope.clone();
    let result=app.state::<DbState>().read(move|conn|resolver::entries(conn,&scope,&kind,&ids)).await?;
    client(&app,&context).await?;Ok(result)
}
#[tauri::command]
pub async fn matching_index_reverse(
    app: tauri::AppHandle,
    context: PlexRequestContext,
    source_owner: String,
    kind: String,
    id: i64,
) -> Result<Vec<resolver::Source>, String> {
    client(&app, &context).await?;
    let captured = context.clone();
    let app_owner = app.clone();
    let result = app
        .state::<DbState>()
        .write(move |conn| {
            let tx = conn
                .unchecked_transaction()
                .map_err(|_| "Matching associations are unavailable")?;
            let result = resolver::reverse(&tx, &captured.cache_scope, &source_owner, &kind, id)?;
            let state = app_owner.state::<PlexState>();
            let _guard = state.cache_identity_guard(&captured)?;
            tx.commit()
                .map_err(|_| "Matching associations are unavailable")?;
            Ok(result)
        })
        .await?;
    client(&app, &context).await?;
    Ok(result)
}
#[tauri::command]
pub async fn matching_index_fallback(
    app: tauri::AppHandle,
    context: PlexRequestContext,
    source_owner: String,
    source: resolver::Source,
) -> Result<resolver::Resolution, String> {
    resolver::validate(&source)?;
    if source_owner.is_empty() || source_owner.len() > 256 {
        return Err("Invalid matching source owner".into());
    }
    let _permit = app
        .state::<IndexState>()
        .lookups
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| "Matching lookup stopped")?;
    app.state::<IndexState>()
        .busy_until
        .store(store::now() + 1500, Ordering::Relaxed);
    let (plex, library) = crate::catalogue_commands::verify_library(&app, &context).await?;
    let epoch = snapshot(&app, &context).await?.epoch;
    let modern = tokio::time::timeout(std::time::Duration::from_secs(5), plex.get_identity())
        .await
        .ok()
        .and_then(Result::ok)
        .is_some_and(|id| transport::modern(&id.version));
    let observed = store::now();
    let page = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        transport::candidates(&plex, library, &source.kind, &source.title, modern),
    )
    .await
    .map_err(|_| "Plex matching lookup timed out")??;
    let complete = page.total == page.rows.len() as i64;
    let result = write(&app, &context, move |conn, plex, context| {
        if store::status(conn, &context.cache_scope)?.epoch != epoch {
            return Err("Matching lookup was superseded".into());
        }
        let tx = conn
            .unchecked_transaction()
            .map_err(|_| "Matching evidence storage is unavailable")?;
        for row in page.rows {
            store::upsert(&tx, &context.cache_scope, &row, observed)?;
        }
        let result = resolver::resolve_confirmed(
            &tx,
            &context.cache_scope,
            &source_owner,
            &source,
            true,
            complete,
            !complete,
        )?;
        store::trim_changes(&tx, &context.cache_scope)?;
        let _guard = plex.cache_commit_guard(context)?;
        tx.commit()
            .map_err(|_| "Matching evidence storage is unavailable")?;
        Ok(result)
    })
    .await?;
    client(&app, &context).await?;
    let _ = app.emit(
        "matching-index-changed",
        serde_json::json!({"scope":context.cache_scope}),
    );
    Ok(result)
}
#[tauri::command]
pub async fn matching_index_notify(
    app: tauri::AppHandle,
    context: PlexRequestContext,
    changes: Vec<MatchingHint>,
    catchup: bool,
) -> Result<(), String> {
    write(&app, &context, move |conn, plex, context| {
        freshness::offer(conn, &context.cache_scope, &changes, catchup, || {
            plex.cache_commit_guard(context)
        })
    })
    .await?;
    start(&app, &context).await
}
#[tauri::command]
pub async fn matching_index_status(
    app: tauri::AppHandle,
    context: PlexRequestContext,
) -> Result<store::Status, String> {
    snapshot(&app, &context).await
}
#[tauri::command]
pub async fn matching_index_changes(
    app: tauri::AppHandle,
    context: PlexRequestContext,
    since: i64,
) -> Result<store::Changes, String> {
    client(&app, &context).await?;
    let scope = context.cache_scope.clone();
    let changes = app
        .state::<DbState>()
        .read(move |conn| store::changes(conn, &scope, since))
        .await?;
    client(&app, &context).await?;
    Ok(changes)
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
    let _ = app.emit(
        "matching-index-changed",
        serde_json::json!({"scope":context.cache_scope}),
    );
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
    let key = (context.connection_revision, context.cache_scope.clone());
    if app
        .state::<IndexState>()
        .running
        .lock()
        .map_err(|_| "Matching index unavailable")?
        .contains(&key)
    {
        return Ok(());
    }
    let scope = context.cache_scope.clone();
    app.state::<DbState>()
        .write(move |conn| store::ensure_scope(conn, &scope))
        .await?;
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
    let permit = app
        .state::<IndexState>()
        .network
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| "Matching index stopped")?;
    let initial = client(app, context).await?;
    if initial.offline_only {
        return Ok(());
    }
    let modern = tokio::time::timeout(std::time::Duration::from_secs(10), initial.get_identity())
        .await
        .ok()
        .and_then(Result::ok)
        .is_some_and(|identity| transport::modern(&identity.version));
    drop(permit);
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
        if background_refresh(app, context, status.epoch, kind, modern).await? {
            tokio::time::sleep(std::time::Duration::from_millis(125)).await;
            continue;
        }
        let hints = if next_kind % 3 == 0 {
            let scope = context.cache_scope.clone();
            app.state::<DbState>()
                .read(move |conn| freshness::hints(conn, &scope))
                .await?
        } else {
            vec![]
        };
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
        if hints.is_empty() && (task.phase == "complete" || task.retry_at > store::now()) {
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
                    let _ = current;
                    verified = Some((library, store::now()));
                }
                Err(_) => {
                    tokio::time::sleep(std::time::Duration::from_secs(15)).await;
                    continue;
                }
            }
        }
        if !hints.is_empty() {
            let observed = store::now();
            let ids: Vec<_> = hints
                .iter()
                .map(|hint| (hint.kind.clone(), hint.id))
                .collect();
            let response = tokio::time::timeout(
                std::time::Duration::from_secs(30),
                transport::details(&plex, verified.unwrap().0, &ids, modern),
            )
            .await;
            drop(network);
            match response {
                Ok(Ok(details)) => {
                    let scope = context.cache_scope.clone();
                    let retry = hints.clone();
                    let applied = write(app, context, move |conn, plex, context| {
                        freshness::apply_hints(
                            conn,
                            &scope,
                            status.epoch,
                            &hints,
                            &details.rows,
                            &details.missing,
                            observed,
                            || plex.cache_commit_guard(context),
                        )
                    })
                    .await;
                    if applied.is_ok() {
                        let _ = app.emit(
                            "matching-index-changed",
                            serde_json::json!({"scope":context.cache_scope}),
                        );
                    } else {
                        let _ = write(app, context, move |conn, _, context| {
                            freshness::defer(conn, &context.cache_scope, &retry)
                        })
                        .await;
                    }
                }
                _ => {
                    write(app, context, move |conn, _, context| {
                        freshness::defer(conn, &context.cache_scope, &hints)
                    })
                    .await
                    .ok();
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(125)).await;
            continue;
        }
        let outcome = if task.phase == "prune" {
            drop(network);
            let job = task.clone();
            write(app, context, move |conn, plex, context| {
                store::prune_fenced(conn, &context.cache_scope, &job, status.epoch, || {
                    freshness::complete_census(
                        conn,
                        &context.cache_scope,
                        &job.kind,
                        &job.generation,
                    )?;
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
                            || {
                                freshness::record_census(
                                    conn,
                                    &context.cache_scope,
                                    &job.kind,
                                    &job.generation,
                                    page.server_time,
                                )?;
                                plex.cache_commit_guard(context)
                            },
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
async fn background_refresh(
    app: &tauri::AppHandle,
    context: &PlexRequestContext,
    epoch: i64,
    kind: &str,
    modern: bool,
) -> Result<bool, String> {
    let scope = context.cache_scope.clone();
    let selected = kind.to_owned();
    let (check, delta) = app
        .state::<DbState>()
        .read(move |conn| {
            Ok((
                freshness::next_check(conn, &scope)?,
                freshness::delta_due(conn, &scope, &selected)?,
            ))
        })
        .await?;
    if check.is_none() && !delta {
        return Ok(false);
    }
    let permit = app
        .state::<IndexState>()
        .network
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| "Matching index stopped")?;
    let plex = client(app, context).await?;
    let current = snapshot(app, context).await?;
    if plex.offline_only
        || current.paused
        || current.epoch != epoch
        || app.state::<IndexState>().busy_until.load(Ordering::Relaxed) > store::now()
        || app
            .try_state::<crate::audio_engine::bridge::AudioEngineState>()
            .is_some_and(|engine| engine.0.is_buffering())
    {
        return Ok(true);
    }
    let (_, library) = match crate::catalogue_commands::verify_library(app, context).await {
        Ok(value) => value,
        Err(_) => {
            drop(permit);
            let _ = write(app, context, |conn, _, context| {
                freshness::defer_check(
                    conn,
                    &context.cache_scope,
                    "Plex library freshness is unavailable. Retained evidence remains available.",
                )
            })
            .await;
            return Ok(true);
        }
    };
    if let Some(check) = check {
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(20),
            transport::section_stamp(&plex, library),
        )
        .await;
        let capabilities = if check.probe {
            Some(
                tokio::time::timeout(
                    std::time::Duration::from_secs(8),
                    transport::capabilities(&plex, library, modern),
                )
                .await
                .ok()
                .and_then(Result::ok)
                .map(|meta| freshness::filters(&meta))
                .unwrap_or_default(),
            )
        } else {
            None
        };
        drop(permit);
        match result {
            Ok(Ok((stamp, scanning))) => {
                let _ = write(app, context, move |conn, plex, context| {
                    freshness::checked(
                        conn,
                        &context.cache_scope,
                        epoch,
                        &check,
                        stamp.as_deref(),
                        scanning,
                        capabilities.as_ref(),
                        || plex.cache_commit_guard(context),
                    )
                })
                .await;
            }
            _ => {
                let _ = write(app, context, |conn, _, context| {
                    freshness::defer_check(
                        conn,
                        &context.cache_scope,
                        "Plex freshness check failed. Retrying without removing retained metadata.",
                    )
                })
                .await;
            }
        }
        let _ = app.emit(
            "matching-index-changed",
            serde_json::json!({"scope":context.cache_scope}),
        );
        return Ok(true);
    }
    let kind = kind.to_owned();
    let window = write(app, context, move |conn, _, context| {
        freshness::delta(conn, &context.cache_scope, &kind, epoch)
    })
    .await?;
    let Some(window) = window else {
        return Ok(false);
    };
    let date = chrono::DateTime::from_timestamp(window.lower, 0)
        .ok_or("Invalid matching checkpoint")?
        .format("%Y-%m-%d")
        .to_string();
    let key = format!("{}{}", window.filter.field, window.filter.operator);
    let filters = [(key.as_str(), date), ("sort", window.filter.sort.clone())];
    let observed = store::now();
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        transport::listing(
            &plex,
            library,
            &window.kind,
            window.offset,
            modern,
            &filters,
        ),
    )
    .await;
    drop(permit);
    let lease = window.clone();
    let outcome = match result {
        Ok(Ok(page)) => {
            write(app, context, move |conn, plex, context| {
                freshness::publish_delta(
                    conn,
                    &context.cache_scope,
                    epoch,
                    &lease,
                    &page,
                    observed,
                    || plex.cache_commit_guard(context),
                )
            })
            .await
        }
        Ok(Err(error)) => Err(error),
        Err(_) => Err("Plex incremental matching request timed out".into()),
    };
    if let Err(error) = outcome {
        let reset = ["changed", "repeated", "timestamp"]
            .iter()
            .any(|word| error.contains(word));
        let _ = write(app, context, move |conn, _, context| {
            freshness::defer_delta(conn, &context.cache_scope, &window, reset, &error)
        })
        .await;
    } else {
        let _ = app.emit(
            "matching-index-changed",
            serde_json::json!({"scope":context.cache_scope}),
        );
    }
    Ok(true)
}
