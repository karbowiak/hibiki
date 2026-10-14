//! Resumable, bounded mirror of the selected Plex library.
use crate::{
    commands::{PlexRequestContext, PlexState},
    db::{catalogue_incremental as incremental, catalogue_sync as sync, DbState},
    plex::{catalogue::number, PlexClient},
};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, Weak},
};
use tauri::{Emitter, Manager, State};
const PAGE: i64 = 200;
async fn background_yield(app: &tauri::AppHandle, idle_ms: u64) {
    let active = app
        .state::<crate::audio_engine::bridge::AudioEngineState>()
        .0
        .background_indexing_delay();
    tokio::time::sleep(std::time::Duration::from_millis(if active {
        idle_ms.saturating_mul(4)
    } else {
        idle_ms
    }))
    .await;
}

pub struct CatalogueSync {
    worker: Arc<tokio::sync::Mutex<()>>,
    targeted: Arc<tokio::sync::Mutex<()>>,
    playlist_worker: Arc<tokio::sync::Mutex<()>>,
    projection_worker: Arc<tokio::sync::Mutex<()>>,
    projections_scheduled: Mutex<HashSet<(u64, String)>>,
    playlists_scheduled: Mutex<HashSet<(u64, String)>>,
    targeted_scheduled: Mutex<HashSet<(u64, String)>>,
    scheduled: Mutex<HashSet<(u64, String)>>,
    verified: Mutex<HashMap<(u64, String), (std::time::Instant, i64)>>,
    playlists: Mutex<HashMap<(String, i64), Weak<tokio::sync::Mutex<()>>>>,
}
impl CatalogueSync {
    pub fn new() -> Self {
        Self {
            worker: Arc::new(tokio::sync::Mutex::new(())),
            targeted: Arc::new(tokio::sync::Mutex::new(())),
            playlist_worker: Arc::new(tokio::sync::Mutex::new(())),
            projection_worker: Arc::new(tokio::sync::Mutex::new(())),
            projections_scheduled: Mutex::new(HashSet::new()),
            playlists_scheduled: Mutex::new(HashSet::new()),
            targeted_scheduled: Mutex::new(HashSet::new()),
            scheduled: Mutex::new(HashSet::new()),
            verified: Mutex::new(HashMap::new()),
            playlists: Mutex::new(HashMap::new()),
        }
    }
}

