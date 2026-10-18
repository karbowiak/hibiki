//! Startup-only defaults. Plex remains authoritative; cached absence never creates anything.
use crate::{
    commands::{PlexRequestContext, PlexState},
    db::DbState,
    plex::{MediaContainer, Playlist, PlexClient},
};
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashSet},
    future::Future,
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};

#[derive(Default)]
pub struct Bootstrap {
    seen: Mutex<HashSet<(String, u64)>>,
    lane: tokio::sync::Mutex<()>,
}

struct Template {
    key: &'static str,
    title: &'static str,
    sort_title: Option<&'static str>,
    summary: &'static str,
    query: &'static [(&'static str, &'static str)],
    poster: &'static [u8],
}
const TEMPLATES: &[Template] = &[
    Template {
        key: "liked-tracks",
        title: "❤️ Tracks",
        sort_title: Some("\u{fe0f} Tracks"),
        summary: "All your highly rated tracks, in one convenient place.",
        query: &[
            ("type", "10"),
            ("sort", "lastRatedAt:desc"),
            ("group", "guid"),
            ("having", "min(album.originallyAvailableAt)"),
            ("track.userRating>>", "1"),
        ],
        poster: include_bytes!("../resources/default-playlists/liked-tracks.png"),
    },
    Template {
        key: "all-music",
        title: "All Music",
        sort_title: None,
        summary: "The easiest way to play or shuffle your entire collection.",
        query: &[("type", "10")],
        poster: include_bytes!("../resources/default-playlists/all-music.png"),
    },
    Template {
        key: "fresh-liked",
        title: "Fresh ❤️",
        sort_title: None,
        summary: "Tracks you love but haven't heard lately.",
        query: &[
            ("type", "10"),
            ("track.lastViewedAt<<", "-1mon"),
            ("track.userRating>>", "4"),
            ("group", "guid"),
            ("having", "min(album.originallyAvailableAt)"),
            ("sort", "lastViewedAt"),
        ],
        poster: include_bytes!("../resources/default-playlists/fresh-liked.png"),
    },
];

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default)]
struct Progress {
    attempted_at: u64,
    id: Option<i64>,
    baseline_poster: Option<String>,
    metadata_done: bool,
    poster_done: bool,
    poster_started: bool,
    baseline_inventory: Vec<String>,
    poster_baseline_captured: bool,
    complete: bool,
}
type Journal = BTreeMap<String, Progress>;
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn number(v: Option<&Value>) -> Option<i64> {
    v.and_then(|v| v.as_i64().or_else(|| v.as_str()?.parse().ok()))
}
fn title_key(title: &str) -> String {
    title
        .replace(['\u{fe0f}', '\u{fe0e}'], "")
        .replace(['❤', '♥', '🧡'], "<3")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}
fn query(template: &Template) -> String {
    url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(template.query.iter().copied())
        .finish()
}

/// Smart content is an encoded library:// URI in current PMS, a server:// URI in older releases.
fn content_location(content: &str) -> Option<(i64, BTreeMap<String, String>)> {
    let content = if let Some((_, encoded)) = content.split_once("/directory/") {
        url::form_urlencoded::parse(format!("value={encoded}").as_bytes())
            .next()?
            .1
            .into_owned()
    } else if let Some((_, path)) = content.split_once("/com.plexapp.plugins.library") {
        path.to_owned()
    } else {
        content.to_owned()
    };
    let parsed = if content.starts_with('/') {
        url::Url::parse(&format!("http://library.invalid{content}")).ok()?
    } else {
        url::Url::parse(&content).ok()?
    };
    let section = parsed
        .path()
        .strip_prefix("/library/sections/")?
        .strip_suffix("/all")?
        .parse()
        .ok()?;
    Some((
        section,
        parsed
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect(),
    ))
}
fn matches_name(playlist: &Playlist, template: &Template, section: i64) -> bool {
    title_key(&playlist.title) == title_key(template.title)
        && playlist.playlist_type == "audio"
        && !playlist.radio
        && (!playlist.smart
            || playlist
                .content
                .as_deref()
                .and_then(content_location)
                .map_or(true, |(id, _)| id == section))
}
fn matches_definition(playlist: &Playlist, template: &Template, section: i64) -> bool {
    matches_name(playlist, template, section)
        && playlist.smart
        && playlist
            .content
            .as_deref()
            .and_then(content_location)
            .is_some_and(|(id, actual)| {
                id == section
                    && actual
                        == template
                            .query
                            .iter()
                            .map(|(k, v)| (k.to_string(), v.to_string()))
                            .collect()
            })
}
fn poster(playlist: &Playlist) -> Option<String> {
    playlist
        .thumb
        .clone()
        .or_else(|| playlist.composite.clone())
}

