//! Plex browsing and focused offline metadata. No background library mirror.
use crate::{
    commands::{PlexRequestContext, PlexState},
    db::DbState,
    plex::{catalogue::number, PlexClient},
};
use std::{
    collections::{HashMap, HashSet},
    sync::Mutex,
};
use tauri::{Manager, State};
const PAGE: i64 = 200;
pub struct CatalogueSync {
    verified: Mutex<HashMap<(u64, String), (std::time::Instant, i64)>>,
}
impl CatalogueSync {
    pub fn new() -> Self {
        Self {
            verified: Mutex::new(HashMap::new()),
        }
    }
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
            }
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
pub(crate) fn playlist_revision(item: &serde_json::Value) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(
            serde_json::to_vec(&serde_json::json!([
                item["leafCount"],
                item["duration"],
                item["smart"],
                item["content"]
            ]))
            .unwrap_or_default()
        ))
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
    let mut timing = crate::performance::Timer::new(&method);
    let offline = {
        let guard = state.0.lock().await;
        state.checked_cache_client(&context, &guard)?.offline_only
    };
    timing.phase("owner_wait");
    // Derived browse indexes can also finish from local data while offline.
    let scope = context.cache_scope.clone();
    let downloaded = downloads.cache();
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
        let result =
            crate::db::catalogue_query::query(conn, &scope, &method, &args).and_then(|page| {
                match page {
                    Some(page) => Ok(Some(page)),
                    None => crate::db::focused_library::related_page(conn, &scope, &method, &args),
                }
            });
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
    let downloaded = downloads.cache();
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
    // A visited page is cached by the bounded browsing snapshot store. Listing
    // the library must not rebuild the retired native mirror as a side effect.
    let items = page
        .items
        .iter()
        .map(|raw| {
            if number(&raw["ratingKey"]).is_none_or(|id| id <= 0)
                || raw["type"].as_str() != Some(kind.as_str())
                || number(&raw["librarySectionID"]).is_some_and(|id| id != section)
            {
                return Err("Plex returned a different library item".into());
            }
            crate::db::catalogue_query::project(&kind, raw.clone())
        })
        .collect::<Result<Vec<_>, String>>()?;
    {
        let state = app.state::<PlexState>();
        let guard = state.0.lock().await;
        state.checked_client(&context, &guard)?;
    }
    Ok(
        serde_json::json!({"items":items,"total":page.total.unwrap_or(offset+page.items.len() as i64),"offset":offset}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
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