#[tauri::command]
pub async fn catalogue_start(
    context: PlexRequestContext,
    app: tauri::AppHandle,
    state: State<'_, PlexState>,
    manager: State<'_, CatalogueSync>,
) -> Result<(), String> {
    let guard = state.0.lock().await;
    state.checked_client(&context, &guard)?;
    drop(guard);
    schedule_targeted(&app, &context)?;
    schedule_playlists(&app, &context)?;
    schedule_projections(&app, &context)?;
    let key = (context.connection_revision, context.cache_scope.clone());
    if !manager
        .scheduled
        .lock()
        .map_err(|_| "Catalogue worker unavailable")?
        .insert(key.clone())
    {
        return Ok(());
    }
    let worker = manager.worker.clone();
    tauri::async_runtime::spawn(async move {
        let _worker = worker.lock().await;
        if let Err(error) = run(&app, &context).await {
            tracing::debug!(%error,"Plex catalogue sync stopped");
        }
        if let Ok(mut scheduled) = app.state::<CatalogueSync>().scheduled.lock() {
            scheduled.remove(&key);
        }
    });
    Ok(())
}
fn schedule_projections(
    app: &tauri::AppHandle,
    context: &PlexRequestContext,
) -> Result<(), String> {
    let manager = app.state::<CatalogueSync>();
    let key = (context.connection_revision, context.cache_scope.clone());
    if !manager
        .projections_scheduled
        .lock()
        .map_err(|_| "Browse index unavailable")?
        .insert(key.clone())
    {
        return Ok(());
    }
    let lane = manager.projection_worker.clone();
    let app = app.clone();
    let context = context.clone();
    tauri::async_runtime::spawn(async move {
        let _lane = lane.lock().await;
        let operation = async {
            let scope = context.cache_scope.clone();
            let needed = app
                .state::<DbState>()
                .read(move |conn| {
                    use rusqlite::OptionalExtension;
                    conn.query_row(
                        "SELECT complete=0 FROM plex_catalogue_browse_state WHERE scope=?1",
                        [scope],
                        |r| r.get::<_, bool>(0),
                    )
                    .optional()
                    .map(|needed| needed.unwrap_or(false))
                    .map_err(|_| "Cannot read browse index".into())
                })
                .await?;
            if !needed {
                return Ok::<(), String>(());
            }
            loop {
                let owner = app.clone();
                let captured = context.clone();
                let done = app
                    .state::<DbState>()
                    .write(move |conn| {
                        let state = owner.state::<PlexState>();
                        let Ok(guard) = state.0.try_lock() else {
                            return Ok(false);
                        };
                        state.checked_cache_client(&captured, &guard)?;
                        crate::db::catalogue_query::backfill_projections(
                            conn,
                            &captured.cache_scope,
                            64,
                        )
                    })
                    .await?;
                if done {
                    let owner = app.clone();
                    let captured = context.clone();
                    let revision = app
                        .state::<DbState>()
                        .write(move |conn| {
                            let state = owner.state::<PlexState>();
                            if !state.is_current(captured.connection_revision) {
                                return Err("Browse index owner retired".into());
                            }
                            incremental::bump(conn, &captured.cache_scope)
                        })
                        .await?;
                    updated(&app, &context, revision, vec![]);
                    return Ok(());
                }
                background_yield(&app, 40).await;
            }
        }
        .await;
        if let Err(error) = operation {
            tracing::debug!(%error,"Browse index paused");
        }
        if let Ok(mut scheduled) = app.state::<CatalogueSync>().projections_scheduled.lock() {
            scheduled.remove(&key);
        }
    });
    Ok(())
}
fn schedule_playlists(app: &tauri::AppHandle, context: &PlexRequestContext) -> Result<(), String> {
    let manager = app.state::<CatalogueSync>();
    let key = (context.connection_revision, context.cache_scope.clone());
    if !manager
        .playlists_scheduled
        .lock()
        .map_err(|_| "Playlist worker unavailable")?
        .insert(key.clone())
    {
        return Ok(());
    }
    let lane = manager.playlist_worker.clone();
    let app = app.clone();
    let context = context.clone();
    tauri::async_runtime::spawn(async move {
        let _lane = lane.lock().await;
        if let Err(error) = playlists(&app, &context).await {
            tracing::debug!(%error, "Plex playlist catalogue paused");
        }
        if let Ok(mut scheduled) = app.state::<CatalogueSync>().playlists_scheduled.lock() {
            scheduled.remove(&key);
        }
    });
    Ok(())
}
#[tauri::command]
pub async fn catalogue_notify(
    context: PlexRequestContext,
    changes: Vec<incremental::Hint>,
    catch_up: bool,
    app: tauri::AppHandle,
    state: State<'_, PlexState>,
) -> Result<(), String> {
    let guard = state.0.lock().await;
    state.checked_client(&context, &guard)?;
    drop(guard);
    save_checked(&app, &context, |conn| {
        incremental::admit(conn, &context.cache_scope, &changes, catch_up)
    })
    .await?;
    schedule_targeted(&app, &context)
}
fn schedule_targeted(app: &tauri::AppHandle, context: &PlexRequestContext) -> Result<(), String> {
    let manager = app.state::<CatalogueSync>();
    let key = (context.connection_revision, context.cache_scope.clone());
    if !manager
        .targeted_scheduled
        .lock()
        .map_err(|_| "Incremental catalogue unavailable")?
        .insert(key.clone())
    {
        return Ok(());
    }
    let lane = manager.targeted.clone();
    let app = app.clone();
    let context = context.clone();
    tauri::async_runtime::spawn(async move {
        let _lane = lane.lock().await;
        let completed = match run_targeted(&app, &context).await {
            Ok(()) => true,
            Err(error) => {
                tracing::debug!(%error,"Plex incremental catalogue paused");
                let _ = save_checked(&app, &context, |conn| {
                    incremental::phase(conn, &context.cache_scope, "idle")
                })
                .await;
                false
            }
        };
        if let Ok(mut scheduled) = app.state::<CatalogueSync>().targeted_scheduled.lock() {
            scheduled.remove(&key);
        }
        // Admitters may race the final empty read. A bounded ready recheck after
        // removing ownership prevents losing that wake-up; deferred failures
        // resume on the regular ensure/start heartbeat.
        if completed {
            if let Ok(true) = save_checked(&app, &context, |conn| {
                Ok(incremental::next(conn, &context.cache_scope)?.is_some()
                    || incremental::catchup_needed(conn, &context.cache_scope)?)
            })
            .await
            {
                let _ = schedule_targeted(&app, &context);
            }
        }
    });
    Ok(())
}
fn updated(
    app: &tauri::AppHandle,
    context: &PlexRequestContext,
    revision: i64,
    items: Vec<serde_json::Value>,
) {
    let _=app.emit("catalogue_updated",serde_json::json!({"cacheScope":context.cache_scope,"connectionRevision":context.connection_revision,"changesRevision":revision,"items":items}));
}
async fn targeted_item(
    app: &tauri::AppHandle,
    context: &PlexRequestContext,
    change: &incremental::Change,
) -> Result<(), String> {
    let (client, section) = verify_library(app, context).await?;
    let raw = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        client.catalogue_lookup(change.id, change.kind == "playlist"),
    )
    .await
    .map_err(|_| "Plex changed metadata timed out")?
    .map_err(|_| "Plex changed metadata unavailable")?;
    if let Some(raw) = &raw {
        if raw["type"].as_str() != Some(change.kind.as_str())
            || change.kind == "playlist" && raw["playlistType"].as_str() != Some("audio")
        {
            return save_checked(app, context, |conn| {
                incremental::discard(conn, &context.cache_scope, change)
            })
            .await;
        }
        if change.kind != "playlist" {
            let mut filters = roster_filters(&change.kind);
            filters.push(("id", change.id.to_string()));
            let owned = tokio::time::timeout(
                std::time::Duration::from_secs(20),
                client.catalogue_page(&roster_path(&change.kind, section), 0, 1, &filters),
            )
            .await
            .map_err(|_| "Plex changed library membership timed out")?
            .map_err(|_| "Plex changed library membership unavailable")?;
            if owned.items.len() != 1
                || number(&owned.items[0]["ratingKey"]) != Some(change.id)
                || number(&raw["librarySectionID"]).is_some_and(|id| id != section)
            {
                return save_checked(app, context, |conn| {
                    incremental::discard(conn, &context.cache_scope, change)
                })
                .await;
            }
        }
    } else {
        // Processing notifications can end at state 1 for local/no-agent
        // libraries. A not-yet-created record retries rather than disappearing
        // before its final metadata becomes queryable.
        if matches!(change.state, 0 | 1) {
            return Err("Plex changed item is still processing".into());
        }
        // A 404 is accepted only after a fresh native selected-library check.
        fresh_library(app, context).await?;
    }
    if raw.is_some() && change.kind == "playlist" {
        sync_playlist(app, context, change.id, Some(change)).await?;
    }
    let revision = save_checked(app, context, |conn| {
        let before =
            crate::db::catalogue::get(conn, &context.cache_scope, &change.kind, change.id)?;
        let revision =
            incremental::apply_with(conn, &context.cache_scope, change, raw.as_ref(), |tx| {
                if change.kind == "track" {
                    if let Some(raw) = &raw {
                        discover_media(tx, &client, change.id, raw, before.as_ref())?;
                    }
                }
                Ok(false)
            })?;
        Ok(revision)
    })
    .await?;
    if let Some(revision) = revision {
        updated(
            app,
            context,
            revision,
            vec![serde_json::json!({"kind":change.kind,"id":change.id})],
        );
    }
    Ok(())
}
async fn drain_changes(
    app: &tauri::AppHandle,
    context: &PlexRequestContext,
    limit: usize,
) -> Result<(), String> {
    for _ in 0..limit {
        let next = save_checked(app, context, |conn| {
            incremental::next(conn, &context.cache_scope)
        })
        .await?;
        let Some(change) = next else { return Ok(()) };
        if let Err(error) = targeted_item(app, context, &change).await {
            save_checked(app, context, |conn| {
                incremental::defer(conn, &context.cache_scope, &change)
            })
            .await?;
            // A single importing/temporarily unavailable item must not block
            // later admitted IDs. Retired/offline contexts still stop the lane.
            self::client(app, context).await?;
            tracing::debug!(%error,"Plex catalogue change deferred");
        }
        background_yield(app, 100).await;
    }
    Ok(())
}
async fn run_targeted(app: &tauri::AppHandle, context: &PlexRequestContext) -> Result<(), String> {
    verify_library(app, context).await?;
    save_checked(app, context, |conn| {
        incremental::phase(conn, &context.cache_scope, "updating")
    })
    .await?;
    loop {
        drain_changes(app, context, 10).await?;
        if save_checked(app, context, |conn| {
            incremental::catchup_needed(conn, &context.cache_scope)
        })
        .await?
        {
            catchup(app, context).await?;
        } else if save_checked(app, context, |conn| {
            incremental::next(conn, &context.cache_scope)
        })
        .await?
        .is_none()
        {
            save_checked(app, context, |conn| {
                incremental::phase(conn, &context.cache_scope, "idle")
            })
            .await?;
            return Ok(());
        }
    }
}
async fn catchup(app: &tauri::AppHandle, context: &PlexRequestContext) -> Result<(), String> {
    let (client, section) = fresh_library(app, context).await?;
    let page = client
        .catalogue_page(
            &roster_path("artist", section),
            0,
            1,
            &roster_filters("artist"),
        )
        .await
        .map_err(|_| "Plex catch-up clock unavailable")?;
    let server_time = page
        .server_time
        .ok_or("Plex catch-up response omitted server time")?;
    let (low, high, version) = save_checked(app, context, |conn| {
        incremental::catchup_begin(conn, &context.cache_scope, server_time)
    })
    .await?;
    for kind in ["artist", "album", "track", "playlist"] {
        let name = format!("catchup:{kind}");
        let mut task = finite_task(app, context, kind, &name, Some(low), Some(high)).await?;
        while task.status != "complete" {
            let changed = match finite_page(app, context, kind, &task).await {
                Ok(changed) => changed,
                Err(error) if error == "Catalogue change queue is full" => {
                    drain_changes(app, context, 200).await?;
                    background_yield(app, 1000).await;
                    continue;
                }
                Err(error) => return Err(error),
            };
            if !changed.is_empty() {
                let revision = save_checked(app, context, |conn| {
                    Ok(incremental::progress(conn, &context.cache_scope)?.changes_revision)
                })
                .await?;
                updated(
                    app,
                    context,
                    revision,
                    changed
                        .into_iter()
                        .map(|id| serde_json::json!({"kind":kind,"id":id}))
                        .collect(),
                );
            }
            // Live hints have bounded latency even during large reconnect gaps.
            drain_changes(app, context, 2).await?;
            task = save_checked(app, context, |conn| {
                sync::task(conn, &context.cache_scope, &name)?
                    .ok_or("Missing catalogue catch-up task".into())
            })
            .await?;
            background_yield(app, 150).await;
        }
    }
    fresh_library(app, context).await?;
    save_checked(app, context, |conn| {
        incremental::catchup_finish(conn, &context.cache_scope, high, version)
    })
    .await?;
    Ok(())
}
async fn client(
    app: &tauri::AppHandle,
    context: &PlexRequestContext,
) -> Result<PlexClient, String> {
    let state = app.state::<PlexState>();
    let guard = state.0.lock().await;
    Ok(state.checked_client(context, &guard)?.clone())
}
async fn verify_library(
    app: &tauri::AppHandle,
    context: &PlexRequestContext,
) -> Result<(PlexClient, i64), String> {
    let client = client(app, context).await?;
    let section = crate::offline_audio::library_id(app, &client)?;
    let key = (context.connection_revision, context.cache_scope.clone());
    let manager = app.state::<CatalogueSync>();
    if manager
        .verified
        .lock()
        .map_err(|_| "Catalogue unavailable")?
        .get(&key)
        .is_some_and(|(time, id)| {
            *id == section && time.elapsed() < std::time::Duration::from_secs(20)
        })
    {
        return Ok((client, section));
    }
    let sections = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        client.get_all_sections(),
    )
    .await
    .map_err(|_| "Plex library request timed out")?
    .map_err(|_| "Plex library is unavailable")?;
    let selected = sections
        .iter()
        .find(|s| s.key == section && s.section_type == "artist")
        .ok_or("The selected Plex music library is unavailable")?;
    if client.cache_scope_for_library(section, selected.uuid.as_deref()) != context.cache_scope {
        return Err("Plex music library identity changed. Reconnect before syncing.".into());
    }
    // A reconnect while the roster was loading cannot publish the old owner.
    self::client(app, context).await?;
    let mut verified = manager
        .verified
        .lock()
        .map_err(|_| "Catalogue unavailable")?;
    // Bound retained identities after repeated account/library switches.
    if verified.len() > 16 {
        verified.clear();
    }
    verified.insert(key, (std::time::Instant::now(), section));
    Ok((client, section))
}
pub(crate) async fn fresh_library(
    app: &tauri::AppHandle,
    context: &PlexRequestContext,
) -> Result<(PlexClient, i64), String> {
    app.state::<CatalogueSync>()
        .verified
        .lock()
        .map_err(|_| "Catalogue unavailable")?
        .remove(&(context.connection_revision, context.cache_scope.clone()));
    verify_library(app, context).await
}
pub(crate) async fn save_checked<T>(
    app: &tauri::AppHandle,
    context: &PlexRequestContext,
    f: impl FnOnce(&rusqlite::Connection) -> Result<T, String>,
) -> Result<T, String> {
    let mut timing = crate::performance::Timer::new("catalogue_write");
    let state = app.state::<PlexState>();
    let db = app.state::<DbState>();
    loop {
        let guard = state.0.lock().await;
        let client = state.checked_client(context, &guard)?;
        if client.library_scope != context.cache_scope {
            return Err("Catalogue request was superseded".into());
        }
        match db.0.try_lock() {
            Ok(conn) => {
                timing.phase("admission_wait");
                let result = f(&conn);
                timing.phase("sql");
                return result;
            },
            Err(std::sync::TryLockError::Poisoned(_)) => {
                return Err("Catalogue storage unavailable".into())
            }
            Err(std::sync::TryLockError::WouldBlock) => {}
        }
        // Never monopolize native audio admission while waiting for SQLite.
        drop(guard);
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
}
async fn start_task(
    app: &tauri::AppHandle,
    context: &PlexRequestContext,
    name: &str,
    generation: Option<&str>,
) -> Result<sync::Task, String> {
    save_checked(app, context, |conn| {
        sync::begin(conn, &context.cache_scope, name, generation)
    })
    .await
}
async fn pause_task(
    app: &tauri::AppHandle,
    context: &PlexRequestContext,
    task: &sync::Task,
    error: &str,
) {
    // Progress belongs to the captured scope even when its connection retired.
    if let Ok(conn) = app.state::<DbState>().0.lock() {
        let _ = sync::stop(&conn, &context.cache_scope, task, Some(error));
    }
}
fn roster_filters(kind: &str) -> Vec<(&'static str, String)> {
    if kind == "playlist" {
        vec![("playlistType", "audio".into())]
    } else {
        vec![
            (
                "type",
                match kind {
                    "artist" => "8",
                    "album" => "9",
                    _ => "10",
                }
                .into(),
            ),
            ("includeGuids", "1".into()),
            ("resolveTags", "1".into()),
            ("includeLyrics", "1".into()),
        ]
    }
}
fn roster_path(kind: &str, section: i64) -> String {
    if kind == "playlist" {
        "/playlists".into()
    } else {
        format!("/library/sections/{section}/all")
    }
}
async fn finite_task(
    app: &tauri::AppHandle,
    context: &PlexRequestContext,
    kind: &str,
    name: &str,
    low: Option<i64>,
    high: Option<i64>,
) -> Result<sync::Task, String> {
    if let Some(t) = save_checked(app, context, |conn| {
        sync::task(conn, &context.cache_scope, name)
    })
    .await?
    {
        if t.scan_mode == "keyset" && t.status != "complete"
            || name.starts_with("catchup:") && t.status == "complete"
        {
            return Ok(t);
        }
    }
    let (client, section) = verify_library(app, context).await?;
    let mut filters = roster_filters(kind);
    filters.push(("sort", "id:desc".into()));
    let page = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        client.catalogue_page(&roster_path(kind, section), 0, 1, &filters),
    )
    .await
    .map_err(|_| "Plex census bounds timed out")?
    .map_err(|_| "Plex census bounds unavailable")?;
    let upper = page
        .items
        .first()
        .and_then(|v| number(&v["ratingKey"]))
        .unwrap_or(0);
    save_checked(app, context, |conn| {
        incremental::begin_keyset(
            conn,
            &context.cache_scope,
            name,
            upper,
            page.total,
            low,
            high,
        )
    })
    .await
}
async fn finite_page(
    app: &tauri::AppHandle,
    context: &PlexRequestContext,
    kind: &str,
    task: &sync::Task,
) -> Result<Vec<i64>, String> {
    let (client, section) = verify_library(app, context).await?;
    let mut filters = roster_filters(kind);
    filters.extend([
        ("sort", "id:asc".into()),
        ("id>>", task.key_cursor.to_string()),
        (
            "id<",
            task.upper_id
                .ok_or("Missing catalogue upper bound")?
                .to_string(),
        ),
    ]);
    if let (Some(low), Some(high)) = (task.lower_time, task.upper_time) {
        filters.extend([
            ("updatedAt>", low.to_string()),
            ("updatedAt<", high.to_string()),
        ]);
    }
    let requested_at = crate::db::catalogue::now();
    let page = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        client.catalogue_page(&roster_path(kind, section), 0, PAGE, &filters),
    )
    .await
    .map_err(|_| "Plex catalogue request timed out")?
    .map_err(|e| format!("Plex catalogue page is unavailable or invalid: {e}"))?;
    if page.items.is_empty() {
        fresh_library(app, context).await?;
    }
    save_checked(app, context, |conn| {
        incremental::keyset_page_at(
            conn,
            &context.cache_scope,
            task,
            kind,
            &page.items,
            page.total,
            Some(requested_at),
        )
    })
    .await
}
async fn roster(
    app: &tauri::AppHandle,
    context: &PlexRequestContext,
    kind: &str,
) -> Result<sync::Task, String> {
    let previous = start_task(app, context, kind, None).await?;
    if previous.status == "complete" {
        return Ok(previous);
    }
    let mut task = finite_task(app, context, kind, kind, None, None).await?;
    while task.status != "complete" {
        if let Err(error) = finite_page(app, context, kind, &task).await {
            pause_task(app, context, &task, &error).await;
            return Err(error);
        }
        task = save_checked(app, context, |conn| {
            sync::task(conn, &context.cache_scope, kind)?.ok_or("Missing catalogue census".into())
        })
        .await?;
        background_yield(app, 200).await;
    }
    save_checked(app, context, |conn| {
        incremental::reconciliation_candidates(conn, &context.cache_scope, &task, kind)
    })
    .await?;
    schedule_targeted(app, context)?;
    Ok(task)
}
async fn details(
    app: &tauri::AppHandle,
    context: &PlexRequestContext,
    kind: &str,
    generation: &str,
) -> Result<(), String> {
    let name = format!("details:{kind}");
    let mut task = start_task(app, context, &name, Some(generation)).await?;
    if task.status == "complete" {
        return Ok(());
    }
    loop {
        let operation = async {
            let ids = save_checked(app, context, |conn| {
                incremental::detail_jobs(conn, &context.cache_scope, kind, task.cursor)
            })
            .await?;
            let jobs = ids;
            let ids: Vec<i64> = jobs.iter().map(|job| job.id).collect();
            let (client, section) = verify_library(app, context).await?;
            let items = if ids.is_empty() {
                Vec::new()
            } else {
                tokio::time::timeout(
                    std::time::Duration::from_secs(30),
                    client.catalogue_details(&ids),
                )
                .await
                .map_err(|_| "Plex detail request timed out")?
                .map_err(|_| "Plex detail batch is unavailable or invalid")?
            };
            for item in &items {
                if number(&item["librarySectionID"]).is_some_and(|id| id != section) {
                    return Err("Plex returned details from another music library".into());
                }
            }
            save_checked(app, context, |conn| {
                let tx = conn
                    .unchecked_transaction()
                    .map_err(|_| "Cannot save changed detail page")?;
                for job in &jobs {
                    if let Some(item) = items
                        .iter()
                        .find(|v| number(&v["ratingKey"]) == Some(job.id))
                    {
                        if incremental::publish_detail(&tx, &context.cache_scope, kind, job, item)?
                            && kind == "track"
                        {
                            discover_media(&tx, &client, job.id, item, None)?;
                        }
                    } else {
                        incremental::enqueue(&tx, &context.cache_scope, kind, job.id, 9)?;
                    }
                }
                sync::checkpoint(
                    &tx,
                    &context.cache_scope,
                    &task,
                    ids.last().copied().unwrap_or(task.cursor),
                    None,
                    ids.is_empty(),
                )?;
                tx.commit()
                    .map_err(|_| "Cannot commit changed detail page".into())
            })
            .await?;
            start_task(app, context, &name, Some(generation)).await
        }
        .await;
        match operation {
            Ok(next) => task = next,
            Err(error) => {
                pause_task(app, context, &task, &error).await;
                return Err(error);
            }
        }
        if task.status == "complete" {
            return Ok(());
        }
        background_yield(app, 150).await;
    }
}
async fn playlist_document(client: &PlexClient, id: i64) -> Result<serde_json::Value, String> {
    let raw: serde_json::Value = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        client.get(&format!("/playlists/{id}")),
    )
    .await
    .map_err(|_| "Plex playlist metadata timed out")?
    .map_err(|_| "Plex playlist metadata is unavailable")?;
    let item = raw["Metadata"]
        .as_array()
        .and_then(|a| a.first())
        .ok_or("Plex playlist metadata is missing")?;
    if number(&item["ratingKey"]) != Some(id) || item["type"].as_str() != Some("playlist") {
        return Err("Plex returned a different playlist".into());
    }
    Ok(item.clone())
}
pub(crate) fn playlist_revision(item: &serde_json::Value) -> String {
    use sha2::{Digest, Sha256};
    format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&serde_json::json!([
                item["leafCount"],
                item["duration"],
                item["smart"],
                item["content"]
            ]))
            .unwrap_or_default()
        )
    )
}
// Plex regenerates composite artwork (and updatedAt) when reading a playlist.
// This structural revision is a resume hint, not a membership proof: both
// catalogue and download capture must verify ordered track/occurrence entries.
fn playlist_lock(
    app: &tauri::AppHandle,
    scope: &str,
    id: i64,
) -> Result<Arc<tokio::sync::Mutex<()>>, String> {
    let manager = app.state::<CatalogueSync>();
    let mut locks = manager
        .playlists
        .lock()
        .map_err(|_| "Playlist catalogue unavailable")?;
    locks.retain(|_, lock| lock.strong_count() > 0);
    let key = (scope.to_owned(), id);
    if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
        return Ok(lock);
    }
    let lock = Arc::new(tokio::sync::Mutex::new(()));
    locks.insert(key, Arc::downgrade(&lock));
    Ok(lock)
}
fn begin_playlist(
    conn: &rusqlite::Connection,
    scope: &str,
    id: i64,
    revision: &str,
    refresh: bool,
) -> Result<sync::Task, String> {
    let name = format!("playlist:{id}");
    let prefix = format!("members-v2:{revision}:");
    if let Some(task) = sync::task(conn, scope, &name)? {
        let invalid = task.status == "error"
            && task.error.as_deref().is_some_and(|e| {
                e.contains("changed") || e.contains("repeated") || e.contains("Incomplete")
            });
        if task.generation.starts_with(&prefix)
            && !invalid
            && (task.status != "complete" || !refresh)
        {
            return Ok(task);
        }
    }
    // A distinct owner also fences late checkpoints from a failed attempt
    // whose header revision happens to be identical.
    sync::begin(
        conn,
        scope,
        &name,
        Some(&format!("{prefix}{}", uuid::Uuid::new_v4())),
    )
}
async fn verify_playlist_staging(
    app: &tauri::AppHandle,
    context: &PlexRequestContext,
    client: &PlexClient,
    id: i64,
    task: &sync::Task,
) -> Result<(), String> {
    let mut offset = 0;
    loop {
        let expected = save_checked(app, context, |conn| {
            sync::playlist_staging_page(conn, &context.cache_scope, id, task, offset, PAGE)
        })
        .await?;
        let page = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            client.catalogue_page(&format!("/playlists/{id}/items"), offset, PAGE, &[]),
        )
        .await
        .map_err(|_| "Playlist verification timed out")?
        .map_err(|_| "Playlist verification is unavailable")?;
        if page.total.is_some_and(|n| n != task.cursor)
            || !crate::plex::catalogue::playlist_membership_matches(&expected, &page.items)
                .map_err(|_| "Invalid playlist verification")?
        {
            return Err("Playlist changed during catalogue sync".into());
        }
        offset += page.items.len() as i64;
        if offset == task.cursor {
            return Ok(());
        }
        if page.items.is_empty() || offset > task.cursor {
            return Err("Incomplete playlist catalogue".into());
        }
        background_yield(app, 150).await;
    }
}
pub(crate) async fn verify_playlist_documents(
    client: &PlexClient,
    id: i64,
    documents: &[serde_json::Value],
) -> Result<(), String> {
    let mut offset = 0;
    loop {
        let end = (offset + PAGE as usize).min(documents.len());
        let page = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            client.catalogue_page(&format!("/playlists/{id}/items"), offset as i64, PAGE, &[]),
        )
        .await
        .map_err(|_| "Playlist verification timed out")?
        .map_err(|_| "Playlist verification is unavailable")?;
        if page.total.is_some_and(|n| n != documents.len() as i64)
            || !crate::plex::catalogue::playlist_membership_matches(
                &documents[offset..end],
                &page.items,
            )
            .map_err(|_| "Invalid playlist verification")?
        {
            return Err("This playlist changed while preparing its download. Try again.".into());
        }
        if end == documents.len() {
            return Ok(());
        }
        offset = end;
    }
}
async fn playlists(app: &tauri::AppHandle, context: &PlexRequestContext) -> Result<(), String> {
    let mut cursor = 0;
    loop {
        let ids = save_checked(app, context, |conn| {
            sync::pending_details(conn, &context.cache_scope, "playlist", cursor)
        })
        .await?;
        if ids.is_empty() {
            return Ok(());
        }
        for id in ids {
            cursor = id;
            if let Err(error) = sync_playlist(app, context, id, None).await {
                // Keep the last published snapshot and move on. The durable
                // change lane retries this playlist independently of full
                // metadata and waveform work. Offline/retired owners stop.
                fresh_library(app, context).await?;
                save_checked(app, context, |conn| {
                    incremental::retry_playlist(conn, &context.cache_scope, id)
                })
                .await?;
                tracing::debug!(%error, "Playlist catalogue deferred; other indexing continues");
                schedule_targeted(app, context)?;
            }
        }
    }
}
async fn sync_playlist(
    app: &tauri::AppHandle,
    context: &PlexRequestContext,
    id: i64,
    admission: Option<&incremental::Change>,
) -> Result<(), String> {
    let lane = playlist_lock(app, &context.cache_scope, id)?;
    let _lane = if admission.is_some() {
        // A huge playlist already being scanned must not hold up unrelated
        // live artist/album/track changes in the incremental lane.
        lane.try_lock()
            .map_err(|_| "Playlist scan already running")?
    } else {
        lane.lock().await
    };
    let (client, _) = verify_library(app, context).await?;
    let before = playlist_document(&client, id).await?;
    let revision = playlist_revision(&before);
    save_checked(app, context, |conn| {
        if let Some(change) = admission {
            if !incremental::current(conn, &context.cache_scope, change)? {
                return Err("Catalogue change was superseded".into());
            }
        }
        crate::db::catalogue::save(conn, &context.cache_scope, "playlist", id, &before, true)
    })
    .await?;
    let mut task = save_checked(app, context, |conn| {
        begin_playlist(
            conn,
            &context.cache_scope,
            id,
            &revision,
            admission.is_some(),
        )
    })
    .await?;
    while task.status != "complete" {
        let operation = async {
            let (client, _) = verify_library(app, context).await?;
            let page = tokio::time::timeout(
                std::time::Duration::from_secs(30),
                client.catalogue_page(&format!("/playlists/{id}/items"), task.cursor, PAGE, &[]),
            )
            .await
            .map_err(|_| "Plex playlist request timed out")?
            .map_err(|e| format!("Plex playlist page is unavailable or invalid: {e}"))?;
            let total = page.total.or(task.total);
            let complete = page.items.is_empty()
                || total.is_some_and(|total| task.cursor + page.items.len() as i64 == total);
            save_checked(app, context, |conn| {
                sync::playlist_page_checked(
                    conn,
                    &context.cache_scope,
                    id,
                    &task,
                    &page.items,
                    total,
                    false,
                    admission,
                )
            })
            .await?;
            task = save_checked(app, context, |conn| {
                sync::task(conn, &context.cache_scope, &format!("playlist:{id}"))?
                    .ok_or("Missing playlist task".into())
            })
            .await?;
            if !complete {
                return Ok(task.clone());
            }
            // Publishing happens only after a second, bounded ordered pass.
            // Equal-count substitutions/reorders and duplicate occurrences
            // remain protected even when Plex's artwork timestamp changes.
            verify_playlist_staging(app, context, &client, id, &task).await?;
            fresh_library(app, context).await?;
            let after = playlist_document(&client, id).await?;
            if playlist_revision(&after) != revision {
                return Err("Playlist changed during catalogue sync".into());
            }
            let revision = save_checked(app, context, |conn| {
                sync::playlist_finish_checked(
                    conn,
                    &context.cache_scope,
                    id,
                    &task,
                    admission,
                    &after,
                )
            })
            .await?;
            if let Some(revision) = revision {
                updated(
                    app,
                    context,
                    revision,
                    vec![serde_json::json!({"kind":"playlist","id":id})],
                );
            }
            save_checked(app, context, |conn| {
                sync::task(conn, &context.cache_scope, &format!("playlist:{id}"))?
                    .ok_or("Missing playlist task".into())
            })
            .await
        }
        .await;
        match operation {
            Ok(next) => task = next,
            Err(error) => {
                pause_task(app, context, &task, &error).await;
                return Err(error);
            }
        }
        background_yield(app, 150).await;
    }
    Ok(())
}

