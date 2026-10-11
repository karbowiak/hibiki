//! Bounded artwork request admission and shared resolution. Keys retain the
//! captured connection and cache generation, even while waiting for a worker.

use crate::image_cache::Ticket;
use crate::image_fetch;
use crate::plex::PlexClient;
use futures::future::{BoxFuture, FutureExt, Shared};
use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, Weak};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

const MAX_URI_BYTES: usize = 64 * 1024;
const MAX_REQUESTS: usize = 512;
const MAX_RESOLUTIONS: usize = 8;
type Artwork = Option<Arc<Vec<u8>>>;

pub struct ImageRequest {
    pub kind: String,
    pub id: String,
    pub src: String,
    pub name: String,
    pub artist: String,
    pub scope: String,
}

impl ImageRequest {
    pub fn parse(method: &str, path: &str, query: &str, body_bytes: usize) -> Result<Self, u16> {
        if method != "GET" {
            return Err(405);
        }
        if path.len().saturating_add(query.len()) > MAX_URI_BYTES {
            return Err(414);
        }
        if body_bytes != 0 {
            return Err(400);
        }
        let (kind, id) = path
            .trim_start_matches('/')
            .split_once('/')
            .ok_or(400_u16)?;
        if !matches!(kind, "artist" | "album" | "track" | "playlist" | "ext")
            || id.is_empty()
            || id.contains('/')
            || (kind == "ext" && id != "img")
        {
            return Err(400);
        }
        let mut fields = HashMap::new();
        for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
            if matches!(key.as_ref(), "src" | "name" | "artist" | "scope")
                && fields
                    .insert(key.into_owned(), value.into_owned())
                    .is_some()
            {
                return Err(400);
            }
        }
        let mut field = |name: &str| fields.remove(name).unwrap_or_default();
        let request = Self {
            kind: kind.into(),
            id: id.into(),
            src: field("src"),
            name: field("name"),
            artist: field("artist"),
            scope: field("scope"),
        };
        if request.src.is_empty() && request.name.is_empty() {
            return Err(400);
        }
        Ok(request)
    }

    pub fn cache_key(&self, context: &ImageContext) -> String {
        image_fetch::cache_key(
            context.cache_scope(),
            &self.kind,
            &self.id,
            &self.src,
            &self.name,
            &self.artist,
        )
    }

    pub fn requires_connection(&self, context: &ImageContext) -> bool {
        !self.scope.is_empty()
            || context
                .client
                .as_ref()
                .is_some_and(|client| client.is_plex_url(&self.src))
    }
}

#[derive(Clone)]
pub struct ImageContext {
    pub revision: u64,
    pub client: Option<PlexClient>,
    identity: String,
}

impl ImageContext {
    pub fn new(revision: u64, client: Option<PlexClient>) -> Self {
        let identity = Self::identity(client.as_ref());
        Self {
            revision,
            client,
            identity,
        }
    }

    fn identity(client: Option<&PlexClient>) -> String {
        use sha2::{Digest, Sha256};
        let binding = client.map(|client| {
            [
                client.base_url(),
                client.token.as_str(),
                client.client_id.as_str(),
                client.machine_identifier.as_str(),
                client.library_scope.as_str(),
            ]
        });
        format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&binding).expect("image context strings"))
        )
    }

    pub fn matches(&self, revision: u64, client: Option<&PlexClient>) -> bool {
        revision == self.revision && Self::identity(client) == self.identity
    }

    pub fn cache_scope(&self) -> &str {
        self.client
            .as_ref()
            .map(|client| client.library_scope.as_str())
            .filter(|scope| !scope.is_empty())
            .unwrap_or(&self.identity)
    }
}

#[derive(Clone, PartialEq, Eq, Hash)]
pub struct WorkKey {
    cache_key: String,
    connection: String,
    revision: u64,
    ticket: Ticket,
}

impl WorkKey {
    pub fn new(request: &ImageRequest, context: &ImageContext, ticket: Ticket) -> Self {
        Self {
            cache_key: request.cache_key(context),
            connection: context.identity.clone(),
            revision: context.revision,
            ticket,
        }
    }
}

struct Flight {
    result: Shared<BoxFuture<'static, Artwork>>,
}
struct Pool {
    requests: Arc<Semaphore>,
    workers: Arc<Semaphore>,
    flights: Mutex<HashMap<WorkKey, Weak<Flight>>>,
}

pub struct WorkQueue {
    pool: Arc<Pool>,
}
pub struct Admission {
    pool: Arc<Pool>,
    _permit: OwnedSemaphorePermit,
}

impl Default for WorkQueue {
    fn default() -> Self {
        Self::new(MAX_REQUESTS, MAX_RESOLUTIONS)
    }
}

