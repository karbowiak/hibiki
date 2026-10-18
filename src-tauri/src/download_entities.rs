//! User-facing download state belongs to library entities, not a flat cache list.
use crate::{
    commands::{PlexRequestContext, PlexState},
    db::{audio, download_entities as intents, DbState},
    offline_audio::AudioDownloads,
    plex::{catalogue::number, PlexClient},
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use tauri::{Manager, State};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entity {
    pub kind: String,
    pub id: i64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub kind: String,
    pub id: i64,
    pub known: bool,
    pub total: usize,
    pub downloaded: usize,
    pub pending: usize,
    pub failed: usize,
    pub requested: bool,
    pub error: Option<String>,
}

async fn capture(
    client: &PlexClient,
    section: i64,
    kind: &str,
    id: i64,
) -> Result<
    (
        String,
        Vec<i64>,
        i64,
        serde_json::Value,
        Vec<serde_json::Value>,
    ),
    String,
> {
    let path = if kind == "playlist" {
        format!("/playlists/{id}")
    } else {
        format!("/library/metadata/{id}")
    };
    let meta: serde_json::Value =
        tokio::time::timeout(std::time::Duration::from_secs(20), client.get(&path))
            .await
            .map_err(|_| "Plex request timed out")?
            .map_err(|_| "Plex could not load this download source")?;
    let source = meta["Metadata"]
        .as_array()
        .and_then(|items| items.first())
        .ok_or("Plex returned no download source")?;
    if number(&source["ratingKey"]) != Some(id)
        || source["type"].as_str() != Some(kind)
        || (kind == "playlist"
            && source["playlistType"]
                .as_str()
                .is_some_and(|t| t != "audio"))
        || source["librarySectionUUID"].as_str().is_some_and(|uuid| {
            client.cache_scope_for_library(section, Some(uuid)) != client.library_scope
        })
        || number(&source["librarySectionID"])
            .or_else(|| number(&meta["librarySectionID"]))
            .is_some_and(|actual| actual != section)
    {
        return Err("Plex returned a different download source".into());
    }
    let title = source["title"].as_str().unwrap_or("Music").to_owned();
    if kind == "track" {
        return Ok((title, vec![id], 1, source.clone(), vec![source.clone()]));
    }
    let (path, filters) = match kind {
        "playlist" => (format!("/playlists/{id}/items"), vec![]),
        "album" => (format!("/library/metadata/{id}/children"), vec![]),
        "artist" => (
            format!("/library/sections/{section}/all"),
            vec![("type", "10".into()), ("artist.id", id.to_string())],
        ),
        _ => return Err("Invalid download source".into()),
    };
    let mut documents = vec![];
    let mut document_bytes = 0usize;
    let mut ids = vec![];
    let mut seen = HashSet::new();
    let mut occurrences = HashSet::new();
    let mut offset = 0;
    let mut total = None;
    loop {
        let page = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            client.catalogue_page(&path, offset, 200, &filters),
        )
        .await
        .map_err(|_| "Plex download preparation timed out")?
        .map_err(|_| "Plex download membership is unavailable or changed")?;
        if total.is_some() && page.total.is_some() && total != page.total {
            return Err("This collection changed while preparing its download. Try again.".into());
        }
        total = page.total.or(total);
        if total.is_some_and(|n| n > 10000) {
            return Err(
                "Choose individual albums or a playlist with at most 10,000 tracks.".into(),
            );
        }
        let length = page.items.len();
        for item in page.items {
            if item["type"].as_str() != Some("track")
                || number(&item["librarySectionID"]).is_some_and(|id| id != section)
            {
                return Err(
                    "This collection contains tracks from another Plex music library.".into(),
                );
            }
            let track = number(&item["ratingKey"])
                .filter(|id| *id > 0)
                .ok_or("Invalid Plex download track")?;
            if kind == "playlist" {
                if let Some(occurrence) = number(&item["playlistItemID"]).filter(|id| *id > 0) {
                    if !occurrences.insert(occurrence) {
                        return Err(
                            "Plex repeated a playlist page while preparing its download.".into(),
                        );
                    }
                }
            } else if seen.contains(&track) {
                return Err("Plex repeated a download page.".into());
            }
            if seen.insert(track) {
                ids.push(track)
            }
            document_bytes = document_bytes.saturating_add(
                serde_json::to_vec(&item)
                    .map_err(|_| "Invalid download metadata")?
                    .len(),
            );
            if document_bytes > 64 * 1024 * 1024 {
                return Err(
                    "Download source metadata is too large. Choose individual albums.".into(),
                );
            }
            documents.push(item);
        }
        offset += length as i64;
        if offset > 10000 {
            return Err(
                "Choose individual albums or a playlist with at most 10,000 tracks.".into(),
            );
        }
        if length == 0 || total.is_some_and(|n| offset == n) {
            break;
        }
    }
    if ids.is_empty() {
        return Err("This collection has no downloadable tracks.".into());
    }
    if total.is_some_and(|n| n != offset) {
        return Err("Plex did not return the complete collection.".into());
    }
    if kind == "playlist" {
        crate::catalogue_commands::verify_playlist_documents(client, id, &documents).await?;
        let after: serde_json::Value = tokio::time::timeout(
            std::time::Duration::from_secs(20),
            client.get(&format!("/playlists/{id}")),
        )
        .await
        .map_err(|_| "Plex request timed out")?
        .map_err(|_| "Cannot verify download source")?;
        let after = after["Metadata"]
            .as_array()
            .and_then(|items| items.first())
            .ok_or("Download source is unavailable")?;
        if number(&after["ratingKey"]) != Some(id)
            || crate::catalogue_commands::playlist_revision(source)
                != crate::catalogue_commands::playlist_revision(after)
        {
            return Err("This playlist changed while preparing its download. Try again.".into());
        }
    }
    Ok((title, ids, offset, source.clone(), documents))
}