async fn run(app: &tauri::AppHandle, context: &PlexRequestContext) -> Result<(), String> {
    verify_library(app, context).await?;
    // List all entities first so browsing/search can benefit before detail work.
    let artists = roster(app, context, "artist").await?;
    let albums = roster(app, context, "album").await?;
    let tracks = roster(app, context, "track").await?;
    roster(app, context, "playlist").await?;
    schedule_playlists(app, context)?;
    details(app, context, "artist", &artists.generation).await?;
    details(app, context, "album", &albums.generation).await?;
    details(app, context, "track", &tracks.generation).await?;
    schedule_targeted(app, context)?;
    analysis(app, context).await?;
    Ok(())
}

#[tauri::command]
pub async fn catalogue_query(
    context: PlexRequestContext,
    method: String,
    args: Vec<serde_json::Value>,
    state: State<'_, PlexState>,
    db: State<'_, DbState>,
    downloads: State<'_, crate::offline_audio::AudioDownloads>,
    engine: State<'_, crate::audio_engine::bridge::AudioEngineState>,
    app: tauri::AppHandle,
) -> Result<Option<crate::db::catalogue_query::Page>, String> {
    let mut timing = crate::performance::Timer::new(&method);
    let offline = {
        let guard = state.0.lock().await;
        state.checked_cache_client(&context, &guard)?.offline_only
    };
    timing.phase("owner_wait");
    // Derived browse indexes can also finish from local data while offline.
    schedule_projections(&app, &context)?;
    let scope = context.cache_scope.clone();
    let downloaded = downloads.cache.clone();
    let automatic = engine.0.cache().clone();
    let urgent = matches!(
        method.as_str(),
        "getTrack" | "getAlbum" | "getArtist" | "getPlaylistItems"
    );
    let work = move |conn: &rusqlite::Connection| {
        let mut sql_timing = crate::performance::Timer::new(&method);
        if method == "getArtistTracks" && offline {
            let artist = args
                .first()
                .and_then(serde_json::Value::as_str)
                .and_then(|s| s.parse::<i64>().ok())
                .filter(|id| *id > 0)
                .ok_or("Invalid offline artist ID")?;
            return offline_artist_tracks(conn, &scope, artist, |key| {
                downloaded.lookup(key).is_some() || automatic.lookup(key).is_some()
            })
            .map(Some);
        }
        let result = crate::db::catalogue_query::query(conn, &scope, &method, &args);
        sql_timing.phase("sql");
        result
    };
    let result = if urgent {
        db.read_urgent(work).await?
    } else {
        db.read(work).await?
    };
    timing.phase("database_read");
    let guard = state.0.lock().await;
    state.checked_cache_client(&context, &guard)?;
    timing.phase("owner_recheck");
    Ok(result)
}
fn offline_artist_tracks(
    conn: &rusqlite::Connection,
    scope: &str,
    artist: i64,
    present: impl Fn(&str) -> bool,
) -> Result<crate::db::catalogue_query::Page, String> {
    let mut stmt=conn.prepare("SELECT track_id,cache_key FROM local_audio WHERE scope=?1 AND json_extract(metadata,'$.artistId')=?2 ORDER BY track_id").map_err(|_|"Cannot read offline artist tracks")?;
    let rows = stmt
        .query_map(rusqlite::params![scope, artist.to_string()], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|_| "Cannot read offline artist tracks")?;
    let mut seen = HashSet::new();
    let mut items = Vec::new();
    let mut bytes = 0;
    for row in rows {
        let (id, key) = row.map_err(|_| "Cannot read offline artist track")?;
        if seen.contains(&id) || !present(&key) {
            continue;
        }
        if let Some(raw) = crate::db::catalogue::get(conn, scope, "track", id)? {
            let item = crate::db::catalogue_query::project("track", raw)?;
            bytes += serde_json::to_vec(&item)
                .map_err(|_| "Invalid offline track projection")?
                .len();
            if bytes > 32 * 1024 * 1024 {
                return Err("This offline artist exceeds the response limit. Play individual downloaded albums.".into());
            }
            seen.insert(id);
            items.push(item);
        }
    }
    Ok(crate::db::catalogue_query::Page {
        total: items.len() as i64,
        items,
        cached_at: crate::db::catalogue::now(),
        complete: true,
        server_total: None,
    })
}
#[tauri::command]
pub async fn catalogue_progress(
    context: PlexRequestContext,
    state: State<'_, PlexState>,
    db: State<'_, DbState>,
) -> Result<serde_json::Value, String> {
    {
        let guard = state.0.lock().await;
        state.checked_cache_client(&context, &guard)?;
    }
    let read_context = context.clone();
    let result = db.read(move |conn| {
    let context = read_context;
    let mut stmt = conn
        .prepare("SELECT task FROM plex_catalogue_tasks WHERE scope=?1 ORDER BY task")
        .map_err(|_| "Cannot read catalogue progress")?;
    let names = stmt
        .query_map([&context.cache_scope], |r| r.get::<_, String>(0))
        .map_err(|_| "Cannot read catalogue progress")?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Cannot read catalogue progress")?;
    let tasks = names
        .iter()
        .map(|name| sync::task(&conn, &context.cache_scope, name))
        .collect::<Result<Vec<_>, _>>()?;
    let count = |sql: &str| {
        conn.query_row::<i64, _, _>(sql, [&context.cache_scope], |r| r.get(0))
            .map_err(|_| "Cannot read catalogue counts")
    };
    Ok(
        serde_json::json!({"tasks":tasks,"incremental":incremental::progress(&conn,&context.cache_scope)?,"entities":count("SELECT COUNT(*) FROM plex_catalogue WHERE scope=?1 AND removed=0")?,"details":count("SELECT COUNT(*) FROM plex_catalogue WHERE scope=?1 AND removed=0 AND detail=1")?,"waveforms":count("SELECT COUNT(*) FROM plex_catalogue_media WHERE scope=?1 AND active=1 AND status='saved'")?,"analysisPending":count("SELECT COUNT(*) FROM plex_catalogue_media WHERE scope=?1 AND active=1 AND status='pending'")?,"analysisUnavailable":count("SELECT COUNT(*) FROM plex_catalogue_media WHERE scope=?1 AND active=1 AND status='unavailable'")?}),
    )
    }).await?;
    let guard = state.0.lock().await;
    state.checked_cache_client(&context, &guard)?;
    Ok(result)
}
#[tauri::command]
pub async fn catalogue_retry(
    context: PlexRequestContext,
    reset: bool,
    app: tauri::AppHandle,
    state: State<'_, PlexState>,
    manager: State<'_, CatalogueSync>,
) -> Result<(), String> {
    let guard = state.0.lock().await;
    state.checked_client(&context, &guard)?;
    drop(guard);
    if !reset {
        save_checked(&app, &context, |conn| {
            let mut stmt = conn.prepare("SELECT CAST(substr(task,10) AS INTEGER) FROM plex_catalogue_tasks WHERE scope=?1 AND task LIKE 'playlist:%' AND status='error'").map_err(|_| "Cannot read playlist retries")?;
            let ids = stmt.query_map([&context.cache_scope], |r| r.get::<_, i64>(0)).map_err(|_| "Cannot read playlist retries")?.collect::<Result<Vec<_>, _>>().map_err(|_| "Cannot read playlist retries")?;
            for id in ids { incremental::retry_playlist(conn, &context.cache_scope, id)?; }
            conn.execute("UPDATE plex_catalogue_changes SET attempted_at=0 WHERE scope=?1 AND kind='playlist' AND id IN (SELECT CAST(substr(task,10) AS INTEGER) FROM plex_catalogue_tasks WHERE scope=?1 AND task LIKE 'playlist:%' AND status='error')",[&context.cache_scope]).map_err(|_| "Cannot resume playlist retries")?;
            Ok(())
        }).await?;
    }
    // Serialize reset with the worker so an old generation cannot republish.
    if reset {
        if manager
            .scheduled
            .lock()
            .map_err(|_| "Catalogue unavailable")?
            .contains(&(context.connection_revision, context.cache_scope.clone()))
        {
            return Err("Catalogue is running. Retry after it pauses.".into());
        }
        save_checked(&app,&context,|conn|{conn.execute("DELETE FROM plex_catalogue_tasks WHERE scope=?1",[&context.cache_scope]).map_err(|_|"Cannot reset catalogue")?;conn.execute("UPDATE plex_catalogue_media SET status='pending',attempted_at=NULL WHERE scope=?1 AND stream_id>0 AND status='unavailable'",[&context.cache_scope]).map_err(|_|"Cannot reset analysis")?;Ok(())}).await?;
    }
    catalogue_start(context, app, state, manager).await
}
/// A failed probe closes native remote operations before the renderer sees the
/// banner. Recovery requires the same native server and library UUID.
#[tauri::command]
pub async fn catalogue_health(
    context: PlexRequestContext,
    app: tauri::AppHandle,
    state: State<'_, PlexState>,
) -> Result<bool, String> {
    let client = {
        let guard = state.0.lock().await;
        state.checked_cache_client(&context, &guard)?.clone()
    };
    let section = crate::offline_audio::library_id(&app, &client)?;
    let healthy = tokio::time::timeout(std::time::Duration::from_secs(8), async {
        let identity = client.get_identity().await.map_err(|_| ())?;
        if identity.machine_identifier != client.machine_identifier {
            return Err(());
        }
        let sections = client.get_all_sections().await.map_err(|_| ())?;
        let selected = sections
            .iter()
            .find(|s| s.key == section && s.section_type == "artist")
            .ok_or(())?;
        if client.cache_scope_for_library(section, selected.uuid.as_deref()) != context.cache_scope
        {
            return Err(());
        }
        Ok::<_, ()>(())
    })
    .await
    .is_ok_and(|result| result.is_ok());
    let mut guard = state.0.lock().await;
    state.checked_cache_client(&context, &guard)?;
    if let Some(client) = guard.as_mut() {
        client.offline_only = !healthy;
    }
    Ok(healthy)
}

