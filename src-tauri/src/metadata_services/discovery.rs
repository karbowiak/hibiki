//! Explicit source discovery only. Opaque server candidates never imply a match.
use super::*;
use std::collections::{HashMap, HashSet};
#[derive(Default)]
pub(super) struct Registry {
    capability: Option<(String, Capability)>,
    receipts: HashMap<String, Receipt>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub retryable: bool,
    pub available: bool,
    pub reason: Option<String>,
}
#[derive(Clone)]
struct Owner {
    native_revision: u64,
    revision: String,
    scope: String,
    kind: String,
}
#[derive(Clone)]
enum Stage {
    Run(String),
    Candidates(HashSet<String>),
    Job(i64),
    Canonical(String),
    Blocked,
}
#[derive(Clone)]
struct Receipt {
    created: std::time::Instant,
    owner: Owner,
    stage: Stage,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    reference: String,
    name: String,
    artists: Vec<String>,
    disambiguation: Option<String>,
    year: Option<u64>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    handle: String,
    state: String,
    candidates: Vec<Candidate>,
    canonical_id: Option<String>,
    retry_after: u64,
}
fn enabled_security(value: &Value, spec: &Value, key: bool) -> bool {
    let Some(alternatives) = value.as_array() else {
        return false;
    };
    alternatives.is_empty()
        || alternatives.iter().any(|alternative| {
            alternative.as_object().is_some_and(|requirements| {
                requirements.is_empty()
                    || key
                        && requirements.keys().all(|name| {
                            spec.pointer(&format!("/components/securitySchemes/{name}"))
                                .is_some_and(|scheme| {
                                    scheme.get("type").and_then(Value::as_str) == Some("http")
                                        && scheme.get("scheme").and_then(Value::as_str).is_some_and(
                                            |scheme| scheme.eq_ignore_ascii_case("bearer"),
                                        )
                                })
                        })
            })
        })
}
fn advertised(spec: &Value, key: bool) -> bool {
    [
        ("/api/v2/discoveries", "post"),
        ("/api/v2/discoveries/{id}", "get"),
        ("/api/v2/resolutions", "post"),
        ("/api/v2/jobs/{id}", "get"),
    ]
    .iter()
    .all(|(path, method)| {
        let Some(operation) = spec
            .get("paths")
            .and_then(|paths| paths.get(*path))
            .and_then(|path| path.get(*method))
        else {
            return false;
        };
        operation
            .get("security")
            .or_else(|| spec.get("security"))
            .map(|security| enabled_security(security, spec, key))
            .unwrap_or(true)
    })
}
fn bounded(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .and_then(crate::public_metadata::identity::bounded_text)
}
fn parsed(
    receipt: &mut Receipt,
    handle: &str,
    value: &Value,
    retry: u64,
) -> Result<Progress, String> {
    let state = value
        .get("state")
        .and_then(Value::as_str)
        .ok_or("Invalid HeyaMetadata discovery status.")?;
    let mut result = Progress {
        handle: handle.into(),
        state: state.into(),
        candidates: vec![],
        canonical_id: None,
        retry_after: retry.clamp(1, 60),
    };
    if value
        .pointer("/result/kind")
        .and_then(Value::as_str)
        .is_some_and(|kind| kind != receipt.owner.kind)
    {
        return Err("Discovery returned a different entity type.".into());
    }
    if let Some(id) = value
        .get("entity_id")
        .or_else(|| value.pointer("/result/entity_id"))
        .and_then(Value::as_str)
        .filter(|id| valid_mbid(id))
    {
        receipt.stage = Stage::Canonical(id.into());
        result.state = "completed".into();
        result.canonical_id = Some(id.into());
        return Ok(result);
    }
    if ["failed", "discarded", "cancelled"].contains(&state) {
        receipt.stage = Stage::Blocked;
        result.state = "failed".into();
        return Ok(result);
    }
    if state == "completed" {
        if value
            .pointer("/result/kind")
            .and_then(Value::as_str)
            .is_some_and(|kind| kind != receipt.owner.kind)
        {
            return Err("Discovery returned a different entity type.".into());
        }
        let entries = value
            .pointer("/result/candidates")
            .and_then(Value::as_array)
            .ok_or("Discovery completed without a reviewable identity.")?;
        for entry in entries.iter().take(20) {
            let Some(reference) = entry
                .get("candidate_ref")
                .and_then(Value::as_str)
                .filter(|id| valid_mbid(id))
            else {
                continue;
            };
            let Some(name) = bounded(entry.pointer(if receipt.owner.kind == "artist" {
                "/display/name"
            } else {
                "/display/title"
            })) else {
                continue;
            };
            if result
                .candidates
                .iter()
                .any(|candidate| candidate.reference == reference)
            {
                continue;
            }
            let artists = entry
                .pointer("/display/artists")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .take(16)
                        .filter_map(|item| bounded(item.get("name")))
                        .collect()
                })
                .unwrap_or_default();
            result.candidates.push(Candidate {
                reference: reference.into(),
                name,
                artists,
                disambiguation: bounded(entry.pointer("/display/disambiguation")),
                year: entry
                    .pointer("/display/year")
                    .and_then(Value::as_u64)
                    .filter(|year| *year > 0 && *year <= 9999),
            });
        }
        receipt.stage = Stage::Candidates(
            result
                .candidates
                .iter()
                .map(|candidate| candidate.reference.clone())
                .collect(),
        );
        result.state = "needs-selection".into();
        return Ok(result);
    }
    if let Some(id) = value
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| valid_mbid(id))
    {
        receipt.stage = Stage::Run(id.into());
    } else if let Some(id) = value
        .pointer("/job/id")
        .and_then(Value::as_i64)
        .filter(|id| *id > 0)
    {
        receipt.stage = Stage::Job(id);
    }
    if ![
        "queued",
        "working",
        "accepted",
        "running",
        "available",
        "scheduled",
        "retryable",
        "pending",
    ]
    .contains(&state)
    {
        return Err("Unsupported discovery status.".into());
    }
    Ok(result)
}
impl Connection {
    async fn discovery_http<C, F>(
        &self,
        directory: &Path,
        revision: &str,
        method: reqwest::Method,
        path: &str,
        body: Option<&Value>,
        check: &C,
    ) -> Result<(Value, u64), String>
    where
        C: Fn() -> F,
        F: std::future::Future<Output = bool>,
    {
        if !check().await {
            return Err("The library connection changed.".into());
        }
        let (status, config) = self.settings.snapshot(directory).await?;
        if status.revision != revision || !status.enabled || !status.configured {
            return Err("HeyaMetadata connection changed. Retry from the current item.".into());
        }
        self.wait().await?;
        if !check().await || !self.settings.owned(revision).await {
            return Err("HeyaMetadata connection changed.".into());
        }
        let url = base(&config.base_url)?
            .join(path)
            .map_err(|_| "Invalid discovery route.")?;
        let mut request = CLIENT
            .request(method, url)
            .header("Prefer", "respond-async");
        if !config.api_key.is_empty() {
            let mut header =
                reqwest::header::HeaderValue::from_str(&format!("Bearer {}", config.api_key))
                    .map_err(|_| "Invalid service key.")?;
            header.set_sensitive(true);
            request = request.header(reqwest::header::AUTHORIZATION, header);
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        let response=request.send().await.map_err(|_|"Discovery response was interrupted. Search existing identities before starting another discovery.")?;
        if !check().await || !self.settings.owned(revision).await {
            return Err("HeyaMetadata connection changed.".into());
        }
        let code = response.status();
        let retry = response
            .headers()
            .get("retry-after")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(1);
        if matches!(code.as_u16(), 401 | 403) {
            self.discovery.lock().await.capability=Some((revision.into(),Capability{retryable:false,available:false,reason:Some("This server requires permission for discovery. Check its API key in Settings.".into())}));
            return Err("This server does not permit discovery. Check Settings.".into());
        }
        if matches!(code.as_u16(), 429 | 503) {
            self.backoff(retry.clamp(1, 3600))?;
        }
        if !code.is_success() && code.as_u16() != 503 {
            return Err("HeyaMetadata discovery is unavailable. Try later.".into());
        }
        let value: Value = response
            .bounded_json(MAX_JSON_BYTES)
            .await
            .map_err(|_| "Invalid or oversized discovery response.")?;
        if !check().await || !self.settings.owned(revision).await {
            return Err("HeyaMetadata connection changed.".into());
        }
        if code.as_u16() == 503 && value.get("state").and_then(Value::as_str) != Some("failed") {
            return Err("HeyaMetadata discovery is temporarily unavailable.".into());
        }
        Ok((value, retry))
    }
    async fn discovery_capability<C, F>(
        &self,
        directory: &Path,
        revision: &str,
        check: &C,
    ) -> Result<Capability, String>
    where
        C: Fn() -> F,
        F: std::future::Future<Output = bool>,
    {
        if !check().await {
            return Err("The library connection changed.".into());
        }
        let (status, config) = self.settings.snapshot(directory).await?;
        if status.revision != revision {
            return Err("HeyaMetadata connection changed.".into());
        }
        if !status.enabled || !status.configured {
            return Ok(Capability {
                retryable: false,
                available: false,
                reason: Some("Enable HeyaMetadata in Settings to discover missing items.".into()),
            });
        }
        if let Some((owner, capability)) = &self.discovery.lock().await.capability {
            if owner == revision {
                return Ok(capability.clone());
            }
        }
        let response = self
            .discovery_http(
                directory,
                revision,
                reqwest::Method::GET,
                "api/openapi.json",
                None,
                check,
            )
            .await;
        let available = response
            .as_ref()
            .is_ok_and(|(value, _)| advertised(value, !config.api_key.is_empty()));
        if response.is_err() {
            if let Some((owner, capability)) = &self.discovery.lock().await.capability {
                if owner == revision && !capability.available && !capability.retryable {
                    return Ok(capability.clone());
                }
            }
        }
        let result=Capability{retryable:response.is_err(),available,reason:(!available).then(||"This server does not advertise supported discovery permissions. Existing metadata search remains available.".into())};
        if self.settings.owned(revision).await && !result.retryable {
            self.discovery.lock().await.capability = Some((revision.into(), result.clone()));
        }
        Ok(result)
    }
    async fn discover<C, F>(
        &self,
        directory: &Path,
        owner: Owner,
        query: String,
        artist: String,
        mbid: Option<String>,
        check: &C,
    ) -> Result<Progress, String>
    where
        C: Fn() -> F,
        F: std::future::Future<Output = bool>,
    {
        let _permit = self
            .discovery_admission
            .try_acquire()
            .map_err(|_| "A discovery action is already running.")?;
        if !["artist", "release_group"].contains(&owner.kind.as_str())
            || crate::public_metadata::identity::bounded_text(&query).is_none()
            || artist.chars().count() > 512
            || mbid.as_deref().is_some_and(|id| !valid_mbid(id))
        {
            return Err("Invalid discovery facts.".into());
        }
        if !self
            .discovery_capability(directory, &owner.revision, check)
            .await?
            .available
        {
            return Err("This connection does not permit discovery.".into());
        }
        let handle = uuid::Uuid::new_v4().to_string();
        {
            let mut registry = self.discovery.lock().await;
            registry.receipts.retain(|_, receipt| {
                receipt.created.elapsed() < Duration::from_secs(1200)
                    && receipt.owner.revision == owner.revision
                    && receipt.owner.native_revision == owner.native_revision
                    && !matches!(receipt.stage, Stage::Blocked | Stage::Canonical(_))
            });
            if registry.receipts.len() >= 8 {
                return Err(
                    "Too many discovery sessions. Reopen the source after pending work completes."
                        .into(),
                );
            };
            registry.receipts.insert(
                handle.clone(),
                Receipt {
                    created: std::time::Instant::now(),
                    owner: owner.clone(),
                    stage: Stage::Blocked,
                },
            );
        }
        let mut body = json!({"kind":owner.kind,"query":query,"limit":5});
        if let Some(mbid) = mbid {
            body["identifiers"] = json!([{"scheme":"musicbrainz","value":mbid}]);
        }
        if owner.kind == "release_group" && !artist.trim().is_empty() {
            body["hints"] = json!({"artists":[artist]});
        }
        let (value, retry) = self
            .discovery_http(
                directory,
                &owner.revision,
                reqwest::Method::POST,
                "api/v2/discoveries",
                Some(&body),
                check,
            )
            .await?;
        let mut registry = self.discovery.lock().await;
        let receipt = registry
            .receipts
            .get_mut(&handle)
            .ok_or("Discovery session was retired.")?;
        if receipt.created.elapsed() >= Duration::from_secs(1200) {
            return Err("Discovery session expired. Search existing identities again.".into());
        }
        parsed(receipt, &handle, &value, retry)
    }
    async fn discovery_step<C, F>(
        &self,
        directory: &Path,
        revision: &str,
        scope: &str,
        native_revision: u64,
        handle: &str,
        selected: Option<&str>,
        check: &C,
    ) -> Result<Progress, String>
    where
        C: Fn() -> F,
        F: std::future::Future<Output = bool>,
    {
        let _permit = self
            .discovery_admission
            .try_acquire()
            .map_err(|_| "A discovery action is already running.")?;
        let receipt = self
            .discovery
            .lock()
            .await
            .receipts
            .get(handle)
            .cloned()
            .filter(|receipt| {
                receipt.created.elapsed() < Duration::from_secs(1200)
                    && receipt.owner.revision == revision
                    && receipt.owner.scope == scope
                    && receipt.owner.native_revision == native_revision
            })
            .ok_or("Discovery session was retired.")?;
        let (method, path, body) = if let Some(selected) = selected {
            if !valid_mbid(selected)
                || !matches!(&receipt.stage,Stage::Candidates(candidates) if candidates.contains(selected))
            {
                return Err("Select a candidate returned by this discovery.".into());
            }
            self.discovery
                .lock()
                .await
                .receipts
                .get_mut(handle)
                .ok_or("Discovery session was retired.")?
                .stage = Stage::Blocked;
            (
                reqwest::Method::POST,
                "api/v2/resolutions".into(),
                Some(json!({"candidate_ref":selected})),
            )
        } else {
            match receipt.stage {
                Stage::Run(id) => (
                    reqwest::Method::GET,
                    format!("api/v2/discoveries/{id}"),
                    None,
                ),
                Stage::Job(id) => (reqwest::Method::GET, format!("api/v2/jobs/{id}"), None),
                Stage::Canonical(id) => {
                    return Ok(Progress {
                        handle: handle.into(),
                        state: "completed".into(),
                        candidates: vec![],
                        canonical_id: Some(id),
                        retry_after: 1,
                    })
                }
                _ => {
                    return Err(
                        "This session needs an explicit candidate choice or a new search.".into(),
                    )
                }
            }
        };
        let (value, retry) = self
            .discovery_http(directory, revision, method, &path, body.as_ref(), check)
            .await?;
        let mut registry = self.discovery.lock().await;
        let current = registry
            .receipts
            .get_mut(handle)
            .ok_or("Discovery session was retired.")?;
        if current.created.elapsed() >= Duration::from_secs(1200) {
            return Err("Discovery session expired. Search existing identities again.".into());
        }
        parsed(current, handle, &value, retry)
    }
}
async fn scope(
    app: &tauri::AppHandle,
    expected: &str,
) -> Result<crate::image_protocol::ImageContext, String> {
    let context = app
        .state::<crate::commands::PlexState>()
        .image_context()
        .await;
    if context.client.is_none()
        || context
            .client
            .as_ref()
            .is_some_and(|client| client.offline_only)
        || expected.is_empty()
        || context.cache_scope() != expected
    {
        return Err("Discovery requires the current online library.".into());
    };
    Ok(context)
}
#[tauri::command]
pub async fn heya_discovery_capability(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<MetadataServicesState>>,
    revision: String,
    scope_id: String,
) -> Result<Capability, String> {
    let context = scope(&app, &scope_id).await?;
    let plex = app.state::<crate::commands::PlexState>();
    let check = || async { plex.image_context_is_current(&context).await };
    tokio::time::timeout(
        Duration::from_secs(15),
        state.connection(Service::Heya).discovery_capability(
            &directory(&app, Service::Heya)?,
            &revision,
            &check,
        ),
    )
    .await
    .map_err(|_| "Discovery capability check timed out.")?
}
#[tauri::command]
pub async fn heya_discover(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<MetadataServicesState>>,
    revision: String,
    scope_id: String,
    kind: String,
    query: String,
    artist: String,
    mbid: Option<String>,
) -> Result<Progress, String> {
    let context = scope(&app, &scope_id).await?;
    let plex = app.state::<crate::commands::PlexState>();
    let check = || async { plex.image_context_is_current(&context).await };
    let result = tokio::time::timeout(
        Duration::from_secs(15),
        state.connection(Service::Heya).discover(
            &directory(&app, Service::Heya)?,
            Owner {
                native_revision: context.revision,
                revision,
                scope: scope_id.clone(),
                kind: if kind == "album" {
                    "release_group".into()
                } else {
                    kind
                },
            },
            query,
            artist,
            mbid,
            &check,
        ),
    )
    .await
    .map_err(|_| {
        "Discovery timed out. Search existing identities before starting another discovery."
    })??;
    if !check().await {
        return Err("The library connection changed.".into());
    }
    Ok(result)
}
#[tauri::command]
pub async fn heya_discovery_step(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<MetadataServicesState>>,
    revision: String,
    scope_id: String,
    handle: String,
    candidate_ref: Option<String>,
) -> Result<Progress, String> {
    let context = scope(&app, &scope_id).await?;
    let plex = app.state::<crate::commands::PlexState>();
    let check = || async { plex.image_context_is_current(&context).await };
    let result = tokio::time::timeout(
        Duration::from_secs(15),
        state.connection(Service::Heya).discovery_step(
            &directory(&app, Service::Heya)?,
            &revision,
            &scope_id,
            context.revision,
            &handle,
            candidate_ref.as_deref(),
            &check,
        ),
    )
    .await
    .map_err(|_| "Discovery check timed out. Check status again later.")??;
    if !check().await {
        return Err("The library connection changed.".into());
    }
    Ok(result)
}

/// Retire local receipts only. This never cancels, deletes, or mutates server jobs.
#[tauri::command]
pub async fn heya_discovery_forget(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<MetadataServicesState>>,
    revision: String,
    scope_id: String,
    handle: String,
) -> Result<(), String> {
    let context = scope(&app, &scope_id).await?;
    let plex = app.state::<crate::commands::PlexState>();
    let mut registry = state.connection(Service::Heya).discovery.lock().await;
    if !plex.image_context_is_current(&context).await {
        return Err("The library connection changed.".into());
    }
    if registry.receipts.get(&handle).is_some_and(|receipt| {
        receipt.owner.scope == scope_id
            && receipt.owner.revision == revision
            && receipt.owner.native_revision == context.revision
    }) {
        registry.receipts.remove(&handle);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::tests::configured;
    use super::*;
    use std::io::{Read, Write};
    fn server(replies: Vec<(u16, Value)>) -> (String, std::thread::JoinHandle<Vec<String>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/proxy/", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let mut requests = vec![];
            for (status, body) in replies {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = vec![];
                let mut buffer = [0; 4096];
                let mut expected = None;
                loop {
                    let n = stream.read(&mut buffer).unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&buffer[..n]);
                    if let Some(end) = bytes.windows(4).position(|slice| slice == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]);
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                line.to_lowercase()
                                    .strip_prefix("content-length:")
                                    .and_then(|value| value.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        expected = Some(end + 4 + length);
                    }
                    if expected.is_some_and(|end| bytes.len() >= end) {
                        break;
                    }
                }
                requests.push(String::from_utf8(bytes).unwrap());
                let body = body.to_string();
                write!(stream,"HTTP/1.1 {status} Result\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            }
            requests
        });
        (base, handle)
    }
    fn specification() -> Value {
        json!({"openapi":"3.1.0","paths":{"/api/v2/discoveries":{"post":{}},"/api/v2/discoveries/{id}":{"get":{}},"/api/v2/resolutions":{"post":{}},"/api/v2/jobs/{id}":{"get":{}}}})
    }
    fn owner(revision: &str) -> Owner {
        Owner {
            revision: revision.into(),
            scope: "scope".into(),
            kind: "release_group".into(),
            native_revision: 7,
        }
    }
    #[test]
    fn advertised_auth_and_candidate_scores_never_grant_identity() {
        let mut spec = specification();
        assert!(advertised(&spec, false));
        spec["security"] = json!([{"Bearer":[]}]);
        spec["components"] =
            json!({"securitySchemes":{"Bearer":{"type":"http","scheme":"bearer"}}});
        assert!(!advertised(&spec, false));
        assert!(advertised(&spec, true));
        spec["components"]["securitySchemes"]["Bearer"] =
            json!({"type":"apiKey","in":"query","name":"token"});
        assert!(!advertised(&spec, true));
        let id = "11111111-1111-4111-8111-111111111111";
        let mut receipt = Receipt {
            created: std::time::Instant::now(),
            owner: owner("revision"),
            stage: Stage::Blocked,
        };
        let result=parsed(&mut receipt,id,&json!({"state":"completed","result":{"kind":"release_group","status":"needs_selection","candidates":[{"candidate_ref":id,"confidence":1.0,"rank":1,"display":{"title":"Album"}}]}}),1).unwrap();
        assert_eq!(result.state, "needs-selection");
        assert!(result.canonical_id.is_none());
        assert_eq!(result.candidates.len(), 1);
        assert!(parsed(
            &mut receipt,
            id,
            &json!({"state":"completed","result":{"kind":"artist","entity_id":id}}),
            1
        )
        .is_err());
    }
    #[tokio::test]
    async fn explicit_discovery_polls_run_then_resolves_registered_candidate_and_job() {
        let run = "11111111-1111-4111-8111-111111111111";
        let reference = "22222222-2222-4222-8222-222222222222";
        let entity = "33333333-3333-4333-8333-333333333333";
        let (base, server) = server(vec![
            (200, specification()),
            (202, json!({"id":run,"state":"queued","job":{"id":10}})),
            (
                200,
                json!({"id":run,"state":"completed","result":{"kind":"release_group","status":"needs_selection","candidates":[{"candidate_ref":reference,"display":{"title":"Album & Edition","artists":[{"name":"Artist"}]}}]}}),
            ),
            (202, json!({"state":"accepted","job":{"id":10}})),
            (200, json!({"id":10,"state":"completed","entity_id":entity})),
        ]);
        let dir = tempfile::tempdir().unwrap();
        let connection = Connection::new(false);
        let (status, _) = configured(
            &connection,
            dir.path(),
            base,
            Some("fictional-discovery-key".into()),
        )
        .await;
        let check = || std::future::ready(true);
        let progress = connection
            .discover(
                dir.path(),
                owner(&status.revision),
                "Album & Edition".into(),
                "Artist".into(),
                Some(entity.into()),
                &check,
            )
            .await
            .unwrap();
        let handle = progress.handle;
        assert!(matches!(
            connection.discovery.lock().await.receipts[&handle].stage,
            Stage::Run(_)
        ));
        let selection = connection
            .discovery_step(
                dir.path(),
                &status.revision,
                "scope",
                7,
                &handle,
                None,
                &check,
            )
            .await
            .unwrap();
        assert_eq!(selection.candidates.len(), 1);
        // Restored cacheScope after A-B-A still has a different native lease.
        assert!(connection
            .discovery_step(
                dir.path(),
                &status.revision,
                "scope",
                8,
                &handle,
                Some(reference),
                &check
            )
            .await
            .is_err());
        assert!(connection
            .discovery_step(
                dir.path(),
                &status.revision,
                "other",
                7,
                &handle,
                Some(reference),
                &check
            )
            .await
            .is_err());
        assert!(connection
            .discovery_step(
                dir.path(),
                &status.revision,
                "scope",
                7,
                &handle,
                Some(entity),
                &check
            )
            .await
            .is_err());
        connection
            .discovery_step(
                dir.path(),
                &status.revision,
                "scope",
                7,
                &handle,
                Some(reference),
                &check,
            )
            .await
            .unwrap();
        let result = connection
            .discovery_step(
                dir.path(),
                &status.revision,
                "scope",
                7,
                &handle,
                None,
                &check,
            )
            .await
            .unwrap();
        assert_eq!(result.canonical_id.as_deref(), Some(entity));
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 5);
        assert!(requests[1].starts_with("POST /proxy/api/v2/discoveries HTTP/1.1"));
        assert!(requests[2].starts_with(&format!("GET /proxy/api/v2/discoveries/{run} HTTP/1.1")));
        assert!(requests[3].starts_with("POST /proxy/api/v2/resolutions HTTP/1.1"));
        assert!(requests[4].starts_with("GET /proxy/api/v2/jobs/10 HTTP/1.1"));
        let body: Value =
            serde_json::from_str(requests[1].split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(
            body,
            json!({"kind":"release_group","query":"Album & Edition","limit":5,"hints":{"artists":["Artist"]},"identifiers":[{"scheme":"musicbrainz","value":entity}]})
        );
        for request in requests {
            let target = request.split_whitespace().nth(1).unwrap();
            assert!(!target.contains("fictional"));
            assert!(request
                .to_lowercase()
                .contains("authorization: bearer fictional-discovery-key"));
        }
    }
    #[tokio::test]
    async fn forbidden_discovery_stays_disabled_and_expired_or_retired_handles_never_poll() {
        let (base, server) = server(vec![
            (200, specification()),
            (403, json!({"detail":"untrusted private server diagnostic"})),
        ]);
        let dir = tempfile::tempdir().unwrap();
        let connection = Connection::new(false);
        let (status, _) = configured(&connection, dir.path(), base, None).await;
        let check = || std::future::ready(true);
        assert!(connection
            .discover(
                dir.path(),
                owner(&status.revision),
                "Album".into(),
                "Artist".into(),
                None,
                &check
            )
            .await
            .is_err());
        assert!(connection
            .discover(
                dir.path(),
                owner(&status.revision),
                "Album".into(),
                "Artist".into(),
                None,
                &check
            )
            .await
            .is_err());
        let cap = connection
            .discovery_capability(dir.path(), &status.revision, &check)
            .await
            .unwrap();
        assert!(!cap.available);
        assert!(cap.reason.unwrap().contains("Settings"));
        assert_eq!(server.join().unwrap().len(), 2);
        let handle = "11111111-1111-4111-8111-111111111111";
        connection.discovery.lock().await.receipts.insert(
            handle.into(),
            Receipt {
                created: std::time::Instant::now() - Duration::from_secs(1201),
                owner: owner(&status.revision),
                stage: Stage::Job(42),
            },
        );
        assert!(connection
            .discovery_step(
                dir.path(),
                &status.revision,
                "scope",
                7,
                handle,
                None,
                &check
            )
            .await
            .is_err());
        assert!(connection
            .discovery_step(
                dir.path(),
                &status.revision,
                "scope",
                7,
                handle,
                None,
                &|| std::future::ready(false)
            )
            .await
            .is_err());
    }
    #[tokio::test]
    async fn changed_native_owner_before_post_and_transient_capability_failure_are_recoverable() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let connection = Connection::new(false);
        let (status, _) = configured(
            &connection,
            dir.path(),
            format!("http://{}/", listener.local_addr().unwrap()),
            None,
        )
        .await;
        connection.discovery.lock().await.capability = Some((
            status.revision.clone(),
            Capability {
                available: true,
                retryable: false,
                reason: None,
            },
        ));
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let check =
            || std::future::ready(calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0);
        assert!(connection
            .discover(
                dir.path(),
                owner(&status.revision),
                "Album".into(),
                "Artist".into(),
                None,
                &check
            )
            .await
            .is_err());
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        let (base, server) = server(vec![
            (503, json!({"detail":"server temporarily unavailable"})),
            (200, specification()),
        ]);
        let dir = tempfile::tempdir().unwrap();
        let connection = Connection::new(false);
        let (status, _) = configured(&connection, dir.path(), base, None).await;
        let check = || std::future::ready(true);
        let unavailable = connection
            .discovery_capability(dir.path(), &status.revision, &check)
            .await
            .unwrap();
        assert!(!unavailable.available && unavailable.retryable);
        assert!(
            connection
                .discovery_capability(dir.path(), &status.revision, &check)
                .await
                .unwrap()
                .available
        );
        assert_eq!(server.join().unwrap().len(), 2);
    }
}