/// A requested collection is independently browsable before the global census
/// finishes. Verified playlist occurrences retain their order and duplicates.
fn save_source(
    conn: &rusqlite::Connection,
    scope: &str,
    kind: &str,
    id: i64,
    revision: &str,
    source: &serde_json::Value,
    items: &[serde_json::Value],
) -> Result<(), String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|_| "Cannot archive download source")?;
    crate::db::catalogue::save(&tx, scope, kind, id, source, true)?;
    let generation = format!("download:{revision}");
    if kind == "playlist" {
        tx.execute("DELETE FROM plex_catalogue_playlist_members WHERE scope=?1 AND playlist_id=?2 AND generation=?3",rusqlite::params![scope,id,generation]).map_err(|_| "Cannot refresh downloaded playlist")?;
    }
    for (position, item) in items.iter().enumerate() {
        let track = number(&item["ratingKey"]).ok_or("Invalid download source member")?;
        crate::db::catalogue::save(&tx, scope, "track", track, item, false)?;
        let document = serde_json::to_string(item).map_err(|_| "Invalid download metadata")?;
        tx.execute("UPDATE audio_download_members SET document=?5 WHERE scope=?1 AND kind=?2 AND entity_id=?3 AND track_id=?4",rusqlite::params![scope,kind,id,track,document]).map_err(|_|"Cannot archive download membership")?;
        if kind == "playlist" {
            tx.execute("INSERT INTO plex_catalogue_playlist_members(scope,playlist_id,generation,position,document) VALUES(?1,?2,?3,?4,?5)",rusqlite::params![scope,id,generation,position as i64,document]).map_err(|_|"Cannot archive playlist occurrences")?;
        }
    }
    if kind == "playlist" {
        tx.execute("INSERT INTO plex_catalogue_playlist_versions(scope,playlist_id,generation,total,saved_at) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(scope,playlist_id) DO UPDATE SET generation=excluded.generation,total=excluded.total,saved_at=excluded.saved_at",rusqlite::params![scope,id,generation,items.len() as i64,crate::db::catalogue::now()]).map_err(|_|"Cannot publish downloaded playlist")?;
        tx.execute("DELETE FROM plex_catalogue_playlist_members WHERE scope=?1 AND playlist_id=?2 AND generation LIKE 'download:%' AND generation!=?3",rusqlite::params![scope,id,generation]).map_err(|_|"Cannot retire old downloaded playlist snapshot")?;
    }
    tx.commit()
        .map_err(|_| "Cannot commit download source".into())
}

