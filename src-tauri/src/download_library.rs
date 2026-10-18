//! Portable explicit downloads. SQLite stays private; M3U paths stay relative.
use crate::{
    audio_engine::cache::{AudioCache, CacheStatus},
    db::DbState,
    offline_audio::AudioDownloads,
};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{Manager, State};

const DIRECTORY_KEY: &str = "downloads.directory.v1";
#[derive(Default)]
pub struct DownloadLibrary {
    gate: tokio::sync::Mutex<()>,
    scheduled: AtomicBool,
    dirty: AtomicBool,
    moving: AtomicBool,
    choosing: AtomicBool,
    move_error: Mutex<Option<String>>,
    export_error: Mutex<Option<String>>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageInfo {
    directory: String,
    default_directory: String,
    moving: bool,
    total_bytes: u64,
    tracks: usize,
    error: Option<String>,
}
fn default_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .audio_dir()
        .or_else(|_| app.path().home_dir().map(|p| p.join("Music")))
        .map(|p| p.join("Hibiki"))
        .map_err(|_| "The system Music folder is unavailable".into())
}
fn configured(conn: &rusqlite::Connection) -> Result<Option<PathBuf>, String> {
    Ok(crate::db::kv::get(conn, DIRECTORY_KEY)?.map(PathBuf::from))
}
pub fn initial_directory(
    app: &tauri::AppHandle,
    conn: &rusqlite::Connection,
) -> Result<PathBuf, String> {
    if let Some(path) = configured(conn)? {
        return Ok(path);
    }
    let legacy = app
        .path()
        .app_data_dir()
        .map_err(|_| "Application storage unavailable")?
        .join("downloads");
    if legacy.join("index.json").is_file() {
        return Ok(legacy);
    }
    default_directory(app)
}
fn record_error(target: &Mutex<Option<String>>, error: Option<String>) {
    if let Ok(mut state) = target.lock() {
        *state = error;
    }
}
#[tauri::command]
pub async fn download_storage_info(
    app: tauri::AppHandle,
    downloads: State<'_, AudioDownloads>,
    library: State<'_, DownloadLibrary>,
) -> Result<StorageInfo, String> {
    let cache = downloads.cache();
    let reading = cache.clone();
    let stats = tauri::async_runtime::spawn_blocking(move || reading.stats())
        .await
        .map_err(|_| "Could not read download storage")?;
    Ok(StorageInfo {
        directory:cache.directory().to_string_lossy().into_owned(),
        default_directory:default_directory(&app)?.to_string_lossy().into_owned(),
        moving:library.moving.load(Ordering::Acquire),total_bytes:stats.total_bytes,tracks:stats.file_count,
        error:library.move_error.lock().ok().and_then(|e|e.clone()).or_else(||library.export_error.lock().ok().and_then(|e|e.clone())).or_else(|| (stats.status!=CacheStatus::Ready).then(||"The download folder is unavailable. Reconnect the drive or restore its permissions, then retry.".into())),
    })
}
struct ResetFlag<'a>(&'a AtomicBool);
impl Drop for ResetFlag<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[tauri::command]
pub async fn download_storage_choose(app: tauri::AppHandle) -> Result<StorageInfo, String> {
    use tauri_plugin_dialog::DialogExt;
    let library = app.state::<DownloadLibrary>();
    if library.choosing.swap(true, Ordering::AcqRel) {
        return Err("A folder selection is already open".into());
    }
    let _choosing = ResetFlag(&library.choosing);
    let current = app.state::<AudioDownloads>().cache().directory().to_owned();
    let picker = app.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        picker
            .dialog()
            .file()
            .set_title("Choose a location for Hibiki downloads")
            .set_directory(current.parent().unwrap_or(&current))
            .blocking_pick_folder()
    })
    .await
    .map_err(|_| "Could not open the folder picker")?;
    if let Some(selected) = selected {
        let mut parent = selected.into_path().map_err(|_| "Choose a local folder")?;
        if parent.file_name().is_none_or(|name| name != "Hibiki") {
            parent.push("Hibiki");
        }
        if let Err(error) = move_to(&app, parent).await {
            record_error(&library.move_error, Some(error.clone()));
            return Err(error);
        }
        rebuild(&app).await?;
    }
    download_storage_info(app.clone(), app.state(), app.state()).await
}
#[tauri::command]
pub async fn download_storage_retry(app: tauri::AppHandle) -> Result<StorageInfo, String> {
    let destination = {
        let db = app.state::<DbState>();
        let conn = db.0.lock().map_err(|_| "Download settings unavailable")?;
        configured(&conn)?
    }
    .unwrap_or(default_directory(&app)?);
    reconcile_downloads(&app).await?;
    move_to(&app, destination).await?;
    resume_downloads(&app).await;
    rebuild(&app).await?;
    download_storage_info(app.clone(), app.state(), app.state()).await
}
#[tauri::command]
pub fn download_storage_open(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let root = app.state::<AudioDownloads>().cache().directory().to_owned();
    app.opener()
        .open_path(root.to_string_lossy(), None::<&str>)
        .map_err(|_| "Could not open the download folder".into())
}
async fn resume_downloads(app: &tauri::AppHandle) {
    let state = app.state::<crate::commands::PlexState>();
    if let Some(context) = state.current_request_context().await {
        let _ = crate::offline_audio::audio_download_resume(
            context,
            app.state(),
            app.state(),
            app.state(),
            app.clone(),
        )
        .await;
    }
}
async fn move_to(app: &tauri::AppHandle, destination: PathBuf) -> Result<(), String> {
    let library = app.state::<DownloadLibrary>();
    let _gate = library.gate.lock().await;
    let downloads = app.state::<AudioDownloads>();
    let source = downloads.cache();
    if source.directory() == destination
        || fs::canonicalize(&destination).is_ok_and(|p| p == source.directory())
    {
        record_error(&library.move_error, None);
        return Ok(());
    }
    if !destination.is_absolute() || destination.to_str().is_none() {
        return Err("Choose an absolute, Unicode download folder".into());
    }
    library.moving.store(true, Ordering::Release);
    let _moving = ResetFlag(&library.moving);
    downloads.interrupt_for_move();
    let _relocating = ResetFlag(&downloads.relocating);
    let worker = downloads.worker.clone();
    let _worker = worker.lock().await;
    let input = source.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let target = Arc::new(AudioCache::downloads(destination));
        if target.stats().status != CacheStatus::Ready {
            return Err(
                "The chosen download folder is unavailable or in use by another Hibiki instance"
                    .into(),
            );
        }
        if input.directory() == target.directory() {
            return Ok(target);
        }
        if input.directory().starts_with(target.directory())
            || target.directory().starts_with(input.directory())
        {
            return Err("Choose a download folder outside the current download folder".into());
        }
        input.copy_downloads_to(&target)?;
        Ok::<_, String>(target)
    })
    .await
    .unwrap_or_else(|_| Err("Could not move downloaded music".into()));
    let outcome = match result {
        Err(error) => Err(error),
        Ok(target) => {
            let saved = (|| {
                let db = app.state::<DbState>();
                let conn = db.0.lock().map_err(|_| "Download settings unavailable")?;
                crate::db::kv::set(
                    &conn,
                    DIRECTORY_KEY,
                    target
                        .directory()
                        .to_str()
                        .ok_or("Invalid download folder")?,
                )
            })();
            if let Err(error) = saved {
                Err(error)
            } else {
                downloads.replace_cache(target);
                let old = source.clone();
                let cleanup = tauri::async_runtime::spawn_blocking(move || {
                    let result = old.clear().map(|_| ()).and_then(|_| {
                        export(
                            &old,
                            Inventory {
                                songs: vec![],
                                playlists: vec![],
                            },
                        )
                    });
                    old.retire();
                    result
                })
                .await;
                record_error(
                    &library.move_error,
                    if matches!(cleanup, Ok(Ok(_))) {
                        None
                    } else {
                        Some("Downloads moved. Some files in the old folder are still open; the verified copies in the new folder are ready.".into())
                    },
                );
                Ok(())
            }
        }
    };
    drop(_worker);
    drop(_relocating);
    drop(_moving);
    drop(_gate);
    resume_downloads(app).await;
    outcome
}

