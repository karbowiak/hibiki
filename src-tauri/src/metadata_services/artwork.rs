//! Credential-free registered references, resolved through the normal image cache.
use super::*;
const IMAGE_REF_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const MAX_IMAGE_REFS: usize = 2048;
pub(super) fn candidates(
    data: &Value,
    kind: &str,
    revision: &str,
) -> (Vec<ArtworkCandidate>, Vec<ArtworkCandidate>) {
    let mut posters = vec![];
    let mut backgrounds = vec![];
    if let Some(images) = data.get("images").and_then(Value::as_array) {
        for image in images.iter().take(512) {
            let Some(id) = image
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| valid_mbid(id))
            else {
                continue;
            };
            let class = image.get("class").and_then(Value::as_str).unwrap_or("");
            let target = if (kind == "artist" && class == "profile")
                || (kind == "release_group" && class == "cover")
            {
                &mut posters
            } else if class == "backdrop" {
                &mut backgrounds
            } else {
                continue;
            };
            if target.len() >= 12 || target.iter().any(|image: &ArtworkCandidate| image.id == id) {
                continue;
            }
            let provider = image
                .get("provider")
                .and_then(Value::as_str)
                .filter(|s| s.len() <= 40)
                .unwrap_or("HeyaMetadata");
            target.push(ArtworkCandidate {
                id: id.into(),
                url: format!("heyametadata://image/{id}?serviceRevision={revision}"),
                label: Some(format!("{provider} · {class}")),
            });
        }
    }
    (posters, backgrounds)
}
pub fn is_heya_image(source: &str) -> bool {
    source.starts_with("heyametadata:")
}
fn reference(source: &str) -> Result<(String, String), String> {
    let url = url::Url::parse(source).map_err(|_| "Invalid HeyaMetadata image reference.")?;
    if source.len() > 512
        || url.scheme() != "heyametadata"
        || url.host_str() != Some("image")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return Err("Invalid HeyaMetadata image reference.".into());
    }
    let id = url
        .path()
        .strip_prefix('/')
        .filter(|id| valid_mbid(id))
        .ok_or("Invalid HeyaMetadata image identity.")?;
    let fields = url.query_pairs().collect::<Vec<_>>();
    if fields.len() != 1 || fields[0].0 != "serviceRevision" || !valid_mbid(&fields[0].1) {
        return Err("Invalid HeyaMetadata source revision.".into());
    }
    Ok((id.into(), fields[0].1.to_string()))
}
fn cache_key(configuration: &Configuration, scope: &str, id: &str) -> String {
    use sha2::{Digest, Sha256};
    let binding = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&[
                configuration.base_url.as_str(),
                configuration.api_key.as_str()
            ])
            .expect("service identity strings")
        )
    );
    crate::image_fetch::cache_key(
        scope,
        "ext",
        "img",
        &format!("heya:{binding}:{id}:webp:1200"),
        "",
        "",
    )
}
impl Connection {
    pub(super) async fn register_images(&self, item: &HeyaItem) {
        let now = std::time::Instant::now();
        let mut images = self.images.lock().await;
        images.retain(|(revision, _), seen| {
            revision == &item.revision && now.duration_since(*seen) < IMAGE_REF_TTL
        });
        self.pending_images
            .lock()
            .await
            .retain(|key, _| images.contains_key(key));
        for image in item.posters.iter().chain(&item.backgrounds) {
            if images.len() >= MAX_IMAGE_REFS
                && !images.contains_key(&(item.revision.clone(), image.id.clone()))
            {
                if let Some(oldest) = images
                    .iter()
                    .min_by_key(|(_, seen)| **seen)
                    .map(|(key, _)| key.clone())
                {
                    images.remove(&oldest);
                }
            }
            images.insert((item.revision.clone(), image.id.clone()), now);
        }
    }
    async fn image_owner(
        &self,
        directory: &Path,
        id: &str,
        revision: &str,
    ) -> Result<Configuration, String> {
        let (status, configuration) = self.settings.snapshot(directory).await?;
        if status.revision != revision || !status.configured || !status.enabled {
            return Err("HeyaMetadata image source changed. Retry the lookup.".into());
        }
        let mut images = self.images.lock().await;
        let key = (revision.into(), id.into());
        let seen = images
            .get_mut(&key)
            .filter(|seen| seen.elapsed() < IMAGE_REF_TTL)
            .ok_or("HeyaMetadata image choices need to be loaded again.")?;
        *seen = std::time::Instant::now();
        Ok(configuration)
    }
    async fn image_bytes(
        &self,
        directory: &Path,
        id: &str,
        revision: &str,
        refresh: bool,
    ) -> Result<Vec<u8>, String> {
        let _permit = self
            .admission
            .try_acquire()
            .map_err(|_| "Artwork service is busy. Retry later.")?;
        for attempt in 0..3 {
            let configuration = self.image_owner(directory, id, revision).await?;
            {
                let mut pending = self.pending_images.lock().await;
                let key = (revision.into(), id.into());
                if pending
                    .get(&key)
                    .is_some_and(|deadline| *deadline > tokio::time::Instant::now())
                {
                    return Err("HeyaMetadata is preparing this image. Retry shortly.".into());
                }
                pending.remove(&key);
            }

            self.wait().await?;
            self.image_owner(directory, id, revision).await?;
            let url = base(&configuration.base_url)?
                .join(&format!("api/v2/images/{id}/variants/webp/1200"))
                .map_err(|_| "Invalid HeyaMetadata image route.")?;
            let mut request = CLIENT.get(url);
            if !configuration.api_key.is_empty() {
                let mut key = reqwest::header::HeaderValue::from_str(&format!(
                    "Bearer {}",
                    configuration.api_key
                ))
                .map_err(|_| "Invalid metadata service key.")?;
                key.set_sensitive(true);
                request = request.header(reqwest::header::AUTHORIZATION, key);
            }
            if refresh {
                request = request.header(reqwest::header::CACHE_CONTROL, "no-cache");
            }
            let response = request
                .send()
                .await
                .map_err(|_| "HeyaMetadata artwork lookup failed. Retry later.")?;
            self.image_owner(directory, id, revision).await?;
            if response.status() == reqwest::StatusCode::ACCEPTED {
                let seconds = response
                    .headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok())
                    .unwrap_or(1)
                    .clamp(1, 3600);
                self.pending_images.lock().await.insert(
                    (revision.into(), id.into()),
                    tokio::time::Instant::now() + Duration::from_secs(seconds),
                );
                if attempt == 2 || seconds > 5 {
                    return Err("HeyaMetadata is preparing this image. Retry shortly.".into());
                }
                drop(response);
                tokio::time::sleep(Duration::from_secs(seconds)).await;
                continue;
            }
            if !response.status().is_success() {
                if matches!(
                    response.status(),
                    reqwest::StatusCode::TOO_MANY_REQUESTS
                        | reqwest::StatusCode::SERVICE_UNAVAILABLE
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
                return Err("HeyaMetadata artwork is unavailable. Retry later.".into());
            }
            let declared = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned);
            let bytes = response
                .bounded_bytes(crate::image_fetch::MAX_IMAGE_BYTES)
                .await
                .map_err(|_| "HeyaMetadata image was invalid or too large.")?;
            let bytes = crate::image_content::validate(bytes, declared)
                .await
                .ok_or("HeyaMetadata returned unsupported image content.")?;
            self.image_owner(directory, id, revision).await?;
            return Ok(bytes);
        }
        Err("HeyaMetadata artwork is unavailable. Retry later.".into())
    }
}
async fn resolve_registered<P, F>(
    connection: &Connection,
    directory: &Path,
    source: &str,
    scope: &str,
    cache: Arc<crate::image_cache::ImageCache>,
    ticket: crate::image_cache::Ticket,
    refresh: bool,
    publish: P,
) -> Result<Vec<u8>, String>
where
    P: FnOnce(
        Arc<crate::image_cache::ImageCache>,
        crate::image_cache::Ticket,
        String,
        Vec<u8>,
        bool,
    ) -> F,
    F: std::future::Future<Output = Result<(), String>>,
{
    let (id, revision) = reference(source)?;
    let configuration = connection.image_owner(directory, &id, &revision).await?;
    let key = cache_key(&configuration, scope, &id);
    let ticket = cache
        .bind_key(&ticket, &key)
        .map_err(|_| "Artwork request was retired.")?;
    if !refresh {
        let guard = connection.settings.publication_guard(&revision).await?;
        let cached =
            crate::image_cache::read_validated(cache.clone(), ticket.clone(), key.clone()).await;
        drop(guard);
        if let Some(bytes) = cached {
            connection.image_owner(directory, &id, &revision).await?;
            return Ok(bytes);
        }
    }
    let bytes = connection
        .image_bytes(directory, &id, &revision, refresh)
        .await?;
    connection.image_owner(directory, &id, &revision).await?;
    let guard = connection.settings.publication_guard(&revision).await?;
    let publication = publish(cache, ticket, key, bytes.clone(), refresh).await;
    drop(guard);
    connection.image_owner(directory, &id, &revision).await?;
    if refresh {
        publication?;
    }
    Ok(bytes)
}
/// Offline references may originate before a native restart. Only the current
/// private service binding can authorize existing pixels; no registry or HTTP
/// lookup is needed, and absent pixels remain absent.
async fn resolve_cached_offline(
    connection: &Connection,
    directory: &Path,
    source: &str,
    scope: &str,
    cache: Arc<crate::image_cache::ImageCache>,
    ticket: crate::image_cache::Ticket,
) -> Result<Vec<u8>, String> {
    let (id, _) = reference(source)?;
    let (status, configuration) = connection.settings.snapshot(directory).await?;
    if !status.enabled || !status.configured {
        return Err("HeyaMetadata is unavailable offline.".into());
    }
    let key = cache_key(&configuration, scope, &id);
    let ticket = cache
        .bind_key(&ticket, &key)
        .map_err(|_| "Artwork request was retired.")?;
    let guard = connection
        .settings
        .publication_guard(&status.revision)
        .await?;
    let bytes = crate::image_cache::read_validated(cache, ticket, key).await;
    drop(guard);
    let (current, _) = connection.settings.snapshot(directory).await?;
    if current.revision != status.revision || !current.enabled || !current.configured {
        return Err("HeyaMetadata image source changed. Retry the lookup.".into());
    }
    bytes.ok_or_else(|| "This artwork has not been saved for offline use.".into())
}