/// Enumerate every native media/part/audio stream without admitting uncached
/// tracks to local_audio (that table means playable audio, not metadata).
fn media_identities(
    client: &PlexClient,
    raw: &serde_json::Value,
) -> Result<Vec<(String, i64, String)>, String> {
    let track: crate::plex::Track =
        serde_json::from_value(raw.clone()).map_err(|_| "Invalid saved track analysis metadata")?;
    let mut identities = Vec::new();
    for media in &track.media {
        let version =
            crate::plex::catalogue::analysis_revision(media, track.music_analysis_version)?;
        for part in &media.parts {
            if part.id <= 0
                || !part
                    .key
                    .starts_with(&format!("/library/parts/{}/", part.id))
                || part.key.contains(['?', '#', '\\'])
            {
                continue;
            }
            let source = crate::audio_engine::source::MediaSource::new(
                client.media_request(&client.direct_play_url(&part.key)),
                Some(&client.library_scope),
            )?;
            for stream in &part.streams {
                if stream.stream_type == Some(2) {
                    if let Some(id) = stream.id.filter(|id| *id > 0) {
                        identities.push((source.cache_key.clone(), id, version.clone()));
                    }
                }
            }
        }
    }
    Ok(identities)
}
fn discover_media(
    conn: &rusqlite::Connection,
    client: &PlexClient,
    id: i64,
    raw: &serde_json::Value,
    previous: Option<&serde_json::Value>,
) -> Result<(), String> {
    let identities = media_identities(client, raw)?;
    let track: crate::plex::Track =
        serde_json::from_value(raw.clone()).map_err(|_| "Invalid track analysis metadata")?;
    let old: Option<crate::plex::Track> =
        previous.and_then(|raw| serde_json::from_value(raw.clone()).ok());
    conn.execute(
        "UPDATE plex_catalogue_media SET active=0 WHERE scope=?1 AND track_id=?2",
        rusqlite::params![client.library_scope, id],
    )
    .map_err(|_| "Cannot retire old analysis identities")?;
    if identities.is_empty() {
        use sha2::{Digest, Sha256};
        let version = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(raw).map_err(|_| "Invalid missing analysis revision")?
            )
        );
        conn.execute("INSERT INTO plex_catalogue_media(scope,track_id,cache_key,stream_id,version,status) VALUES(?1,?2,'analysis-unavailable',0,?3,'unavailable') ON CONFLICT(scope,track_id,cache_key,stream_id,version) DO UPDATE SET active=1",rusqlite::params![client.library_scope,id,version]).map_err(|_|"Cannot mark absent track analysis")?;
    }
    for (key, stream, version) in identities {
        // Reuse V5/V6 levels only under the exact prior Media identity, stream
        // and musicAnalysisVersion. A tag timestamp alone does not invalidate.
        for source in std::iter::once(&track).chain(old.as_ref()) {
            for media in &source.media {
                if source.music_analysis_version != track.music_analysis_version
                    || crate::plex::catalogue::analysis_revision(
                        media,
                        source.music_analysis_version,
                    )? != version
                {
                    continue;
                }
                use sha2::{Digest, Sha256};
                let legacy = format!(
                    "{:x}",
                    Sha256::digest(
                        serde_json::to_vec(&(
                            media,
                            source.music_analysis_version,
                            source.updated_at
                        ))
                        .map_err(|_| "Invalid legacy analysis revision")?
                    )
                );
                if let Some(levels) = crate::db::catalogue::levels(
                    conn,
                    &client.library_scope,
                    &key,
                    stream,
                    &legacy,
                )? {
                    crate::db::catalogue::save_levels(
                        conn,
                        &client.library_scope,
                        &key,
                        stream,
                        &version,
                        &levels,
                    )?;
                }
            }
        }
        conn.execute("INSERT INTO plex_catalogue_media(scope,track_id,cache_key,stream_id,version,status) VALUES(?1,?2,?3,?4,?5,CASE WHEN EXISTS(SELECT 1 FROM plex_audio_analysis WHERE scope=?1 AND cache_key=?3 AND stream_id=?4 AND version=?5) THEN 'saved' ELSE 'pending' END) ON CONFLICT(scope,track_id,cache_key,stream_id,version) DO UPDATE SET active=1",rusqlite::params![client.library_scope,id,key,stream,version]).map_err(|_|"Cannot discover changed track analysis")?;
    }
    Ok(())
}
async fn analysis(app: &tauri::AppHandle, context: &PlexRequestContext) -> Result<(), String> {
    let generation = save_checked(app, context, |conn| {
        Ok(sync::task(conn, &context.cache_scope, "track")?
            .ok_or("Missing track roster")?
            .generation)
    })
    .await?;
    let mut task = start_task(app, context, "analysis:discover", Some(&generation)).await?;
    while task.status != "complete" {
        let (client, _) = verify_library(app, context).await?;
        let rows=save_checked(app,context,|conn|{
            let mut stmt=conn.prepare("SELECT id,document FROM plex_catalogue WHERE scope=?1 AND kind='track' AND detail=1 AND removed=0 AND id>?2 ORDER BY id LIMIT 50").map_err(|_|"Cannot read analysis discovery")?;
            let rows=stmt.query_map(rusqlite::params![context.cache_scope,task.cursor],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?))).map_err(|_|"Cannot read analysis discovery")?.collect::<Result<Vec<_>,_>>().map_err(|_|"Cannot read analysis discovery")?;Ok(rows)
        }).await?;
        let mut documents = Vec::new();
        for (id, text) in &rows {
            documents.push((
                *id,
                serde_json::from_str::<serde_json::Value>(text)
                    .map_err(|_| "Invalid analysis document")?,
            ));
        }
        save_checked(app, context, |conn| {
            let transaction = conn
                .unchecked_transaction()
                .map_err(|_| "Cannot save analysis discovery")?;
            for (id, raw) in &documents {
                discover_media(&transaction, &client, *id, raw, None)?;
            }
            sync::checkpoint(
                &transaction,
                &context.cache_scope,
                &task,
                rows.last().map(|r| r.0).unwrap_or(task.cursor),
                None,
                rows.is_empty(),
            )?;
            transaction
                .commit()
                .map_err(|_| "Cannot commit analysis discovery".to_owned())
        })
        .await?;
        task = start_task(app, context, "analysis:discover", Some(&generation)).await?;
        background_yield(app, 150).await;
    }
    save_checked(app,context,|conn|{conn.execute("UPDATE plex_catalogue_media SET status='pending' WHERE scope=?1 AND stream_id>0 AND status='unavailable' AND attempted_at<?2",rusqlite::params![context.cache_scope,crate::db::catalogue::now()-24*60*60*1000]).map_err(|_|"Cannot resume analysis")?;Ok(())}).await?;
    loop {
        let next=save_checked(app,context,|conn|{
            use rusqlite::OptionalExtension;
            conn.query_row("SELECT track_id,cache_key,stream_id,version FROM plex_catalogue_media WHERE scope=?1 AND active=1 AND stream_id>0 AND status='pending' ORDER BY track_id LIMIT 1",rusqlite::params![context.cache_scope],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?,r.get::<_,String>(3)?))).optional().map_err(|_|"Cannot read pending analysis".into())
        }).await?;
        let Some((id, key, stream, version)) = next else {
            return Ok(());
        };
        let (client, _) = verify_library(app, context).await?;
        let raw = tokio::time::timeout(
            std::time::Duration::from_secs(12),
            client.get::<serde_json::Value>(&format!("/library/streams/{stream}/levels")),
        )
        .await;
        let saved = match raw {
            Ok(Ok(raw)) => crate::db::catalogue::validate_levels(&raw)
                .ok()
                .map(|_| raw),
            _ => None,
        };
        // A transport failure pauses bulk work instead of labeling the entire
        // remaining catalogue as having no analysis.
        if saved.is_none() {
            verify_library(app, context).await?;
        }
        save_checked(app,context,|conn|{
            let tx=conn.unchecked_transaction().map_err(|_|"Cannot save catalogue analysis")?;
            if let Some(raw)=&saved {crate::db::catalogue::save_levels(&tx,&context.cache_scope,&key,stream,&version,raw)?;}
            tx.execute("UPDATE plex_catalogue_media SET status=?6,attempted_at=?7 WHERE scope=?1 AND track_id=?2 AND cache_key=?3 AND stream_id=?4 AND version=?5",rusqlite::params![context.cache_scope,id,key,stream,version,if saved.is_some(){"saved"}else{"unavailable"},crate::db::catalogue::now()]).map_err(|_|"Cannot checkpoint catalogue analysis")?;
            tx.commit().map_err(|_|"Cannot commit catalogue analysis".to_owned())
        }).await?;
        // Small serial requests yield between streams; encoded audio is never
        // downloaded here and player waveform/cache reads use their own lane.
        background_yield(app, 250).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[tokio::test]
    #[ignore = "Explicit private Plex settings/playlist ID; read-only ordered verification in a temporary database"]
    async fn private_playlist_artwork_churn_resume_and_publication_proof() {
        let settings: crate::plex::PlexSettings = serde_json::from_slice(
            &std::fs::read(
                std::env::var("HIBIKI_CATALOGUE_PROOF_SETTINGS")
                    .expect("Set private settings path"),
            )
            .unwrap(),
        )
        .unwrap();
        let id: i64 = std::env::var("HIBIKI_PLAYLIST_PROOF_ID")
            .expect("Set explicit playlist ID")
            .parse()
            .unwrap();
        assert!(id > 0);
        let mut client = PlexClient::new(crate::plex::PlexClientConfig {
            base_url: settings.base_url,
            token: settings.token,
            client_id: settings.client_id,
            ..Default::default()
        })
        .unwrap();
        let identity = client
            .get_identity()
            .await
            .expect("Private server unavailable");
        assert!(identity.machine_identifier == settings.machine_identifier);
        client.machine_identifier = identity.machine_identifier;
        let section: i64 = std::env::var("HIBIKI_CATALOGUE_PROOF_SECTION")
            .expect("Set explicit music section")
            .parse()
            .unwrap();
        let sections = client
            .get_all_sections()
            .await
            .expect("Private library unavailable");
        let selected = sections
            .iter()
            .find(|s| s.key == section && s.section_type == "artist")
            .expect("Private music section missing");
        client.library_scope = client.cache_scope_for_library(section, selected.uuid.as_deref());
        let before = playlist_document(&client, id)
            .await
            .expect("Private playlist unavailable");
        let revision = playlist_revision(&before);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("playlist-proof.db");
        let mut conn = rusqlite::Connection::open(&path).unwrap();
        crate::db::schema::run_migrations(&conn).unwrap();
        let scope = client.library_scope.clone();
        let mut task = begin_playlist(&conn, &scope, id, &revision, false).unwrap();
        let mut documents = Vec::new();
        let mut reopened = false;
        loop {
            let page = client
                .catalogue_page(&format!("/playlists/{id}/items"), task.cursor, PAGE, &[])
                .await
                .expect("Private playlist page unavailable");
            assert!(
                page.total.is_none_or(|n| n <= 10_000),
                "Proof is bounded to 10,000 occurrences"
            );
            let done = page.items.is_empty()
                || page
                    .total
                    .is_some_and(|n| n == task.cursor + page.items.len() as i64);
            sync::playlist_page_checked(
                &conn,
                &scope,
                id,
                &task,
                &page.items,
                page.total,
                false,
                None,
            )
            .unwrap();
            documents.extend(page.items);
            assert!(documents.len() <= 10_000);
            if !reopened {
                let checkpoint = sync::task(&conn, &scope, &format!("playlist:{id}"))
                    .unwrap()
                    .unwrap();
                drop(conn);
                conn = rusqlite::Connection::open(&path).unwrap();
                task = begin_playlist(&conn, &scope, id, &revision, false).unwrap();
                assert_eq!(
                    (task.generation.clone(), task.cursor),
                    (checkpoint.generation, checkpoint.cursor)
                );
                reopened = true;
            } else {
                task = sync::task(&conn, &scope, &format!("playlist:{id}"))
                    .unwrap()
                    .unwrap();
            }
            if done {
                break;
            }
        }
        assert_eq!(
            conn.query_row::<i64, _, _>(
                "SELECT COUNT(*) FROM plex_catalogue_playlist_versions",
                [],
                |r| r.get(0)
            )
            .unwrap(),
            0
        );
        verify_playlist_documents(&client, id, &documents)
            .await
            .expect("Private ordered verification failed");
        let after = playlist_document(&client, id)
            .await
            .expect("Private final playlist unavailable");
        assert_eq!(revision, playlist_revision(&after));
        assert!(
            sync::playlist_finish_checked(&conn, &scope, id, &task, None, &after)
                .unwrap()
                .is_some()
        );
        let page = crate::db::catalogue_query::query(
            &conn,
            &scope,
            "getPlaylistItems",
            &[json!(id.to_string()), json!(0), json!(200)],
        )
        .unwrap()
        .expect("Published playlist unavailable");
        assert!(page.complete);
        assert_eq!(page.total, documents.len() as i64);
        for (expected, projected) in documents.iter().zip(&page.items) {
            assert_eq!(
                number(&expected["ratingKey"]),
                number(&projected["rating_key"])
            );
            assert_eq!(
                number(&expected["playlistItemID"]),
                number(&projected["playlist_item_id"])
            );
        }
        eprintln!("Read-only playlist proof: {} ordered occurrences verified across database reopen and atomic publication; artwork timestamp changed: {}; no encoded audio downloaded",documents.len(),before["updatedAt"]!=after["updatedAt"]);
    }
    #[test]
    fn playlist_artwork_churn_does_not_change_membership_resume_hint() {
        let before =
            json!({"updatedAt":1,"leafCount":988,"duration":1000,"smart":false,"composite":"/old"});
        let mut after = before.clone();
        after["updatedAt"] = json!(2);
        after["composite"] = json!("/regenerated");
        after["Image"] = json!([{"type":"coverPoster","url":"/new"}]);
        assert_eq!(playlist_revision(&before), playlist_revision(&after));
        for (key, value) in [
            ("leafCount", json!(989)),
            ("duration", json!(2000)),
            ("smart", json!(true)),
            ("content", json!("/new-filter")),
        ] {
            let mut edited = before.clone();
            edited[key] = value;
            assert_ne!(playlist_revision(&before), playlist_revision(&edited));
        }
    }
    #[test]
    fn playlist_retry_uses_a_fresh_owner_but_transport_interruption_resumes() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::schema::run_migrations(&conn).unwrap();
        let scope = format!("plex-{}", "a".repeat(64));
        let raw = json!({"type":"track","ratingKey":1,"playlistItemID":10});
        let first = begin_playlist(&conn, &scope, 7, "same-header", false).unwrap();
        sync::playlist_page(&conn, &scope, 7, &first, &[raw.clone()], Some(2), false).unwrap();
        let checkpoint = sync::task(&conn, &scope, "playlist:7").unwrap().unwrap();
        sync::stop(
            &conn,
            &scope,
            &checkpoint,
            Some("Playlist verification timed out"),
        )
        .unwrap();
        let resumed = begin_playlist(&conn, &scope, 7, "same-header", false).unwrap();
        assert_eq!(resumed.generation, first.generation);
        assert_eq!(resumed.cursor, 1);
        sync::stop(
            &conn,
            &scope,
            &resumed,
            Some("Playlist changed during catalogue sync"),
        )
        .unwrap();
        let replaced = begin_playlist(&conn, &scope, 7, "same-header", false).unwrap();
        assert_ne!(replaced.generation, first.generation);
        assert_eq!(replaced.cursor, 0);
        assert!(
            sync::playlist_page(&conn, &scope, 7, &resumed, &[raw.clone()], Some(2), true).is_err()
        );
        assert!(
            sync::playlist_staging_page(&conn, &scope, 7, &replaced, 0, 200)
                .unwrap()
                .is_empty()
        );
        sync::playlist_page(&conn, &scope, 7, &replaced, &[raw], Some(1), true).unwrap();
        let complete = begin_playlist(&conn, &scope, 7, "same-header", false).unwrap();
        assert_eq!(complete.status, "complete");
        assert_eq!(complete.generation, replaced.generation);
        // An equal-count websocket edit must be rechecked even if the header
        // marker stayed the same, while a bulk heartbeat can reuse completion.
        let refresh = begin_playlist(&conn, &scope, 7, "same-header", true).unwrap();
        assert_ne!(refresh.generation, complete.generation);
        assert_eq!(refresh.status, "pending");
        assert_eq!(
            conn.query_row::<String, _, _>(
                "SELECT generation FROM plex_catalogue_playlist_versions WHERE playlist_id=7",
                [],
                |r| r.get(0)
            )
            .unwrap(),
            complete.generation
        );
    }
    #[test]
    fn all_native_media_parts_and_audio_streams_have_scoped_revision_identities() {
        let mut client = PlexClient::new(crate::plex::PlexClientConfig {
            base_url: "https://fixture.invalid".into(),
            token: "fixture-token".into(),
            ..Default::default()
        })
        .unwrap();
        client.library_scope = format!("plex-{}", "a".repeat(64));
        let raw = json!({"type":"track","ratingKey":42,"duration":1000,"librarySectionID":7,"musicAnalysisVersion":1,"Media":[{"id":1,"Part":[{"id":10,"key":"/library/parts/10/file.flac","Stream":[{"id":20,"streamType":2},{"id":21,"streamType":2},{"id":99,"streamType":1}]},{"id":11,"key":"/library/parts/11/file.flac","Stream":[{"id":22,"streamType":"2"}]}]},{"id":2,"Part":[{"id":12,"key":"/library/parts/12/file.mp3","Stream":[{"id":23,"streamType":2}]}]}]});
        let identities = media_identities(&client, &raw).unwrap();
        assert_eq!(identities.len(), 4);
        assert_eq!(identities[0].0, identities[1].0);
        assert_ne!(identities[0].0, identities[2].0);
        assert_ne!(identities[0].0, identities[3].0);
        assert_eq!(identities[0].2, identities[2].2);
        assert_ne!(identities[0].2, identities[3].2);
        let mut updated = raw.clone();
        updated["musicAnalysisVersion"] = json!(2);
        let revised = media_identities(&client, &updated).unwrap();
        assert_eq!(identities[0].0, revised[0].0);
        assert_ne!(identities[0].2, revised[0].2);
        client.library_scope = format!("plex-{}", "b".repeat(64));
        assert_ne!(
            identities[0].0,
            media_identities(&client, &raw).unwrap()[0].0
        );
    }
    #[test]
    fn collection_availability_requires_real_files_and_owned_known_playlist_membership() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::schema::run_migrations(&conn).unwrap();
        let scope = format!("plex-{}", "a".repeat(64));
        conn.execute("INSERT INTO local_audio(scope,track_id,cache_key,extension,metadata,saved_at) VALUES(?1,42,'cache-key','flac',?2,1)",rusqlite::params![scope,json!({"albumId":"7","artistId":"9"}).to_string()]).unwrap();
        assert!(group_available(&conn, &scope, "album", 7, |key| key == "cache-key").unwrap());
        assert!(group_available(&conn, &scope, "artist", 9, |key| key == "cache-key").unwrap());
        assert!(!group_available(&conn, &scope, "album", 7, |_| false).unwrap());
        assert!(!group_available(
            &conn,
            &format!("plex-{}", "b".repeat(64)),
            "album",
            7,
            |_| true
        )
        .unwrap());
        assert!(!group_available(&conn, &scope, "playlist", 5, |_| true).unwrap());
        crate::db::offline::put(
            &conn,
            &scope,
            "[\"v1\",\"getPlaylistItems\",[\"5\",0,100]]",
            &json!({"items":[{"id":"42","title":"Song"}],"total":100}),
            1,
        )
        .unwrap();
        assert!(group_available(&conn, &scope, "playlist", 5, |key| key == "cache-key").unwrap());
        assert!(!group_available(&conn, &scope, "playlist", 6, |_| true).unwrap());
    }
    #[tokio::test]
    #[ignore = "Requires explicit private Plex settings; read-only bounded keyset transport and isolated DB proof"]
    async fn private_keyset_incremental_transport_and_restart_proof() {
        let path = std::env::var("HIBIKI_CATALOGUE_PROOF_SETTINGS")
            .expect("Set explicit private settings path");
        let settings: crate::plex::PlexSettings =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let mut client = PlexClient::new(crate::plex::PlexClientConfig {
            base_url: settings.base_url,
            token: settings.token,
            client_id: settings.client_id,
            ..Default::default()
        })
        .unwrap();
        let identity = client
            .get_identity()
            .await
            .expect("Private identity unavailable");
        assert!(identity.machine_identifier == settings.machine_identifier);
        client.machine_identifier = identity.machine_identifier;
        let sections = client
            .get_all_sections()
            .await
            .expect("Private section unavailable");
        let proof_section = std::env::var("HIBIKI_CATALOGUE_PROOF_SECTION")
            .ok()
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(settings.section_id);
        let candidates: Vec<_> = sections
            .iter()
            .filter(|section| {
                section.section_type == "artist"
                    && (proof_section == 0 || section.key == proof_section)
                    && (settings.section_uuid.is_empty()
                        || section.uuid.as_deref() == Some(&settings.section_uuid))
            })
            .collect();
        assert_eq!(
            candidates.len(),
            1,
            "Private proof needs one unambiguous music section"
        );
        let section_id = candidates[0].key;
        let section_uuid = candidates[0].uuid.clone();
        client.library_scope = client.cache_scope_for_library(section_id, section_uuid.as_deref());
        let scope = client.library_scope.clone();
        let dir = tempfile::tempdir().unwrap();
        let dbpath = dir.path().join("keyset-proof.db");
        let mut counts = Vec::new();
        for kind in ["artist", "album", "track", "playlist"] {
            let path = roster_path(kind, section_id);
            let mut bounds = roster_filters(kind);
            bounds.push(("sort", "id:desc".into()));
            let bound = client
                .catalogue_page(&path, 0, 1, &bounds)
                .await
                .expect("Private bounds unavailable");
            assert_eq!(bound.items.len(), 1);
            let upper = number(&bound.items[0]["ratingKey"]).unwrap();
            let server_time = bound
                .server_time
                .expect("Private response omitted server clock");
            let conn = rusqlite::Connection::open(&dbpath).unwrap();
            crate::db::schema::run_migrations(&conn).unwrap();
            let task =
                incremental::begin_keyset(&conn, &scope, kind, upper, bound.total, None, None)
                    .unwrap();
            let mut filters = roster_filters(kind);
            filters.extend([
                ("sort", "id:asc".into()),
                ("id>>", "0".into()),
                ("id<", upper.to_string()),
            ]);
            let first = client
                .catalogue_page(&path, 0, 5, &filters)
                .await
                .expect("Private first bounded page failed");
            assert_eq!(first.items.len(), 5);
            incremental::keyset_page(&conn, &scope, &task, kind, &first.items, first.total)
                .unwrap();
            drop(conn);
            let conn = rusqlite::Connection::open(&dbpath).unwrap();
            let resumed =
                incremental::begin_keyset(&conn, &scope, kind, upper + 1000, Some(1), None, None)
                    .unwrap();
            assert_eq!(resumed.upper_id, Some(upper));
            assert_eq!(resumed.cursor, 5);
            filters.retain(|(key, _)| *key != "id>>");
            filters.push(("id>>", resumed.key_cursor.to_string()));
            let second = client
                .catalogue_page(&path, 0, 5, &filters)
                .await
                .expect("Private next bounded page failed");
            assert_eq!(second.items.len(), 5);
            incremental::keyset_page(&conn, &scope, &resumed, kind, &second.items, second.total)
                .unwrap();
            filters.retain(|(key, _)| *key != "id>>");
            filters.push(("id>>", upper.to_string()));
            let end = client
                .catalogue_page(&path, 0, 5, &filters)
                .await
                .expect("Private finite terminal page failed");
            assert!(end.items.is_empty());
            filters.retain(|(key, _)| *key != "id>>");
            filters.extend([
                ("id>>", "0".into()),
                ("updatedAt>", (server_time - 3600).to_string()),
                ("updatedAt<", server_time.to_string()),
            ]);
            let recent = client
                .catalogue_page(&path, 0, 5, &filters)
                .await
                .expect("Private timestamp bounded page failed");
            assert!(recent.items.iter().all(|raw| number(&raw["updatedAt"])
                .is_some_and(|t| t >= server_time - 3600 && t <= server_time)));
            filters.retain(|(key, _)| *key != "updatedAt>" && *key != "updatedAt<");
            filters.push(("updatedAt>", (server_time + 3600).to_string()));
            assert!(client
                .catalogue_page(&path, 0, 5, &filters)
                .await
                .expect("Private future timestamp proof failed")
                .items
                .is_empty());
            let id = number(&first.items[0]["ratingKey"]).unwrap();
            let raw = client
                .catalogue_lookup(id, kind == "playlist")
                .await
                .expect("Private authoritative lookup failed")
                .expect("Private known item missing");
            assert_eq!(raw["type"], kind);
            assert_eq!(number(&raw["ratingKey"]), Some(id));
            counts.push((kind, 10, recent.items.len()));
        }
        eprintln!("Read-only native proof: four entity kinds passed finite upper-ID capture, two 5-row keyset pages across DB restart, terminal empty page, bounded timestamps, future rejection and authoritative full lookup; {} kinds tested",counts.len());
    }
    #[tokio::test]
    #[ignore = "Requires explicit private Plex settings path; read-only server proof in an isolated temporary DB"]
    async fn private_catalogue_readonly_resume_projection_and_full_analysis_proof() {
        let settings_path = std::env::var("HIBIKI_CATALOGUE_PROOF_SETTINGS")
            .expect("Set HIBIKI_CATALOGUE_PROOF_SETTINGS explicitly");
        let settings: crate::plex::PlexSettings =
            serde_json::from_slice(&std::fs::read(settings_path).unwrap()).unwrap();
        let mut client = PlexClient::new(crate::plex::PlexClientConfig {
            base_url: settings.base_url,
            token: settings.token,
            client_id: settings.client_id,
            ..Default::default()
        })
        .unwrap();
        let identity = client
            .get_identity()
            .await
            .expect("Private server identity request failed");
        assert_eq!(identity.machine_identifier, settings.machine_identifier);
        client.machine_identifier = identity.machine_identifier;
        let sections = client
            .get_all_sections()
            .await
            .expect("Private library identity request failed");
        let section = sections
            .iter()
            .find(|s| {
                s.key == settings.section_id
                    && s.section_type == "artist"
                    && s.uuid.as_deref() == Some(&settings.section_uuid)
            })
            .expect("Private selected library identity changed");
        client.library_scope = client.cache_scope_for_library(section.key, section.uuid.as_deref());
        let scope = client.library_scope.clone();
        let dir = tempfile::tempdir().unwrap();
        let conn = rusqlite::Connection::open(dir.path().join("isolated-proof.sqlite")).unwrap();
        crate::db::schema::run_migrations(&conn).unwrap();
        let first = client
            .catalogue_page(
                &format!("/library/sections/{}/all", section.key),
                0,
                200,
                &[
                    ("type", "10".into()),
                    ("includeGuids", "1".into()),
                    ("resolveTags", "1".into()),
                ],
            )
            .await
            .expect("Private first catalogue page failed");
        let task = sync::begin(&conn, &scope, "track", None).unwrap();
        sync::roster_page(&conn, &scope, &task, &first.items, first.total, false).unwrap();
        drop(conn);
        let conn = rusqlite::Connection::open(dir.path().join("isolated-proof.sqlite")).unwrap();
        let resumed = sync::begin(&conn, &scope, "track", None).unwrap();
        assert_eq!(resumed.cursor, first.items.len() as i64);
        assert_eq!(resumed.generation, task.generation);
        let second = client
            .catalogue_page(
                &format!("/library/sections/{}/all", section.key),
                resumed.cursor,
                200,
                &[
                    ("type", "10".into()),
                    ("includeGuids", "1".into()),
                    ("resolveTags", "1".into()),
                ],
            )
            .await
            .expect("Private second catalogue page failed");
        sync::roster_page(&conn, &scope, &resumed, &second.items, second.total, false).unwrap();
        let ids = first
            .items
            .iter()
            .take(50)
            .map(|item| number(&item["ratingKey"]).unwrap())
            .collect::<Vec<_>>();
        let raw = client
            .catalogue_details(&ids)
            .await
            .expect("Private full metadata batch failed");
        assert!(!raw.is_empty());
        let mut streams = 0;
        let mut samples = 0;
        for item in &raw {
            let id = number(&item["ratingKey"]).unwrap();
            crate::db::catalogue::save(&conn, &scope, "track", id, item, true).unwrap();
            let identities = media_identities(&client, item).unwrap();
            streams += identities.len();
            if samples == 0 {
                if let Some((key, stream, version)) = identities.first() {
                    let levels: serde_json::Value = client
                        .get(&format!("/library/streams/{stream}/levels"))
                        .await
                        .expect("Private full levels read failed");
                    crate::db::catalogue::save_levels(
                        &conn, &scope, key, *stream, version, &levels,
                    )
                    .unwrap();
                    samples = levels["Level"].as_array().unwrap().len();
                    assert!(samples > 128);
                }
            }
            let page = crate::db::catalogue_query::query(
                &conn,
                &scope,
                "getTrack",
                &[json!(id.to_string())],
            )
            .unwrap()
            .unwrap();
            assert_eq!(page.items[0]["rating_key"], id);
            assert!(!page.items[0].to_string().contains("/storage/"));
        }
        let browse = crate::db::catalogue_query::query(
            &conn,
            &scope,
            "getAllTracks",
            &[json!(0), json!(200)],
        )
        .unwrap()
        .unwrap();
        assert!(!browse.complete);
        assert_eq!(browse.server_total, first.total);
        assert_eq!(
            browse.total,
            (first.items.len() + second.items.len()) as i64
        );
        let text = raw[0]["title"].as_str().unwrap();
        let search = crate::db::catalogue_query::query(&conn, &scope, "search", &[json!(text)])
            .unwrap()
            .unwrap();
        assert!(!search.items.is_empty());
        let playlist_roster = client
            .catalogue_page("/playlists", 0, 200, &[("playlistType", "audio".into())])
            .await
            .expect("Private playlist roster failed");
        let selected = playlist_roster
            .items
            .iter()
            .find(|item| number(&item["leafCount"]).is_some_and(|n| n > 0 && n <= 200));
        let mut playlist_items = 0;
        if let Some(playlist) = selected {
            let id = number(&playlist["ratingKey"]).unwrap();
            let page = client
                .catalogue_page(&format!("/playlists/{id}/items"), 0, 200, &[])
                .await
                .expect("Private playlist page failed");
            playlist_items = page.items.len();
            let task =
                sync::begin(&conn, &scope, &format!("playlist:{id}"), Some("proof")).unwrap();
            sync::playlist_page(&conn, &scope, id, &task, &page.items, page.total, true).unwrap();
            assert_eq!(
                crate::db::catalogue_query::query(
                    &conn,
                    &scope,
                    "getPlaylistItems",
                    &[json!(id.to_string()), json!(0), json!(200)]
                )
                .unwrap()
                .unwrap()
                .items
                .len(),
                playlist_items
            );
        }
        println!("private catalogue proof: roster={}, server_total={}, full_details={}, audio_streams={}, full_waveform_samples={}, playlist_items={}, resumed_after_reopen=true, encoded_audio_downloaded=false",browse.total,browse.server_total.unwrap_or_default(),raw.len(),streams,samples,playlist_items);
    }
    #[test]
    fn offline_artist_playback_projects_actual_files_without_materializing_the_unavailable_catalogue(
    ) {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::schema::run_migrations(&conn).unwrap();
        let scope = format!("plex-{}", "a".repeat(64));
        for id in [1, 2, 3] {
            crate::db::catalogue::save(&conn,&scope,"track",id,&json!({"type":"track","ratingKey":id,"grandparentRatingKey":9,"title":format!("Song {id}")}),true).unwrap();
        }
        for (id, key) in [(1, "present"), (2, "evicted")] {
            conn.execute("INSERT INTO local_audio(scope,track_id,cache_key,extension,metadata,saved_at) VALUES(?1,?2,?3,'flac',?4,1)",rusqlite::params![scope,id,key,json!({"artistId":"9"}).to_string()]).unwrap();
        }
        let page = offline_artist_tracks(&conn, &scope, 9, |key| key == "present").unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.items[0]["rating_key"], 1);
        assert_eq!(
            offline_artist_tracks(&conn, &scope, 9, |_| false)
                .unwrap()
                .total,
            0
        );
        assert_eq!(
            offline_artist_tracks(&conn, &scope, 10, |_| true)
                .unwrap()
                .total,
            0
        );
    }
}

