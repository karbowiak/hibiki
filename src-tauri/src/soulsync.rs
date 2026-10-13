//! Optional explicit SoulSync connection. No discovery, credential imports or mutations.
pub(crate) mod entities;
use crate::http_response::BoundedResponseExt;
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tauri::Manager;
use tokio::sync::Mutex;

#[derive(Default, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Configuration {
    base_url: String,
    api_key: String,
    enabled: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub revision: String,
    pub base_url: String,
    pub configured: bool,
    pub has_api_key: bool,
    pub enabled: bool,
}
struct Current {
    configuration: Configuration,
    revision: String,
    loaded: bool,
}
impl Default for Current {
    fn default() -> Self {
        Self {
            configuration: Configuration::default(),
            revision: uuid::Uuid::new_v4().to_string(),
            loaded: false,
        }
    }
}
pub struct SoulSyncState {
    current: Mutex<Current>,
    limiter: Mutex<Option<tokio::time::Instant>>,
    admission: tokio::sync::Semaphore,
}
impl Default for SoulSyncState {
    fn default() -> Self {
        Self {
            current: Mutex::new(Current::default()),
            limiter: Mutex::new(None),
            admission: tokio::sync::Semaphore::new(8),
        }
    }
}
fn status(current: &Current) -> Status {
    Status {
        revision: current.revision.clone(),
        base_url: current.configuration.base_url.clone(),
        configured: !current.configuration.api_key.is_empty()
            && !current.configuration.base_url.is_empty(),
        has_api_key: !current.configuration.api_key.is_empty(),
        enabled: current.configuration.enabled,
    }
}
fn plain_base(value: &str) -> Result<url::Url, String> {
    let mut base = url::Url::parse(value).map_err(|_| "Enter a valid SoulSync server URL.")?;
    if !["http", "https"].contains(&base.scheme())
        || base.host_str().is_none()
        || !base.username().is_empty()
        || base.password().is_some()
        || base.query().is_some()
        || base.fragment().is_some()
    {
        return Err("SoulSync URL must be HTTP(S), without credentials, query or fragment.".into());
    }
    if value.len() > 2048 {
        return Err("SoulSync URL is too long.".into());
    }
    base.set_path(&format!("{}/", base.path().trim_end_matches('/')));
    Ok(base)
}
fn private(file: &std::fs::File) -> Result<(), String> {
    if crate::cache_files::file_id(file).is_none()
        || !crate::cache_files::regular_file(
            &file
                .metadata()
                .map_err(|_| "Could not inspect SoulSync settings.")?,
        )
    {
        return Err("SoulSync settings must be a private regular file.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|_| "Could not protect SoulSync settings.")?;
    }
    Ok(())
}
fn transaction(
    directory: &Path,
    update: Option<(Configuration, Configuration)>,
) -> Result<Configuration, String> {
    std::fs::create_dir_all(directory)
        .map_err(|_| "Could not open SoulSync settings directory.")?;
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let lock = options
        .open(directory.join(".soulsync-settings.lock"))
        .map_err(|_| "Could not lock SoulSync settings.")?;
    private(&lock)?;
    lock.lock()
        .map_err(|_| "Could not lock SoulSync settings.")?;
    let path = directory.join("soulsync-settings.json");
    let saved = match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Configuration::default(),
        Err(_) => return Err("Could not safely read SoulSync settings.".into()),
        Ok(metadata) => {
            if !crate::cache_files::regular_file(&metadata) || metadata.len() > 16384 {
                return Err("SoulSync settings are not a valid private file.".into());
            }
            let mut options = std::fs::OpenOptions::new();
            options.read(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                options.custom_flags(
                    windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT,
                );
            }
            let file = options
                .open(&path)
                .map_err(|_| "Could not safely read SoulSync settings.")?;
            private(&file)?;
            let mut content = String::new();
            file.take(16385)
                .read_to_string(&mut content)
                .map_err(|_| "Could not safely read SoulSync settings.")?;
            serde_json::from_str(&content).map_err(|_| {
                "SoulSync settings are invalid; existing credentials were preserved."
            })?
        }
    };
    if !saved.base_url.is_empty() {
        plain_base(&saved.base_url)?;
    }
    if saved.api_key.len() > 4096
        || saved.api_key.chars().any(char::is_whitespace)
        || reqwest::header::HeaderValue::from_str(&format!("Bearer {}", saved.api_key)).is_err()
        || (saved.enabled && (saved.base_url.is_empty() || saved.api_key.is_empty()))
    {
        return Err("SoulSync settings are invalid; existing credentials were preserved.".into());
    }
    if let Some((next, expected)) = update {
        if saved != expected {
            return Err("SoulSync configuration changed in another app instance. Reload Settings before saving.".into());
        }
        let bytes = serde_json::to_vec(&next).map_err(|_| "Could not save SoulSync settings.")?;
        let mut temporary = tempfile::Builder::new()
            .prefix(".soulsync.")
            .tempfile_in(directory)
            .map_err(|_| "Could not save SoulSync settings.")?;
        private(temporary.as_file())?;
        temporary
            .write_all(&bytes)
            .and_then(|_| temporary.as_file().sync_all())
            .map_err(|_| "Could not save SoulSync settings.")?;
        temporary.persist(path).map_err(|_| {
            "Could not replace SoulSync settings; existing credentials were preserved."
        })?;
        #[cfg(unix)]
        std::fs::File::open(directory)
            .and_then(|file| file.sync_all())
            .map_err(|_| "Could not sync SoulSync settings.")?;
        Ok(next)
    } else {
        Ok(saved)
    }
}
fn detail_id(value: Option<&serde_json::Value>) -> Option<i64> {
    value.and_then(|value| {
        if let Some(id) = value.as_i64() {
            return (id > 0).then_some(id);
        }
        let text = value.as_str()?;
        if text.len() > 19
            || !text.starts_with(|ch: char| ch.is_ascii_digit() && ch != '0')
            || !text.bytes().all(|byte| byte.is_ascii_digit())
        {
            return None;
        }
        text.parse::<i64>().ok().filter(|id| *id > 0)
    })
}
fn string_tags(value: Option<&serde_json::Value>) -> Vec<String> {
    let parsed = value
        .and_then(|value| value.as_str())
        .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok());
    value
        .filter(|value| value.is_array())
        .or(parsed.as_ref())
        .and_then(|value| value.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str())
                .filter(|text| !text.trim().is_empty() && text.chars().count() <= 512)
                .take(64)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}
