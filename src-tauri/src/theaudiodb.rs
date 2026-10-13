//! Optional premium V2 GET-only enrichment. Keys never leave private native settings.
use crate::{
    http_response::{BoundedResponseExt, MAX_JSON_BYTES},
    metadata_service_settings::{ServiceSettings, Status},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{path::PathBuf, sync::Arc, time::Duration};
use tauri::Manager;
use tokio::sync::{Mutex, Semaphore};
const BASE: &str = "https://www.theaudiodb.com/api/v2/json/";
pub struct TheAudioDbState {
    settings: ServiceSettings,
    gate: Mutex<Option<tokio::time::Instant>>,
    cooldown: std::sync::Mutex<Option<tokio::time::Instant>>,
    admission: Semaphore,
    client: reqwest::Client,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    fn serve(replies: Vec<(u16, Value)>) -> (String, std::thread::JoinHandle<Vec<String>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let task = std::thread::spawn(move || {
            let mut requests = vec![];
            for (code, value) in replies {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut bytes = vec![];
                loop {
                    let mut byte = [0];
                    socket.read_exact(&mut byte).unwrap();
                    bytes.push(byte[0]);
                    if bytes.ends_with(b"\r\n\r\n") {
                        break;
                    }
                }
                requests.push(String::from_utf8(bytes).unwrap());
                let body = value.to_string();
                write!(socket,"HTTP/1.1 {code} Result\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            }
            requests
        });
        (format!("http://{address}/api/v2/json/"), task)
    }
    fn album() -> Lookup {
        Lookup {
            kind: "album".into(),
            artist: "A & B".into(),
            title: Some("Title / 日本".into()),
            mbid: None,
        }
    }
    fn row() -> Value {
        json!({"idAlbum":"12","strAlbum":"Title / 日本","strArtist":"A & B","strDescription":"Description","strGenre":"Rock","intYearReleased":"2024","strAlbumThumb":"https://r2.theaudiodb.com/images/album/thumb.jpg"})
    }
    #[tokio::test]
    async fn real_v2_header_search_detail_and_exact_identity() {
        let (base, server) = serve(vec![
            (200, json!({"search":[row()]})),
            (200, json!({"lookup":[row()]})),
        ]);
        let state = TheAudioDbState::default();
        let result = state
            .lookup(
                &base,
                "revision",
                &album(),
                "fictional-premium-key",
                &|| async { true },
            )
            .await
            .unwrap();
        let ResultDto::Ready { item } = result else {
            panic!("expected verified album")
        };
        assert_eq!(item.fields["releaseDate"], "2024");
        assert_eq!(item.posters.len(), 1);
        let requests = server.join().unwrap();
        assert!(requests[0]
            .starts_with("GET /api/v2/json/search/album/Title%20%2F%20%E6%97%A5%E6%9C%AC "));
        assert!(requests[1].starts_with("GET /api/v2/json/lookup/album/12 "));
        assert!(requests.iter().all(|r| r
            .to_lowercase()
            .contains("x-api-key: fictional-premium-key")));
        assert!(requests
            .iter()
            .all(|r| !r.lines().next().unwrap().contains("fictional")));
    }
    #[tokio::test]
    async fn ambiguous_and_mismatched_detail_never_choose_record() {
        let (base, server) = serve(vec![(200, json!({"search":[row(),row()]}))]);
        let result = TheAudioDbState::default()
            .lookup(&base, "r", &album(), "fictional", &|| async { true })
            .await
            .unwrap();
        assert!(matches!(result, ResultDto::Ambiguous { .. }));
        server.join().unwrap();
        let mut wrong = row();
        wrong["strArtist"] = json!("Other artist");
        let (base, server) = serve(vec![
            (200, json!({"search":[row()]})),
            (200, json!({"lookup":[wrong]})),
        ]);
        assert!(matches!(
            TheAudioDbState::default()
                .lookup(&base, "r", &album(), "fictional", &|| async { true })
                .await
                .unwrap(),
            ResultDto::Unavailable
        ));
        server.join().unwrap();
    }
    #[tokio::test]
    async fn known_mbid_requires_returned_id_and_never_falls_back_to_name() {
        let mb = "00000000-0000-4000-8000-000000000001";
        let mut q = album();
        q.mbid = Some(mb.into());
        let (base, server) = serve(vec![(200, json!({"lookup":[row()]}))]);
        assert!(matches!(
            TheAudioDbState::default()
                .lookup(&base, "r", &q, "fictional", &|| async { true })
                .await
                .unwrap(),
            ResultDto::Unavailable
        ));
        let requests = server.join().unwrap();
        assert!(requests[0].starts_with(&format!("GET /api/v2/json/lookup/album_mb/{mb} ")));
        assert!(artwork(&json!({"strArtistThumb":"https://evil.example/photo","strArtistFanart":"https://r2.theaudiodb.com/p.jpg?token=secret"}),&["strArtistThumb","strArtistFanart"]).is_empty());
    }
    #[tokio::test(start_paused = true)]
    async fn cancelled_wait_preserves_budget_and_long_backoff_is_prompt() {
        let state = Arc::new(TheAudioDbState::default());
        state.wait().await.unwrap();
        let s = state.clone();
        let waiting = tokio::spawn(async move { s.wait().await });
        tokio::task::yield_now().await;
        waiting.abort();
        assert!(state.gate.lock().await.unwrap() > tokio::time::Instant::now());
        *state.gate.lock().await = Some(tokio::time::Instant::now() + Duration::from_secs(60));
        assert!(state.wait().await.unwrap_err().contains("cooling down"));
        tokio::time::advance(Duration::from_secs(60)).await;
        state.wait().await.unwrap();
    }
    #[tokio::test]
    async fn forbidden_redirect_and_rate_limit_are_sanitized_and_retired_owner_sends_nothing() {
        for code in [302, 403, 429] {
            let (base, server) = serve(vec![(
                code,
                json!({"Message":"fictional-premium-key reflected"}),
            )]);
            let state = TheAudioDbState::default();
            let error = state
                .lookup(&base, "r", &album(), "fictional-premium-key", &|| async {
                    true
                })
                .await
                .err()
                .unwrap();
            assert!(!error.contains("fictional") && !error.contains("127.0.0.1"));
            server.join().unwrap();
            if code == 429 {
                assert!(state.wait().await.unwrap_err().contains("cooling down"));
            }
        }
        assert!(TheAudioDbState::default()
            .lookup(
                "http://127.0.0.1:9/",
                "r",
                &album(),
                "fictional",
                &|| async { false }
            )
            .await
            .err()
            .unwrap()
            .contains("owner changed"));
    }
    #[tokio::test(start_paused = true)]
    async fn concurrent_backoff_retires_already_waiting_admission() {
        let state = Arc::new(TheAudioDbState::default());
        state.wait().await.unwrap();
        let clone = state.clone();
        let queued = tokio::spawn(async move { clone.wait().await });
        tokio::task::yield_now().await;
        *state.cooldown.lock().unwrap() =
            Some(tokio::time::Instant::now() + Duration::from_secs(60));
        tokio::time::advance(Duration::from_secs(1)).await;
        assert!(queued.await.unwrap().unwrap_err().contains("cooling down"));
        assert!(state.wait().await.unwrap_err().contains("cooling down"));
    }
}
impl Default for TheAudioDbState {
    fn default() -> Self {
        Self {
            settings: ServiceSettings::new(true),
            gate: Mutex::new(None),
            cooldown: std::sync::Mutex::new(None),
            admission: Semaphore::new(4),
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(10))
                .user_agent("Hibiki/0.1 (+https://github.com/karbowiak/hibiki)")
                .build()
                .expect("metadata HTTP client"),
        }
    }
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Lookup {
    pub kind: String,
    pub artist: String,
    pub title: Option<String>,
    pub mbid: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    id: String,
    kind: String,
    artist: String,
    title: Option<String>,
    mbid: Option<String>,
    revision: String,
    fields: Value,
    posters: Vec<Artwork>,
    backgrounds: Vec<Artwork>,
    url: String,
}
#[derive(Serialize)]
pub struct Artwork {
    id: String,
    url: String,
    label: String,
}
#[derive(Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum ResultDto {
    Ready { item: Item },
    Unavailable,
    Ambiguous { candidates: Vec<Candidate> },
}
#[derive(Serialize)]
pub struct Candidate {
    id: String,
    name: String,
}
fn text(v: &Value, key: &str, max: usize) -> Option<String> {
    let s = v.get(key)?.as_str()?.trim();
    (!s.is_empty()
        && s.chars().count() <= max
        && !s.chars().any(|c| c.is_control() && c != '\n' && c != '\t'))
    .then(|| s.into())
}
fn id(v: &Value, key: &str) -> Option<String> {
    let s = v.get(key).and_then(|v| {
        v.as_str()
            .map(String::from)
            .or_else(|| v.as_u64().map(|n| n.to_string()))
    })?;
    (s.len() <= 18 && s.bytes().all(|b| b.is_ascii_digit()) && s.parse::<u64>().ok()? > 0)
        .then_some(s)
}
fn equal(a: &str, b: &str) -> bool {
    a.trim().to_lowercase() == b.trim().to_lowercase()
}
fn validate(q: &Lookup) -> Result<(), String> {
    if !matches!(q.kind.as_str(), "artist" | "album" | "track")
        || q.artist.trim().is_empty()
        || q.artist.chars().count() > 512
        || q.artist.chars().any(char::is_control)
        || (q.kind != "artist"
            && q.title.as_ref().is_none_or(|s| {
                s.trim().is_empty() || s.chars().count() > 512 || s.chars().any(char::is_control)
            }))
        || q.mbid
            .as_ref()
            .is_some_and(|s| uuid::Uuid::parse_str(s).is_err())
    {
        return Err("TheAudioDB lookup identity is invalid.".into());
    }
    Ok(())
}
fn matches(v: &Value, q: &Lookup) -> bool {
    text(v, "strArtist", 512).is_some_and(|s| equal(&s, &q.artist))
        && (q.kind == "artist"
            || text(
                v,
                if q.kind == "album" {
                    "strAlbum"
                } else {
                    "strTrack"
                },
                512,
            )
            .is_some_and(|s| equal(&s, q.title.as_deref().unwrap_or(""))))
        && q.mbid
            .as_ref()
            .is_none_or(|mb| text(v, "strMusicBrainzID", 36).is_some_and(|s| equal(&s, mb)))
}
fn rows<'a>(v: &'a Value, key: &str) -> Result<Vec<&'a Value>, String> {
    match v.get(key) {
        Some(Value::Null) => Ok(vec![]),
        Some(Value::Array(a)) if a.len() <= 10 => Ok(a.iter().collect()),
        None if v.get("Message").and_then(Value::as_str) == Some("No data found") => Ok(vec![]),
        _ => Err("TheAudioDB returned an unsupported response. Retry later.".into()),
    }
}
fn artwork(v: &Value, keys: &[&str]) -> Vec<Artwork> {
    keys.iter()
        .filter_map(|key| {
            let s = text(v, key, 2048)?;
            let u = url::Url::parse(&s).ok()?;
            if u.scheme() != "https"
                || !matches!(
                    u.host_str(),
                    Some("www.theaudiodb.com" | "theaudiodb.com" | "r2.theaudiodb.com")
                )
                || !u.username().is_empty()
                || u.password().is_some()
                || u.port().is_some()
                || u.query().is_some()
                || u.fragment().is_some()
            {
                return None;
            }
            Some(Artwork {
                id: (*key).into(),
                url: s,
                label: "TheAudioDB".into(),
            })
        })
        .collect()
}
fn project(v: &Value, q: &Lookup, revision: &str) -> Option<Item> {
    let entity_id = id(
        v,
        match q.kind.as_str() {
            "artist" => "idArtist",
            "album" => "idAlbum",
            _ => "idTrack",
        },
    )?;
    if !matches(v, q) {
        return None;
    }
    let mut f = Map::new();
    for (field, keys) in [
        (
            if q.kind == "artist" {
                "biography"
            } else {
                "summary"
            },
            if q.kind == "artist" {
                vec!["strBiography", "strBiographyEN"]
            } else {
                vec!["strDescription", "strDescriptionEN"]
            },
        ),
        ("label", vec!["strLabel"]),
        ("area", vec!["strCountry"]),
    ] {
        for k in keys {
            if let Some(s) = text(v, k, 16000) {
                f.insert(field.into(), json!(s));
                break;
            }
        }
    }
    if let Some(s) = text(v, "strGenre", 256) {
        f.insert("genres".into(), json!([s]));
    }
    if let Some(s) = text(v, "strStyle", 256) {
        f.insert("tags".into(), json!([s]));
    }
    let mbid = text(v, "strMusicBrainzID", 36).filter(|s| uuid::Uuid::parse_str(s).is_ok());
    if let Some(ref mb) = mbid {
        f.insert("mbid".into(), json!(mb));
    }
    let year = v
        .get(if q.kind == "artist" {
            "intFormedYear"
        } else {
            "intYearReleased"
        })
        .and_then(|n| {
            n.as_str()
                .map(String::from)
                .or_else(|| n.as_u64().map(|i| i.to_string()))
        })
        .filter(|s| s.len() == 4 && s.parse::<u16>().is_ok_and(|n| (1000..=9999).contains(&n)));
    if let Some(y) = year {
        f.insert(
            if q.kind == "artist" {
                "beginDate"
            } else {
                "releaseDate"
            }
            .into(),
            json!(y),
        );
    }
    let link = format!("https://www.theaudiodb.com/{}/{}", q.kind, entity_id);
    f.insert("externalUrl".into(), json!(link));
    Some(Item {
        id: entity_id,
        kind: q.kind.clone(),
        artist: text(v, "strArtist", 512)?,
        title: if q.kind == "artist" {
            None
        } else {
            text(
                v,
                if q.kind == "album" {
                    "strAlbum"
                } else {
                    "strTrack"
                },
                512,
            )
        },
        mbid,
        revision: revision.into(),
        fields: Value::Object(f),
        posters: artwork(
            v,
            &[match q.kind.as_str() {
                "artist" => "strArtistThumb",
                "album" => "strAlbumThumb",
                _ => "strTrackThumb",
            }],
        ),
        backgrounds: if q.kind == "artist" {
            artwork(
                v,
                &["strArtistFanart", "strArtistFanart2", "strArtistFanart3"],
            )
        } else {
            vec![]
        },
        url: link,
    })
}
impl TheAudioDbState {
    async fn wait(&self) -> Result<(), String> {
        let mut gate = self.gate.lock().await;
        loop {
            let cooldown = *self
                .cooldown
                .lock()
                .map_err(|_| "TheAudioDB rate budget is unavailable.")?;
            let next = match (*gate, cooldown) {
                (Some(a), Some(b)) => Some(a.max(b)),
                (a, b) => a.or(b),
            };
            let now = tokio::time::Instant::now();
            if let Some(next) = next.filter(|next| *next > now) {
                if next - now > Duration::from_secs(5) {
                    return Err("TheAudioDB is cooling down. Retry in a minute.".into());
                }
                tokio::time::sleep_until(next).await;
                continue;
            }
            break;
        }
        *gate = Some(tokio::time::Instant::now() + Duration::from_secs(1));
        Ok(())
    }
    async fn get<C, F>(
        &self,
        base: &str,
        path: &[&str],
        key: &str,
        check: &C,
    ) -> Result<Value, String>
    where
        C: Fn() -> F,
        F: std::future::Future<Output = bool>,
    {
        if !check().await {
            return Err("TheAudioDB lookup owner changed.".into());
        }
        self.wait().await?;
        if !check().await {
            return Err("TheAudioDB lookup owner changed.".into());
        }
        let mut url = url::Url::parse(base).map_err(|_| "TheAudioDB endpoint is invalid.")?;
        url.path_segments_mut()
            .map_err(|_| "TheAudioDB endpoint is invalid.")?
            .pop_if_empty()
            .extend(path);
        let mut header = reqwest::header::HeaderValue::from_str(key)
            .map_err(|_| "TheAudioDB key is invalid.")?;
        header.set_sensitive(true);
        let response = self
            .client
            .get(url)
            .header("X-API-KEY", header)
            .send()
            .await
            .map_err(|_| "TheAudioDB could not be reached. Retry later.")?;
        if !check().await {
            return Err("TheAudioDB lookup owner changed.".into());
        }
        if response.status().as_u16() == 429 {
            *self
                .cooldown
                .lock()
                .map_err(|_| "TheAudioDB rate budget is unavailable.")? =
                Some(tokio::time::Instant::now() + Duration::from_secs(60));
            return Err("TheAudioDB rate limit reached. Retry in a minute.".into());
        }
        if matches!(response.status().as_u16(), 401 | 403) {
            return Err("TheAudioDB rejected the premium API key. Check Settings.".into());
        }
        if !response.status().is_success() {
            return Err("TheAudioDB lookup failed. Check the key or retry later.".into());
        }
        let value = response
            .bounded_json(MAX_JSON_BYTES)
            .await
            .map_err(|_| "TheAudioDB response could not be read.")?;
        if !check().await {
            return Err("TheAudioDB lookup owner changed.".into());
        }
        Ok(value)
    }
    async fn lookup<C, F>(
        &self,
        base: &str,
        revision: &str,
        q: &Lookup,
        key: &str,
        check: &C,
    ) -> Result<ResultDto, String>
    where
        C: Fn() -> F,
        F: std::future::Future<Output = bool>,
    {
        validate(q)?;
        let _permit = self
            .admission
            .try_acquire()
            .map_err(|_| "TheAudioDB is busy. Retry later.")?;
        let lookup_kind = format!("{}_mb", q.kind);
        let query = q.title.as_deref().unwrap_or(&q.artist);
        let (path, field) = if let Some(ref mb) = q.mbid {
            (vec!["lookup", lookup_kind.as_str(), mb.as_str()], "lookup")
        } else {
            (vec!["search", q.kind.as_str(), query], "search")
        };
        let first = self.get(base, &path, key, check).await?;
        let selected = rows(&first, field)?
            .into_iter()
            .filter(|v| matches(v, q))
            .collect::<Vec<_>>();
        if selected.is_empty() {
            return Ok(ResultDto::Unavailable);
        }
        if selected.len() > 1 {
            return Ok(ResultDto::Ambiguous {
                candidates: selected
                    .iter()
                    .filter_map(|v| {
                        Some(Candidate {
                            id: id(
                                v,
                                match q.kind.as_str() {
                                    "artist" => "idArtist",
                                    "album" => "idAlbum",
                                    _ => "idTrack",
                                },
                            )?,
                            name: text(
                                v,
                                if q.kind == "artist" {
                                    "strArtist"
                                } else if q.kind == "album" {
                                    "strAlbum"
                                } else {
                                    "strTrack"
                                },
                                512,
                            )?,
                        })
                    })
                    .collect(),
            });
        }
        let first = selected[0];
        let entity = id(
            first,
            match q.kind.as_str() {
                "artist" => "idArtist",
                "album" => "idAlbum",
                _ => "idTrack",
            },
        )
        .ok_or("TheAudioDB identity could not be verified.")?;
        if field == "lookup" {
            return Ok(project(first, q, revision)
                .map_or(ResultDto::Unavailable, |item| ResultDto::Ready { item }));
        }
        let detail = self
            .get(base, &["lookup", &q.kind, &entity], key, check)
            .await?;
        let details = rows(&detail, "lookup")?;
        if details.len() != 1
            || id(
                details[0],
                match q.kind.as_str() {
                    "artist" => "idArtist",
                    "album" => "idAlbum",
                    _ => "idTrack",
                },
            )
            .as_deref()
                != Some(&entity)
        {
            return Ok(ResultDto::Unavailable);
        }
        Ok(project(details[0], q, revision)
            .map_or(ResultDto::Unavailable, |item| ResultDto::Ready { item }))
    }
}
fn directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|_| "Could not locate metadata settings.")?
        .join("metadata-services")
        .join("theaudiodb"))
}
#[tauri::command]
pub async fn theaudiodb_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<TheAudioDbState>>,
) -> Result<Status, String> {
    Ok(state.settings.snapshot(&directory(&app)?).await?.0)
}
#[tauri::command]
pub async fn theaudiodb_configure(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<TheAudioDbState>>,
    revision: String,
    api_key: Option<String>,
    enabled: bool,
    clear: bool,
) -> Result<Status, String> {
    state
        .settings
        .update(
            &directory(&app)?,
            &revision,
            BASE.into(),
            api_key,
            enabled,
            clear,
        )
        .await
}
#[tauri::command]
pub async fn theaudiodb_lookup(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<TheAudioDbState>>,
    revision: String,
    scope_id: String,
    identity: Lookup,
) -> Result<ResultDto, String> {
    let plex = app.state::<crate::commands::PlexState>();
    let context = plex.image_context().await;
    if context.client.as_ref().is_none_or(|c| c.offline_only)
        || context.cache_scope() != scope_id
        || scope_id.is_empty()
    {
        return Err("TheAudioDB requires the current online library.".into());
    }
    let dir = directory(&app)?;
    let (status, config) = state.settings.snapshot(&dir).await?;
    if !status.enabled || !status.configured {
        return Ok(ResultDto::Unavailable);
    }
    if status.revision != revision {
        return Err("TheAudioDB settings changed. Retry the lookup.".into());
    }
    let check = || async {
        state.settings.owned(&revision).await && plex.image_context_is_current(&context).await
    };
    let result = tokio::time::timeout(
        Duration::from_secs(15),
        state.lookup(BASE, &revision, &identity, &config.api_key, &check),
    )
    .await
    .map_err(|_| "TheAudioDB lookup timed out. Retry later.")??;
    let current = state.settings.snapshot(&dir).await?.0;
    if current.revision != revision || !check().await {
        return Err("TheAudioDB lookup owner changed.".into());
    }
    Ok(result)
}