#[tauri::command]
pub async fn download_entity(
    context: PlexRequestContext,
    kind: String,
    id: i64,
    app: tauri::AppHandle,
    state: State<'_, PlexState>,
    db: State<'_, DbState>,
) -> Result<usize, String> {
    prepare_download(context, kind, id, app, state, db, None).await
}
async fn prepare_download(
    context: PlexRequestContext,
    kind: String,
    id: i64,
    app: tauri::AppHandle,
    state: State<'_, PlexState>,
    db: State<'_, DbState>,
    refresh_revision: Option<&str>,
) -> Result<usize, String> {
    intents::check(&context.cache_scope, &kind, id)?;
    let (client, section) = crate::catalogue_commands::fresh_library(&app, &context).await?;
    let (title, ids, entries, source, documents) = capture(&client, section, &kind, id).await?;
    let documents = documents
        .iter()
        .map(crate::db::catalogue::clean_document)
        .collect::<Result<Vec<_>, _>>()?;
    let revision = {
        let guard = state.0.lock().await;
        state.checked_client(&context, &guard)?;
        let conn = db.0.lock().map_err(|_| "Download storage unavailable")?;
        let revision = if let Some(expected) = refresh_revision {
            intents::refresh(
                &conn,
                &context.cache_scope,
                &kind,
                id,
                &title,
                &ids,
                entries,
                expected,
            )?
        } else {
            intents::remember(
                &conn,
                &context.cache_scope,
                &kind,
                id,
                &title,
                &ids,
                entries,
            )?
        };
        save_source(
            &conn,
            &context.cache_scope,
            &kind,
            id,
            &revision,
            &source,
            &documents,
        )?;
        revision
    };
    // Admit bounded batches through the existing durable/validated audio pipeline.
    // Completed and in-flight jobs are unchanged by enqueue. Failed jobs get
    // one new attempt on this hourly pass, without a notification or tight loop.
    for batch in ids.chunks(256) {
        crate::offline_audio::enqueue_download_batch(
            context.clone(),
            batch.to_vec(),
            state.clone(),
            db.clone(),
            app.clone(),
            Some((&kind, id, &revision)),
        )
        .await?;
    }
    crate::download_library::schedule(app);
    Ok(ids.len())
}

/// Follow only explicitly requested collections; never scan the entire library.
pub(crate) fn start_requested_refresh(app: tauri::AppHandle, context: PlexRequestContext) {
    let key = (context.connection_revision, context.cache_scope.clone());
    let downloads = app.state::<AudioDownloads>();
    let Ok(mut scheduled) = downloads.collection_refreshes.lock() else {
        return;
    };
    if !scheduled.insert(key.clone()) {
        return;
    }
    drop(scheduled);
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
        let mut last = None::<std::time::Instant>;
        loop {
            interval.tick().await;
            let state = app.state::<PlexState>();
            {
                let guard = state.0.lock().await;
                if state.checked_client(&context, &guard).is_err() {
                    break;
                }
            }
            if last.is_some_and(|checked| checked.elapsed() < std::time::Duration::from_secs(3600))
            {
                continue;
            }
            last = Some(std::time::Instant::now());
            let scope = context.cache_scope.clone();
            let db = app.state::<DbState>();
            let Ok(requests) = db
                .read(move |conn| intents::requested_collections(conn, &scope))
                .await
            else {
                continue;
            };
            for (kind, id, revision) in requests {
                if let Err(error) = prepare_download(
                    context.clone(),
                    kind,
                    id,
                    app.clone(),
                    state.clone(),
                    db.clone(),
                    Some(&revision),
                )
                .await
                {
                    tracing::debug!(%error,"Requested download refresh deferred");
                }
            }
        }
        if let Ok(mut scheduled) = app.state::<AudioDownloads>().collection_refreshes.lock() {
            scheduled.remove(&key);
        }
    });
}