#[derive(serde::Deserialize, serde::Serialize)]
pub struct AvailabilityItem {
    kind: String,
    id: String,
}
fn group_available(
    conn: &rusqlite::Connection,
    scope: &str,
    kind: &str,
    id: i64,
    present: impl Fn(&str) -> bool,
) -> Result<bool, String> {
    let (sql,binding)=match kind {
        "album"=>("SELECT cache_key FROM local_audio WHERE scope=?1 AND json_extract(metadata,'$.albumId')=?2",id.to_string()),
        "artist"=>("SELECT cache_key FROM local_audio WHERE scope=?1 AND json_extract(metadata,'$.artistId')=?2",id.to_string()),
        "playlist"=>("SELECT a.cache_key FROM plex_catalogue_playlist_versions v JOIN plex_catalogue_playlist_members m ON m.scope=v.scope AND m.playlist_id=v.playlist_id AND m.generation=v.generation JOIN local_audio a ON a.scope=m.scope AND a.track_id=CAST(json_extract(m.document,'$.ratingKey') AS INTEGER) WHERE v.scope=?1 AND v.playlist_id=CAST(?2 AS INTEGER) AND v.saved_at>coalesce((SELECT invalidated_at FROM plex_catalogue_invalidations WHERE scope=v.scope AND method='getPlaylistItems'),0)",id.to_string()),
        _=>return Err("Invalid offline availability kind".into())
    };
    let mut statement = conn
        .prepare(sql)
        .map_err(|_| "Cannot query offline collection availability")?;
    let rows = statement
        .query_map(rusqlite::params![scope, binding], |r| r.get::<_, String>(0))
        .map_err(|_| "Cannot query offline availability")?;
    for key in rows {
        if present(&key.map_err(|_| "Cannot read offline availability")?) {
            return Ok(true);
        }
    }
    if kind == "playlist" {
        // Visited exact pages also prove membership, before the bulk generation
        // publishes. Scope + numeric ID fence the fixed JSON-key prefix.
        let prefix = format!("[\"v1\",\"getPlaylistItems\",[\"{id}\",%");
        let mut stmt=conn.prepare("SELECT a.cache_key FROM offline_snapshots s JOIN json_each(s.payload,'$.items') m JOIN local_audio a ON a.scope=s.scope AND a.track_id=CAST(json_extract(m.value,'$.id') AS INTEGER) WHERE s.scope=?1 AND s.cache_key LIKE ?2").map_err(|_|"Cannot read saved playlist availability")?;
        let rows = stmt
            .query_map(rusqlite::params![scope, prefix], |r| r.get::<_, String>(0))
            .map_err(|_| "Cannot read saved playlist availability")?;
        for key in rows {
            if present(&key.map_err(|_| "Cannot read saved playlist availability")?) {
                return Ok(true);
            }
        }
    }
    Ok(false)
}
#[tauri::command]
pub async fn catalogue_availability(
    context: PlexRequestContext,
    items: Vec<AvailabilityItem>,
    state: State<'_, PlexState>,
    db: State<'_, DbState>,
    downloads: State<'_, crate::offline_audio::AudioDownloads>,
    engine: State<'_, crate::audio_engine::bridge::AudioEngineState>,
) -> Result<Vec<serde_json::Value>, String> {
    if items.len() > 1000 {
        return Err("Offline availability batch exceeds its limit".into());
    }
    {
        let guard = state.0.lock().await;
        state.checked_cache_client(&context, &guard)?;
    }
    let scope = context.cache_scope.clone();
    let downloaded = downloads.cache.clone();
    let automatic = engine.0.cache().clone();
    let result = db
        .read(move |conn| {
            let mut result = Vec::new();
            for item in items {
                let id = item
                    .id
                    .parse::<i64>()
                    .ok()
                    .filter(|id| *id > 0)
                    .ok_or("Invalid offline collection ID")?;
                let available = group_available(conn, &scope, &item.kind, id, |key| {
                    downloaded.lookup(key).is_some() || automatic.lookup(key).is_some()
                })?;
                result
                    .push(serde_json::json!({"kind":item.kind,"id":item.id,"available":available}));
            }
            Ok(result)
        })
        .await?;
    let guard = state.0.lock().await;
    state.checked_cache_client(&context, &guard)?;
    Ok(result)
}