pub fn start(app: tauri::AppHandle) {
    crate::background_jobs::advisory(crate::background_jobs::Lane::Refresh, "Checking downloaded music", async move {
        let desired = match app.state::<DbState>().read(configured).await {
            Ok(Some(path)) => Ok(path),
            Ok(None) => default_directory(&app),
            Err(error) => Err(error),
        };
        let outcome = match desired {
            Ok(path) => match reconcile_downloads(&app).await {
                Ok(()) => move_to(&app, path).await,
                Err(error) => Err(error),
            },
            Err(error) => Err(error),
        };
        if let Err(error) = outcome {
            record_error(&app.state::<DownloadLibrary>().move_error, Some(error));
        }
        resume_downloads(&app).await;
        schedule(app);
    });
}

async fn reconcile_downloads(app: &tauri::AppHandle) -> Result<(), String> {
    let library = app.state::<DownloadLibrary>();
    let _gate = library.gate.lock().await;
    let downloads = app.state::<AudioDownloads>();
    downloads.interrupt_for_move();
    let _relocating = ResetFlag(&downloads.relocating);
    let worker = downloads.worker.clone();
    let _worker = worker.lock().await;
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<DbState>();
        let conn = db.0.lock().map_err(|_| "Download storage unavailable")?;
        let tx = conn
            .unchecked_transaction()
            .map_err(|_| "Cannot reconcile download ownership")?;
        for (scope, id) in crate::db::download_entities::reconcile_legacy(&tx)? {
            for binding in crate::db::audio::bindings(&tx, &scope, id)? {
                app.state::<AudioDownloads>()
                    .cache()
                    .remove(&binding.cache_key)?;
            }
            crate::db::audio::remove(&tx, &scope, id)?;
        }
        tx.commit()
            .map_err(|_| "Cannot save repaired download ownership".into())
    })
    .await
    .map_err(|_| "Could not reconcile legacy downloads")?
}
struct ExportLease(tauri::AppHandle);
impl Drop for ExportLease {
    fn drop(&mut self) { self.0.state::<DownloadLibrary>().scheduled.store(false, Ordering::Release); }
}
pub fn schedule(app: tauri::AppHandle) {
    let library = app.state::<DownloadLibrary>();
    library.dirty.store(true, Ordering::Release);
    if library.scheduled.swap(true, Ordering::AcqRel) {
        return;
    }
    let lease = ExportLease(app.clone());
    crate::background_jobs::advisory(crate::background_jobs::Lane::Metadata, "Updating downloaded playlists and files", async move {
        let lease = lease;
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            app.state::<DownloadLibrary>()
                .dirty
                .store(false, Ordering::Release);
            let _ = rebuild(&app).await;
            if !app.state::<DownloadLibrary>().dirty.load(Ordering::Acquire) {
                break;
            }
        }
        drop(lease);
        if app.state::<DownloadLibrary>().dirty.load(Ordering::Acquire) {
            schedule(app.clone());
        }
    });
}
async fn rebuild(app: &tauri::AppHandle) -> Result<(), String> {
    let library = app.state::<DownloadLibrary>();
    let _gate = library.gate.lock().await;
    let app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let inventory = {
            let db = app.state::<DbState>();
            let conn = db.0.lock().map_err(|_| "Download metadata unavailable")?;
            inventory(&conn)?
        };
        export(&app.state::<AudioDownloads>().cache(), inventory)
    })
    .await
    .map_err(|_| "Could not update the downloaded music folder")?;
    record_error(&library.export_error, result.as_ref().err().cloned());
    result
}
struct Song {
    scope: String,
    id: i64,
    key: String,
    extension: String,
    metadata: Value,
}
struct Playlist {
    scope: String,
    id: i64,
    title: String,
    tracks: Vec<i64>,
}
struct Inventory {
    songs: Vec<Song>,
    playlists: Vec<Playlist>,
}
fn inventory(conn: &rusqlite::Connection) -> Result<Inventory, String> {
    let mut stmt=conn.prepare("SELECT j.scope,j.track_id,j.cache_key,a.extension,a.metadata FROM audio_download_jobs j JOIN local_audio a ON a.scope=j.scope AND a.track_id=j.track_id AND a.cache_key=j.cache_key WHERE j.status='downloaded' ORDER BY j.scope,j.track_id LIMIT 32769").map_err(|_|"Cannot read downloaded songs")?;
    let songs = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
            ))
        })
        .map_err(|_| "Cannot read downloaded songs")?
        .map(|row| {
            let (scope, id, key, extension, text) =
                row.map_err(|_| "Cannot read downloaded songs")?;
            Ok(Song {
                scope,
                id,
                key,
                extension,
                metadata: serde_json::from_str(&text)
                    .map_err(|_| "Invalid downloaded song metadata")?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    if songs.len() > 32768 {
        return Err("There are too many saved audio files to export".into());
    }
    let mut stmt=conn.prepare("SELECT scope,entity_id,title FROM audio_download_entities WHERE kind='playlist' ORDER BY scope,entity_id LIMIT 10001").map_err(|_|"Cannot read downloaded playlists")?;
    let entities = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|_| "Cannot read downloaded playlists")?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Cannot read downloaded playlists")?;
    if entities.len() > 10000 {
        return Err("There are too many downloaded playlists to export".into());
    }
    let mut playlists = vec![];
    for (scope, id, title) in entities {
        let mut stmt=conn.prepare("SELECT document FROM plex_catalogue_playlist_members WHERE scope=?1 AND playlist_id=?2 AND generation=(SELECT generation FROM plex_catalogue_playlist_versions WHERE scope=?1 AND playlist_id=?2) ORDER BY position LIMIT 10001").map_err(|_|"Cannot read playlist order")?;
        let rows = stmt
            .query_map(rusqlite::params![scope, id], |r| r.get::<_, String>(0))
            .map_err(|_| "Cannot read playlist order")?;
        let mut tracks = vec![];
        for row in rows {
            let text = row.map_err(|_| "Cannot read playlist order")?;
            let raw: Value = serde_json::from_str(&text).map_err(|_| "Invalid playlist order")?;
            tracks.push(
                crate::plex::catalogue::number(&raw["ratingKey"]).ok_or("Invalid playlist song")?,
            );
        }
        if tracks.len() > 10000 {
            return Err("This playlist exceeds the download limit".into());
        }
        playlists.push(Playlist {
            scope,
            id,
            title,
            tracks,
        });
    }
    Ok(Inventory { songs, playlists })
}
fn component(text: &str, fallback: &str, limit: usize) -> String {
    let mut result = String::new();
    for c in text.chars() {
        let c = if c.is_control() || "/\\:*?\"<>|".contains(c) {
            '_'
        } else {
            c
        };
        if result.len() + c.len_utf8() > limit {
            break;
        }
        result.push(c);
    }
    let result = result.trim().trim_end_matches(['.', ' ']);
    if result.is_empty() || result == "." || result == ".." {
        return fallback.into();
    }
    let upper = result
        .split('.')
        .next()
        .unwrap_or(result)
        .to_ascii_uppercase();
    if matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (upper.len() == 4
            && (upper.starts_with("COM") || upper.starts_with("LPT"))
            && matches!(upper.as_bytes()[3], b'1'..=b'9'))
    {
        format!("_{result}")
    } else {
        result.into()
    }
}
fn filename(song: &Song) -> String {
    let m = &song.metadata;
    let artist = component(m["artistName"].as_str().unwrap_or(""), "Unknown Artist", 64);
    let album = component(m["albumName"].as_str().unwrap_or(""), "Unknown Album", 64);
    let title = component(m["title"].as_str().unwrap_or(""), "Untitled", 96);
    let number = m["trackNumber"].as_u64().unwrap_or(0);
    let disc = m["discNumber"].as_u64().unwrap_or(1);
    let prefix = if disc > 1 {
        format!("{disc:02}-{number:02} - ")
    } else if number > 0 {
        format!("{number:02} - ")
    } else {
        String::new()
    };
    format!(
        "{artist}/{album}/{prefix}{title} [{}].{}",
        &song.key[song.key.len().saturating_sub(12)..],
        song.extension
    )
}
fn line(text: &str) -> String {
    text.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect()
}
fn owner(playlist: &Playlist) -> String {
    format!("#HIBIKI:{}:{}", playlist.scope, playlist.id)
}
fn m3u(
    playlist: &Playlist,
    songs: &HashMap<(&str, i64), &Song>,
    paths: &HashMap<String, PathBuf>,
    root: &Path,
) -> String {
    let mut output = format!(
        "#EXTM3U\n{}\n#PLAYLIST:{}\n",
        owner(playlist),
        line(&playlist.title)
    );
    for id in &playlist.tracks {
        let Some(song) = songs.get(&(playlist.scope.as_str(), *id)) else {
            continue;
        };
        let Some(path) = paths
            .get(&song.key)
            .and_then(|p| p.strip_prefix(root).ok())
            .and_then(Path::to_str)
        else {
            continue;
        };
        let duration = song.metadata["duration"]
            .as_u64()
            .map(|n| (n / 1000) as i64)
            .unwrap_or(-1);
        output.push_str(&format!(
            "#EXTINF:{duration},{} - {}\n../{}\n",
            line(
                song.metadata["artistName"]
                    .as_str()
                    .unwrap_or("Unknown Artist")
            ),
            line(song.metadata["title"].as_str().unwrap_or("Untitled")),
            path.replace('\\', "/")
        ));
    }
    output
}
fn export(cache: &AudioCache, inventory: Inventory) -> Result<(), String> {
    let mut seen = HashSet::new();
    for song in &inventory.songs {
        if seen.insert(&song.key) {
            cache.organize_download(&song.key, &filename(song))?;
        }
    }
    let paths = cache.download_paths()?;
    let root = cache.directory();
    let folder = root.join("Playlists");
    if !folder.exists() {
        fs::create_dir(&folder).map_err(|_| "Cannot create the playlist folder")?;
    }
    if crate::cache_files::directory_id(&folder).is_none() {
        return Err("The playlist folder cannot be a link".into());
    }
    let songs = inventory
        .songs
        .iter()
        .map(|s| ((s.scope.as_str(), s.id), s))
        .collect::<HashMap<_, _>>();
    let mut expected = HashMap::new();
    for playlist in &inventory.playlists {
        crate::db::download_entities::check(&playlist.scope, "playlist", playlist.id)?;
        let name = format!(
            "{} [{}-{}].m3u",
            component(&playlist.title, "Playlist", 96),
            &playlist.scope[5..17],
            playlist.id
        );
        let path = folder.join(name);
        let marker = owner(playlist);
        let text = m3u(playlist, &songs, &paths, root);
        let replacing = path.exists();
        if replacing {
            let mut file = crate::cache_files::open_regular_file(&path)
                .map_err(|_| "Cannot replace a linked or unavailable playlist file")?;
            let mut previous = String::new();
            std::io::Read::by_ref(&mut file)
                .take(4 * 1024 * 1024)
                .read_to_string(&mut previous)
                .map_err(|_| "Cannot read playlist file")?;
            if previous.lines().nth(1) != Some(&marker) {
                return Err("A playlist file already exists and is not managed by Hibiki".into());
            }
            if previous == text {
                expected.insert(path, marker);
                continue;
            }
        }
        let mut temp = tempfile::Builder::new()
            .prefix(".hibiki-playlist-")
            .tempfile_in(&folder)
            .map_err(|_| "Cannot write playlist file")?;
        temp.write_all(text.as_bytes())
            .map_err(|_| "Cannot write playlist file")?;
        temp.as_file()
            .sync_all()
            .map_err(|_| "Cannot save playlist file")?;
        if replacing {
            temp.persist(&path)
                .map_err(|_| "Cannot publish playlist file")?;
        } else {
            temp.persist_noclobber(&path)
                .map_err(|_| "A file appeared in the playlist destination")?;
        }
        expected.insert(path, marker);
    }
    let mut count = 0;
    for entry in fs::read_dir(&folder).map_err(|_| "Cannot read playlist folder")? {
        count += 1;
        if count > 20000 {
            return Err("The playlist export folder has too many files".into());
        }
        let path = entry.map_err(|_| "Cannot read playlist folder")?.path();
        if expected.contains_key(&path) || path.extension().is_none_or(|s| s != "m3u") {
            continue;
        }
        let Ok(file) = crate::cache_files::open_regular_file(&path) else {
            continue;
        };
        let mut text = String::new();
        let _ = file.take(512).read_to_string(&mut text);
        let marker = text.lines().nth(1).unwrap_or("");
        if let Some(identity) = marker.strip_prefix("#HIBIKI:") {
            if let Some((scope, id)) = identity.rsplit_once(':') {
                if id.parse::<i64>().ok().is_some_and(|id| {
                    crate::db::download_entities::check(scope, "playlist", id).is_ok()
                }) {
                    fs::remove_file(path).map_err(|_| "Cannot remove an obsolete playlist file")?;
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn song(id: i64, scope: &str, suffix: char) -> Song {
        Song {
            scope: scope.into(),
            id,
            key: format!("s1-{}", suffix.to_string().repeat(64)),
            extension: "flac".into(),
            metadata: json!({"title":"First\nsong","artistName":"あの/Artist","albumName":"An album","duration":123456,"trackNumber":1}),
        }
    }
    fn write(cache: &AudioCache, song: &Song) {
        let mut writer = cache.begin_write(&song.key, &song.extension).unwrap();
        writer.write_chunk(b"encoded music").unwrap();
        writer.finish(cache).unwrap();
    }
    #[test]
    fn m3u_preserves_order_duplicates_and_scope_and_only_lists_available_files() {
        let dir = tempfile::tempdir().unwrap();
        let scope = format!("plex-{}", "a".repeat(64));
        let other = format!("plex-{}", "b".repeat(64));
        let a = song(1, &scope, 'a');
        let mut b = song(2, &scope, 'b');
        b.metadata["title"] = json!("Second");
        let wrong = song(3, &other, 'c');
        let cache = AudioCache::downloads(dir.path().to_owned());
        for s in [&a, &b, &wrong] {
            write(&cache, s);
        }
        let playlist = Playlist {
            scope: scope.clone(),
            id: 8,
            title: "Favorites\n#injected".into(),
            tracks: vec![2, 1, 2, 3, 4],
        };
        export(
            &cache,
            Inventory {
                songs: vec![a, b, wrong],
                playlists: vec![playlist],
            },
        )
        .unwrap();
        let entries = fs::read_dir(dir.path().join("Playlists"))
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect::<Vec<_>>();
        assert_eq!(entries.len(), 1);
        let text = fs::read_to_string(&entries[0]).unwrap();
        assert!(text.starts_with("#EXTM3U\n#HIBIKI:"));
        assert!(text.contains("#PLAYLIST:Favorites #injected\n"));
        let paths = text
            .lines()
            .filter(|line| !line.starts_with('#'))
            .collect::<Vec<_>>();
        assert_eq!(paths.len(), 3);
        assert_eq!(paths[0], paths[2]);
        assert!(paths[0].contains("Second"));
        assert!(paths[1].contains("First_song"));
        for relative in paths {
            assert!(entries[0].parent().unwrap().join(relative).is_file());
            assert!(!relative.contains("http"));
        }
        assert!(!text.contains("\n#injected"));
        assert!(text.contains("#EXTINF:123,"));
    }
    #[test]
    fn filename_components_are_portable_unicode_bounded_and_not_windows_devices() {
        for (text, expected) in [
            ("CON", "_CON"),
            ("NUL.flac", "_NUL.flac"),
            ("../A:B", ".._A_B"),
            ("...", "Unknown"),
            ("あの", "あの"),
        ] {
            assert_eq!(component(text, "Unknown", 64), expected);
        }
        assert!(component(&"あ".repeat(300), "Unknown", 64).len() <= 64);
    }
    #[test]
    fn regeneration_removes_obsolete_managed_playlists_and_preserves_manual_files() {
        let dir = tempfile::tempdir().unwrap();
        let scope = format!("plex-{}", "a".repeat(64));
        let s = song(1, &scope, 'a');
        let cache = AudioCache::downloads(dir.path().to_owned());
        write(&cache, &s);
        export(
            &cache,
            Inventory {
                songs: vec![s],
                playlists: vec![Playlist {
                    scope: scope.clone(),
                    id: 1,
                    title: "Old title".into(),
                    tracks: vec![1],
                }],
            },
        )
        .unwrap();
        let folder = dir.path().join("Playlists");
        let old = fs::read_dir(&folder)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        fs::write(folder.join("Manual.m3u"), "#EXTM3U\nmanual.flac\n").unwrap();
        export(
            &cache,
            Inventory {
                songs: vec![song(1, &scope, 'a')],
                playlists: vec![Playlist {
                    scope,
                    id: 1,
                    title: "New title".into(),
                    tracks: vec![1],
                }],
            },
        )
        .unwrap();
        assert!(!old.exists());
        export(
            &cache,
            Inventory {
                songs: vec![],
                playlists: vec![],
            },
        )
        .unwrap();
        assert_eq!(fs::read_dir(&folder).unwrap().count(), 1);
        assert!(folder.join("Manual.m3u").exists());
    }
    #[test]
    fn inventory_reads_verified_playlist_occurrences_instead_of_unique_claims() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::schema::run_migrations(&conn).unwrap();
        let scope = format!("plex-{}", "a".repeat(64));
        crate::db::download_entities::remember(
            &conn,
            &scope,
            "playlist",
            8,
            "Favorites",
            &[1, 2],
            3,
        )
        .unwrap();
        conn.execute("INSERT INTO plex_catalogue_playlist_versions(scope,playlist_id,generation,total,saved_at) VALUES(?1,8,'download:test',3,1)",[&scope]).unwrap();
        for (position, id) in [2, 1, 2].iter().enumerate() {
            conn.execute("INSERT INTO plex_catalogue_playlist_members(scope,playlist_id,generation,position,document) VALUES(?1,8,'download:test',?2,?3)",rusqlite::params![scope,position as i64,json!({"ratingKey":id.to_string()}).to_string()]).unwrap();
        }
        let inventory = inventory(&conn).unwrap();
        assert_eq!(inventory.playlists[0].tracks, vec![2, 1, 2]);
    }
}
