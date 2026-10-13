//! Optional configured HeyaMetadata and fixed-origin Fanart music GETs.
pub(crate) mod discovery;
pub(crate) mod identity;
use crate::{
    http_response::{BoundedResponseExt, MAX_JSON_BYTES},
    metadata_service_settings::{Configuration, ServiceSettings, Status},
};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tauri::Manager;
use tokio::sync::Mutex;
mod artwork;
pub use artwork::{is_heya_image, resolve_heya_image};
const FANART_BASE: &str = "https://webservice.fanart.tv/v3.2/";
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Service {
    Fanart,
    Heya,
}
struct Connection {
    discovery: Mutex<discovery::Registry>,
    discovery_admission: tokio::sync::Semaphore,
    settings: ServiceSettings,
    gate: Mutex<Option<tokio::time::Instant>>,
    cooldown: std::sync::Mutex<Option<tokio::time::Instant>>,
    admission: tokio::sync::Semaphore,
    images: Mutex<std::collections::HashMap<(String, String), std::time::Instant>>,
    pending_images: Mutex<std::collections::HashMap<(String, String), tokio::time::Instant>>,
}
impl Connection {
    fn new(required: bool) -> Self {
        Self {
            discovery: Mutex::new(discovery::Registry::default()),
            discovery_admission: tokio::sync::Semaphore::new(1),
            settings: ServiceSettings::new(required),
            gate: Mutex::new(None),
            cooldown: std::sync::Mutex::new(None),
            admission: tokio::sync::Semaphore::new(8),
            images: Mutex::new(std::collections::HashMap::new()),
            pending_images: Mutex::new(std::collections::HashMap::new()),
        }
    }
    fn backoff(&self, seconds: u64) -> Result<(), String> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(seconds.clamp(1, 3600));
        let mut cooldown = self
            .cooldown
            .lock()
            .map_err(|_| "Metadata service rate budget is unavailable.")?;
        *cooldown = Some(cooldown.map_or(deadline, |old| old.max(deadline)));
        Ok(())
    }
    async fn wait(&self) -> Result<(), String> {
        let mut next = self.gate.lock().await;
        loop {
            let cooldown = *self
                .cooldown
                .lock()
                .map_err(|_| "Metadata service rate budget is unavailable.")?;
            let deadline = match (*next, cooldown) {
                (Some(a), Some(b)) => Some(a.max(b)),
                (a, b) => a.or(b),
            };
            let now = tokio::time::Instant::now();
            if let Some(deadline) = deadline.filter(|deadline| *deadline > now) {
                if deadline - now > Duration::from_secs(5) {
                    return Err("Metadata service is cooling down. Retry later.".into());
                }
                tokio::time::sleep_until(deadline).await;
                // A response may impose backoff while a queued call sleeps.
                continue;
            }
            *next = Some(tokio::time::Instant::now() + Duration::from_secs(1));
            return Ok(());
        }
    }
    async fn get(
        &self,
        service: Service,
        directory: &Path,
        revision: &str,
        configuration: &Configuration,
        path: &str,
        query: &[(&str, &str)],
    ) -> Result<Option<Value>, String> {
        let _permit = self
            .admission
            .try_acquire()
            .map_err(|_| "Metadata service is busy. Retry later.")?;
        if !self.settings.owned(revision).await {
            return Err("Metadata service configuration changed. Retry the lookup.".into());
        }
        self.wait().await?;
        let (status, _) = self.settings.snapshot(directory).await?;
        if status.revision != revision {
            return Err("Metadata service configuration changed. Retry the lookup.".into());
        }
        let url = base(&configuration.base_url)?
            .join(path)
            .map_err(|_| "Invalid metadata service route.")?;
        let mut request = CLIENT
            .get(url)
            .query(query)
            .header(reqwest::header::ACCEPT, "application/json");
        if !configuration.api_key.is_empty() {
            let value = match service {
                Service::Fanart => configuration.api_key.clone(),
                Service::Heya => format!("Bearer {}", configuration.api_key),
            };
            let mut header = reqwest::header::HeaderValue::from_str(&value)
                .map_err(|_| "Invalid metadata service key.")?;
            header.set_sensitive(true);
            request = request.header(
                match service {
                    Service::Fanart => "api-key",
                    Service::Heya => "authorization",
                },
                header,
            );
        }
        let response = request
            .send()
            .await
            .map_err(|_| "Metadata service request failed. Retry later.")?;
        let (status, _) = self.settings.snapshot(directory).await?;
        if status.revision != revision {
            return Err("Metadata service configuration changed. Retry the lookup.".into());
        }
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            if matches!(
                response.status(),
                reqwest::StatusCode::TOO_MANY_REQUESTS | reqwest::StatusCode::SERVICE_UNAVAILABLE
            ) {
                let seconds = response
                    .headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok())
                    .unwrap_or(60)
                    .clamp(1, 3600);
                self.backoff(seconds)?;
            }
            return Err(
                "Metadata service rejected the lookup. Check Settings or retry later.".into(),
            );
        }
        let result = response
            .bounded_json(MAX_JSON_BYTES)
            .await
            .map_err(|_| "Metadata service response was invalid or too large.")?;
        let (status, _) = self.settings.snapshot(directory).await?;
        if status.revision != revision {
            return Err("Metadata service configuration changed. Retry the lookup.".into());
        }
        Ok(Some(result))
    }
}
static CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!(
            "Hibiki/",
            env!("CARGO_PKG_VERSION"),
            " (https://github.com/karbowiak/hibiki)"
        ))
        .build()
        .expect("metadata service client")
});
pub struct MetadataServicesState {
    fanart: Connection,
    heya: Connection,
}
impl Default for MetadataServicesState {
    fn default() -> Self {
        Self {
            fanart: Connection::new(true),
            heya: Connection::new(false),
        }
    }
}
impl MetadataServicesState {
    fn connection(&self, source: Service) -> &Connection {
        match source {
            Service::Fanart => &self.fanart,
            Service::Heya => &self.heya,
        }
    }
}
fn directory(app: &tauri::AppHandle, source: Service) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|_| "Could not locate metadata settings.")?
        .join("metadata-services")
        .join(match source {
            Service::Fanart => "fanart",
            Service::Heya => "heya",
        }))
}
fn base(value: &str) -> Result<url::Url, String> {
    let mut url = url::Url::parse(value).map_err(|_| "Invalid metadata service URL.")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Invalid metadata service URL.".into());
    }
    url.set_path(&format!("{}/", url.path().trim_end_matches('/')));
    Ok(url)
}
fn valid_mbid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value.to_lowercase())
}
#[tauri::command]
pub async fn metadata_service_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<MetadataServicesState>>,
    service: Service,
) -> Result<Status, String> {
    Ok(state
        .connection(service)
        .settings
        .snapshot(&directory(&app, service)?)
        .await?
        .0)
}
#[tauri::command]
pub async fn metadata_service_configure(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<MetadataServicesState>>,
    service: Service,
    revision: String,
    base_url: String,
    api_key: Option<String>,
    enabled: bool,
    clear: bool,
) -> Result<Status, String> {
    let target = match service {
        Service::Fanart => FANART_BASE.to_string(),
        Service::Heya => base_url,
    };
    let status = state
        .connection(service)
        .settings
        .update(
            &directory(&app, service)?,
            &revision,
            target,
            api_key,
            enabled,
            clear,
        )
        .await?;
    *state
        .connection(service)
        .cooldown
        .lock()
        .map_err(|_| "Metadata service rate budget is unavailable.")? = None;
    Ok(status)
}
#[derive(Clone, Serialize)]
pub struct ArtworkCandidate {
    id: String,
    url: String,
    label: Option<String>,
}
#[derive(Serialize)]
pub struct FanartAlbum {
    mbid: String,
    posters: Vec<ArtworkCandidate>,
}
#[derive(Serialize)]
pub struct FanartArtist {
    name: String,
    mbid: String,
    posters: Vec<ArtworkCandidate>,
    backgrounds: Vec<ArtworkCandidate>,
    albums: Vec<FanartAlbum>,
    revision: String,
}
fn fanart_candidates(value: Option<&Value>, role: &str) -> Vec<ArtworkCandidate> {
    let Some(images) = value.and_then(Value::as_array) else {
        return vec![];
    };
    let mut result = vec![];
    for image in images.iter().take(200) {
        let Some(id) = image.get("id").and_then(Value::as_str).filter(|id| {
            !id.is_empty()
                && id.len() <= 64
                && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        }) else {
            continue;
        };
        let Some(raw) = image
            .get("url")
            .and_then(Value::as_str)
            .filter(|v| v.len() <= 2048)
        else {
            continue;
        };
        let Ok(mut url) = url::Url::parse(raw) else {
            continue;
        };
        if !matches!(url.scheme(), "https" | "http")
            || url.host_str() != Some("assets.fanart.tv")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            continue;
        }
        let _ = url.set_scheme("https");
        let id = format!("{role}:{id}");
        if result.iter().any(|item: &ArtworkCandidate| item.id == id) {
            continue;
        }
        let label = image
            .get("lang")
            .and_then(Value::as_str)
            .filter(|s| s.len() <= 12)
            .map(|lang| format!("{} · {}", role, lang));
        result.push(ArtworkCandidate {
            id,
            url: url.to_string(),
            label,
        });
        if result.len() == 12 {
            break;
        }
    }
    result
}
fn fanart_artist(value: &Value, mbid: &str, revision: &str) -> Option<FanartArtist> {
    if !value.get("mbid_id")?.as_str()?.eq_ignore_ascii_case(mbid) {
        return None;
    }
    let name = value.get("name")?.as_str()?.trim();
    if name.is_empty() || name.chars().count() > 512 {
        return None;
    }
    let mut albums = vec![];
    if let Some(items) = value.get("albums").and_then(Value::as_array) {
        for album in items.iter().take(512) {
            let Some(id) = album
                .get("release_group_id")
                .and_then(Value::as_str)
                .filter(|id| valid_mbid(id))
            else {
                continue;
            };
            if albums.iter().any(|a: &FanartAlbum| a.mbid == id) {
                continue;
            }
            let posters = fanart_candidates(album.get("albumcover"), "cover");
            if !posters.is_empty() {
                albums.push(FanartAlbum {
                    mbid: id.to_lowercase(),
                    posters,
                });
            }
        }
    }
    Some(FanartArtist {
        name: name.into(),
        mbid: mbid.to_lowercase(),
        posters: fanart_candidates(value.get("artistthumb"), "portrait"),
        backgrounds: fanart_candidates(value.get("artistbackground"), "background"),
        albums,
        revision: revision.into(),
    })
}
#[tauri::command]
pub async fn fanart_get_artist(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<MetadataServicesState>>,
    revision: String,
    artist_mbid: String,
) -> Result<Option<FanartArtist>, String> {
    if !valid_mbid(&artist_mbid) {
        return Err("Invalid verified MusicBrainz artist identity.".into());
    }
    let source = Service::Fanart;
    let directory = directory(&app, source)?;
    let connection = state.connection(source);
    let (status, configuration) = connection.settings.snapshot(&directory).await?;
    if status.revision != revision {
        return Err("Metadata service configuration changed. Retry the lookup.".into());
    }
    if !status.configured || !status.enabled {
        return Ok(None);
    }
    if base(&configuration.base_url)?.as_str() != FANART_BASE {
        return Err("Fanart service configuration needs to be saved again.".into());
    }
    let Some(value) = connection
        .get(
            source,
            &directory,
            &revision,
            &configuration,
            &format!("music/{}", artist_mbid.to_lowercase()),
            &[],
        )
        .await?
    else {
        return Ok(None);
    };
    Ok(fanart_artist(&value, &artist_mbid, &revision))
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FanartAlbumResult {
    mbid: String,
    revision: String,
    posters: Vec<ArtworkCandidate>,
    backgrounds: Vec<ArtworkCandidate>,
}
#[tauri::command]
pub async fn fanart_get_album(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<MetadataServicesState>>,
    revision: String,
    release_group_mbid: String,
    artist_mbid: Option<String>,
) -> Result<Option<FanartAlbumResult>, String> {
    if !valid_mbid(&release_group_mbid) || artist_mbid.as_deref().is_some_and(|id| !valid_mbid(id))
    {
        return Err("Invalid MusicBrainz identity.".into());
    }
    if app
        .state::<crate::commands::PlexState>()
        .image_context()
        .await
        .client
        .as_ref()
        .is_some_and(|client| client.offline_only)
    {
        return Err("Fanart lookup is unavailable offline.".into());
    }
    let dir = directory(&app, Service::Fanart)?;
    let connection = state.connection(Service::Fanart);
    let (status, config) = connection.settings.snapshot(&dir).await?;
    if status.revision != revision {
        return Err("Metadata service configuration changed. Retry the lookup.".into());
    }
    if !status.enabled || !status.configured {
        return Ok(None);
    }
    if base(&config.base_url)?.as_str() != FANART_BASE {
        return Err("Fanart service configuration needs to be saved again.".into());
    }
    let Some(value) = connection
        .get(
            Service::Fanart,
            &dir,
            &revision,
            &config,
            &format!("music/albums/{}", release_group_mbid.to_lowercase()),
            &[],
        )
        .await?
    else {
        return Ok(None);
    };
    let Some(parent) = value
        .get("mbid_id")
        .and_then(Value::as_str)
        .filter(|id| valid_mbid(id))
    else {
        return Ok(None);
    };
    if artist_mbid
        .as_deref()
        .is_some_and(|id| !id.eq_ignore_ascii_case(parent))
    {
        return Ok(None);
    }
    let Some(item) = fanart_artist(&value, parent, &revision) else {
        return Ok(None);
    };
    Ok(item
        .albums
        .into_iter()
        .find(|album| album.mbid.eq_ignore_ascii_case(&release_group_mbid))
        .map(|album| FanartAlbumResult {
            mbid: album.mbid,
            revision,
            posters: album.posters,
            backgrounds: vec![],
        }))
}
#[derive(Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum HeyaLookup {
    Ready { item: HeyaItem },
    Unavailable,
    Ambiguous { candidates: Vec<HeyaCandidate> },
}
#[derive(Serialize)]
pub struct HeyaCandidate {
    id: String,
    name: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeyaItem {
    posters: Vec<ArtworkCandidate>,
    backgrounds: Vec<ArtworkCandidate>,
    id: String,
    artist: String,
    title: Option<String>,
    fields: Value,
    field_origins: std::collections::BTreeMap<String, String>,
    revision: String,
}
fn name(value: &str) -> String {
    value.trim().to_lowercase()
}
fn heya_identity(value: &Value, kind: &str, artist: &str, title: &str, mbid: Option<&str>) -> bool {
    if value.get("kind").and_then(Value::as_str) != Some(kind) {
        return false;
    }
    if let Some(mbid) = mbid {
        return value
            .get("external_ids")
            .and_then(Value::as_array)
            .is_some_and(|ids| {
                ids.iter().any(|id| {
                    id.get("provider").and_then(Value::as_str) == Some("musicbrainz")
                        && id.get("namespace").and_then(Value::as_str)
                            == Some(if kind == "artist" {
                                "artist"
                            } else {
                                "release_group"
                            })
                        && id
                            .get("value")
                            .and_then(Value::as_str)
                            .is_some_and(|v| v.eq_ignore_ascii_case(mbid))
                })
            });
    }
    if kind == "artist" {
        value
            .pointer("/display/name")
            .and_then(Value::as_str)
            .is_some_and(|v| name(v) == name(artist))
    } else {
        value
            .pointer("/display/title")
            .and_then(Value::as_str)
            .is_some_and(|v| name(v) == name(title))
            && value
                .pointer("/display/artist_credit")
                .and_then(Value::as_str)
                .is_some_and(|v| name(v) == name(artist))
    }
}
fn heya_item(
    value: &Value,
    id: &str,
    kind: &str,
    artist: &str,
    title: &str,
    mbid: Option<&str>,
    revision: &str,
) -> Option<HeyaItem> {
    if value.get("id")?.as_str()? != id || !heya_identity(value, kind, artist, title, mbid) {
        return None;
    }
    let data = value.get("data")?;
    let mut fields = serde_json::Map::new();
    let mut origins = std::collections::BTreeMap::new();
    let text_key = if kind == "artist" {
        "biographies"
    } else {
        "descriptions"
    };
    let field = if kind == "artist" {
        "biography"
    } else {
        "summary"
    };
    if let Some(text) = data
        .get(text_key)
        .and_then(Value::as_array)
        .and_then(|items| {
            items.iter().find_map(|item| {
                item.get("value")
                    .and_then(Value::as_str)
                    .filter(|s| !s.trim().is_empty() && s.chars().count() <= 16000)
            })
        })
    {
        fields.insert(field.into(), json!(text));
    }
    for key in ["genres", "tags"] {
        if let Some(items) = data.get(key).and_then(Value::as_array) {
            let mut terms = vec![];
            for term in items.iter().take(128) {
                if let Some(text) = term
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|s| !s.trim().is_empty() && s.chars().count() <= 128)
                {
                    if !terms.contains(&text) {
                        terms.push(text);
                        if terms.len() == 64 {
                            break;
                        }
                    }
                }
            }
            if !terms.is_empty() {
                fields.insert(key.into(), json!(terms));
            }
        }
    }
    if kind == "artist" {
        if let Some(value) = data
            .pointer("/classification/artist_type")
            .and_then(Value::as_str)
            .filter(|s| s.len() <= 128)
        {
            fields.insert("artistType".into(), json!(value));
        }
    } else if let Some(date) = data
        .get("dates")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .find(|date| date.get("type").and_then(Value::as_str) == Some("first_release"))
        })
        .and_then(|date| date.get("value"))
        .and_then(Value::as_str)
        .filter(|s| s.len() <= 10)
    {
        fields.insert("releaseDate".into(), json!(date));
    }
    if kind == "artist" {
        if let Some(area) = data
            .get("areas")
            .and_then(Value::as_array)
            .and_then(|areas| {
                areas
                    .iter()
                    .find(|area| area.get("role").and_then(Value::as_str) == Some("primary"))
            })
            .and_then(|area| area.get("name"))
            .and_then(Value::as_str)
            .filter(|name| !name.trim().is_empty() && name.chars().count() <= 512)
        {
            fields.insert("area".into(), json!(area));
        }
        if let Some(date) = data
            .pointer("/lifecycle/dates")
            .and_then(Value::as_array)
            .and_then(|dates| {
                dates
                    .iter()
                    .find(|date| date.get("type").and_then(Value::as_str) == Some("begin"))
            })
            .and_then(|date| date.get("value"))
            .and_then(Value::as_str)
            .filter(|date| {
                [4, 7, 10].contains(&date.len())
                    && date.bytes().enumerate().all(|(i, b)| {
                        if i == 4 || i == 7 {
                            b == b'-'
                        } else {
                            b.is_ascii_digit()
                        }
                    })
            })
        {
            fields.insert("beginDate".into(), json!(date));
        }
    }
    if let Some(id) = value
        .get("external_ids")
        .and_then(Value::as_array)
        .and_then(|ids| {
            ids.iter().find(|id| {
                id.get("provider").and_then(Value::as_str) == Some("musicbrainz")
                    && id.get("namespace").and_then(Value::as_str)
                        == Some(if kind == "artist" {
                            "artist"
                        } else {
                            "release_group"
                        })
            })
        })
        .and_then(|id| id.get("value"))
        .and_then(Value::as_str)
        .filter(|id| valid_mbid(id))
    {
        fields.insert("mbid".into(), json!(id));
    }
    if let Some(metrics) = data.get("metrics").and_then(Value::as_array) {
        for metric in metrics.iter().take(128) {
            let field = match metric.get("name").and_then(Value::as_str) {
                Some("listeners") => "listeners",
                Some("playcount") => "playCount",
                Some("fan_count") => "fans",
                _ => continue,
            };
            if fields.contains_key(field) {
                continue;
            }
            let count = metric.get("value").and_then(Value::as_f64).filter(|count| {
                count.is_finite()
                    && *count >= 0.0
                    && *count <= 9007199254740991.0
                    && count.fract() == 0.0
            });
            if let Some(count) = count {
                fields.insert(field.into(), json!(count as u64));
                let provider = metric
                    .get("provider")
                    .and_then(Value::as_str)
                    .filter(|provider| provider.len() <= 40)
                    .unwrap_or("Canonical projection");
                origins.insert(field.into(), format!("{provider} via HeyaMetadata"));
            }
        }
    }
    if let Some(links) = data.get("links").and_then(Value::as_array) {
        for link in links.iter().take(128) {
            let Some(url) = link
                .get("url")
                .and_then(Value::as_str)
                .filter(|url| url.len() <= 2048)
                .and_then(|url| url::Url::parse(url).ok())
            else {
                continue;
            };
            if url.scheme() == "https"
                && url
                    .host_str()
                    .is_some_and(|host| host == "wikipedia.org" || host.ends_with(".wikipedia.org"))
                && url.username().is_empty()
                && url.password().is_none()
                && url.port().is_none()
                && url.query().is_none()
                && url.fragment().is_none()
            {
                fields.insert("wikipediaUrl".into(), json!(url.to_string()));
                break;
            }
        }
    }
    for (field, key) in [
        (field, text_key),
        ("genres", "genres"),
        ("tags", "tags"),
        ("artistType", "classification.artist_type"),
        ("releaseDate", "dates"),
        ("area", "areas"),
        ("beginDate", "lifecycle"),
        ("mbid", "external_ids"),
        ("wikipediaUrl", "links"),
    ] {
        if fields.contains_key(field) {
            let providers = value
                .get("provenance")
                .and_then(|p| p.get(format!("data.{key}")).or_else(|| p.get(key)))
                .and_then(Value::as_array)
                .map(|p| {
                    p.iter()
                        .filter_map(|v| v.get("provider").and_then(Value::as_str))
                        .filter(|v| v.len() <= 40)
                        .take(8)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            origins.insert(
                field.into(),
                if providers.is_empty() {
                    "HeyaMetadata canonical projection".into()
                } else {
                    format!("{} via HeyaMetadata", providers.join(", "))
                },
            );
        }
    }
    let (posters, backgrounds) = artwork::candidates(data, kind, revision);
    Some(HeyaItem {
        posters,
        backgrounds,
        id: id.into(),
        artist: artist.into(),
        title: (kind != "artist").then(|| title.into()),
        fields: Value::Object(fields),
        field_origins: origins,
        revision: revision.into(),
    })
}
async fn heya_lookup(
    connection: &Connection,
    directory: &Path,
    revision: &str,
    kind: &str,
    artist: &str,
    title: &str,
    mbid: Option<&str>,
) -> Result<HeyaLookup, String> {
    let (status, configuration) = connection.settings.snapshot(directory).await?;
    if status.revision != revision {
        return Err("Metadata service configuration changed. Retry the lookup.".into());
    }
    if !status.configured || !status.enabled {
        return Ok(HeyaLookup::Unavailable);
    }
    let query = mbid.unwrap_or(if kind == "artist" { artist } else { title });
    let Some(value) = connection
        .get(
            Service::Heya,
            directory,
            revision,
            &configuration,
            "api/v2/search",
            &[("q", query), ("kind", kind), ("limit", "20")],
        )
        .await?
    else {
        return Ok(HeyaLookup::Unavailable);
    };
    let mut candidates = vec![];
    if let Some(items) = value.get("results").and_then(Value::as_array) {
        for item in items.iter().take(20) {
            if !heya_identity(item, kind, artist, title, mbid) {
                continue;
            }
            let Some(id) = item
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| valid_mbid(id))
            else {
                continue;
            };
            if candidates
                .iter()
                .any(|candidate: &HeyaCandidate| candidate.id == id)
            {
                continue;
            }
            candidates.push(HeyaCandidate {
                id: id.into(),
                name: if kind == "artist" {
                    artist.into()
                } else {
                    title.into()
                },
            });
        }
    }
    if candidates.len() > 1 {
        return Ok(HeyaLookup::Ambiguous { candidates });
    }
    let Some(candidate) = candidates.pop() else {
        return Ok(HeyaLookup::Unavailable);
    };
    let Some(detail) = connection
        .get(
            Service::Heya,
            directory,
            revision,
            &configuration,
            &format!("api/v2/entities/{}", candidate.id),
            &[],
        )
        .await?
    else {
        return Ok(HeyaLookup::Unavailable);
    };
    let Some(item) = heya_item(&detail, &candidate.id, kind, artist, title, mbid, revision) else {
        return Ok(HeyaLookup::Unavailable);
    };
    let guard = connection.settings.publication_guard(revision).await?;
    connection.register_images(&item).await;
    drop(guard);
    let (current, _) = connection.settings.snapshot(directory).await?;
    if current.revision != revision {
        return Err("Metadata service configuration changed. Retry the lookup.".into());
    }
    Ok(HeyaLookup::Ready { item })
}
#[tauri::command]
pub async fn heya_get_metadata(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<MetadataServicesState>>,
    revision: String,
    kind: String,
    artist: String,
    title: Option<String>,
    mbid: Option<String>,
    selected_id: Option<String>,
    selected_connection_id: Option<String>,
) -> Result<HeyaLookup, String> {
    if app
        .state::<crate::commands::PlexState>()
        .image_context()
        .await
        .client
        .as_ref()
        .is_some_and(|client| client.offline_only)
    {
        return Err("HeyaMetadata lookup is unavailable offline.".into());
    }
    let kind = match kind.as_str() {
        "artist" => "artist",
        "album" => "release_group",
        _ => return Err("Unsupported HeyaMetadata entity type.".into()),
    };
    let title = title.unwrap_or_default();
    if artist.trim().is_empty()
        || artist.chars().count() > 512
        || title.chars().count() > 512
        || (kind != "artist" && title.trim().is_empty())
        || mbid.as_deref().is_some_and(|id| !valid_mbid(id))
    {
        return Err("Invalid HeyaMetadata identity.".into());
    }
    if let Some(id) = selected_id {
        if !valid_mbid(&id) {
            return Err("Invalid canonical identity.".into());
        }
        let connection = state.connection(Service::Heya);
        let dir = directory(&app, Service::Heya)?;
        let (status, config) = connection.settings.snapshot(&dir).await?;
        if status.revision != revision
            || status.connection_id.as_deref() != selected_connection_id.as_deref()
            || !status.enabled
            || !status.configured
            || selected_connection_id.is_none()
        {
            return Err(
                "The reviewed HeyaMetadata connection changed. Review the identity again.".into(),
            );
        }
        let Some(detail) = connection
            .get(
                Service::Heya,
                &dir,
                &revision,
                &config,
                &format!("api/v2/entities/{id}"),
                &[],
            )
            .await?
        else {
            return Ok(HeyaLookup::Unavailable);
        };
        if detail.get("id").and_then(Value::as_str) != Some(id.as_str())
            || detail.get("kind").and_then(Value::as_str) != Some(kind)
        {
            return Err("The canonical identity response did not match.".into());
        }
        let canonical_artist = detail
            .pointer(if kind == "artist" {
                "/display/name"
            } else {
                "/display/artist_credit"
            })
            .and_then(Value::as_str)
            .ok_or("The canonical artist is unavailable.")?;
        let canonical_title = detail
            .pointer("/display/title")
            .and_then(Value::as_str)
            .unwrap_or("");
        let mut item = heya_item(
            &detail,
            &id,
            kind,
            canonical_artist,
            canonical_title,
            None,
            &revision,
        )
        .ok_or("The canonical identity response did not match.")?;
        item.artist = artist;
        item.title = (kind != "artist").then_some(title);
        let guard = connection.settings.publication_guard(&revision).await?;
        connection.register_images(&item).await;
        drop(guard);
        let (current, _) = connection.settings.snapshot(&dir).await?;
        if current.revision != revision {
            return Err("Metadata service configuration changed. Retry the lookup.".into());
        }
        return Ok(HeyaLookup::Ready { item });
    }
    heya_lookup(
        state.connection(Service::Heya),
        &directory(&app, Service::Heya)?,
        &revision,
        kind,
        &artist,
        &title,
        mbid.as_deref(),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    fn server(
        replies: Vec<(u16, Value, Option<String>)>,
    ) -> (String, std::thread::JoinHandle<Vec<String>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/proxy/", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let mut requests = vec![];
            for (status, body, extra) in replies {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut bytes = vec![];
                let mut buffer = [0; 4096];
                while !bytes.windows(4).any(|p| p == b"\r\n\r\n") {
                    let n = stream.read(&mut buffer).unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&buffer[..n]);
                }
                requests.push(String::from_utf8(bytes).unwrap());
                let body = body.to_string();
                let extra = extra.unwrap_or_default();
                write!(stream,"HTTP/1.1 {status} Result\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).ok();
            }
            requests
        });
        (base, server)
    }
    pub(super) async fn configured(
        connection: &Connection,
        directory: &Path,
        url: String,
        key: Option<String>,
    ) -> (Status, Configuration) {
        let (status, _) = connection.settings.snapshot(directory).await.unwrap();
        connection
            .settings
            .update(directory, &status.revision, url, key, true, false)
            .await
            .unwrap();
        connection.settings.snapshot(directory).await.unwrap()
    }
    #[tokio::test(start_paused = true)]
    async fn shared_connection_gate_survives_cancelled_and_late_wakes() {
        let connection = Arc::new(Connection::new(false));
        connection.wait().await.unwrap();
        let retired = {
            let connection = connection.clone();
            tokio::spawn(async move {
                connection.wait().await.unwrap();
            })
        };
        tokio::task::yield_now().await;
        retired.abort();
        let a = {
            let connection = connection.clone();
            tokio::spawn(async move {
                connection.wait().await.unwrap();
                tokio::time::Instant::now()
            })
        };
        let b = {
            let connection = connection.clone();
            tokio::spawn(async move {
                connection.wait().await.unwrap();
                tokio::time::Instant::now()
            })
        };
        tokio::time::advance(Duration::from_secs(30)).await;
        let a = a.await.unwrap();
        let b = b.await.unwrap();
        assert!(b - a >= Duration::from_secs(1));
    }
    #[tokio::test]
    async fn long_server_backoff_returns_promptly_without_an_early_second_request() {
        let (url, server) = server(vec![(429, json!({}), Some("Retry-After: 120\r\n".into()))]);
        let root = tempfile::tempdir().unwrap();
        let connection = Connection::new(false);
        let (status, config) = configured(&connection, root.path(), url, None).await;
        assert!(connection
            .get(
                Service::Heya,
                root.path(),
                &status.revision,
                &config,
                "api/v2/search",
                &[]
            )
            .await
            .is_err());
        let second = tokio::time::timeout(
            Duration::from_millis(200),
            connection.get(
                Service::Heya,
                root.path(),
                &status.revision,
                &config,
                "api/v2/search",
                &[],
            ),
        )
        .await
        .expect("cooldown must not hold a native worker");
        assert!(second.err().unwrap().contains("cooling down"));
        assert_eq!(server.join().unwrap().len(), 1);
    }
    #[tokio::test]
    async fn actual_fanart_header_is_private_no_url_key_redirects_or_wrong_identity() {
        let (base, server) = server(vec![
            (
                200,
                json!({"name":"Artist","mbid_id":"12345678-1234-1234-1234-123456789abc","artistthumb":[{"id":"1","url":"https://assets.fanart.tv/portrait"}],"artistbackground":[{"id":"2","url":"http://assets.fanart.tv/background"}]}),
                None,
            ),
            (
                302,
                json!({}),
                Some("Location: http://127.0.0.1:1/secret\r\n".into()),
            ),
        ]);
        let root = tempfile::tempdir().unwrap();
        let connection = Connection::new(true);
        let (status, config) = configured(
            &connection,
            root.path(),
            base,
            Some("fictional-project-key".into()),
        )
        .await;
        let value = connection
            .get(
                Service::Fanart,
                root.path(),
                &status.revision,
                &config,
                "music/12345678-1234-1234-1234-123456789abc",
                &[],
            )
            .await
            .unwrap()
            .unwrap();
        let result = fanart_artist(
            &value,
            "12345678-1234-1234-1234-123456789abc",
            &status.revision,
        )
        .unwrap();
        assert_eq!(result.posters.len(), 1);
        assert_eq!(
            result.backgrounds[0].url,
            "https://assets.fanart.tv/background"
        );
        assert!(fanart_artist(
            &value,
            "22345678-1234-1234-1234-123456789abc",
            &status.revision
        )
        .is_none());
        let error = connection
            .get(
                Service::Fanart,
                root.path(),
                &status.revision,
                &config,
                "music/next",
                &[],
            )
            .await
            .err()
            .unwrap();
        assert!(!error.contains("fictional-project-key") && !error.contains("127.0.0.1"));
        let requests = server.join().unwrap();
        assert!(requests[0]
            .starts_with("GET /proxy/music/12345678-1234-1234-1234-123456789abc HTTP/1.1"));
        assert!(requests[0].contains("api-key: fictional-project-key"));
        assert!(!requests[0].lines().next().unwrap().contains("fictional"));
        assert!(!requests[0].contains("authorization:"));
        let bad = json!([{"id":"safe","url":"https://evil.test/a"},{"id":"../path","url":"https://assets.fanart.tv/a"},{"id":"good","url":"https://assets.fanart.tv/a?token=secret"}]);
        assert!(fanart_candidates(Some(&bad), "portrait").is_empty());
    }
    #[tokio::test]
    async fn heya_verified_search_detail_keep_provenance_and_never_discover() {
        let id = "12345678-1234-1234-1234-123456789abc";
        let mbid = "22345678-1234-1234-1234-123456789abc";
        let document = json!({"id":id,"kind":"artist","display":{"name":"Artist"},"external_ids":[{"provider":"musicbrainz","namespace":"artist","value":mbid}],"data":{"biographies":[{"value":"Verified biography"}],"genres":[{"name":"Pop"}],"tags":[{"name":"Tag"}],"classification":{"artist_type":"Person"}},"provenance":{"data.biographies":[{"provider":"lastfm"}]}});
        let (base, server) = server(vec![
            (200, json!({"results":[document.clone()]}), None),
            (200, document, None),
        ]);
        let root = tempfile::tempdir().unwrap();
        let connection = Connection::new(false);
        let (status, _) = configured(&connection, root.path(), base, None).await;
        let result = heya_lookup(
            &connection,
            root.path(),
            &status.revision,
            "artist",
            "Artist",
            "",
            Some(mbid),
        )
        .await
        .unwrap();
        match result {
            HeyaLookup::Ready { item } => {
                assert_eq!(item.fields["biography"], "Verified biography");
                assert_eq!(item.field_origins["biography"], "lastfm via HeyaMetadata");
            }
            _ => panic!("expected uniquely verified canonical metadata"),
        }
        let requests = server.join().unwrap();
        assert!(requests[0].starts_with(&format!(
            "GET /proxy/api/v2/search?q={mbid}&kind=artist&limit=20 HTTP/1.1"
        )));
        assert!(requests[1].starts_with(&format!("GET /proxy/api/v2/entities/{id} HTTP/1.1")));
        assert!(requests
            .iter()
            .all(|request| !request.contains("authorization:")
                && !request.contains("POST")
                && !request.contains("/images/")));
    }
    #[tokio::test]
    async fn heya_homonyms_and_changed_configuration_do_not_read_detail() {
        let (base, server) = server(vec![(
            200,
            json!({"results":[{"id":"12345678-1234-1234-1234-123456789abc","kind":"artist","display":{"name":"Artist"}},{"id":"22345678-1234-1234-1234-123456789abc","kind":"artist","display":{"name":"Artist"}}]}),
            None,
        )]);
        let root = tempfile::tempdir().unwrap();
        let connection = Connection::new(false);
        let (status, config) = configured(&connection, root.path(), base, None).await;
        assert!(matches!(
            heya_lookup(
                &connection,
                root.path(),
                &status.revision,
                "artist",
                "Artist",
                "",
                None
            )
            .await
            .unwrap(),
            HeyaLookup::Ambiguous { .. }
        ));
        assert_eq!(server.join().unwrap().len(), 1);
        connection
            .settings
            .update(
                root.path(),
                &status.revision,
                "https://new.test".into(),
                None,
                true,
                false,
            )
            .await
            .unwrap();
        assert!(connection
            .get(
                Service::Heya,
                root.path(),
                &status.revision,
                &config,
                "api/v2/search",
                &[]
            )
            .await
            .is_err());
    }
    #[tokio::test]
    async fn disabled_and_overloaded_sources_never_issue_requests() {
        let root = tempfile::tempdir().unwrap();
        let connection = Connection::new(false);
        let (status, _) = connection.settings.snapshot(root.path()).await.unwrap();
        assert!(matches!(
            heya_lookup(
                &connection,
                root.path(),
                &status.revision,
                "artist",
                "Artist",
                "",
                None
            )
            .await
            .unwrap(),
            HeyaLookup::Unavailable
        ));
        let _permits = connection.admission.acquire_many(8).await.unwrap();
        assert!(connection
            .get(
                Service::Heya,
                root.path(),
                &status.revision,
                &Configuration::default(),
                "api/v2/search",
                &[]
            )
            .await
            .err()
            .unwrap()
            .contains("busy"));
    }
}