/// Only a complete, internally consistent fresh listing is allowed to prove absence.
async fn roster(client: &PlexClient) -> Result<Vec<Playlist>> {
    let mut result = Vec::new();
    let mut expected = None;
    let mut ids = HashSet::new();
    loop {
        let offset = result.len();
        let value: Value = client.get(&format!("/playlists?playlistType=audio&X-Plex-Container-Start={offset}&X-Plex-Container-Size=256")).await?;
        let total =
            number(value.get("totalSize")).context("Plex omitted the complete playlist count")?;
        ensure!((0..=100000).contains(&total), "Invalid Plex playlist count");
        ensure!(
            number(value.get("offset")) == Some(offset as i64),
            "Plex returned the wrong playlist page"
        );
        if let Some(previous) = expected {
            ensure!(previous == total, "Plex playlists changed during setup");
        }
        expected = Some(total);
        let rows = value.get("Metadata").and_then(Value::as_array);
        let empty = Vec::new();
        let rows = if total == 0 {
            rows.unwrap_or(&empty)
        } else {
            rows.context("Plex omitted playlist metadata")?
        };
        ensure!(
            number(value.get("size")) == Some(rows.len() as i64) && rows.len() <= 256,
            "Invalid Plex playlist page"
        );
        for row in rows {
            let item: Playlist = serde_json::from_value(row.clone())?;
            ensure!(
                item.rating_key > 0 && ids.insert(item.rating_key),
                "Plex repeated an invalid playlist identifier"
            );
            result.push(item);
        }
        ensure!(
            result.len() <= total as usize,
            "Plex returned conflicting playlist totals"
        );
        if result.len() == total as usize {
            return Ok(result);
        }
        ensure!(
            !rows.is_empty(),
            "Plex returned an incomplete playlist listing"
        );
    }
}
async fn item(client: &PlexClient, id: i64) -> Result<Playlist> {
    let container: MediaContainer<Playlist> =
        client.get(&format!("/library/metadata/{id}")).await?;
    ensure!(
        container.metadata.len() == 1,
        "Plex returned ambiguous playlist metadata"
    );
    let item = container.metadata.into_iter().next().unwrap();
    ensure!(item.rating_key == id, "Plex returned a different playlist");
    Ok(item)
}
async fn selected_posters(client: &PlexClient, id: i64) -> Result<Vec<String>> {
    let value: Value = client
        .get(&format!("/library/metadata/{id}/posters"))
        .await?;
    let values = value.get("Metadata").or_else(|| value.get("Photo"));
    let empty = Vec::new();
    let entries = if number(value.get("size")) == Some(0) {
        values.and_then(Value::as_array).unwrap_or(&empty)
    } else {
        values
            .and_then(Value::as_array)
            .context("Plex omitted poster inventory")?
    };
    ensure!(
        entries.len() <= 200,
        "Plex poster inventory exceeds its limit"
    );
    let mut selected = Vec::new();
    for entry in entries {
        if entry.get("selected").and_then(Value::as_bool) != Some(true)
            && number(entry.get("selected")) != Some(1)
        {
            continue;
        }
        let key = entry
            .get("ratingKey")
            .and_then(Value::as_str)
            .context("Plex omitted selected poster identity")?;
        selected.push(crate::plex::artwork_inventory::candidate_id(
            crate::plex::artwork_inventory::ArtworkRole::Poster,
            key,
        ));
    }
    selected.sort();
    Ok(selected)
}
async fn save(db: &DbState, key: &str, journal: &Journal) -> Result<()> {
    let key = key.to_owned();
    let bytes = serde_json::to_string(journal)?;
    db.write(move |conn| crate::db::kv::set(conn, &key, &bytes))
        .await
        .map_err(anyhow::Error::msg)
}