fn entity_members(
    conn: &rusqlite::Connection,
    scope: &str,
    kind: &str,
    id: i64,
) -> Result<(Vec<i64>, bool, bool), String> {
    let claimed = intents::members(conn, scope, kind, id)?;
    let requested = !claimed.is_empty();
    if kind == "track" {
        return Ok((vec![id], true, requested));
    }
    let complete = crate::db::catalogue_sync::task(conn, scope, "track")?
        .is_some_and(|t| t.status == "complete");
    if kind == "playlist" {
        use rusqlite::OptionalExtension;
        let generation:Option<String>=conn.query_row("SELECT generation FROM plex_catalogue_playlist_versions WHERE scope=?1 AND playlist_id=?2",rusqlite::params![scope,id],|r|r.get(0)).optional().map_err(|_|"Cannot read downloaded playlist")?;
        if let Some(generation) = generation {
            let mut stmt=conn.prepare("SELECT DISTINCT CAST(json_extract(document,'$.ratingKey') AS INTEGER) FROM plex_catalogue_playlist_members WHERE scope=?1 AND playlist_id=?2 AND generation=?3").map_err(|_|"Cannot read downloaded playlist")?;
            let ids = stmt
                .query_map(rusqlite::params![scope, id, generation], |r| r.get(0))
                .map_err(|_| "Cannot read downloaded playlist")?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| "Cannot read downloaded playlist")?;
            return Ok((ids, true, requested));
        }
    } else if complete {
        let field = if kind == "album" {
            "download_album"
        } else {
            "download_artist"
        };
        let mut stmt=conn.prepare(&format!("SELECT id FROM plex_catalogue WHERE scope=?1 AND kind='track' AND removed=0 AND {field}=?2")).map_err(|_|"Cannot read downloaded collection")?;
        let ids = stmt
            .query_map(rusqlite::params![scope, id], |r| r.get(0))
            .map_err(|_| "Cannot read downloaded collection")?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "Cannot read downloaded collection")?;
        return Ok((ids, true, requested));
    }
    Ok((claimed, requested, requested))
}
fn read_statuses(
    conn: &rusqlite::Connection,
    scope: &str,
    entities: Vec<Entity>,
    mut present: impl FnMut(&str) -> bool,
) -> Result<Vec<Status>, String> {
    let mut members = Vec::with_capacity(entities.len());
    let mut wanted = HashSet::new();
    for entity in entities {
        let (ids, known, requested) = entity_members(conn, scope, &entity.kind, entity.id)?;
        wanted.extend(ids.iter().copied());
        members.push((entity, ids, known, requested));
    }
    let ids: Vec<_> = wanted.into_iter().collect();
    let mut jobs = HashMap::new();
    let mut statement = conn.prepare_cached(
        "SELECT track_id,status,cache_key,error FROM audio_download_jobs WHERE scope=?1 AND track_id IN (SELECT value FROM json_each(?2))"
    ).map_err(|_| "Cannot read downloads")?;
    for batch in ids.chunks(500) {
        let selected = serde_json::to_string(batch).map_err(|_| "Cannot select download statuses")?;
        let rows = statement.query_map(rusqlite::params![scope, selected], |row| Ok((
            row.get::<_,i64>(0)?, row.get::<_,String>(1)?,
            row.get::<_,Option<String>>(2)?, row.get::<_,Option<String>>(3)?
        ))).map_err(|_| "Cannot read downloads")?;
        for row in rows {
            let (id, status, key, error) = row.map_err(|_| "Cannot read downloads")?;
            let ready = key.as_ref().is_some_and(|key| present(key));
            jobs.insert(id, (status, ready, error));
        }
    }
    let mut statuses = vec![];
    for (entity, ids, known, requested) in members {
        let mut downloaded = 0;
        let mut pending = 0;
        let mut failed = 0;
        let mut error = None;
        for id in &ids {
            if let Some((status, ready, reason)) = jobs.get(id) {
                if *ready {
                    downloaded += 1
                } else if matches!(status.as_str(), "queued" | "downloading" | "paused") {
                    pending += 1
                } else {
                    failed += 1;
                    if error.is_none() {
                        error = reason.clone();
                    }
                }
            }
        }
        statuses.push(Status {
            kind: entity.kind,
            id: entity.id,
            known,
            total: ids.len(),
            downloaded,
            pending,
            failed,
            requested,
            error,
        });
    }
    Ok(statuses)
}