/// The runtime revision is never the disk key: restart cache hits are shared only
/// under the same private origin/auth binding and a newly registered reference.
pub async fn resolve_heya_image(
    app: &tauri::AppHandle,
    source: &str,
    context: &crate::image_protocol::ImageContext,
    cache: Arc<crate::image_cache::ImageCache>,
    ticket: crate::image_cache::Ticket,
    refresh: bool,
) -> Result<Vec<u8>, String> {
    let services = app.state::<Arc<MetadataServicesState>>();
    let connection = services.connection(Service::Heya);
    let directory = directory(app, Service::Heya)?;
    let state = app.state::<crate::commands::PlexState>();
    let publication_state = &state;
    if context
        .client
        .as_ref()
        .is_some_and(|client| client.offline_only)
    {
        if refresh {
            return Err("Artwork cannot be refreshed offline.".into());
        }
        let bytes = resolve_cached_offline(
            connection,
            &directory,
            source,
            context.cache_scope(),
            cache,
            ticket,
        )
        .await?;
        if !state.image_context_is_current(context).await {
            return Err("The library changed. Retry the lookup.".into());
        }
        return Ok(bytes);
    }
    let bytes = resolve_registered(
        connection,
        &directory,
        source,
        context.cache_scope(),
        cache,
        ticket,
        refresh,
        |cache, ticket, key, bytes, refresh| async move {
            publication_state
                .publish_image(context, move || {
                    if refresh {
                        cache.refresh(&ticket, &key, &bytes)
                    } else {
                        cache.store_verified(&ticket, &key, &bytes)
                    }
                })
                .await
        },
    )
    .await?;
    if !state.image_context_is_current(context).await {
        return Err("The library changed. Retry the lookup.".into());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    fn server(
        replies: Vec<(u16, Vec<u8>, String)>,
    ) -> (String, std::thread::JoinHandle<Vec<String>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/proxy/", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let mut requests = vec![];
            for (status, body, headers) in replies {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut data = vec![];
                let mut buffer = [0; 4096];
                while !data.windows(4).any(|v| v == b"\r\n\r\n") {
                    let n = stream.read(&mut buffer).unwrap();
                    assert!(n > 0);
                    data.extend_from_slice(&buffer[..n]);
                }
                requests.push(String::from_utf8(data).unwrap());
                write!(stream,"HTTP/1.1 {status} Response\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n",body.len()).unwrap();
                let _ = stream.write_all(&body);
            }
            requests
        });
        (base, server)
    }
    const ID: &str = "12345678-1234-1234-1234-123456789abc";
    async fn setup(
        connection: &Connection,
        directory: &Path,
        url: String,
    ) -> (String, Configuration) {
        let (status, _) = connection.settings.snapshot(directory).await.unwrap();
        connection
            .settings
            .update(
                directory,
                &status.revision,
                url,
                Some("fictional-native-image-key".into()),
                true,
                false,
            )
            .await
            .unwrap();
        let (status, configuration) = connection.settings.snapshot(directory).await.unwrap();
        register(connection, &status.revision).await;
        (status.revision, configuration)
    }
    async fn register(connection: &Connection, revision: &str) {
        let value = json!({"id":ID,"kind":"artist","display":{"name":"Artist"},"data":{"images":[{"id":ID,"class":"profile","provider":"fanart"}]}});
        let item = heya_item(&value, ID, "artist", "Artist", "", None, revision).unwrap();
        connection.register_images(&item).await;
    }
    async fn publish(
        cache: Arc<crate::image_cache::ImageCache>,
        ticket: crate::image_cache::Ticket,
        key: String,
        bytes: Vec<u8>,
        refresh: bool,
    ) -> Result<(), String> {
        tokio::task::spawn_blocking(move || {
            if refresh {
                cache.refresh(&ticket, &key, &bytes)
            } else {
                cache.store_verified(&ticket, &key, &bytes)
            }
        })
        .await
        .unwrap()
    }
    #[tokio::test]
    async fn registered_images_use_authenticated_bounded_variant_and_restart_cache_without_redownload(
    ) {
        let png = crate::image_content::test_png();
        let (base, server) = server(vec![(
            200,
            png.clone(),
            "Content-Type: image/png\r\n".into(),
        )]);
        let root = tempfile::tempdir().unwrap();
        let credentials = root.path().join("settings");
        let cache_path = root.path().join("cache");
        let connection = Connection::new(false);
        let (revision, configuration) = setup(&connection, &credentials, base).await;
        let cache = Arc::new(crate::image_cache::ImageCache::new(cache_path.clone()));
        let uri = format!("heyametadata://image/{ID}?serviceRevision={revision}");
        assert_eq!(
            resolve_registered(
                &connection,
                &credentials,
                &uri,
                "scope",
                cache.clone(),
                cache.ticket(),
                false,
                publish
            )
            .await
            .unwrap(),
            png
        );
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].starts_with(&format!(
            "GET /proxy/api/v2/images/{ID}/variants/webp/1200 HTTP/1.1"
        )));
        assert!(requests[0].contains("authorization: Bearer fictional-native-image-key"));
        assert!(!uri.contains("fictional") && !uri.contains("proxy"));
        assert_eq!(
            resolve_registered(
                &connection,
                &credentials,
                &uri,
                "scope",
                cache.clone(),
                cache.ticket(),
                false,
                publish
            )
            .await
            .unwrap(),
            png
        );
        drop(cache);
        drop(connection);
        let reopened = Connection::new(false);
        let (status, config) = reopened.settings.snapshot(&credentials).await.unwrap();
        assert!(revision != status.revision);
        assert_eq!(
            cache_key(&configuration, "scope", ID),
            cache_key(&config, "scope", ID)
        );
        let cache = Arc::new(crate::image_cache::ImageCache::new(cache_path));
        // Offline restart accepts saved references without re-registering them,
        // but authorizes pixels exclusively through the current private binding.
        assert_eq!(
            resolve_cached_offline(
                &reopened,
                &credentials,
                &uri,
                "scope",
                cache.clone(),
                cache.ticket(),
            )
            .await
            .unwrap(),
            png
        );
        assert!(resolve_cached_offline(
            &reopened,
            &credentials,
            &uri,
            "different-scope",
            cache.clone(),
            cache.ticket(),
        )
        .await
        .is_err());
        let new_uri = format!(
            "heyametadata://image/{ID}?serviceRevision={}",
            status.revision
        );
        assert!(resolve_registered(
            &reopened,
            &credentials,
            &uri,
            "scope",
            cache.clone(),
            cache.ticket(),
            false,
            publish
        )
        .await
        .is_err());
        assert!(resolve_registered(
            &reopened,
            &credentials,
            &new_uri,
            "scope",
            cache.clone(),
            cache.ticket(),
            false,
            publish
        )
        .await
        .is_err());
        register(&reopened, &status.revision).await;
        assert_eq!(
            resolve_registered(
                &reopened,
                &credentials,
                &new_uri,
                "scope",
                cache.clone(),
                cache.ticket(),
                false,
                publish
            )
            .await
            .unwrap(),
            png
        );
        let mut different = config.clone();
        different.api_key = "different-fictional-key".into();
        assert_ne!(
            cache_key(&config, "scope", ID),
            cache_key(&different, "scope", ID)
        );
        different = config.clone();
        different.base_url = "https://another.test/".into();
        assert_ne!(
            cache_key(&config, "scope", ID),
            cache_key(&different, "scope", ID)
        );
        assert_ne!(
            cache_key(&config, "scope", ID),
            cache_key(&config, "other-scope", ID)
        );
    }
    #[tokio::test]
    async fn pending_images_retry_finitely_and_failure_refresh_preserves_prior_pixels() {
        let png = crate::image_content::test_png();
        let (base, server) = server(vec![
            (202, vec![], "Retry-After: 1\r\n".into()),
            (200, png.clone(), "Content-Type: image/png\r\n".into()),
            (
                200,
                b"<html>not an image</html>".to_vec(),
                "Content-Type: text/html\r\n".into(),
            ),
        ]);
        let root = tempfile::tempdir().unwrap();
        let connection = Connection::new(false);
        let (revision, _) = setup(&connection, root.path(), base).await;
        let cache = Arc::new(crate::image_cache::ImageCache::new(
            root.path().join("cache"),
        ));
        let uri = format!("heyametadata://image/{ID}?serviceRevision={revision}");
        assert_eq!(
            resolve_registered(
                &connection,
                root.path(),
                &uri,
                "scope",
                cache.clone(),
                cache.ticket(),
                false,
                publish
            )
            .await
            .unwrap(),
            png
        );
        assert!(resolve_registered(
            &connection,
            root.path(),
            &uri,
            "scope",
            cache.clone(),
            cache.ticket(),
            true,
            publish
        )
        .await
        .is_err());
        assert_eq!(
            resolve_registered(
                &connection,
                root.path(),
                &uri,
                "scope",
                cache.clone(),
                cache.ticket(),
                false,
                publish
            )
            .await
            .unwrap(),
            png
        );
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 3);
        assert!(requests[2].contains("cache-control: no-cache"));
    }
    #[tokio::test]
    async fn long_pending_backoff_never_polls_early_or_negative_caches() {
        let (base, server) = server(vec![(202, vec![], "Retry-After: 120\r\n".into())]);
        let root = tempfile::tempdir().unwrap();
        let connection = Connection::new(false);
        let (revision, configuration) = setup(&connection, root.path(), base).await;
        let cache = Arc::new(crate::image_cache::ImageCache::new(
            root.path().join("cache"),
        ));
        let uri = format!("heyametadata://image/{ID}?serviceRevision={revision}");
        for _ in 0..2 {
            assert!(resolve_registered(
                &connection,
                root.path(),
                &uri,
                "scope",
                cache.clone(),
                cache.ticket(),
                false,
                publish
            )
            .await
            .is_err());
        }
        assert_eq!(server.join().unwrap().len(), 1);
        let key = cache_key(&configuration, "scope", ID);
        assert!(
            crate::image_cache::read_validated(cache.clone(), cache.ticket(), key)
                .await
                .is_none()
        );
    }
    #[test]
    fn image_reference_and_role_candidates_never_accept_paths_origins_or_credentials() {
        let revision = "22345678-1234-1234-1234-123456789abc";
        for value in [
            format!("https://heya.test/image/{ID}?serviceRevision={revision}"),
            format!("heyametadata://evil/{ID}?serviceRevision={revision}"),
            format!("heyametadata://user@image/{ID}?serviceRevision={revision}"),
            format!("heyametadata://image/{ID}/extra?serviceRevision={revision}"),
            format!(
                "heyametadata://image/{ID}?serviceRevision={revision}&serviceRevision={revision}"
            ),
        ] {
            assert!(reference(&value).is_err());
        }
        let images=(0..30).map(|n|json!({"id":format!("12345678-1234-1234-1234-{n:012x}"),"class":if n%2==0{"profile"}else{"backdrop"},"provider":"fanart"})).collect::<Vec<_>>();
        let data = json!({"images":images});
        let (posters, backgrounds) = candidates(&data, "artist", revision);
        assert_eq!(posters.len(), 12);
        assert_eq!(backgrounds.len(), 12);
        assert!(posters
            .iter()
            .all(|item| item.url.starts_with("heyametadata://image/")
                && !item.url.contains("heya.test")));
        let (posters, _) = candidates(&data, "release_group", revision);
        assert!(posters.is_empty());
    }
}