async fn run<F, Fut>(
    client: &PlexClient,
    section: i64,
    db: &DbState,
    current: F,
) -> Result<(usize, bool)>
where
    F: Fn() -> Fut,
    Fut: Future<Output = bool>,
{
    ensure!(
        !client.offline_only && current().await,
        "Plex default setup was superseded"
    );
    let sections = client.get_all_sections().await?;
    let library = sections
        .iter()
        .find(|s| s.key == section && s.section_type == "artist")
        .context("Plex music library unavailable")?;
    ensure!(
        client.library_scope == client.cache_scope_for_library(section, library.uuid.as_deref())
            || client.library_scope == client.cache_scope_for_library(section, None),
        "Plex library changed"
    );
    let key = format!("default-playlists.v1:{}", client.library_scope);
    let read_key = key.clone();
    let saved = db
        .read(move |conn| crate::db::kv::get(conn, &read_key))
        .await
        .map_err(anyhow::Error::msg)?;
    let mut journal: Journal = saved
        .map(|text| serde_json::from_str(&text))
        .transpose()
        .context("Saved default playlist setup is invalid")?
        .unwrap_or_default();
    let mut playlists = roster(client).await?;
    let mut changed = 0;
    let mut pending = false;
    for template in TEMPLATES {
        ensure!(current().await, "Plex default setup was superseded");
        let mut progress = journal.get(template.key).cloned().unwrap_or_default();
        let mut created_now = false;
        let matching: Vec<_> = playlists
            .iter()
            .filter(|p| matches_name(p, template, section))
            .cloned()
            .collect();
        if progress
            .id
            .is_some_and(|id| !playlists.iter().any(|p| p.rating_key == id))
        {
            // Known, confirmed playlists may have been deliberately deleted.
            progress = Progress::default();
        }
        if !matching.is_empty()
            && (progress.id.is_none() && progress.attempted_at == 0 || progress.complete)
        {
            continue;
        }
        if progress.id.is_none() && progress.attempted_at > 0 {
            // A lost create reply is reconciled, never immediately replayed.
            let exact: Vec<_> = matching
                .iter()
                .filter(|p| matches_definition(p, template, section))
                .collect();
            if exact.len() == 1 {
                progress.id = Some(exact[0].rating_key);
                progress.baseline_poster = poster(exact[0]);
            } else if !matching.is_empty() {
                continue;
            } else if now().saturating_sub(progress.attempted_at) < 60 {
                pending = true;
                continue;
            }
            // After the prior request's deadline, this complete fresh listing
            // proves the synchronous Plex create did not leave a playlist.
        }
        if progress.id.is_none() {
            // Recheck immediately before a create; another client may have added it.
            playlists = roster(client).await?;
            if playlists.iter().any(|p| matches_name(p, template, section)) {
                continue;
            }
            progress = Progress {
                attempted_at: now(),
                ..Default::default()
            };
            journal.insert(template.key.into(), progress.clone());
            save(db, &key, &journal).await?;
            ensure!(current().await, "Plex default setup was superseded");
            let uri = format!(
                "server://{}/com.plexapp.plugins.library/library/sections/{section}/all?{}",
                client.machine_identifier,
                query(template)
            );
            let response: Result<MediaContainer<Playlist>> = client
                .create_playlist_once(&[
                    ("title", template.title),
                    ("type", "audio"),
                    ("smart", "1"),
                    ("uri", &uri),
                ])
                .await;
            match response {
                Ok(container)
                    if container.metadata.len() == 1 && container.metadata[0].rating_key > 0 =>
                {
                    let created = &container.metadata[0];
                    ensure!(
                        matches_name(created, template, section),
                        "Plex created a different playlist"
                    );
                    progress.id = Some(created.rating_key);
                    progress.baseline_poster = poster(created);
                    created_now = true;
                }
                _ => {
                    pending = true;
                    continue;
                }
            }
            journal.insert(template.key.into(), progress.clone());
            save(db, &key, &journal).await?;
        }
        let id = progress.id.context("Missing created playlist identifier")?;
        let actual = item(client, id).await?;
        // Once users rename or alter our newly created playlist, their edits win.
        if !matches_definition(&actual, template, section) {
            continue;
        }
        if !progress.poster_baseline_captured && !progress.poster_started {
            let selected = selected_posters(client, id).await?;
            // Capture a new playlist's generated poster before editing its description.
            // On recovery, a selected custom poster is conservatively preserved.
            if created_now || selected.is_empty() && poster(&actual) == progress.baseline_poster {
                progress.baseline_inventory = selected;
                progress.baseline_poster = poster(&actual);
                progress.poster_baseline_captured = true;
                journal.insert(template.key.into(), progress.clone());
                save(db, &key, &journal).await?;
            }
        }
        if !progress.metadata_done {
            ensure!(current().await, "Plex default setup was superseded");
            let mut params = vec![("summary", template.summary), ("summary.locked", "1")];
            if let Some(sort) = template.sort_title {
                params.extend([("titleSort", sort), ("titleSort.locked", "1")]);
            }
            // Do not overwrite a description entered after an interrupted setup.
            if actual.summary.as_deref().unwrap_or("").is_empty()
                || actual.summary.as_deref() == Some(template.summary)
            {
                let before_poster = poster(&actual);
                client
                    .put_metadata_params_once(&format!("/playlists/{id}"), &params)
                    .await?;
                let verified = item(client, id).await?;
                ensure!(
                    verified.summary.as_deref() == Some(template.summary)
                        && template
                            .sort_title
                            .map_or(true, |sort| verified.title_sort.as_deref() == Some(sort)),
                    "Plex did not confirm default playlist metadata"
                );
                if progress.poster_baseline_captured
                    && !progress.poster_started
                    && before_poster == progress.baseline_poster
                    && selected_posters(client, id).await? == progress.baseline_inventory
                {
                    // Our metadata PUT may refresh Plex's generated composite URL.
                    progress.baseline_poster = poster(&verified);
                }
            }
            progress.metadata_done = true;
            journal.insert(template.key.into(), progress.clone());
            save(db, &key, &journal).await?;
        }
        if !progress.poster_done {
            let actual = item(client, id).await?;
            let selected = selected_posters(client, id).await?;
            let completed_upload = progress.poster_started
                && !selected.is_empty()
                && selected != progress.baseline_inventory;
            if progress.poster_baseline_captured
                && selected == progress.baseline_inventory
                && poster(&actual) == progress.baseline_poster
                && !completed_upload
            {
                if !progress.poster_started {
                    progress.poster_started = true;
                    journal.insert(template.key.into(), progress.clone());
                    save(db, &key, &journal).await?;
                }
                ensure!(current().await, "Plex default setup was superseded");
                client
                    .mutate_params_once(
                        reqwest::Method::POST,
                        &format!("/library/metadata/{id}/posters"),
                        &[],
                        Some(template.poster.to_vec()),
                        Some("image/png"),
                    )
                    .await?;
                let verified = item(client, id).await?;
                let selection = selected_posters(client, id).await?;
                ensure!(
                    poster(&verified).is_some()
                        && (poster(&verified) != progress.baseline_poster
                            || !selection.is_empty() && selection != progress.baseline_inventory),
                    "Plex did not confirm default playlist artwork"
                );
            }
            // An interrupted upload or a user's custom poster is retained.
            progress.poster_done = true;
        }
        progress.complete = true;
        journal.insert(template.key.into(), progress);
        save(db, &key, &journal).await?;
        changed += 1;
    }
    Ok((changed, pending))
}

