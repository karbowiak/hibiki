//! Resumable, bounded mirror of the selected Plex library.
use crate::{
    commands::{PlexRequestContext, PlexState},
    db::{catalogue_sync as sync, DbState},
    plex::{catalogue::number, PlexClient},
};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
};
use tauri::{Manager, State};
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
    scheduled: Mutex<HashSet<(u64, String)>>,
    verified: Mutex<HashMap<(u64, String), (std::time::Instant, i64)>>,
}
impl CatalogueSync {
    pub fn new() -> Self {
        Self {
            worker: Arc::new(tokio::sync::Mutex::new(())),
            scheduled: Mutex::new(HashSet::new()),
            verified: Mutex::new(HashMap::new()),
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
async fn save_checked<T>(
    app: &tauri::AppHandle,
    context: &PlexRequestContext,
    f: impl FnOnce(&rusqlite::Connection) -> Result<T, String>,
) -> Result<T, String> {
    let state = app.state::<PlexState>();
    let guard = state.0.lock().await;
    let client = state.checked_client(context, &guard)?;
    if client.library_scope != context.cache_scope {
        return Err("Catalogue request was superseded".into());
    }
    let db = app.state::<DbState>();
    let conn = db.0.lock().map_err(|_| "Catalogue storage unavailable")?;
    f(&conn)
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
async fn roster(
    app: &tauri::AppHandle,
    context: &PlexRequestContext,
    kind: &str,
) -> Result<sync::Task, String> {
    let mut task = start_task(app, context, kind, None).await?;
    if task.status == "complete" {
        return Ok(task);
    }
    loop {
        let operation = async {
            let (client, section) = verify_library(app, context).await?;
            let (path, filters) = if kind == "playlist" {
                (
                    "/playlists".to_owned(),
                    vec![("playlistType", "audio".to_owned())],
                )
            } else {
                (
                    format!("/library/sections/{section}/all"),
                    vec![
                        (
                            "type",
                            match kind {
                                "artist" => "8",
                                "album" => "9",
                                _ => "10",
                            }
                            .to_owned(),
                        ),
                        ("includeGuids", "1".into()),
                        ("resolveTags", "1".into()),
                        ("includeLyrics", "1".into()),
                    ],
                )
            };
            let page = tokio::time::timeout(
                std::time::Duration::from_secs(30),
                client.catalogue_page(&path, task.cursor, PAGE, &filters),
            )
            .await
            .map_err(|_| "Plex catalogue request timed out")?
            .map_err(|e| format!("Plex catalogue page is unavailable or invalid: {e}"))?;
            let total = page.total.or(task.total);
            let complete = page.items.is_empty()
                || total.is_some_and(|total| task.cursor + page.items.len() as i64 == total);
            if complete {
                fresh_library(app, context).await?;
            }
            save_checked(app, context, |conn| {
                sync::roster_page(
                    conn,
                    &context.cache_scope,
                    &task,
                    &page.items,
                    total,
                    complete,
                )
            })
            .await?;
            start_task(app, context, kind, None).await
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
            return Ok(task);
        }
        background_yield(app, 200).await;
    }
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
                sync::pending_details(conn, &context.cache_scope, kind, task.cursor)
            })
            .await?;
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
                sync::detail_page(conn, &context.cache_scope, &task, kind, &ids, &items)
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
                item["updatedAt"],
                item["leafCount"],
                item["duration"],
                item["smart"],
                item["content"]
            ]))
            .unwrap_or_default()
        )
    )
}
async fn playlists(
    app: &tauri::AppHandle,
    context: &PlexRequestContext,
    generation: &str,
) -> Result<(), String> {
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
            let name = format!("playlist:{id}");
            let (client, _) = verify_library(app, context).await?;
            let before = playlist_document(&client, id).await?;
            let revision = playlist_revision(&before);
            let playlist_generation = format!("{generation}:{revision}");
            save_checked(app, context, |conn| {
                crate::db::catalogue::save(
                    conn,
                    &context.cache_scope,
                    "playlist",
                    id,
                    &before,
                    true,
                )
            })
            .await?;
            let mut task = start_task(app, context, &name, Some(&playlist_generation)).await?;
            while task.status != "complete" {
                let operation = async {
                    let (client, _) = verify_library(app, context).await?;
                    let page = tokio::time::timeout(
                        std::time::Duration::from_secs(30),
                        client.catalogue_page(
                            &format!("/playlists/{id}/items"),
                            task.cursor,
                            PAGE,
                            &[],
                        ),
                    )
                    .await
                    .map_err(|_| "Plex playlist request timed out")?
                    .map_err(|e| format!("Plex playlist page is unavailable or invalid: {e}"))?;
                    let total = page.total.or(task.total);
                    let complete = page.items.is_empty()
                        || total
                            .is_some_and(|total| task.cursor + page.items.len() as i64 == total);
                    if complete {
                        fresh_library(app, context).await?;
                        let after = playlist_document(&client, id).await?;
                        if playlist_revision(&after) != revision {
                            return Err("Playlist changed during catalogue sync".into());
                        }
                    }
                    save_checked(app, context, |conn| {
                        sync::playlist_page(
                            conn,
                            &context.cache_scope,
                            id,
                            &task,
                            &page.items,
                            total,
                            complete,
                        )
                    })
                    .await?;
                    start_task(app, context, &name, Some(&playlist_generation)).await
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
        }
    }
}
async fn run(app: &tauri::AppHandle, context: &PlexRequestContext) -> Result<(), String> {
    verify_library(app, context).await?;
    // List all entities first so browsing/search can benefit before detail work.
    let artists = roster(app, context, "artist").await?;
    let albums = roster(app, context, "album").await?;
    let tracks = roster(app, context, "track").await?;
    let playlist_roster = roster(app, context, "playlist").await?;
    playlists(app, context, &playlist_roster.generation).await?;
    details(app, context, "artist", &artists.generation).await?;
    details(app, context, "album", &albums.generation).await?;
    details(app, context, "track", &tracks.generation).await?;
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
) -> Result<Option<crate::db::catalogue_query::Page>, String> {
    let guard = state.0.lock().await;
    let client = state.checked_cache_client(&context, &guard)?;
    let conn = db.0.lock().map_err(|_| "Catalogue storage unavailable")?;
    if method == "getArtistTracks" && client.offline_only {
        let artist = args
            .first()
            .and_then(serde_json::Value::as_str)
            .and_then(|s| s.parse::<i64>().ok())
            .filter(|id| *id > 0)
            .ok_or("Invalid offline artist ID")?;
        return offline_artist_tracks(&conn, &client.library_scope, artist, |key| {
            downloads.cache.lookup(key).is_some() || engine.0.cache().lookup(key).is_some()
        })
        .map(Some);
    }
    crate::db::catalogue_query::query(&conn, &client.library_scope, &method, &args)
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
    let guard = state.0.lock().await;
    state.checked_cache_client(&context, &guard)?;
    let conn = db.0.lock().map_err(|_| "Catalogue storage unavailable")?;
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
        serde_json::json!({"tasks":tasks,"entities":count("SELECT COUNT(*) FROM plex_catalogue WHERE scope=?1 AND removed=0")?,"details":count("SELECT COUNT(*) FROM plex_catalogue WHERE scope=?1 AND removed=0 AND detail=1")?,"waveforms":count("SELECT COUNT(*) FROM plex_catalogue_media WHERE scope=?1 AND active=1 AND status='saved'")?,"analysisPending":count("SELECT COUNT(*) FROM plex_catalogue_media WHERE scope=?1 AND active=1 AND status='pending'")?,"analysisUnavailable":count("SELECT COUNT(*) FROM plex_catalogue_media WHERE scope=?1 AND active=1 AND status='unavailable'")?}),
    )
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
    use sha2::{Digest, Sha256};
    let track: crate::plex::Track =
        serde_json::from_value(raw.clone()).map_err(|_| "Invalid saved track analysis metadata")?;
    let mut identities = Vec::new();
    for media in &track.media {
        let version = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&(media, track.music_analysis_version, track.updated_at))
                    .map_err(|_| "Invalid analysis revision")?
            )
        );
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
        let mut discovered = Vec::new();
        for (id, text) in &rows {
            let raw = serde_json::from_str(text).map_err(|_| "Invalid analysis document")?;
            let identities = media_identities(&client, &raw)?;
            if identities.is_empty() {
                use sha2::{Digest, Sha256};
                discovered.push((
                    *id,
                    "analysis-unavailable".to_owned(),
                    0,
                    format!("{:x}", Sha256::digest(text.as_bytes())),
                ));
            }
            for (key, stream, version) in identities {
                discovered.push((*id, key, stream, version));
            }
        }
        save_checked(app,context,|conn|{
            let transaction=conn.unchecked_transaction().map_err(|_|"Cannot save analysis discovery")?;
            for (id,_) in &rows {transaction.execute("UPDATE plex_catalogue_media SET active=0 WHERE scope=?1 AND track_id=?2",rusqlite::params![context.cache_scope,id]).map_err(|_|"Cannot retire old analysis associations")?;}
            for (id,key,stream,version) in &discovered {transaction.execute("INSERT INTO plex_catalogue_media(scope,track_id,cache_key,stream_id,version,status) VALUES(?1,?2,?3,?4,?5,CASE WHEN EXISTS(SELECT 1 FROM plex_audio_analysis WHERE scope=?1 AND cache_key=?3 AND stream_id=?4 AND version=?5) THEN 'saved' WHEN ?4=0 THEN 'unavailable' ELSE 'pending' END) ON CONFLICT(scope,track_id,cache_key,stream_id,version) DO UPDATE SET active=1",rusqlite::params![context.cache_scope,id,key,stream,version]).map_err(|_|"Cannot save analysis identity")?;}
            sync::checkpoint(&transaction,&context.cache_scope,&task,rows.last().map(|r|r.0).unwrap_or(task.cursor),None,rows.is_empty())?;
            transaction.commit().map_err(|_|"Cannot commit analysis discovery".to_owned())
        }).await?;
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
    let guard = state.0.lock().await;
    let client = state.checked_cache_client(&context, &guard)?;
    let conn = db.0.lock().map_err(|_| "Local audio storage unavailable")?;
    let mut result = Vec::new();
    for item in items {
        let id = item
            .id
            .parse::<i64>()
            .ok()
            .filter(|id| *id > 0)
            .ok_or("Invalid offline collection ID")?;
        let available = group_available(&conn, &client.library_scope, &item.kind, id, |key| {
            downloads.cache.lookup(key).is_some() || engine.0.cache().lookup(key).is_some()
        })?;
        result.push(serde_json::json!({"kind":item.kind,"id":item.id,"available":available}));
    }
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