#[tauri::command]
pub async fn download_activity(
    context: PlexRequestContext,
    state: State<'_, PlexState>,
    db: State<'_, DbState>,
) -> Result<audio::ActivitySummary, String> {
    {
        let guard = state.0.lock().await;
        state.checked_cache_client(&context, &guard)?;
    }
    let scope = context.cache_scope.clone();
    let result = db.read(move |conn| audio::activity(conn, &scope)).await?;
    let guard = state.0.lock().await;
    state.checked_cache_client(&context, &guard)?;
    Ok(result)
}

#[tauri::command]
pub async fn download_entity_status(
    context: PlexRequestContext,
    entities: Vec<Entity>,
    state: State<'_, PlexState>,
    db: State<'_, DbState>,
    downloads: State<'_, AudioDownloads>,
) -> Result<Vec<Status>, String> {
    if entities.len() > 200 {
        return Err("Too many download status requests".into());
    }
    for entity in &entities {
        intents::check(&context.cache_scope, &entity.kind, entity.id)?;
    }
    {
        let guard = state.0.lock().await;
        state.checked_cache_client(&context, &guard)?;
    }
    let scope = context.cache_scope.clone();
    let cache = downloads.cache();
    let result = db
        .read(move |conn| read_statuses(conn, &scope, entities, |key| cache.lookup(key).is_some()))
        .await?;
    let guard = state.0.lock().await;
    state.checked_cache_client(&context, &guard)?;
    Ok(result)
}
#[tauri::command]
pub async fn download_entity_issues(
    context: PlexRequestContext,
    kind: String,
    id: i64,
    offset: u32,
    state: State<'_, PlexState>,
    db: State<'_, DbState>,
) -> Result<serde_json::Value, String> {
    intents::check(&context.cache_scope, &kind, id)?;
    {
        let guard = state.0.lock().await;
        state.checked_cache_client(&context, &guard)?;
    }
    let scope = context.cache_scope.clone();
    let result = db
        .read(move |conn| read_issues(conn, &scope, &kind, id, offset))
        .await?;
    let guard = state.0.lock().await;
    state.checked_cache_client(&context, &guard)?;
    Ok(result)
}