pub fn start(app: tauri::AppHandle, context: PlexRequestContext, section: i64) {
    if section <= 0 {
        return;
    }
    let owner = (context.cache_scope.clone(), context.connection_revision);
    if app.state::<Bootstrap>().seen.lock().is_ok_and(|seen| seen.contains(&owner)) { return; }
    crate::background_jobs::advisory_once(format!("default-playlists:{}:{}:{section}", owner.0, owner.1),
        crate::background_jobs::Lane::Sync, "Preparing default Plex playlists", async move {
        let bootstrap = app.state::<Bootstrap>();
        let owner = (context.cache_scope.clone(), context.connection_revision);
        if !bootstrap
            .seen
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(owner)
        {
            return;
        }
        let _lane = bootstrap.lane.lock().await;
        let state = app.state::<PlexState>();
        let current = || async {
            state.current_request_context().await.is_some_and(|c| {
                c.cache_scope == context.cache_scope
                    && c.connection_revision == context.connection_revision
            })
        };
        let operation = async {
            let client = {
                let guard = state.0.lock().await;
                state
                    .checked_client(&context, &guard)
                    .map_err(anyhow::Error::msg)?
                    .clone()
            };
            let directory = app.path().app_config_dir()?;
            let settings = crate::plex::load_settings(&directory)?;
            ensure!(
                settings.section_id == section && settings.token == client.token,
                "Plex settings changed"
            );
            // Require positive ownership proof. Shared/read-only servers are never written.
            let account = if settings.plex_account_token.is_empty() {
                &client.token
            } else {
                &settings.plex_account_token
            };
            let resources = tokio::time::timeout(
                Duration::from_secs(10),
                crate::plextv::get_resources(&client.client_id, account),
            )
            .await??;
            if !resources.iter().any(|r| {
                r.owned
                    && r.client_identifier == client.machine_identifier
                    && (r.access_token.as_deref() == Some(client.token.as_str())
                        || account == &client.token)
            }) {
                return Ok(());
            }
            ensure!(current().await, "Plex default setup was superseded");
            let data = app.path().app_data_dir()?;
            let lock = std::fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .open(data.join("default-playlists.lock"))?;
            // Also serialize multiple Hibiki processes; crashing releases this OS lock.
            if lock.try_lock().is_err() {
                return Ok(());
            }
            let db = app.state::<DbState>();
            for attempt in 0..2 {
                let (changed, pending) = run(&client, section, &db, &current).await?;
                if changed > 0 && current().await {
                    let _ = app.emit("plex-default-playlists-updated", &context);
                }
                if !pending || attempt > 0 {
                    break;
                }
                tokio::time::sleep(Duration::from_secs(60)).await;
                if !current().await {
                    break;
                }
            }
            Ok::<_, anyhow::Error>(())
        }
        .await;
        if let Err(error) = operation {
            tracing::warn!("Default playlist setup did not finish: {error}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[derive(Default)]
    struct Remote {
        rows: BTreeMap<i64, Value>,
        selected: BTreeMap<i64, Vec<String>>,
        creates: usize,
        uploads: usize,
        edits: usize,
        partial: bool,
        lose_create_reply: bool,
        reject_upload: bool,
    }
    fn playlist(template: &Template, id: i64) -> Value {
        json!({"ratingKey":id.to_string(),"playlistType":"audio","type":"playlist","title":template.title,
            "smart":true,"content":format!("server://fixture-server/com.plexapp.plugins.library/library/sections/5/all?{}",query(template)),
            "composite":format!("/playlists/{id}/composite/generated"),"leafCount":0})
    }
    struct Fixture {
        client: PlexClient,
        db: DbState,
        remote: Arc<Mutex<Remote>>,
        alive: Arc<AtomicBool>,
        task: tokio::task::JoinHandle<()>,
        _directory: tempfile::TempDir,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.alive.store(false, Ordering::Release);
            self.task.abort();
        }
    }
    async fn fixture(remote: Remote) -> Fixture {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut client = PlexClient::new(crate::plex::PlexClientConfig {
            base_url: format!("http://{}/proxy", listener.local_addr().unwrap()),
            token: "fixture-token".into(),
            ..Default::default()
        })
        .unwrap();
        client.machine_identifier = "fixture-server".into();
        client.library_scope = client.cache_scope_for_library(5, Some("fixture-library"));
        let remote = Arc::new(Mutex::new(remote));
        let state = remote.clone();
        let alive = Arc::new(AtomicBool::new(true));
        let running = alive.clone();
        let task = tokio::spawn(async move {
            while running.load(Ordering::Acquire) {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let mut bytes = Vec::new();
                let mut chunk = [0; 8192];
                let boundary = loop {
                    let count = socket.read(&mut chunk).await.unwrap();
                    if count == 0 {
                        break None;
                    }
                    bytes.extend_from_slice(&chunk[..count]);
                    assert!(bytes.len() < 9 * 1024 * 1024);
                    if let Some(pos) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                        break Some(pos + 4);
                    }
                };
                let Some(boundary) = boundary else { continue };
                let header = String::from_utf8(bytes[..boundary].to_vec()).unwrap();
                let length = header
                    .lines()
                    .find_map(|line| {
                        line.split_once(':').and_then(|(key, value)| {
                            key.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().unwrap())
                        })
                    })
                    .unwrap_or(0);
                assert!(length < 8 * 1024 * 1024);
                while bytes.len() < boundary + length {
                    let count = socket.read(&mut chunk).await.unwrap();
                    assert!(count > 0);
                    bytes.extend_from_slice(&chunk[..count]);
                }
                let first = header
                    .lines()
                    .next()
                    .unwrap()
                    .split_whitespace()
                    .collect::<Vec<_>>();
                let uri = url::Url::parse(&format!("http://fixture{}", first[1])).unwrap();
                let path = uri.path().strip_prefix("/proxy").unwrap();
                let params = uri.query_pairs().into_owned().collect::<BTreeMap<_, _>>();
                let (status, body, lose_reply) = {
                    let mut state = state.lock().unwrap();
                    match (first[0], path) {
                        ("GET", "/library/sections") => (
                            200,
                            json!({"Directory":[{"key":"5","type":"artist","uuid":"fixture-library"}]}),
                            false,
                        ),
                        ("GET", "/playlists") => {
                            let rows = state.rows.values().cloned().collect::<Vec<_>>();
                            (
                                200,
                                json!({"size":rows.len(),"totalSize":rows.len()+usize::from(state.partial),"offset":0,"Metadata":rows}),
                                false,
                            )
                        }
                        ("POST", "/playlists") => {
                            assert_eq!(params["smart"], "1");
                            assert_eq!(params["type"], "audio");
                            let template = TEMPLATES
                                .iter()
                                .find(|t| t.title == params["title"])
                                .unwrap();
                            let (section, actual) = content_location(&params["uri"]).unwrap();
                            assert_eq!(section, 5);
                            assert_eq!(
                                actual,
                                template
                                    .query
                                    .iter()
                                    .map(|(k, v)| (k.to_string(), v.to_string()))
                                    .collect()
                            );
                            let id = 100 + state.creates as i64;
                            let value = playlist(template, id);
                            state.rows.insert(id, value.clone());
                            // PMS may have an automatically selected poster on a fresh playlist.
                            state
                                .selected
                                .insert(id, vec!["metadata://generated".into()]);
                            state.creates += 1;
                            let lose = std::mem::take(&mut state.lose_create_reply);
                            (200, json!({"Metadata":[value]}), lose)
                        }
                        (method, _) => {
                            let id = path
                                .split('/')
                                .find_map(|part| part.parse::<i64>().ok())
                                .unwrap();
                            if path.ends_with("/posters") {
                                assert!(path.starts_with("/library/metadata/"));
                                if method == "POST" {
                                    let template = TEMPLATES
                                        .iter()
                                        .find(|t| t.title == state.rows[&id]["title"])
                                        .unwrap();
                                    assert_eq!(
                                        &bytes[boundary..boundary + length],
                                        template.poster
                                    );
                                    state.uploads += 1;
                                    if std::mem::take(&mut state.reject_upload) {
                                        (400, json!({}), false)
                                    } else {
                                        state
                                            .selected
                                            .insert(id, vec!["upload://reference".into()]);
                                        state.rows.get_mut(&id).unwrap()["composite"] =
                                            json!(format!("/playlists/{id}/composite/reference"));
                                        (200, json!({}), false)
                                    }
                                } else {
                                    assert_eq!(method, "GET");
                                    let rows = state
                                        .selected
                                        .get(&id)
                                        .cloned()
                                        .unwrap_or_default()
                                        .iter()
                                        .map(|key| json!({"ratingKey":key,"selected":true}))
                                        .collect::<Vec<_>>();
                                    (200, json!({"size":rows.len(),"Metadata":rows}), false)
                                }
                            } else if method == "PUT" {
                                assert_eq!(path, format!("/playlists/{id}"));
                                state.edits += 1;
                                let value = state.rows.get_mut(&id).unwrap();
                                value["summary"] = json!(params["summary"]);
                                if let Some(title) = params.get("titleSort") {
                                    value["titleSort"] = json!(title)
                                }
                                value["composite"] =
                                    json!(format!("/playlists/{id}/composite/metadata-edited"));
                                (200, json!({}), false)
                            } else {
                                assert_eq!(method, "GET");
                                assert_eq!(path, format!("/library/metadata/{id}"));
                                (200, json!({"Metadata":[state.rows[&id].clone()]}), false)
                            }
                        }
                    }
                };
                if lose_reply {
                    continue;
                }
                let body = json!({"MediaContainer":body}).to_string();
                let reply=format!("HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
                socket.write_all(reply.as_bytes()).await.unwrap();
            }
        });
        let directory = tempfile::tempdir().unwrap();
        let db = DbState::open(&directory.path().join("defaults.db")).unwrap();
        Fixture {
            client,
            db,
            remote,
            alive,
            task,
            _directory: directory,
        }
    }
    fn all_present() -> Remote {
        Remote {
            rows: TEMPLATES
                .iter()
                .enumerate()
                .map(|(i, t)| (i as i64 + 1, playlist(t, i as i64 + 1)))
                .collect(),
            ..Default::default()
        }
    }
    #[test]
    fn original_templates_are_portable_and_heart_spellings_are_equivalent() {
        assert_eq!(title_key("❤️ Tracks"), title_key("<3 Tracks"));
        assert_eq!(title_key("Fresh 🧡"), title_key("Fresh <3"));
        for template in TEMPLATES {
            let original = format!("/library/sections/5/all?{}", query(template));
            let encoded =
                url::form_urlencoded::byte_serialize(original.as_bytes()).collect::<String>();
            let (section, pairs) =
                content_location(&format!("library://library/directory/{encoded}")).unwrap();
            assert_eq!(section, 5);
            assert_eq!(
                pairs,
                template
                    .query
                    .iter()
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect()
            );
            assert!(template.poster.starts_with(b"\x89PNG\r\n\x1a\n"));
        }
    }
    #[tokio::test]
    async fn complete_existing_roster_and_user_edits_are_never_changed() {
        let mut remote = all_present();
        remote.rows.get_mut(&1).unwrap()["title"] = json!("<3 Tracks");
        remote.rows.get_mut(&1).unwrap()["summary"] = json!("My custom description");
        remote.rows.get_mut(&1).unwrap()["content"] = json!("unrecognized-custom-filter");
        let f = fixture(remote).await;
        assert_eq!(
            run(&f.client, 5, &f.db, || async { true }).await.unwrap(),
            (0, false)
        );
        let state = f.remote.lock().unwrap();
        assert_eq!((state.creates, state.edits, state.uploads), (0, 0, 0));
    }
    #[tokio::test]
    async fn creates_only_missing_defaults_with_exact_posters_then_reconnect_is_idempotent() {
        for missing in [1, 3] {
            let mut remote = all_present();
            for id in 1..=missing {
                remote.rows.remove(&id);
            }
            let f = fixture(remote).await;
            assert_eq!(
                run(&f.client, 5, &f.db, || async { true }).await.unwrap(),
                (missing as usize, false)
            );
            assert_eq!(
                run(&f.client, 5, &f.db, || async { true }).await.unwrap(),
                (0, false)
            );
            let state = f.remote.lock().unwrap();
            assert_eq!(
                (state.creates, state.edits, state.uploads),
                (missing as usize, missing as usize, missing as usize)
            );
        }
    }
    #[tokio::test]
    async fn partial_offline_and_retired_connection_never_admit_writes() {
        let f = fixture(Remote {
            partial: true,
            ..Default::default()
        })
        .await;
        assert!(run(&f.client, 5, &f.db, || async { true }).await.is_err());
        assert!(run(&f.client, 5, &f.db, || async { false }).await.is_err());
        let mut offline = f.client.clone();
        offline.offline_only = true;
        assert!(run(&offline, 5, &f.db, || async { true }).await.is_err());
        let state = f.remote.lock().unwrap();
        assert_eq!((state.creates, state.edits, state.uploads), (0, 0, 0));
    }
    #[tokio::test]
    async fn lost_create_reply_is_reconciled_without_creating_twice() {
        let mut remote = all_present();
        remote.rows.remove(&1);
        remote.lose_create_reply = true;
        let f = fixture(remote).await;
        assert_eq!(
            run(&f.client, 5, &f.db, || async { true }).await.unwrap(),
            (0, true)
        );
        run(&f.client, 5, &f.db, || async { true }).await.unwrap();
        assert_eq!(f.remote.lock().unwrap().creates, 1);
    }
    #[tokio::test]
    async fn failed_poster_upload_resumes_on_the_known_id() {
        let mut remote = all_present();
        remote.rows.remove(&1);
        remote.reject_upload = true;
        let f = fixture(remote).await;
        assert!(run(&f.client, 5, &f.db, || async { true }).await.is_err());
        run(&f.client, 5, &f.db, || async { true }).await.unwrap();
        let state = f.remote.lock().unwrap();
        assert_eq!((state.creates, state.edits, state.uploads), (1, 1, 2));
    }
}