impl WorkQueue {
    fn new(requests: usize, workers: usize) -> Self {
        Self {
            pool: Arc::new(Pool {
                requests: Arc::new(Semaphore::new(requests)),
                workers: Arc::new(Semaphore::new(workers)),
                flights: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub fn try_admit(&self) -> Option<Admission> {
        Some(Admission {
            pool: self.pool.clone(),
            _permit: self.pool.requests.clone().try_acquire_owned().ok()?,
        })
    }
}

impl Admission {
    pub async fn resolve<F, Fut>(self, key: WorkKey, operation: F) -> Artwork
    where
        F: FnOnce() -> Fut + Send + 'static,
        Fut: Future<Output = Option<Vec<u8>>> + Send + 'static,
    {
        let flight = {
            let mut flights = self.pool.flights.lock().ok()?;
            // Finished results have no permanent in-memory cache. The bounded
            // disk cache handles replay; only current callers retain bytes.
            flights.retain(|_, flight| flight.strong_count() != 0);
            if let Some(flight) = flights.get(&key).and_then(Weak::upgrade) {
                flight
            } else {
                let workers = self.pool.workers.clone();
                let result = async move {
                    let _worker = workers.acquire_owned().await.ok()?;
                    operation().await.map(Arc::new)
                }
                .boxed()
                .shared();
                let flight = Arc::new(Flight { result });
                flights.insert(key, Arc::downgrade(&flight));
                flight
            }
        };
        // Shared is driven by every remaining caller. Cancelling the first
        // caller cannot strand a follower waiting for its HTTP result.
        flight.result.clone().await
    }
}

pub fn error_response(status: u16) -> tauri::http::Response<Vec<u8>> {
    let mut response = tauri::http::Response::builder()
        .status(status)
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", "no-store");
    if status == 503 {
        response = response.header("Retry-After", "1");
    }
    if status == 405 {
        response = response.header("Allow", "GET");
    }
    response.body(Vec::new()).expect("image error response")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image_cache::ImageCache;
    use futures::stream::{FuturesUnordered, StreamExt};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    fn request(id: usize) -> ImageRequest {
        ImageRequest::parse(
            "GET",
            &format!("artist/{id}"),
            "src=https%3A%2F%2Fcdn.test%2Fart.png",
            0,
        )
        .unwrap()
    }

    #[test]
    fn malformed_protocol_requests_are_rejected_before_resolution() {
        let parsed = ImageRequest::parse(
            "GET",
            "/album/encoded%2Fid",
            "name=Album+Name&artist=Artist&scope=library&unused=compatible",
            0,
        )
        .unwrap();
        assert_eq!(parsed.id, "encoded%2Fid");
        assert_eq!(parsed.name, "Album Name");
        assert_eq!(parsed.scope, "library");
        for (method, path, query, body, expected) in [
            ("POST", "artist/1", "name=Artist", 0, 405),
            ("GET", "artist/1", "name=Artist", 1, 400),
            ("GET", "unknown/1", "name=Artist", 0, 400),
            ("GET", "artist/", "name=Artist", 0, 400),
            ("GET", "artist/one/two", "name=Artist", 0, 400),
            ("GET", "ext/wrong", "src=https://cdn.test", 0, 400),
            ("GET", "artist/1", "name=first&name=second", 0, 400),
            ("GET", "artist/1", "src=", 0, 400),
        ] {
            assert_eq!(
                ImageRequest::parse(method, path, query, body).err(),
                Some(expected)
            );
        }
        assert_eq!(
            ImageRequest::parse("GET", "artist/1", &"x".repeat(MAX_URI_BYTES), 0).err(),
            Some(414)
        );
        assert_eq!(error_response(503).headers()["Retry-After"], "1");
        assert_eq!(error_response(503).headers()["Cache-Control"], "no-store");
        assert_eq!(error_response(405).headers()["Allow"], "GET");
    }

    #[test]
    fn admission_rejects_overload_and_releases_cancelled_requests() {
        let queue = WorkQueue::new(2, 1);
        let first = queue.try_admit().unwrap();
        let second = queue.try_admit().unwrap();
        assert!(queue.try_admit().is_none());
        drop(first);
        assert!(queue.try_admit().is_some());
        drop(second);
        assert!(queue.try_admit().is_some());
    }

    #[tokio::test]
    async fn duplicate_callers_share_one_resolution_and_cancelled_callers_do_not_strand_followers()
    {
        let directory = tempfile::tempdir().unwrap();
        let cache = ImageCache::new(directory.path().join("images"));
        let context = ImageContext::new(1, None);
        let key = WorkKey::new(&request(1), &context, cache.ticket());
        let queue = WorkQueue::new(4, 2);
        let operations = Arc::new(AtomicUsize::new(0));
        let release = Arc::new(tokio::sync::Notify::new());
        let operation_count = operations.clone();
        let operation_release = release.clone();
        let mut first = Box::pin(queue.try_admit().unwrap().resolve(
            key.clone(),
            move || async move {
                operation_count.fetch_add(1, Ordering::SeqCst);
                operation_release.notified().await;
                Some(vec![1, 2, 3])
            },
        ));
        assert!(futures::poll!(&mut first).is_pending());
        let follower_count = operations.clone();
        let mut second = Box::pin(queue.try_admit().unwrap().resolve(key, move || async move {
            follower_count.fetch_add(1, Ordering::SeqCst);
            Some(vec![9])
        }));
        assert!(futures::poll!(&mut second).is_pending());
        drop(first);
        release.notify_one();
        assert_eq!(&**second.await.unwrap(), &[1, 2, 3]);
        assert_eq!(operations.load(Ordering::SeqCst), 1);
        assert!(queue.try_admit().is_some());
    }

    #[tokio::test]
    async fn clear_and_connection_changes_do_not_join_an_older_resolution() {
        for change in ["clear", "revision", "credentials"] {
            let directory = tempfile::tempdir().unwrap();
            let cache = ImageCache::new(directory.path().join("images"));
            let mut client = PlexClient::new(crate::plex::PlexClientConfig {
                base_url: "https://plex.test".into(),
                token: "dummy-a".into(),
                ..Default::default()
            })
            .unwrap();
            client.library_scope = "same-library".into();
            let context = ImageContext::new(1, Some(client.clone()));
            let old_key = WorkKey::new(&request(1), &context, cache.ticket());
            let queue = WorkQueue::new(8, 2);
            let release = Arc::new(tokio::sync::Notify::new());
            let operation_release = release.clone();
            let mut old = Box::pin(queue.try_admit().unwrap().resolve(
                old_key,
                move || async move {
                    operation_release.notified().await;
                    Some(vec![1])
                },
            ));
            assert!(futures::poll!(&mut old).is_pending());
            let revision = if change == "revision" { 2 } else { 1 };
            if change == "clear" {
                cache.clear().unwrap();
            }
            if change == "credentials" {
                client.token = "dummy-b".into();
            }
            let next_context = ImageContext::new(revision, Some(client));
            let key = WorkKey::new(&request(1), &next_context, cache.ticket());
            let result = tokio::time::timeout(
                Duration::from_secs(2),
                queue
                    .try_admit()
                    .unwrap()
                    .resolve(key, || async { Some(vec![2]) }),
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(&**result, &[2], "{change} shared old work");
            release.notify_one();
            assert_eq!(&**old.await.unwrap(), &[1]);
        }
    }

    #[test]
    fn image_context_binds_credentials_and_library_even_before_library_selection() {
        let client = PlexClient::new(crate::plex::PlexClientConfig {
            base_url: "https://plex.test".into(),
            token: "dummy-a".into(),
            ..Default::default()
        })
        .unwrap();
        let first = ImageContext::new(7, Some(client.clone()));
        assert!(first.matches(7, Some(&client)));
        assert!(!first.matches(8, Some(&client)));
        let mut changed = client.clone();
        changed.token = "dummy-b".into();
        let second = ImageContext::new(7, Some(changed.clone()));
        assert!(!first.matches(7, Some(&changed)));
        assert_ne!(first.cache_scope(), second.cache_scope());
        changed.library_scope = "different-library".into();
        assert!(!second.matches(7, Some(&changed)));
        let mut private = request(1);
        private.src = "https://plex.test/library/metadata/1/thumb".into();
        assert!(private.requires_connection(&first));
        assert!(!request(1).requires_connection(&first));
        private.src = request(1).src;
        private.scope = "library".into();
        assert!(private.requires_connection(&first));
    }

    #[tokio::test]
    async fn a_large_http_burst_finishes_with_only_the_configured_parallel_downloads() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        const REQUEST_COUNT: usize = 24;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let uri = format!("http://{}", listener.local_addr().unwrap());
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let server_peak = peak.clone();
        let server = tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            for _ in 0..REQUEST_COUNT {
                let (mut socket, _) = listener.accept().await.unwrap();
                let active = active.clone();
                let peak = server_peak.clone();
                connections.spawn(async move {
                    let mut request = [0; 2048];
                    socket.read(&mut request).await.unwrap();
                    let count = active.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(count, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    socket
                        .write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc",
                        )
                        .await
                        .unwrap();
                    active.fetch_sub(1, Ordering::SeqCst);
                });
            }
            while let Some(result) = connections.join_next().await {
                result.unwrap();
            }
        });
        let directory = tempfile::tempdir().unwrap();
        let cache = ImageCache::new(directory.path().join("images"));
        let queue = WorkQueue::new(32, 3);
        let context = ImageContext::new(1, None);
        let mut requests = FuturesUnordered::new();
        for id in 0..REQUEST_COUNT {
            let admission = queue.try_admit().unwrap();
            let key = WorkKey::new(&request(id), &context, cache.ticket());
            let uri = uri.clone();
            requests.push(admission.resolve(key, move || async move {
                image_fetch::fetch(image_fetch::request(None, &uri).unwrap()).await
            }));
        }
        while let Some(bytes) = requests.next().await {
            assert_eq!(&**bytes.unwrap(), b"abc");
        }
        server.await.unwrap();
        assert_eq!(peak.load(Ordering::SeqCst), 3);
    }
}