#[tauri::command]
pub async fn catalogue_remote_page(
    context: PlexRequestContext,
    kind: String,
    offset: i64,
    limit: i64,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let code = match kind.as_str() {
        "artist" => "8",
        "album" => "9",
        "track" => "10",
        _ => return Err("Invalid catalogue browse kind".into()),
    };
    if offset < 0 || !(1..=500).contains(&limit) {
        return Err("Invalid catalogue browse bounds".into());
    }
    let (client, section) = verify_library(&app, &context).await?;
    let page = client
        .catalogue_page(
            &format!("/library/sections/{section}/all"),
            offset,
            limit,
            &[
                ("type", code.into()),
                ("includeGuids", "1".into()),
                ("resolveTags", "1".into()),
            ],
        )
        .await
        .map_err(|_| "Plex library page is unavailable")?;
    let mut items = Vec::new();
    save_checked(&app,&context,|conn|{
        let transaction=conn.unchecked_transaction().map_err(|_|"Cannot save catalogue browse page")?;
        for raw in &page.items {
            let id=number(&raw["ratingKey"]).filter(|id|*id>0).ok_or("Invalid catalogue browse identity")?;
            if raw["type"].as_str()!=Some(kind.as_str()) || number(&raw["librarySectionID"]).is_some_and(|id|id!=section){return Err("Plex returned a different library item".into());}
            crate::db::catalogue::save(&transaction,&context.cache_scope,&kind,id,raw,false)?;
            let document=serde_json::to_string(&crate::db::catalogue::clean_document(raw)?).map_err(|_|"Invalid catalogue browse metadata")?;
            transaction.execute("UPDATE plex_catalogue SET listing=?4,listing_saved_at=?5,removed=0 WHERE scope=?1 AND kind=?2 AND id=?3",rusqlite::params![context.cache_scope,kind,id,document,crate::db::catalogue::now()]).map_err(|_|"Cannot save latest library listing")?;
            items.push(crate::db::catalogue_query::project(&kind,raw.clone())?);
        }
        transaction.commit().map_err(|_|"Cannot commit library browse page".to_owned())
    }).await?;
    Ok(
        serde_json::json!({"items":items,"total":page.total.unwrap_or(offset+page.items.len() as i64),"offset":offset}),
    )
}