fn read_issues(
    conn: &rusqlite::Connection,
    scope: &str,
    kind: &str,
    id: i64,
    offset: u32,
) -> Result<serde_json::Value, String> {
    intents::check(scope, kind, id)?;
    let ids = entity_members(conn, scope, kind, id)?
        .0
        .into_iter()
        .collect::<HashSet<_>>();
    // Captured Plex documents also identify failures that happened before an
    // audio binding could be saved. Only return display fields, never payloads.
    let mut query = conn.prepare(
        "SELECT j.track_id,j.error,
            COALESCE(NULLIF(json_extract(a.metadata,'$.title'),''),json_extract(m.document,'$.title'),''),
            COALESCE(NULLIF(json_extract(a.metadata,'$.artistName'),''),json_extract(m.document,'$.grandparentTitle'),'')
         FROM audio_download_jobs j
         LEFT JOIN local_audio a ON a.scope=j.scope AND a.track_id=j.track_id
            AND a.cache_key=(SELECT cache_key FROM local_audio WHERE scope=j.scope AND track_id=j.track_id ORDER BY saved_at DESC,cache_key LIMIT 1)
         LEFT JOIN audio_download_members m ON m.scope=j.scope AND m.kind=?2 AND m.entity_id=?3 AND m.track_id=j.track_id
         WHERE j.scope=?1 AND j.status='error' ORDER BY j.track_id"
    ).map_err(|_| "Cannot read download issues")?;
    let rows = query
        .query_map(rusqlite::params![scope, kind, id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .map_err(|_| "Cannot read download issues")?;
    let mut total = 0usize;
    let mut items = vec![];
    for row in rows {
        let (track, error, title, artist) = row.map_err(|_| "Cannot read download issues")?;
        if !ids.contains(&track) {
            continue;
        }
        if total >= offset as usize && items.len() < 100 {
            items.push(serde_json::json!({
                "trackId":track,
                "title":if title.is_empty() {format!("Track {track}")} else {title},
                "artist":artist,
                "error":error.unwrap_or_else(||"Could not download this track. Retry when Plex is available.".into())
            }));
        }
        total += 1;
    }
    Ok(serde_json::json!({"total":total,"items":items}))
}

#[tauri::command]
pub async fn remove_entity_download(
    context: PlexRequestContext,
    kind: String,
    id: i64,
    state: State<'_, PlexState>,
    db: State<'_, DbState>,
    downloads: State<'_, AudioDownloads>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    intents::check(&context.cache_scope, &kind, id)?;
    let guard = state.0.lock().await;
    let client = state.checked_cache_client(&context, &guard)?;
    let conn = db.0.lock().map_err(|_| "Download storage unavailable")?;
    let tx = conn
        .unchecked_transaction()
        .map_err(|_| "Cannot remove download intention")?;
    let unclaimed = intents::detach(&tx, &client.library_scope, &kind, id)?;
    for track in unclaimed {
        downloads.cancel_download(&client.library_scope, track)?;
        for binding in audio::bindings(&tx, &client.library_scope, track)? {
            downloads.cache().remove(&binding.cache_key)?;
        }
        audio::remove(&tx, &client.library_scope, track)?;
    }
    tx.commit().map_err(|_| "Cannot remove download intention")?;
    crate::download_library::schedule(app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn requested_playlist_publishes_complete_order_before_roster_without_disturbing_staging() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::schema::run_migrations(&conn).unwrap();
        let scope = format!("plex-{}", "a".repeat(64));
        let revision =
            intents::remember(&conn, &scope, "playlist", 8, "Playlist", &[1, 2], 3).unwrap();
        conn.execute("INSERT INTO plex_catalogue_playlist_members(scope,playlist_id,generation,position,document) VALUES(?1,8,'worker-pending',0,?2)",rusqlite::params![scope,json!({"type":"track","ratingKey":3}).to_string()]).unwrap();
        let source = json!({"type":"playlist","ratingKey":"8","title":"Playlist","leafCount":3,"customField":"retained"});
        let rows = vec![
            json!({"type":"track","ratingKey":"1","playlistItemID":50,"title":"One"}),
            json!({"type":"track","ratingKey":"1","playlistItemID":51,"title":"One"}),
            json!({"type":"track","ratingKey":"2","playlistItemID":52,"title":"Two"}),
        ];
        save_source(&conn, &scope, "playlist", 8, &revision, &source, &rows).unwrap();
        let page = crate::db::catalogue_query::query(
            &conn,
            &scope,
            "getPlaylistItems",
            &[json!("8"), json!(0), json!(100)],
        )
        .unwrap()
        .unwrap();
        assert_eq!(page.total, 3);
        assert_eq!(
            page.items
                .iter()
                .map(|i| i["rating_key"].as_i64().unwrap())
                .collect::<Vec<_>>(),
            vec![1, 1, 2]
        );
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM plex_catalogue_playlist_members WHERE generation='worker-pending'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(
            crate::db::catalogue::get(&conn, &scope, "playlist", 8)
                .unwrap()
                .unwrap()["customField"],
            "retained"
        );
        assert!(crate::db::catalogue_sync::task(&conn, &scope, "track")
            .unwrap()
            .is_none());
        assert_eq!(
            entity_members(&conn, &scope, "playlist", 8).unwrap(),
            (vec![1, 2], true, true)
        );
        // Hourly refresh keeps the intention token, but replaces its published
        // occurrences atomically instead of colliding with the old positions.
        save_source(&conn, &scope, "playlist", 8, &revision, &source, &rows[1..]).unwrap();
        let refreshed = crate::db::catalogue_query::query(
            &conn,
            &scope,
            "getPlaylistItems",
            &[json!("8"), json!(0), json!(100)],
        )
        .unwrap()
        .unwrap();
        assert_eq!(refreshed.total, 2);
        assert_eq!(refreshed.items.len(), 2);
    }

    #[test]
    fn status_reads_only_relevant_jobs_and_checks_shared_files_once() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::schema::run_migrations(&conn).unwrap();
        let scope = format!("plex-{}", "a".repeat(64));
        conn.execute("WITH RECURSIVE ids(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM ids WHERE id<10000) INSERT INTO audio_download_jobs(scope,track_id,revision,status,created_at,cache_key) SELECT ?1,id,'test','downloaded',1,'cache-'||id FROM ids",[&scope]).unwrap();
        conn.execute("UPDATE audio_download_jobs SET status='queued' WHERE track_id=3",[]).unwrap();
        intents::remember(&conn,&scope,"playlist",8,"Selected",&[1,2,3],3).unwrap();
        let mut checked = Vec::new();
        let statuses = read_statuses(&conn,&scope,vec![
            Entity {kind:"track".into(),id:1},Entity {kind:"playlist".into(),id:8},Entity {kind:"track".into(),id:99999}
        ],|key| {checked.push(key.to_owned());key == "cache-1"}).unwrap();
        checked.sort();assert_eq!(checked,vec!["cache-1","cache-2","cache-3"]);
        assert_eq!((statuses[1].total,statuses[1].downloaded,statuses[1].pending,statuses[1].failed),(3,1,1,1));
        assert_eq!((statuses[2].total,statuses[2].downloaded,statuses[2].failed),(1,0,0));
    }

    #[test]
    fn download_issues_name_only_this_collections_failed_tracks_and_page_results() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::schema::run_migrations(&conn).unwrap();
        let scope = format!("plex-{}", "a".repeat(64));
        let other_scope = format!("plex-{}", "b".repeat(64));
        let ids = (1..=103).collect::<Vec<_>>();
        intents::remember(&conn, &scope, "playlist", 8, "Playlist", &ids, 103).unwrap();
        audio::enqueue(&conn, &scope, &ids, 1).unwrap();
        audio::enqueue(&conn, &scope, &[999], 1).unwrap();
        audio::enqueue(&conn, &other_scope, &[1], 1).unwrap();
        conn.execute(
            "UPDATE audio_download_jobs SET status='error',error='Damaged audio'",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE audio_download_jobs SET status='downloaded' WHERE scope=?1 AND track_id=103",
            [&scope],
        )
        .unwrap();
        conn.execute(
            "UPDATE audio_download_members SET document=?2 WHERE scope=?1 AND track_id=1",
            rusqlite::params![
                scope,
                json!({"title":"Too Original","grandparentTitle":"Major Lazer"}).to_string()
            ],
        )
        .unwrap();
        audio::remember(
            &conn,
            &scope,
            &audio::Binding {
                track_id: 2,
                cache_key: format!("s1-{}", "c".repeat(64)),
                extension: "flac".into(),
                metadata: json!({"title":"Surface Tension","artistName":"CRAZY BLUES"}),
            },
            1,
        )
        .unwrap();
        let page = read_issues(&conn, &scope, "playlist", 8, 0).unwrap();
        assert_eq!(page["total"], 102);
        assert_eq!(page["items"].as_array().unwrap().len(), 100);
        assert_eq!(
            page["items"][0],
            json!({"trackId":1,"title":"Too Original","artist":"Major Lazer","error":"Damaged audio"})
        );
        assert_eq!(page["items"][1]["title"], "Surface Tension");
        assert_eq!(page["items"][1]["artist"], "CRAZY BLUES");
        assert_eq!(page["items"][2]["title"], "Track 3");
        let next = read_issues(&conn, &scope, "playlist", 8, 100).unwrap();
        assert_eq!(next["total"], 102);
        assert_eq!(next["items"].as_array().unwrap().len(), 2);
        assert_eq!(next["items"][0]["trackId"], 101);
        assert_eq!(
            read_issues(&conn, &scope, "playlist", 9, 0).unwrap()["total"],
            0
        );
        assert_eq!(
            read_issues(&conn, &other_scope, "playlist", 8, 0).unwrap()["total"],
            0
        );
    }
}