impl SoulSyncState {
    async fn load(&self, directory: &Path) -> Result<(), String> {
        let mut current = self.current.lock().await;
        if !current.loaded {
            let directory = directory.to_path_buf();
            current.configuration =
                tokio::task::spawn_blocking(move || transaction(&directory, None))
                    .await
                    .map_err(|_| "Could not read SoulSync settings.")??;
            current.loaded = true;
        }
        Ok(())
    }
    async fn reload(&self, directory: &Path) -> Result<(), String> {
        let mut current = self.current.lock().await;
        let directory = directory.to_path_buf();
        let saved = tokio::task::spawn_blocking(move || transaction(&directory, None))
            .await
            .map_err(|_| "Could not read SoulSync settings.")??;
        if !current.loaded || current.configuration != saved {
            current.configuration = saved;
            current.revision = uuid::Uuid::new_v4().to_string();
            current.loaded = true;
        }
        Ok(())
    }
    async fn update(
        &self,
        directory: &Path,
        revision: &str,
        base_url: String,
        key: Option<String>,
        enabled: bool,
        clear: bool,
    ) -> Result<Status, String> {
        self.load(directory).await?;
        let mut current = self.current.lock().await;
        if current.revision != revision {
            return Err("SoulSync configuration changed. Reload Settings before saving.".into());
        }
        let base = if base_url.trim().is_empty() {
            String::new()
        } else {
            plain_base(base_url.trim())?.to_string()
        };
        let previous_base = if current.configuration.base_url.is_empty() {
            String::new()
        } else {
            plain_base(&current.configuration.base_url)?.to_string()
        };
        if !clear
            && !base.is_empty()
            && base != previous_base
            && !current.configuration.api_key.is_empty()
            && key.as_ref().is_none_or(|value| value.is_empty())
        {
            return Err("Enter an API key when changing the SoulSync server URL. The saved key stays with its original server.".into());
        }
        let api_key = if clear {
            String::new()
        } else {
            key.unwrap_or_else(|| current.configuration.api_key.clone())
        };
        if api_key.len() > 4096
            || api_key.chars().any(char::is_whitespace)
            || reqwest::header::HeaderValue::from_str(&format!("Bearer {api_key}")).is_err()
        {
            return Err("SoulSync API key is invalid.".into());
        }
        if enabled && !clear && (base.is_empty() || api_key.is_empty()) {
            return Err("Enter a server URL and API key before enabling SoulSync.".into());
        }
        let previous = current.configuration.clone();
        let next = Configuration {
            base_url: base,
            api_key,
            enabled: enabled && !clear,
        };
        let directory = directory.to_path_buf();
        let saved = next.clone();
        // Retire active service requests even if an atomic save has an unknown outcome.
        current.revision = uuid::Uuid::new_v4().to_string();
        tokio::task::spawn_blocking(move || transaction(&directory, Some((saved, previous))))
            .await
            .map_err(|_| "Could not save SoulSync settings.")??;
        current.configuration = next;
        current.revision = uuid::Uuid::new_v4().to_string();
        Ok(status(&current))
    }
    async fn owned(&self, revision: &str) -> bool {
        self.current.lock().await.revision == revision
    }
    async fn wait(&self) {
        let mut next = self.limiter.lock().await;
        if let Some(until) = *next {
            tokio::time::sleep_until(until).await;
        }
        *next = Some(tokio::time::Instant::now() + Duration::from_secs(1));
    }
    async fn get(
        &self,
        configuration: &Configuration,
        revision: &str,
        path: &str,
        query: &[(&str, &str)],
    ) -> Result<serde_json::Value, String> {
        self.wait().await;
        if !self.owned(revision).await {
            return Err("SoulSync configuration was superseded.".into());
        }
        let url = plain_base(&configuration.base_url)?
            .join(path)
            .map_err(|_| "Invalid SoulSync request.")?;
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .build()
            .map_err(|_| "Could not initialize SoulSync connection.")?;
        let response = client
            .get(url)
            .bearer_auth(&configuration.api_key)
            .query(query)
            .send()
            .await
            .map_err(|_| "Could not reach SoulSync. Check the server URL and connection.")?;
        if !self.owned(revision).await {
            return Err("SoulSync configuration was superseded.".into());
        }
        if !response.status().is_success() {
            return Err(match response.status().as_u16() {
                401 | 403 => "SoulSync rejected the API key. Update it in Settings.",
                429 => "SoulSync rate limit reached. Try again later.",
                _ => "SoulSync could not return metadata. Try again later.",
            }
            .into());
        }
        let body: serde_json::Value = response
            .bounded_json(1024 * 1024)
            .await
            .map_err(|_| "SoulSync returned invalid or oversized metadata.")?;
        if body.get("success").and_then(|value| value.as_bool()) != Some(true) {
            return Err("SoulSync returned an unsuccessful metadata response.".into());
        }
        if !self.owned(revision).await {
            return Err("SoulSync configuration was superseded.".into());
        }
        Ok(body)
    }
    async fn artist(
        &self,
        directory: &Path,
        revision: &str,
        artist: &str,
    ) -> Result<ArtistLookup, String> {
        self.load(directory).await?;
        let configuration = {
            let current = self.current.lock().await;
            if current.revision != revision {
                return Err("SoulSync configuration was superseded.".into());
            }
            if !current.configuration.enabled {
                return Ok(ArtistLookup::Unavailable);
            }
            current.configuration.clone()
        };
        let _permit = self
            .admission
            .try_acquire()
            .map_err(|_| "SoulSync metadata requests are busy. Try again shortly.")?;
        if artist.trim().is_empty() || artist.chars().count() > 512 {
            return Err("Artist name is invalid.".into());
        }
        let listing = self
            .get(
                &configuration,
                revision,
                "api/v1/library/artists",
                &[
                    ("search", artist),
                    ("page", "1"),
                    ("limit", "5"),
                    ("fields", "id,name"),
                ],
            )
            .await?;
        let items = listing
            .pointer("/data/artists")
            .and_then(|value| value.as_array())
            .ok_or("SoulSync returned invalid artist metadata.")?;
        if items.len() > 5
            || listing
                .pointer("/pagination/has_next")
                .and_then(|value| value.as_bool())
                == Some(true)
            || listing
                .pointer("/pagination/total")
                .and_then(|value| value.as_u64())
                .is_some_and(|total| total > items.len() as u64)
        {
            return Ok(ArtistLookup::Unavailable);
        }
        let normalize = |value: &str| {
            value
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .to_lowercase()
        };
        let name = normalize(artist);
        let matching: Vec<_> = items
            .iter()
            .filter(|item| {
                item.get("name")
                    .and_then(|value| value.as_str())
                    .is_some_and(|value| normalize(value) == name)
                    && detail_id(item.get("id")).is_some()
            })
            .collect();
        if matching.len() > 1 {
            return Ok(ArtistLookup::Ambiguous {
                candidates: matching
                    .iter()
                    .map(|item| ArtistCandidate {
                        id: detail_id(item.get("id")).unwrap().to_string(),
                        name: artist.to_string(),
                    })
                    .collect(),
            });
        }
        if matching.is_empty() {
            return Ok(ArtistLookup::Unavailable);
        }
        let id = detail_id(matching[0].get("id")).unwrap();
        let detail = self
            .get(
                &configuration,
                revision,
                &format!("api/v1/library/artists/{id}"),
                &[(
                    "fields",
                    "id,name,summary,thumb_url,genres,label,musicbrainz_id,lastfm_match_status,lastfm_bio,lastfm_tags,lastfm_listeners,lastfm_playcount,genius_match_status,genius_description",
                )],
            )
            .await?;
        let item = detail
            .pointer("/data/artist")
            .ok_or("SoulSync returned invalid artist metadata.")?;
        if detail_id(item.get("id")) != Some(id)
            || !item
                .get("name")
                .and_then(|value| value.as_str())
                .is_some_and(|value| normalize(value) == name)
        {
            return Ok(ArtistLookup::Unavailable);
        }
        let text = |key: &str| {
            item.get(key)
                .and_then(|value| value.as_str())
                .filter(|value| !value.trim().is_empty())
                .map(str::to_string)
        };
        let thumb = text("thumb_url").filter(|value| {
            url::Url::parse(value).is_ok_and(|url| {
                ["http", "https"].contains(&url.scheme())
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.query().is_none()
                    && url.fragment().is_none()
            })
        });
        let lastfm_matched = item
            .get("lastfm_match_status")
            .and_then(|value| value.as_str())
            == Some("matched");
        let genius_matched = item
            .get("genius_match_status")
            .and_then(|value| value.as_str())
            == Some("matched");
        let (summary, summary_origin) = if let Some(summary) = text("summary") {
            (Some(summary), Some("SoulSync library".into()))
        } else if lastfm_matched && text("lastfm_bio").is_some() {
            (text("lastfm_bio"), Some("Last.fm via SoulSync".into()))
        } else if genius_matched && text("genius_description").is_some() {
            (
                text("genius_description"),
                Some("Genius via SoulSync".into()),
            )
        } else {
            (None, None)
        };
        let count = |key: &str| {
            if lastfm_matched {
                item.get(key)
                    .and_then(|value| value.as_u64())
                    .filter(|value| *value <= 9007199254740991)
            } else {
                None
            }
        };
        Ok(ArtistLookup::Ready {
            artist: ArtistInfo {
                name: text("name").unwrap(),
                summary,
                summary_origin,
                tags: if lastfm_matched {
                    string_tags(item.get("lastfm_tags"))
                } else {
                    Vec::new()
                },
                listeners: count("lastfm_listeners"),
                play_count: count("lastfm_playcount"),
                thumb_url: thumb,
                genres: item
                    .get("genres")
                    .and_then(|value| value.as_array())
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|item| item.as_str().map(str::to_string))
                            .take(64)
                            .collect()
                    })
                    .unwrap_or_default(),
                label: text("label"),
                mbid: text("musicbrainz_id"),
            },
        })
    }
}
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ArtistInfo {
    pub name: String,
    pub summary: Option<String>,
    pub summary_origin: Option<String>,
    pub tags: Vec<String>,
    pub listeners: Option<u64>,
    pub play_count: Option<u64>,
    pub thumb_url: Option<String>,
    pub genres: Vec<String>,
    pub label: Option<String>,
    pub mbid: Option<String>,
}
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ArtistCandidate {
    pub id: String,
    pub name: String,
}
#[derive(Serialize, Debug)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum ArtistLookup {
    Ready { artist: ArtistInfo },
    Unavailable,
    Ambiguous { candidates: Vec<ArtistCandidate> },
}
#[cfg(test)]
impl ArtistLookup {
    fn into_artist(self) -> Option<ArtistInfo> {
        match self {
            Self::Ready { artist } => Some(artist),
            _ => None,
        }
    }
}
fn directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|_| "Could not open SoulSync settings directory.".into())
}
#[tauri::command]
pub async fn soulsync_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<SoulSyncState>>,
) -> Result<Status, String> {
    state.reload(&directory(&app)?).await?;
    Ok(status(&*state.current.lock().await))
}
#[tauri::command]
pub async fn soulsync_configure(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<SoulSyncState>>,
    revision: String,
    base_url: String,
    api_key: Option<String>,
    enabled: bool,
    clear: bool,
) -> Result<Status, String> {
    state
        .update(
            &directory(&app)?,
            &revision,
            base_url,
            api_key,
            enabled,
            clear,
        )
        .await
}
#[tauri::command]
pub async fn soulsync_artist(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<SoulSyncState>>,
    revision: String,
    artist: String,
) -> Result<ArtistLookup, String> {
    state.artist(&directory(&app)?, &revision, &artist).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    pub(super) fn service(
        replies: Vec<(u16, String, Option<String>)>,
    ) -> (String, std::thread::JoinHandle<Vec<String>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/proxy", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for (status, body, location) in replies {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut buffer = [0; 4096];
                while !bytes.windows(4).any(|part| part == b"\r\n\r\n") {
                    let count = stream.read(&mut buffer).unwrap();
                    if count == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&buffer[..count]);
                }
                requests.push(String::from_utf8(bytes).unwrap());
                let location = location
                    .map(|value| format!("Location: {value}\r\n"))
                    .unwrap_or_default();
                write!(stream,"HTTP/1.1 {status} synthetic\r\n{location}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            }
            requests
        });
        (base, server)
    }
    pub(super) async fn configured(directory: &Path, base: String) -> (SoulSyncState, String) {
        let state = SoulSyncState::default();
        state.load(directory).await.unwrap();
        let revision = state.current.lock().await.revision.clone();
        let status = state
            .update(
                directory,
                &revision,
                base,
                Some("synthetic-native-only-key".into()),
                true,
                false,
            )
            .await
            .unwrap();
        (state, status.revision)
    }
    #[tokio::test]
    async fn soulsync_get_routes_are_bounded_encoded_and_authenticated_without_key_in_url() {
        let listing=serde_json::json!({"success":true,"data":{"artists":[{"id":42,"name":"Artist & Name"}]},"pagination":{"has_next":false,"total":1}}).to_string();
        let detail=serde_json::json!({"success":true,"data":{"artist":{"id":42,"name":"Artist & Name","summary":"Biography","genres":["Pop"],"thumb_url":"https://images.test/art"}}}).to_string();
        let (base, server) = service(vec![(200, listing, None), (200, detail, None)]);
        let directory = tempfile::tempdir().unwrap();
        let (state, revision) = configured(directory.path(), base).await;
        let result = state
            .artist(directory.path(), &revision, "Artist & Name")
            .await
            .unwrap()
            .into_artist()
            .unwrap();
        assert_eq!(result.summary.as_deref(), Some("Biography"));
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 2);
        for request in &requests {
            assert!(request.starts_with("GET /proxy/api/v1/library/artists"));
            let target = request.split_whitespace().nth(1).unwrap();
            assert!(!target.contains("synthetic-native-only-key"));
            assert!(request
                .to_lowercase()
                .contains("authorization: bearer synthetic-native-only-key"));
        }
        let url = url::Url::parse(&format!(
            "http://synthetic.test{}",
            requests[0].split_whitespace().nth(1).unwrap()
        ))
        .unwrap();
        assert_eq!(
            url.query_pairs()
                .find(|(key, _)| key == "search")
                .unwrap()
                .1,
            "Artist & Name"
        );
        assert!(
            !serde_json::to_string(&status(&*state.current.lock().await))
                .unwrap()
                .contains("synthetic-native-only-key")
        );
    }
    #[tokio::test]
    async fn soulsync_denied_redirect_and_stale_revision_do_not_follow_or_expose_key() {
        for code in [401, 302] {
            let (base, server) = service(vec![(
                code,
                String::new(),
                Some("https://foreign.test/private".into()),
            )]);
            let directory = tempfile::tempdir().unwrap();
            let (state, revision) = configured(directory.path(), base).await;
            let error = state
                .artist(directory.path(), &revision, "Artist")
                .await
                .unwrap_err();
            assert!(!error.contains("synthetic-native-only-key"));
            assert!(!error.contains("foreign.test"));
            assert_eq!(server.join().unwrap().len(), 1);
        }
        let directory = tempfile::tempdir().unwrap();
        let (state, revision) = configured(directory.path(), "http://127.0.0.1:1".into()).await;
        state.current.lock().await.revision = "replacement".into();
        assert!(state
            .artist(directory.path(), &revision, "Artist")
            .await
            .unwrap_err()
            .contains("superseded"));
    }
    #[tokio::test]
    async fn soulsync_revision_change_during_get_retires_reply() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (seen_tx, seen_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut bytes = [0; 4096];
            let _ = stream.read(&mut bytes).unwrap();
            seen_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            let body = "{\"success\":true,\"data\":{\"artists\":[]}}";
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
        });
        let directory = tempfile::tempdir().unwrap();
        let (state, revision) = configured(directory.path(), base).await;
        let state = Arc::new(state);
        let path = directory.path().to_path_buf();
        let task_state = state.clone();
        let job = tokio::spawn(async move { task_state.artist(&path, &revision, "Artist").await });
        seen_rx.await.unwrap();
        state.current.lock().await.revision = "retired".into();
        release_tx.send(()).unwrap();
        assert!(job.await.unwrap().unwrap_err().contains("superseded"));
        server.join().unwrap();
    }
    #[tokio::test(start_paused = true)]
    async fn soulsync_shared_gate_spaces_concurrent_calls_and_cancellation() {
        let state = Arc::new(SoulSyncState::default());
        state.wait().await;
        let canceled = {
            let state = state.clone();
            tokio::spawn(async move { state.wait().await })
        };
        tokio::task::yield_now().await;
        canceled.abort();
        let mut jobs = Vec::new();
        for _ in 0..3 {
            let state = state.clone();
            jobs.push(tokio::spawn(async move {
                state.wait().await;
                tokio::time::Instant::now()
            }));
        }
        let mut times = Vec::new();
        for job in jobs {
            times.push(job.await.unwrap());
        }
        times.sort();
        assert!(times
            .windows(2)
            .all(|pair| pair[1] - pair[0] >= Duration::from_secs(1)));
    }
    #[tokio::test]
    async fn saved_key_never_follows_an_implicit_server_or_path_change() {
        let directory = tempfile::tempdir().unwrap();
        let (state, revision) =
            configured(directory.path(), "https://synthetic.test/proxy".into()).await;
        let original = std::fs::read(directory.path().join("soulsync-settings.json")).unwrap();
        let captured = state.current.lock().await.configuration.clone();
        for target in ["https://other.test/proxy", "https://synthetic.test/another"] {
            for key in [None, Some(String::new())] {
                let error = state
                    .update(directory.path(), &revision, target.into(), key, true, false)
                    .await
                    .err()
                    .unwrap();
                assert!(error.contains("Enter an API key"));
                assert_eq!(
                    std::fs::read(directory.path().join("soulsync-settings.json")).unwrap(),
                    original
                );
                assert!(state.owned(&revision).await);
                assert!(state.current.lock().await.configuration == captured);
            }
        }
        // Case/default port/trailing slash normalization preserves the same target.
        let same = state
            .update(
                directory.path(),
                &revision,
                "HTTPS://SYNTHETIC.TEST:443/proxy/".into(),
                None,
                true,
                false,
            )
            .await
            .unwrap();
        assert_eq!(
            state.current.lock().await.configuration.api_key,
            "synthetic-native-only-key"
        );
        let changed = state
            .update(
                directory.path(),
                &same.revision,
                "https://other.test/path".into(),
                Some("synthetic-replacement-key".into()),
                true,
                false,
            )
            .await
            .unwrap();
        assert_eq!(
            state.current.lock().await.configuration.api_key,
            "synthetic-replacement-key"
        );
        let partial = state
            .update(
                directory.path(),
                &changed.revision,
                String::new(),
                None,
                false,
                false,
            )
            .await
            .unwrap();
        assert!(partial.has_api_key);
        assert!(state
            .update(
                directory.path(),
                &partial.revision,
                "https://other.test/path".into(),
                None,
                true,
                false
            )
            .await
            .is_err());
        assert!(state.owned(&partial.revision).await);
        let cleared = state
            .update(
                directory.path(),
                &partial.revision,
                "https://third.test/path".into(),
                None,
                true,
                true,
            )
            .await
            .unwrap();
        assert!(!cleared.has_api_key);
        assert!(!cleared.enabled);
        assert!(
            !std::fs::read_to_string(directory.path().join("soulsync-settings.json"))
                .unwrap()
                .contains("synthetic-replacement-key")
        );
    }

    #[tokio::test]
    async fn soulsync_atomic_settings_preserve_invalid_blob_and_explicit_clear_removes_key() {
        let directory = tempfile::tempdir().unwrap();
        let (state, revision) = configured(directory.path(), "https://synthetic.test".into()).await;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(directory.path().join("soulsync-settings.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        let partial = state
            .update(
                directory.path(),
                &revision,
                String::new(),
                None,
                false,
                false,
            )
            .await
            .unwrap();
        assert!(!partial.configured);
        assert!(partial.has_api_key);
        let cleared = state
            .update(
                directory.path(),
                &partial.revision,
                "https://synthetic.test".into(),
                None,
                false,
                true,
            )
            .await
            .unwrap();
        assert!(!cleared.configured);
        assert!(
            !std::fs::read_to_string(directory.path().join("soulsync-settings.json"))
                .unwrap()
                .contains("synthetic-native-only-key")
        );
        let path = directory.path().join("soulsync-settings.json");
        std::fs::write(&path, "{invalid-original").unwrap();
        assert!(transaction(
            directory.path(),
            Some((Configuration::default(), Configuration::default()))
        )
        .is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), "{invalid-original");
        let previous_revision = state.current.lock().await.revision.clone();
        assert!(state
            .update(
                directory.path(),
                &previous_revision,
                "https://synthetic.test".into(),
                None,
                false,
                false
            )
            .await
            .is_err());
        assert_ne!(
            state.current.lock().await.revision,
            previous_revision,
            "failed configuration confirmation retires old service requests too"
        );
        for base in [
            "https://key@synthetic.test",
            "https://synthetic.test?key=private",
            "file:///private",
        ] {
            assert!(plain_base(base).is_err());
        }
    }
    #[tokio::test]
    async fn soulsync_admission_is_bounded_but_disabled_lookup_remains_quiet() {
        let directory = tempfile::tempdir().unwrap();
        let (state, revision) = configured(directory.path(), "http://127.0.0.1:1".into()).await;
        let _all = state.admission.try_acquire_many(8).unwrap();
        assert!(state
            .artist(directory.path(), &revision, "Artist")
            .await
            .unwrap_err()
            .contains("busy"));
        let disabled = SoulSyncState::default();
        disabled.load(directory.path()).await.unwrap();
        disabled.current.lock().await.configuration.enabled = false;
        let disabled_revision = disabled.current.lock().await.revision.clone();
        let _all_disabled = disabled.admission.try_acquire_many(8).unwrap();
        assert!(disabled
            .artist(directory.path(), &disabled_revision, "Artist")
            .await
            .unwrap()
            .into_artist()
            .is_none());
    }
    #[tokio::test]
    async fn soulsync_string_library_ids_ignore_unsupported_aliases_and_use_matched_aggregate_fields(
    ) {
        let listing=serde_json::json!({"success":true,"data":{"artists":[{"id":"42","name":"Artist"},{"id":"99::soulsync","name":"Artist"}]},"pagination":{"has_next":false,"total":2}}).to_string();
        let detail=serde_json::json!({"success":true,"data":{"artist":{"id":"42","name":"Artist","summary":"","genres":[],"lastfm_match_status":"matched","lastfm_bio":"Verified biography","lastfm_tags":"[\"Dance\"]","lastfm_listeners":123,"lastfm_playcount":456,"genius_match_status":"matched","genius_description":"Secondary biography"}}}).to_string();
        let (base, server) = service(vec![(200, listing, None), (200, detail, None)]);
        let directory = tempfile::tempdir().unwrap();
        let (state, revision) = configured(directory.path(), base).await;
        let artist = state
            .artist(directory.path(), &revision, "Artist")
            .await
            .unwrap()
            .into_artist()
            .unwrap();
        assert_eq!(artist.summary.as_deref(), Some("Verified biography"));
        assert_eq!(
            artist.summary_origin.as_deref(),
            Some("Last.fm via SoulSync")
        );
        assert_eq!(artist.tags, vec!["Dance"]);
        assert_eq!(artist.listeners, Some(123));
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests[1].starts_with("GET /proxy/api/v1/library/artists/42?"));
        assert!(!requests[1].contains("soulsync%"));
    }
    #[tokio::test]
    async fn soulsync_two_numeric_homonyms_remain_ambiguous_without_a_detail_request() {
        let listing=serde_json::json!({"success":true,"data":{"artists":[{"id":"42","name":"Artist"},{"id":99,"name":"Artist"},{"id":"1::soulsync","name":"Artist"}]},"pagination":{"has_next":false,"total":3}}).to_string();
        let (base, server) = service(vec![(200, listing, None)]);
        let directory = tempfile::tempdir().unwrap();
        let (state, revision) = configured(directory.path(), base).await;
        match state
            .artist(directory.path(), &revision, "Artist")
            .await
            .unwrap()
        {
            ArtistLookup::Ambiguous { candidates } => assert_eq!(
                candidates
                    .iter()
                    .map(|candidate| candidate.id.as_str())
                    .collect::<Vec<_>>(),
                vec!["42", "99"]
            ),
            _ => panic!("homonyms must not be automatically chosen"),
        };
        assert_eq!(server.join().unwrap().len(), 1);
        for value in [
            serde_json::json!("99::soulsync"),
            serde_json::json!("42/../secret"),
            serde_json::json!("0"),
            serde_json::json!(-1),
            serde_json::json!("9223372036854775808"),
        ] {
            assert!(detail_id(Some(&value)).is_none());
        }
    }
    #[tokio::test]
    async fn soulsync_biography_keeps_library_priority_and_rejects_unmatched_provider_values() {
        for (summary, lastfm_status, genius_status, expected, origin) in [
            (
                Some("Library biography"),
                "matched",
                "matched",
                Some("Library biography"),
                Some("SoulSync library"),
            ),
            (
                None,
                "error",
                "matched",
                Some("Genius biography"),
                Some("Genius via SoulSync"),
            ),
            (None, "error", "not_found", None, None),
        ] {
            let listing=serde_json::json!({"success":true,"data":{"artists":[{"id":"42","name":"Artist"}]},"pagination":{"has_next":false,"total":1}}).to_string();
            let detail=serde_json::json!({"success":true,"data":{"artist":{"id":"42","name":"Artist","summary":summary,"lastfm_match_status":lastfm_status,"lastfm_bio":"Last.fm biography","lastfm_tags":["Tag"],"lastfm_listeners":10,"genius_match_status":genius_status,"genius_description":"Genius biography"}}}).to_string();
            let (base, server) = service(vec![(200, listing, None), (200, detail, None)]);
            let directory = tempfile::tempdir().unwrap();
            let (state, revision) = configured(directory.path(), base).await;
            let artist = state
                .artist(directory.path(), &revision, "Artist")
                .await
                .unwrap()
                .into_artist()
                .unwrap();
            assert_eq!(artist.summary.as_deref(), expected);
            assert_eq!(artist.summary_origin.as_deref(), origin);
            if lastfm_status != "matched" {
                assert!(artist.tags.is_empty());
                assert!(artist.listeners.is_none());
            }
            server.join().unwrap();
        }
    }
}
