//! Provider playlist manifests share explicit audio claims, jobs, validation,
//! relocation and export with Plex. Only public metadata crosses persistence.
use crate::{
    commands::{PlexRequestContext, PlexState},
    db::{audio, download_entities, DbState},
    offline_audio::AudioDownloads,
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
};
use tauri::{Emitter, Manager};

pub(crate) fn identity(value: &str) -> i64 {
    let hash = Sha256::digest(value.as_bytes());
    ((u64::from_be_bytes(hash[..8].try_into().unwrap()) & ((1_u64 << 53) - 1)).max(1)) as i64
}
pub(crate) fn youtube_scope(app: &tauri::AppHandle) -> Result<String, String> {
    Ok(format!(
        "ytmusic-{}",
        hex::encode(Sha256::digest(
            crate::ytmusic::playback::cache_owner(app)?.as_bytes()
        ))
    ))
}
async fn owner(
    app: &tauri::AppHandle,
    context: Option<&PlexRequestContext>,
    online: bool,
) -> Result<String, String> {
    let youtube = youtube_scope(app)?;
    if let Some(context) = context {
        let plex = app.state::<PlexState>();
        let guard = plex.0.lock().await;
        if online {
            plex.checked_client(context, &guard)?;
        } else {
            plex.checked_cache_client(context, &guard)?;
        }
        Ok(format!("{}:{}", context.cache_scope, youtube))
    } else {
        Ok(youtube)
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Member {
    pub scope: String,
    pub id: i64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedPlaylist {
    metadata: Value,
    status: Status,
    issues: Vec<Issue>,
}
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    kind: &'static str,
    id: i64,
    known: bool,
    total: usize,
    downloaded: usize,
    pending: usize,
    failed: usize,
    requested: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    track_id: i64,
    title: String,
    artist: String,
    error: String,
}

fn clean_track(mut track: Value) -> Result<Value, String> {
    let object = track.as_object_mut().ok_or("Invalid download metadata")?;
    object.remove("_providerData");
    // Search associations can contain another provider's opaque/live DTO. The
    // explicit download stores the chosen recording's public metadata only.
    object.remove("counterparts");
    object.insert("streamUrl".into(), Value::Null);
    crate::db::offline::check_payload(&track, 0)?;
    if serde_json::to_vec(&track)
        .map_err(|_| "Invalid metadata")?
        .len()
        > 64 * 1024
    {
        return Err("Download metadata is too large".into());
    }
    Ok(track)
}
fn video_id(track: &Value) -> Result<&str, String> {
    track["id"]
        .as_str()
        .and_then(|id| id.strip_prefix("ytmusic:"))
        .filter(|id| {
            id.len() == 11
                && id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
        })
        .ok_or_else(|| "Invalid YouTube Music song".into())
}

#[tauri::command]
pub async fn playlist_download_save(
    app: tauri::AppHandle,
    context: Option<PlexRequestContext>,
    id: String,
    mut metadata: Value,
    tracks: Vec<Value>,
) -> Result<SavedPlaylist, String> {
    if id.is_empty() || id.len() > 512 || tracks.is_empty() || tracks.len() > 10000 {
        return Err("Choose a playlist with 1–10,000 songs".into());
    }
    let manifest_owner = owner(&app, context.as_ref(), true).await?;
    let youtube = youtube_scope(&app)?;
    let cache_owner = crate::ytmusic::playback::cache_owner(&app)?;
    let entity_id = identity(&format!("playlist:{manifest_owner}:{id}"));
    let title = metadata["title"].as_str().unwrap_or("Playlist").to_owned();
    let mut members = vec![];
    let mut cleaned = vec![];
    let mut groups: BTreeMap<String, Vec<i64>> = BTreeMap::new();
    for track in tracks {
        let track = clean_track(track)?;
        let source = track["id"].as_str().ok_or("Invalid playlist song")?;
        let (scope, track_id) = if source.starts_with("ytmusic:") {
            (youtube.clone(), identity(video_id(&track)?))
        } else {
            let context = context
                .as_ref()
                .ok_or("Connect this playlist's Plex library")?;
            let track_id = source
                .parse::<i64>()
                .ok()
                .filter(|id| *id > 0)
                .ok_or("Unsupported download source")?;
            (context.cache_scope.clone(), track_id)
        };
        groups.entry(scope.clone()).or_default().push(track_id);
        members.push(Member {
            scope,
            id: track_id,
        });
        cleaned.push(track);
    }
    metadata["tracks"] = Value::Array(cleaned.clone());
    crate::db::offline::check_payload(&metadata, 0)?;
    let text = serde_json::to_string(&metadata).map_err(|_| "Invalid playlist metadata")?;
    if text.len() > 32 * 1024 * 1024 {
        return Err("Playlist metadata exceeds the download limit".into());
    }
    let db = app.state::<DbState>();
    let source_app = app.clone();
    let groups_to_save = groups.clone();
    let saved_id = id.clone();
    let write = move |conn: &rusqlite::Connection, _scope: &str| {
        let groups = &groups_to_save;
        let id = &saved_id;
        let app = &source_app;
        if youtube_scope(app)? != youtube {
            return Err("YouTube Music connection changed".into());
        }
        let mut revisions = BTreeMap::new();
        for (track, member) in cleaned
            .iter()
            .zip(&members)
            .filter(|(_, member)| member.scope == youtube)
        {
            if let Some(old) = audio::latest(&conn, &youtube, member.id)? {
                if old.metadata["id"] != track["id"] {
                    return Err("Download source identity collision".into());
                }
                // Preserve the validated encoding on retry; a metadata snapshot
                // must never relabel an existing WebM download as .dat.
                if old.cache_key
                    == crate::ytmusic::playback::cache_key(&cache_owner, video_id(track)?)
                {
                    continue;
                }
            }
            let video = video_id(track)?;
            audio::remember(
                &conn,
                &youtube,
                &audio::Binding {
                    track_id: member.id,
                    cache_key: crate::ytmusic::playback::cache_key(&cache_owner, video),
                    extension: "dat".into(),
                    metadata: track.clone(),
                },
                crate::ytmusic::now() * 1000,
            )?;
        }
        for (scope, ids) in groups {
            let mut seen = HashSet::new();
            let unique: Vec<_> = ids.iter().copied().filter(|id| seen.insert(*id)).collect();
            let revision = download_entities::remember(
                &conn,
                scope,
                "playlist",
                entity_id,
                &title,
                &unique,
                ids.len() as i64,
            )?;
            revisions.insert(scope.clone(), revision);
            if scope == &youtube {
                for id in &unique {
                    if let Some(mut job) = audio::jobs_for_id(&conn, scope, *id)? {
                        if job.status == "downloaded"
                            && job.cache_key.as_ref().is_none_or(|key| {
                                app.state::<AudioDownloads>().cache().lookup(key).is_none()
                            })
                        {
                            job.status = "error".into();
                            audio::update(&conn, scope, &job)?;
                        }
                    }
                }
                for batch in unique.chunks(256) {
                    audio::enqueue(&conn, scope, batch, crate::ytmusic::now() * 1000)?;
                }
            }
        }
        conn.execute("INSERT INTO provider_playlist_downloads(owner,id,entity_id,metadata,members,revision) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(owner,id) DO UPDATE SET metadata=excluded.metadata,members=excluded.members,revision=excluded.revision",
            params![manifest_owner,id,entity_id,text,serde_json::to_string(&members).map_err(|_| "Invalid playlist membership")?,uuid::Uuid::new_v4().to_string()]).map_err(|_| "Cannot save downloaded playlist")?;
        Ok(revisions)
    };
    let revisions = if let Some(context) = &context {
        crate::offline_commands::owned_write(&app, context, true, write).await?
    } else {
        db.write(move |conn| write(conn, "")).await?
    };
    if let Some(context) = &context {
        if let Some(ids) = groups.get(&context.cache_scope) {
            for batch in ids.chunks(256) {
                crate::offline_audio::enqueue_download_batch(
                    context.clone(),
                    batch.to_vec(),
                    app.state::<PlexState>(),
                    app.state::<DbState>(),
                    app.clone(),
                    Some(("playlist", entity_id, &revisions[&context.cache_scope])),
                )
                .await?;
            }
        }
    }
    start_youtube_worker(app.clone()).await?;
    playlist_download_read(app, context, id)
        .await?
        .ok_or_else(|| "Downloaded playlist was superseded".into())
}

#[tauri::command]
pub async fn playlist_download_read(
    app: tauri::AppHandle,
    context: Option<PlexRequestContext>,
    id: String,
) -> Result<Option<SavedPlaylist>, String> {
    let owner = owner(&app, context.as_ref(), false).await?;
    let cache = app.state::<AudioDownloads>().cache();
    let db = app.state::<DbState>();
    db.read(move |conn| read(conn, &owner, &id, &cache)).await
}
fn read(
    conn: &rusqlite::Connection,
    owner: &str,
    id: &str,
    cache: &Arc<crate::audio_engine::cache::AudioCache>,
) -> Result<Option<SavedPlaylist>, String> {
    read_page(conn, owner, id, cache, 0, 50)
}
fn read_page(
    conn: &rusqlite::Connection,
    owner: &str,
    id: &str,
    cache: &Arc<crate::audio_engine::cache::AudioCache>,
    issue_offset: usize,
    issue_limit: usize,
) -> Result<Option<SavedPlaylist>, String> {
    let saved: Option<(String, String, i64)> = conn.query_row("SELECT metadata,members,entity_id FROM provider_playlist_downloads WHERE owner=?1 AND id=?2", params![owner,id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional().map_err(|_| "Cannot read downloaded playlist")?;
    let Some((metadata, members, entity_id)) = saved else {
        return Ok(None);
    };
    let mut metadata: Value =
        serde_json::from_str(&metadata).map_err(|_| "Invalid saved playlist")?;
    let members: Vec<Member> =
        serde_json::from_str(&members).map_err(|_| "Invalid saved playlist membership")?;
    let mut status = Status {
        kind: "playlist",
        id: entity_id,
        known: true,
        total: members.len(),
        requested: true,
        ..Default::default()
    };
    let mut issues = vec![];
    let tracks = metadata["tracks"]
        .as_array_mut()
        .ok_or("Invalid saved playlist")?;
    struct Fact {
        available: bool,
        status: String,
        error: Option<String>,
        metadata: Value,
    }
    let mut facts = std::collections::HashMap::new();
    let mut groups: BTreeMap<&str, HashSet<i64>> = BTreeMap::new();
    for member in &members {
        groups.entry(&member.scope).or_default().insert(member.id);
    }
    for (scope, ids) in groups {
        let ids = serde_json::to_string(&ids).map_err(|_| "Invalid saved playlist membership")?;
        let mut query = conn.prepare("SELECT j.track_id,j.status,j.cache_key,j.error,a.metadata FROM audio_download_jobs j LEFT JOIN local_audio a ON a.scope=j.scope AND a.track_id=j.track_id AND a.cache_key=j.cache_key WHERE j.scope=?1 AND j.track_id IN (SELECT value FROM json_each(?2))").map_err(|_| "Cannot read playlist downloads")?;
        let rows = query
            .query_map(params![scope, ids], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            })
            .map_err(|_| "Cannot read playlist downloads")?;
        for row in rows {
            let (id, status, key, error, metadata) =
                row.map_err(|_| "Cannot read playlist downloads")?;
            facts.insert(
                (scope.to_owned(), id),
                Fact {
                    available: key.as_ref().is_some_and(|key| cache.lookup(key).is_some()),
                    status,
                    error,
                    metadata: metadata
                        .and_then(|text| serde_json::from_str(&text).ok())
                        .unwrap_or(Value::Null),
                },
            );
        }
    }
    for (member, track) in members.iter().zip(tracks) {
        let fact = facts.get(&(member.scope.clone(), member.id));
        track["mediaInfo"]["offlineAvailable"] = Value::Bool(false);
        if fact.is_some_and(|fact| fact.available) {
            status.downloaded += 1;
            if let Some(fact) = fact {
                for field in ["codec", "bitrate", "mediaInfo"] {
                    if !fact.metadata[field].is_null() {
                        track[field] = fact.metadata[field].clone();
                    }
                }
            }
            track["mediaInfo"]["offlineAvailable"] = Value::Bool(true);
            if track["id"]
                .as_str()
                .is_some_and(|id| id.starts_with("ytmusic:"))
            {
                track["streamUrl"] = track["id"].clone();
            }
        } else if fact
            .is_some_and(|fact| matches!(fact.status.as_str(), "queued" | "downloading" | "paused"))
        {
            status.pending += 1;
        } else {
            status.failed += 1;
            if status.failed > issue_offset && issues.len() < issue_limit {
                issues.push(Issue {
                    track_id: member.id,
                    title: track["title"].as_str().unwrap_or("Unavailable song").into(),
                    artist: track["artistName"].as_str().unwrap_or("").into(),
                    error: fact.and_then(|fact| fact.error.clone()).unwrap_or_else(|| {
                        "Audio is missing. Reconnect and retry downloads.".into()
                    }),
                });
            }
        }
    }
    Ok(Some(SavedPlaylist {
        metadata,
        status,
        issues,
    }))
}

#[tauri::command]
pub async fn playlist_download_issues(
    app: tauri::AppHandle,
    context: Option<PlexRequestContext>,
    id: String,
    offset: usize,
) -> Result<Value, String> {
    if offset > 10000 {
        return Err("Invalid download issue page".into());
    }
    let owner = owner(&app, context.as_ref(), false).await?;
    let cache = app.state::<AudioDownloads>().cache();
    app.state::<DbState>()
        .read(move |conn| {
            let saved = read_page(conn, &owner, &id, &cache, offset, 50)?
                .ok_or("Downloaded playlist was removed")?;
            Ok(serde_json::json!({"items":saved.issues,"total":saved.status.failed}))
        })
        .await
}

#[tauri::command]
pub async fn playlist_download_remove(
    app: tauri::AppHandle,
    context: Option<PlexRequestContext>,
    id: String,
) -> Result<(), String> {
    let owner = owner(&app, context.as_ref(), false).await?;
    let db = app.state::<DbState>();
    let operation_app = app.clone();
    db.write(move |conn| {
        let downloads=operation_app.state::<AudioDownloads>();
        let record: Option<(String, i64)> = conn.query_row("SELECT members,entity_id FROM provider_playlist_downloads WHERE owner=?1 AND id=?2",params![owner,id],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|_| "Cannot remove downloaded playlist")?;
        if let Some((members, entity_id)) = record {
            let members: Vec<Member> =
                serde_json::from_str(&members).map_err(|_| "Invalid saved playlist")?;
            let scopes: HashSet<_> = members.iter().map(|member| member.scope.as_str()).collect();
            for scope in scopes {
                for track in download_entities::detach(&conn, scope, "playlist", entity_id)? {
                    downloads.cancel_download(scope, track)?;
                    let bindings = audio::bindings(&conn, scope, track)?;
                    audio::remove(&conn, scope, track)?;
                    for binding in bindings {
                        downloads.cache().remove(&binding.cache_key)?;
                    }
                }
            }
            conn.execute(
                "DELETE FROM provider_playlist_downloads WHERE owner=?1 AND id=?2",
                params![owner, id],
            )
            .map_err(|_| "Cannot remove downloaded playlist")?;
        }
        Ok(())
    }).await?;
    crate::download_library::schedule(app);
    Ok(())
}

pub(crate) async fn start_youtube_worker(app: tauri::AppHandle) -> Result<(), String> {
    let scope = youtube_scope(&app)?;
    let queued_scope = scope.clone();
    let due=app.state::<DbState>().read(move |conn|conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM audio_download_jobs WHERE scope=?1 AND status IN ('queued','paused','downloading'))",
        [queued_scope],|row|row.get::<_,bool>(0)).map_err(|_|"Cannot inspect requested YTM downloads".into())).await?;
    if !due {
        return Ok(());
    }
    let Ok(generation) = app
        .state::<Arc<crate::ytmusic::YoutubeMusic>>()
        .generation()
    else {
        return Ok(());
    };
    // Each admitted request has a durable turn. A new request cannot be lost
    // while the previous worker is finishing its last empty-queue check.
    crate::background_jobs::submit(
        &app,
        crate::background_jobs::Task::YoutubeDownloads { scope, generation },
        false,
        std::time::Duration::ZERO,
    )
    .await?;
    Ok(())
}

pub(crate) async fn run_youtube_download_worker(
    app: &tauri::AppHandle,
    scope: String,
    generation: u64,
) -> Result<(), String> {
    let state = app.state::<Arc<crate::ytmusic::YoutubeMusic>>();
    let downloads = app.state::<AudioDownloads>();
    let gate = downloads.worker.clone();
    let _gate = gate.lock().await;
    if !state.owns(generation) || youtube_scope(app)? != scope {
        return Ok(());
    }
    let db = app.state::<DbState>();
    let captured = scope.clone();
    db.write(move |conn| audio::resume(conn, &captured)).await?;
    loop {
        if !state.owns(generation)
            || youtube_scope(app)? != scope
            || downloads.relocating.load(Ordering::Acquire)
        {
            return Ok(());
        }
        let captured = scope.clone();
        let captured_app = app.clone();
        let next = db
            .write(move |conn| {
                if !captured_app
                    .state::<Arc<crate::ytmusic::YoutubeMusic>>()
                    .owns(generation)
                    || youtube_scope(&captured_app)? != captured
                {
                    return Ok(None);
                }
                let Some(mut job) = audio::next(conn, &captured)? else {
                    return Ok(None);
                };
                let cancel = Arc::new(AtomicBool::new(false));
                *captured_app
                    .state::<AudioDownloads>()
                    .active
                    .lock()
                    .map_err(|_| "Download worker unavailable")? =
                    Some((captured.clone(), job.track_id, cancel.clone()));
                job.status = "downloading".into();
                audio::update(conn, &captured, &job)?;
                Ok(Some((job, cancel)))
            })
            .await?;
        let Some((mut job, cancel)) = next else {
            return Ok(());
        };
        let received = Arc::new(AtomicU64::new(0));
        let total = Arc::new(AtomicU64::new(0));
        let transfer_job = job.clone();
        let transfer = async {
            let captured = scope.clone();
            let track_id = transfer_job.track_id;
            let mut binding = db
                .read(move |conn| audio::latest(conn, &captured, track_id))
                .await?
                .ok_or("Missing download metadata")?;
            let captured = scope.clone();
            let summary = db
                .read(move |conn| audio::activity(conn, &captured))
                .await?;
            crate::background_jobs::report(
                "Downloading audio",
                binding.metadata["title"].as_str().map(str::to_owned),
                summary.downloaded,
                Some(summary.downloaded + summary.queued + summary.downloading),
                "songs",
            )
            .await?;
            let video = video_id(&binding.metadata)?.to_owned();
            let (resolved, stream) = crate::ytmusic::extractor::resolve(app, &video).await?;
            if resolved != generation || !state.owns(generation) {
                return Err("YouTube Music session changed".into());
            }
            let mut source = crate::audio_engine::source::MediaSource::new(
                crate::ytmusic::extractor::media_client()?
                    .get(stream.url)
                    .headers(stream.headers),
                None,
            )?;
            source.extension = stream.extension;
            source.cache_key = binding.cache_key.clone();
            let cache = downloads.cache();
            let automatic = app
                .state::<crate::audio_engine::bridge::AudioEngineState>()
                .0
                .cache()
                .clone();
            let writer = crate::offline_audio::stage_download(
                &source,
                None,
                binding.metadata["duration"].as_u64().unwrap_or(0),
                &cache,
                &automatic,
                &cancel,
                &received,
                &total,
            )
            .await?;
            binding.extension = source.extension;
            binding.metadata["codec"] = stream.codec.into();
            binding.metadata["bitrate"] = stream.bitrate.into();
            let captured = scope.clone();
            let publishing = app.clone();
            let cancelled = cancel.clone();
            let revision = transfer_job.revision.clone();
            db.write(move |conn| {
                if !publishing
                    .state::<Arc<crate::ytmusic::YoutubeMusic>>()
                    .owns(generation)
                    || youtube_scope(&publishing)? != captured
                    || cancelled.load(Ordering::Acquire)
                {
                    return Err("Download cancelled".into());
                }
                if audio::jobs_for_id(conn, &captured, track_id)?
                    .is_none_or(|job| job.revision != revision)
                {
                    return Err("Download superseded".into());
                }
                writer.finish(&cache)?;
                audio::remember(conn, &captured, &binding, crate::ytmusic::now() * 1000)?;
                Ok(binding.cache_key)
            })
            .await
        };
        tokio::pin!(transfer);
        let result = loop {
            tokio::select! {
                result=&mut transfer=>break result,
                _=tokio::time::sleep(std::time::Duration::from_millis(250))=>{
                    if !state.owns(generation) || cancel.load(Ordering::Acquire) || downloads.relocating.load(Ordering::Acquire) { cancel.store(true,Ordering::Release);break Err("Download paused".into()); }
                    let mut progress=job.clone();progress.received=received.load(Ordering::Acquire);progress.total=match total.load(Ordering::Acquire){0=>None,value=>Some(value)};
                    if let Ok(conn)=db.0.try_lock(){let _=audio::update(&conn,&scope,&progress);}
                }
            }
        };
        job.received = received.load(Ordering::Acquire);
        job.total = match total.load(Ordering::Acquire) {
            0 => None,
            value => Some(value),
        };
        match result {
            Ok(key) => {
                job.status = "downloaded".into();
                job.cache_key = Some(key);
                job.error = None;
            }
            Err(_) if cancel.load(Ordering::Acquire) || !state.owns(generation) => {
                job.status = "paused".into();
                job.error = None;
            }
            Err(_) => {
                job.status = "error".into();
                job.error=Some("Could not save this song. Check YouTube Music and available storage, then retry.".into());
            }
        }
        let finished = job.clone();
        let captured = scope.clone();
        let retained = db
            .write(move |conn| audio::update(conn, &captured, &finished))
            .await;
        *downloads
            .active
            .lock()
            .map_err(|_| "Download worker unavailable")? = None;
        let _ = app.emit_to("main", "playlist-downloads-updated", ());
        crate::download_library::schedule(app.clone());
        retained?;
        if cancel.load(Ordering::Acquire) || !state.owns(generation) {
            return Ok(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn metadata_drops_playback_credentials_and_rejects_secret_bearing_urls() {
        let clean = clean_track(json!({"id":"ytmusic:abcdefghijk","title":"Tone","streamUrl":"ytmusic:abcdefghijk","_providerData":{"private":"discarded"}})).unwrap();
        assert!(clean.get("_providerData").is_none());
        assert!(clean["streamUrl"].is_null());
        let linked=clean_track(json!({"id":"ytmusic:abcdefghijk","counterparts":{"plex":{"_providerData":{"private":"discarded"}},"ytmusic":{"streamUrl":"ytmusic:abcdefghijk"}}})).unwrap();
        assert!(linked.get("counterparts").is_none());
        assert!(clean_track(
            json!({"id":"ytmusic:abcdefghijk","thumbUrl":"https://example.test/?token=synthetic"})
        )
        .is_err());
        assert!(video_id(&json!({"id":"ytmusic:../private"})).is_err());
        assert_ne!(identity("abcdefghijk"), identity("lmnopqrstuv"));
        assert!(identity("abcdefghijk") > 0 && identity("abcdefghijk") < (1_i64 << 53));
    }
    #[test]
    fn downloaded_provider_playlists_reopen_without_sessions_and_retain_order_and_missing_audio() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("library.sqlite");
        let scope = format!("ytmusic-{}", "a".repeat(64));
        let key = format!("s1-{}", "b".repeat(64));
        let track = json!({"id":"ytmusic:abcdefghijk","title":"Tone","artistName":"Fixture","duration":1000,"streamUrl":null});
        {
            let conn = rusqlite::Connection::open(&database).unwrap();
            crate::db::schema::run_migrations(&conn).unwrap();
            audio::remember(
                &conn,
                &scope,
                &audio::Binding {
                    track_id: 1,
                    cache_key: key.clone(),
                    extension: "wav".into(),
                    metadata: track.clone(),
                },
                1,
            )
            .unwrap();
            audio::enqueue(&conn, &scope, &[1], 2).unwrap();
            let mut job = audio::next(&conn, &scope).unwrap().unwrap();
            job.status = "downloaded".into();
            job.cache_key = Some(key.clone());
            audio::update(&conn, &scope, &job).unwrap();
            let cache =
                crate::audio_engine::cache::AudioCache::downloads(directory.path().join("audio"));
            let mut writer = cache.begin_write(&key, "wav").unwrap();
            writer
                .write_chunk(
                    &crate::audio_engine::deck::decode::tests::generate_test_wav(48000, 2, 1.0),
                )
                .unwrap();
            writer.finish(&cache).unwrap();
            let members = vec![
                Member {
                    scope: scope.clone(),
                    id: 1
                };
                2
            ];
            conn.execute(
                "INSERT INTO provider_playlist_downloads VALUES(?1,?2,?3,?4,?5,?6)",
                params![
                    "owner",
                    "ytmusic:VLPL_list",
                    8,
                    json!({"title":"Saved","tracks":[track.clone(),track]}).to_string(),
                    serde_json::to_string(&members).unwrap(),
                    "revision"
                ],
            )
            .unwrap();
        }
        let conn = rusqlite::Connection::open(database).unwrap();
        let cache = Arc::new(crate::audio_engine::cache::AudioCache::downloads(
            directory.path().join("audio"),
        ));
        let page = read(&conn, "owner", "ytmusic:VLPL_list", &cache)
            .unwrap()
            .unwrap();
        assert_eq!(
            (
                page.status.total,
                page.status.downloaded,
                page.status.failed
            ),
            (2, 2, 0)
        );
        assert_eq!(
            page.metadata["tracks"][0]["id"],
            page.metadata["tracks"][1]["id"]
        );
        assert_eq!(
            page.metadata["tracks"][0]["streamUrl"],
            "ytmusic:abcdefghijk"
        );
        assert!(
            read(&conn, "different-account", "ytmusic:VLPL_list", &cache)
                .unwrap()
                .is_none()
        );
        cache.remove(&key).unwrap();
        let missing = read(&conn, "owner", "ytmusic:VLPL_list", &cache)
            .unwrap()
            .unwrap();
        assert_eq!((missing.status.downloaded, missing.status.failed), (0, 2));
        assert_eq!(missing.metadata["tracks"].as_array().unwrap().len(), 2);
        assert_eq!(missing.issues.len(), 2);
        let tracks=(0..123).map(|index|json!({"id":"ytmusic:abcdefghijk","title":format!("Issue {index}"),"artistName":"Fixture"})).collect::<Vec<_>>();
        let members = vec![
            Member {
                scope: scope.clone(),
                id: 1
            };
            123
        ];
        conn.execute(
            "UPDATE provider_playlist_downloads SET metadata=?1,members=?2",
            params![
                json!({"title":"Saved","tracks":tracks}).to_string(),
                serde_json::to_string(&members).unwrap()
            ],
        )
        .unwrap();
        let second = read_page(&conn, "owner", "ytmusic:VLPL_list", &cache, 50, 50)
            .unwrap()
            .unwrap();
        assert_eq!(second.status.failed, 123);
        assert_eq!(second.issues.len(), 50);
        assert_eq!(second.issues[0].title, "Issue 50");
        assert_eq!(
            read_page(&conn, "owner", "ytmusic:VLPL_list", &cache, 100, 50)
                .unwrap()
                .unwrap()
                .issues
                .len(),
            23
        );
    }
}
