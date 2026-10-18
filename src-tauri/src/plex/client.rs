//! Plex API HTTP client with retry logic and connection pooling
#![allow(dead_code)]

use crate::http_response::{BoundedResponseExt, MAX_PLEX_BYTES};
use reqwest::header::{HeaderMap, HeaderValue};
use reqwest_middleware::{ClientBuilder, ClientWithMiddleware};
use reqwest_retry::RetryTransientMiddleware;
use reqwest_retry::policies::ExponentialBackoff;
use serde::de::DeserializeOwned;
use anyhow::{Result, Context};
use tracing::{debug, instrument};

use crate::plex::models::PlexApiResponse;

pub(super) fn request_error(error: reqwest_middleware::Error) -> anyhow::Error {
    match error {
        reqwest_middleware::Error::Reqwest(error) => error.without_url().into(),
        reqwest_middleware::Error::Middleware(_) => anyhow::anyhow!("Plex request failed"),
    }
}

pub(super) fn token_header(value: &str) -> HeaderValue {
    let mut header = HeaderValue::from_str(value).unwrap_or_else(|_| HeaderValue::from_static(""));
    header.set_sensitive(true);
    header
}

pub(super) fn without_plex_token(value: &str) -> String {
    let Ok(mut url) = url::Url::parse(value) else { return value.into(); };
    if !url.query_pairs().any(|(key, _)| key.eq_ignore_ascii_case("X-Plex-Token")) { return value.into(); }
    let filtered = url.query().unwrap_or_default().split('&').filter(|pair| {
        !url::form_urlencoded::parse(pair.as_bytes()).next().is_some_and(|(key, _)| key.eq_ignore_ascii_case("X-Plex-Token"))
    }).collect::<Vec<_>>().join("&");
    url.set_query(if filtered.is_empty() { None } else { Some(&filtered) });
    url.into()
}

/// Never forward Plex headers (or token-bearing URLs) across an origin redirect.
fn plex_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 10 {
            return attempt.error("too many Plex redirects");
        }
        if attempt.previous().first().map(|first| first.origin() == attempt.url().origin()).unwrap_or(true) {
            attempt.follow()
        } else {
            attempt.error("refusing cross-origin Plex redirect")
        }
    })
}

/// Public audio (including podcasts) does not require a Plex connection/token.
pub fn public_media_request(url: &str) -> reqwest::RequestBuilder {
    static CLIENT: once_cell::sync::Lazy<reqwest::Client> = once_cell::sync::Lazy::new(|| {
        reqwest::Client::builder().http1_only().pool_max_idle_per_host(0)
            .connect_timeout(std::time::Duration::from_secs(10))
            .read_timeout(std::time::Duration::from_secs(15))
            .build().expect("public media HTTP client")
    });
    CLIENT.get(without_plex_token(url))
}

const PRODUCT_NAME: &str = "Hibiki";
const PRODUCT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Configuration for the PlexClient
#[derive(Clone)]
pub struct PlexClientConfig {
    /// Base URL of the Plex server (e.g., "http://localhost:32400")
    pub base_url: String,
    /// Plex authentication token
    pub token: String,
    /// Stable per-installation UUID used as X-Plex-Client-Identifier.
    /// Required by Plex for timeline/session tracking.
    pub client_id: String,
    /// Maximum concurrent connections (default: 100)
    pub max_connections: usize,
    /// Enable debug logging (default: false)
    pub debug: bool,
    /// Disable TLS certificate verification (useful for local servers with self-signed certs)
    pub accept_invalid_certs: bool,
}

impl Default for PlexClientConfig {
    fn default() -> Self {
        Self {
            base_url: String::from("http://localhost:32400"),
            token: String::new(),
            client_id: String::from("hibiki-client"),
            max_connections: 100,
            debug: false,
            accept_invalid_certs: false,
        }
    }
}

impl std::fmt::Debug for PlexClientConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PlexClientConfig").field("has_token", &!self.token.is_empty())
            .field("accept_invalid_certs", &self.accept_invalid_certs).finish_non_exhaustive()
    }
}

/// Plex API client with retry logic and connection pooling
#[derive(Clone)]
pub struct PlexClient {
    pub(crate) metadata_cache: Option<super::metadata_cache::Context>,
    base_url: String,
    pub token: String,
    pub client_id: String,
    pub machine_identifier: String,
    pub library_scope: String,
    /// Verified endpoint aliases share an existing account/library cache owner.
    pub(crate) scope_bases: std::collections::BTreeMap<String, String>,
    /// Restored cached-library contexts must never dispatch server requests.
    pub offline_only: bool,
    pub client: ClientWithMiddleware,
    /// Separate reqwest client for `fetch_bytes` (audio download path).
    ///
    /// Plex closes idle keep-alive connections aggressively, and reqwest's
    /// pool happily hands those stale sockets out for new requests. For the
    /// large-body media path we use a dedicated client with **pooling disabled**
    /// so every download opens a fresh TCP/TLS connection. ~50–100ms handshake
    /// overhead per fetch, fully reliable.
    media_client: reqwest::Client,
    artwork_client: reqwest::Client,
    metadata_mutation_client: reqwest::Client,
    /// Shared by this server connection and its clones. Plex can terminate a
    /// media response when active playback, preload, and downloads overlap.
    /// Streaming uses bounded ranges and releases the lock between them, so
    /// newer playback does not queue behind an entire file or retry backoff.
    fetch_lock: std::sync::Arc<tokio::sync::Mutex<()>>,
}

impl std::fmt::Debug for PlexClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PlexClient").field("has_token", &!self.token.is_empty()).finish_non_exhaustive()
    }
}

impl PlexClient {
    /// Create a new PlexClient with the given configuration
    ///
    /// # Arguments
    /// * `config` - Client configuration
    ///
    /// # Returns
    /// * `Result<PlexClient>` - The configured client or an error
    ///
    /// # Example
    /// ```no_run
    /// use plex::client::{PlexClient, PlexClientConfig};
    ///
    /// # tokio_test::block_on(async {
    /// let config = PlexClientConfig {
    ///     base_url: "http://localhost:32400".to_string(),
    ///     token: "your-token-here".to_string(),
    ///     ..Default::default()
    /// };
    ///
    /// let client = PlexClient::new(config)?;
    /// # Ok::<(), anyhow::Error>(())
    /// # });
    /// ```
    pub fn new(config: PlexClientConfig) -> Result<Self> {
        super::tls::server_url(&config.base_url)?;
        HeaderValue::from_str(&config.token).context("Invalid Plex token header")?;
        // Build retry policy with exponential backoff
        // Only 1 retry — large playlist item requests can take a long time to
        // evaluate server-side, and retrying a 60-second timeout 4 times would
        // leave the user waiting 4+ minutes before seeing an error.
        let retry_policy = ExponentialBackoff::builder()
            .retry_bounds(
                std::time::Duration::from_millis(100),
                std::time::Duration::from_millis(3200),
            )
            .build_with_max_retries(1);

        let retry_middleware = RetryTransientMiddleware::new_with_policy(retry_policy);

        // Build default headers sent on every request so Plex can identify
        // and name this client in its dashboard / sessions view.
        let platform = std::env::consts::OS; // "macos", "linux", "windows"
        let mut default_headers = HeaderMap::new();
        default_headers.insert("X-Plex-Product",      HeaderValue::from_static(PRODUCT_NAME));
        default_headers.insert("X-Plex-Version",      HeaderValue::from_static(PRODUCT_VERSION));
        default_headers.insert("X-Plex-Platform",     HeaderValue::from_str(platform).unwrap_or(HeaderValue::from_static("Desktop")));
        default_headers.insert("X-Plex-Device",       HeaderValue::from_static("Desktop"));
        default_headers.insert("X-Plex-Device-Name",  HeaderValue::from_static(PRODUCT_NAME));
        if let Ok(v) = HeaderValue::from_str(&config.client_id) {
            default_headers.insert("X-Plex-Client-Identifier", v);
        }

        // Build HTTP client.
        //
        // `pool_idle_timeout(3s)` defends against Plex closing idle keep-alive
        // connections from under us — reqwest's default of 90s is well above
        // Plex's server-side timeout, which means the pool keeps handing out
        // dead sockets after even brief idle periods. 3s is short enough to
        // avoid stale entries while still allowing back-to-back API calls to
        // reuse a connection.
        let client = reqwest::Client::builder()
            .redirect(plex_redirect_policy())
            .pool_max_idle_per_host(config.max_connections)
            .pool_idle_timeout(std::time::Duration::from_secs(3))
            // 120s: smart playlists with 100k+ tracks can take a long time to
            // evaluate server-side even with correct pagination params.
            .timeout(std::time::Duration::from_secs(120))
            .danger_accept_invalid_certs(config.accept_invalid_certs)
            .danger_accept_invalid_hostnames(config.accept_invalid_certs)
            .default_headers(default_headers.clone())
            .build()
            .context("Failed to build HTTP client")?;

        // Dedicated client for `fetch_bytes`. No connection pooling at all —
        // every audio download opens a fresh TCP/TLS connection. See the
        // `media_client` field doc for the rationale.
        let media_client = reqwest::Client::builder()
            .pool_max_idle_per_host(0)
            .http1_only()
            .connect_timeout(std::time::Duration::from_secs(10))
            .read_timeout(std::time::Duration::from_secs(15))
            .redirect(plex_redirect_policy())
            .danger_accept_invalid_certs(config.accept_invalid_certs)
            .danger_accept_invalid_hostnames(config.accept_invalid_certs)
            .default_headers(default_headers.clone())
            .build()
            .context("Failed to build media HTTP client")?;

        // Explicit catalog edits must never retry an ambiguous accepted write or
        // follow a redirect to another endpoint.
        let metadata_mutation_client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .retry(reqwest::retry::never())
            .redirect(reqwest::redirect::Policy::none())
            .danger_accept_invalid_certs(config.accept_invalid_certs)
            .danger_accept_invalid_hostnames(config.accept_invalid_certs)
            .default_headers(default_headers.clone())
            .build()
            .context("Failed to build metadata mutation HTTP client")?;

        let artwork_client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(5))
            .timeout(std::time::Duration::from_secs(15))
            .redirect(super::artwork::redirect_policy(url::Url::parse(&config.base_url)?))
            .danger_accept_invalid_certs(config.accept_invalid_certs)
            .danger_accept_invalid_hostnames(config.accept_invalid_certs)
            .default_headers(default_headers)
            .build()
            .context("Failed to build artwork HTTP client")?;

        // Add middleware
        let client = ClientBuilder::new(client)
            .with(retry_middleware)
            .build();

        Ok(Self {
            metadata_cache: None,
            base_url: config.base_url,
            token: config.token,
            client_id: config.client_id,
            machine_identifier: String::new(),
            library_scope: String::new(),
            scope_bases: Default::default(),
            offline_only: false,
            client,
            media_client,
            artwork_client,
            metadata_mutation_client,
            fetch_lock: std::sync::Arc::new(tokio::sync::Mutex::new(())),
        })
    }

    /// Perform a GET request and deserialize the JSON response.
    ///
    /// Plex wraps every response in `{"MediaContainer": <T>}`. This method
    /// automatically unwraps that envelope and returns the inner value.
    ///
    /// # Arguments
    /// * `path` - API path (e.g., "/library/sections")
    #[instrument(skip_all)]
    pub async fn get<T>(&self, path: &str) -> Result<T>
    where
        T: DeserializeOwned,
    {
        if let Some(context) = self.metadata_cache.as_ref().filter(|_| super::metadata_cache::eligible(path)) {
            let value = super::metadata_cache::get(context,self,path).await.map_err(anyhow::Error::msg)?;
            return serde_json::from_value(value).context("Failed to parse cached Plex metadata");
        }
        self.get_uncached(path).await
    }

    pub(crate) async fn get_uncached<T>(&self, path: &str) -> Result<T>
    where T: DeserializeOwned,
    {
        self.get_uncached_with_policy(path,0).await.map(|(value,_)| value)
    }
    pub(crate) async fn get_uncached_with_policy<T: DeserializeOwned>(&self, path: &str, fallback: i64) -> Result<(T,crate::metadata_cache::HttpPolicy)> {
        let operation = if path.starts_with("/hubs") { "plex.hubs" }
            else if path.starts_with("/playlists") && path.contains("/items") { "plex.playlist_items" }
            else if path.starts_with("/playlists") { "plex.playlists" }
            else if path.starts_with("/library/metadata/") && path.contains("/children") { "plex.children" }
            else if path.starts_with("/library/metadata/") { "plex.metadata" }
            else if path.starts_with("/library/sections/") { "plex.library" }
            else { "plex.other" };
        let mut timing = crate::performance::Timer::new(operation);
        let url = self.build_url(path);
        debug!("GET request");

        let response = self
            .client
            .get(&url)
            .header("X-Plex-Token", token_header(&self.token))
            .header("Accept", "application/json")
            .send()
            .await.map_err(request_error)
            .context("GET request failed")?;
        timing.phase("headers");

        debug!("Response status: {}", response.status());

        if !response.status().is_success() {
            return Err(anyhow::anyhow!(
                "HTTP error: {}", response.status()
            ));
        }

        let policy = crate::metadata_cache::HttpPolicy::from_headers(response.headers(),fallback,crate::metadata_cache::now());
        let wrapper = response
            .bounded_plex_json::<PlexApiResponse<T>>(MAX_PLEX_BYTES)
            .await
            .context("Failed to parse JSON response")?;
        timing.phase("body_decode");

        Ok((wrapper.container,policy))
    }

    /// Fetch raw response text — for non-JSON endpoints (e.g., TTML/LRC lyrics).
    pub async fn get_text(&self, path: &str) -> Result<String> {
        let url = self.build_url(path);
        let response = self.client.get(&url)
            .header("X-Plex-Token", token_header(&self.token))
            .send().await.map_err(request_error).context("GET request failed")?;
        if !response.status().is_success() {
            return Err(anyhow::anyhow!("HTTP error: {}", response.status()));
        }
        response.bounded_text(MAX_PLEX_BYTES).await.context("Failed to read response text")
    }

    /// Fetch raw response text — for debugging API responses in tests.
    #[cfg(test)]
    pub async fn get_raw(&self, path: &str) -> Result<String> {
        let url = self.build_url(path);
        let response = self.client.get(&url)
            .header("X-Plex-Token", token_header(&self.token))
            .header("Accept", "application/json")
            .send().await.map_err(request_error).context("GET request failed")?;
        response.bounded_text(MAX_PLEX_BYTES).await.context("Failed to read response text")
    }

    /// Perform a POST request with a JSON body.
    ///
    /// Automatically unwraps the Plex `{"MediaContainer": <T>}` envelope.
    #[instrument(skip_all)]
    pub async fn post<T>(&self, path: &str, body: serde_json::Value) -> Result<T>
    where
        T: DeserializeOwned,
    {
        let url = self.build_url(path);
        debug!("POST request");

        let response = self
            .client
            .post(&url)
            .header("X-Plex-Token", token_header(&self.token))
            .header("Accept", "application/json")
            .json(&body)
            .send()
            .await.map_err(request_error)
            .context("POST request failed")?;

        debug!("Response status: {}", response.status());

        if !response.status().is_success() {
            return Err(anyhow::anyhow!(
                "HTTP error: {}", response.status()
            ));
        }

        let wrapper = response
            .bounded_json::<PlexApiResponse<T>>(MAX_PLEX_BYTES)
            .await
            .context("Failed to parse JSON response")?;

        Ok(wrapper.container)
    }

    /// Perform a PUT request with a JSON body
    ///
    /// # Arguments
    /// * `path` - API path
    /// * `body` - Request body to serialize as JSON
    ///
    /// # Returns
    /// * `Result<T>` - The deserialized response or an error
    #[instrument(skip_all)]
    pub async fn put<T>(&self, path: &str, body: serde_json::Value) -> Result<T>
    where
        T: DeserializeOwned,
    {
        let url = self.build_url(path);
        debug!("PUT request");

        let response = self
            .client
            .put(&url)
            .header("X-Plex-Token", token_header(&self.token))
            .header("Accept", "application/json")
            .json(&body)
            .send()
            .await.map_err(request_error)
            .context("PUT request failed")?;

        debug!("Response status: {}", response.status());

        if !response.status().is_success() {
            return Err(anyhow::anyhow!(
                "HTTP error: {}", response.status()
            ));
        }

        let json = response
            .bounded_json::<T>(MAX_PLEX_BYTES)
            .await
            .context("Failed to parse JSON response")?;

        Ok(json)
    }

    /// Perform a POST request with query parameters and no body.
    ///
    /// Automatically unwraps the Plex `{"MediaContainer": <T>}` envelope.
    #[instrument(skip_all)]
    pub async fn post_params<T>(&self, path: &str, params: &[(&str, &str)]) -> Result<T>
    where
        T: DeserializeOwned,
    {
        let url = self.build_url(path);
        debug!("POST (params) request");

        let response = self
            .client
            .post(&url)
            .header("X-Plex-Token", token_header(&self.token))
            .header("Accept", "application/json")
            .query(params)
            .send()
            .await.map_err(request_error)
            .context("POST request failed")?;

        debug!("Response status: {}", response.status());

        if !response.status().is_success() {
            return Err(anyhow::anyhow!(
                "HTTP error: {}", response.status()
            ));
        }

        let wrapper = response
            .bounded_json::<PlexApiResponse<T>>(MAX_PLEX_BYTES)
            .await
            .context("Failed to parse JSON response")?;

        Ok(wrapper.container)
    }

    /// A playlist create cannot be replayed after an unknown outcome. Keep the
    /// response bounded so its freshly returned ID can be retained by callers.
    pub(crate) async fn create_playlist_once<T: DeserializeOwned>(&self, params: &[(&str, &str)]) -> Result<T> {
        if self.offline_only { anyhow::bail!("Reconnect to Plex before creating playlists."); }
        let response = self.metadata_mutation_client.post(self.build_endpoint_url("/playlists"))
            .header("X-Plex-Token", token_header(&self.token))
            .header("Accept", "application/json").query(params).send().await
            .map_err(|error| error.without_url()).context("Plex did not confirm the playlist create")?;
        if !response.status().is_success() { anyhow::bail!("Plex did not confirm the playlist create (HTTP {})", response.status()); }
        let wrapper = response.bounded_json::<PlexApiResponse<T>>(crate::http_response::MAX_JSON_BYTES)
            .await.context("Plex did not confirm the created playlist identifier")?;
        Ok(wrapper.container)
    }

    /// One explicit metadata write. Do not replay an unknown outcome.
    pub(crate) async fn put_metadata_params_once(&self, path: &str, params: &[(&str, &str)]) -> Result<()> {
        self.mutate_params_once(reqwest::Method::PUT, path, params, None, None).await
    }

    /// A user-admitted mutation has exactly one HTTP attempt and cannot redirect.
    pub(crate) async fn mutate_params_once(
        &self,
        method: reqwest::Method,
        path: &str,
        params: &[(&str, &str)],
        body: Option<Vec<u8>>,
        content_type: Option<&str>,
    ) -> Result<()> {
        if self.offline_only { anyhow::bail!("Reconnect to Plex before changing the library."); }
        if !matches!(method, reqwest::Method::POST | reqwest::Method::PUT | reqwest::Method::DELETE) {
            anyhow::bail!("Unsupported library mutation method.");
        }
        let mut request = self.metadata_mutation_client.request(method, self.build_endpoint_url(path))
            .header("X-Plex-Token", token_header(&self.token))
            .header("Accept", "application/json").query(params);
        if let Some(body) = body {
            request = request.body(body);
            if let Some(content_type) = content_type {
                request = request.header(reqwest::header::CONTENT_TYPE, content_type);
            }
        }
        let response = request.send().await
            .map_err(|error| error.without_url()).context("Plex did not confirm the library change")?;
        if !response.status().is_success() { anyhow::bail!("Plex did not confirm the library change (HTTP {})", response.status()); }
        Ok(())
    }

    /// Perform a PUT request with query parameters and no body, ignoring the response body.
    #[instrument(skip_all)]
    pub async fn put_params_ok(&self, path: &str, params: &[(&str, &str)]) -> Result<()>
    {
        let url = self.build_url(path);
        debug!("PUT (params) request");

        let response = self
            .client
            .put(&url)
            .header("X-Plex-Token", token_header(&self.token))
            .header("Accept", "application/json")
            .query(params)
            .send()
            .await.map_err(request_error)
            .context("PUT request failed")?;

        debug!("Response status: {}", response.status());

        if !response.status().is_success() {
            return Err(anyhow::anyhow!(
                "HTTP error: {}", response.status()
            ));
        }

        Ok(())
    }

    /// Perform a DELETE request
    ///
    /// # Arguments
    /// * `path` - API path
    ///
    /// # Returns
    /// * `Result<()>` - Success or an error
    #[instrument(skip_all)]
    pub async fn delete(&self, path: &str) -> Result<()> {
        let url = self.build_url(path);
        debug!("DELETE request");

        let response = self
            .client
            .delete(&url)
            .header("X-Plex-Token", token_header(&self.token))
            .header("Accept", "application/json")
            .send()
            .await.map_err(request_error)
            .context("DELETE request failed")?;

        debug!("Response status: {}", response.status());

        if !response.status().is_success() {
            return Err(anyhow::anyhow!(
                "HTTP error: {}", response.status()
            ));
        }

        Ok(())
    }

    /// Perform a GET request against a pre-built full URL (no `build_url` call).
    ///
    /// Use this when you already have the complete URL including query params.
    /// Like `get()`, automatically unwraps the Plex `{"MediaContainer": <T>}` envelope.
    #[instrument(skip_all)]
    pub async fn get_url<T>(&self, url: &str) -> Result<T>
    where
        T: DeserializeOwned,
    {
        if !self.is_plex_url(url) { anyhow::bail!("Plex API URL does not belong to the connected server"); }
        debug!("GET request");

        let response = self
            .client
            .get(url)
            .header("X-Plex-Token", token_header(&self.token))
            .header("Accept", "application/json")
            .send()
            .await.map_err(request_error)
            .context("GET request failed")?;

        debug!("Response status: {}", response.status());

        if !response.status().is_success() {
            return Err(anyhow::anyhow!(
                "HTTP error: {}", response.status()
            ));
        }

        let wrapper = response
            .bounded_plex_json::<PlexApiResponse<T>>(MAX_PLEX_BYTES)
            .await
            .context("Failed to parse JSON response")?;

        Ok(wrapper.container)
    }

    /// Get cloneable handles for streaming audio fetches.
    ///
    /// The lock serializes Plex media downloads; public streams never inherit
    /// the Plex token or this server's TLS configuration.
    pub fn media_fetch_lock(&self) -> std::sync::Arc<tokio::sync::Mutex<()>> {
        self.fetch_lock.clone()
    }

    pub fn cache_scope_for_library(&self, id: i64, uuid: Option<&str>) -> String {
        let library = uuid.filter(|value| !value.is_empty())
            .map(str::to_string).unwrap_or_else(|| id.to_string());
        super::cache_scope::library_scope(&self.machine_identifier, &self.token, &library,
            self.scope_bases.get(&library).unwrap_or(&self.base_url))
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub fn is_plex_url(&self, value: &str) -> bool {
        match (url::Url::parse(&self.base_url), url::Url::parse(value)) {
            (Ok(base), Ok(target)) => base.origin() == target.origin()
                && target.username().is_empty() && target.password().is_none(),
            _ => false,
        }
    }

    pub fn media_request(&self, url: &str) -> reqwest::RequestBuilder {
        if self.is_plex_url(url) {
            self.media_client.get(without_plex_token(url)).header("X-Plex-Token", token_header(&self.token))
        } else {
            public_media_request(url)
        }
    }

    pub fn artwork_request(&self, value: &str) -> Option<reqwest::RequestBuilder> {
        let base = url::Url::parse(&self.base_url).ok()?;
        let mut target = url::Url::parse(&without_plex_token(value)).ok()?;
        super::artwork::normalize_source(&base, &mut target, &self.token)?;
        if !super::artwork::public_url(&target) || !super::artwork::allowed(&base, &target) {
            return None;
        }
        let target = super::artwork::bounded_source(&base, &target)?;
        Some(self.artwork_client.get(target).header("X-Plex-Token", token_header(&self.token)))
    }

    /// Only the inventory registry may call this with a verified same-item image
    /// route. The direct client has no redirects or retry middleware.
    pub(crate) fn registered_artwork_request(&self, value: &str) -> reqwest::RequestBuilder {
        self.metadata_mutation_client.get(value)
            .header("X-Plex-Token", token_header(&self.token))
    }

    /// Fetch the raw response body bytes for a pre-built full URL.
    ///
    /// Used by the audio engine to download media files for in-memory decoding.
    /// Routes through `media_client` (no connection pooling) and serializes
    /// against any other in-flight `fetch_bytes` call via `fetch_lock`. See the
    /// field docs for the rationale on both — TL;DR Plex's media endpoint hates
    /// reused pooled connections AND hates concurrent large-body downloads.
    #[instrument(skip_all)]
    pub async fn fetch_bytes(&self, url: &str) -> Result<Vec<u8>> {
        debug!("fetching audio bytes");
        let _guard = self.fetch_lock.lock().await;

        let response = self.media_request(url)
            .send()
            .await.map_err(|error| error.without_url())
            .context("fetch_bytes request failed")?;

        let status = response.status();
        if !status.is_success() {
            return Err(anyhow::anyhow!("HTTP {}", status));
        }

        // This legacy whole-file IPC path must also have a finite buffer size.
        let bytes = response
            .bounded_bytes(512 * 1024 * 1024)
            .await
            .context("fetch_bytes failed reading body")?;
        debug!("fetch_bytes complete: {} bytes", bytes.len());
        Ok(bytes)
    }


    /// Perform a PUT request against a pre-built full URL (no `build_url` call).
    ///
    /// Use this when the URL already contains query params (e.g. `?after=N`).
    #[instrument(skip_all)]
    pub async fn put_url<T>(&self, url: &str, body: serde_json::Value) -> Result<T>
    where
        T: DeserializeOwned,
    {
        if !self.is_plex_url(url) { anyhow::bail!("Plex API URL does not belong to the connected server"); }
        debug!("PUT request");

        let response = self
            .client
            .put(url)
            .header("X-Plex-Token", token_header(&self.token))
            .header("Accept", "application/json")
            .json(&body)
            .send()
            .await.map_err(request_error)
            .context("PUT request failed")?;

        debug!("Response status: {}", response.status());

        if !response.status().is_success() {
            return Err(anyhow::anyhow!(
                "HTTP error: {}", response.status()
            ));
        }

        response
            .bounded_json::<T>(MAX_PLEX_BYTES)
            .await
            .context("Failed to parse JSON response")
    }

    /// Build a full URL from a path
    ///
    /// # Arguments
    /// * `path` - API path (e.g., "/library/sections")
    ///
    /// # Returns
    /// * `String` - The full URL
    pub fn build_url(&self, path: &str) -> String {
        let url = self.build_endpoint_url(path);
        // Request analysis with track metadata so crossfade data is available.
        if url.contains('?') {
            format!("{}&includeLoudnessRamps=1", url)
        } else {
            format!("{}?includeLoudnessRamps=1", url)
        }
    }

    /// Build an endpoint URL without adding track-metadata options. Personalized
    /// discovery responses can depend on their query, even for unrelated flags.
    pub fn build_endpoint_url(&self, path: &str) -> String {
        let base = self.base_url.trim_end_matches('/');
        let path = path.trim_start_matches('/');
        format!("{}/{}", base, path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn tokens_are_sensitive_headers_and_url_cleanup_preserves_other_signed_query_bytes() {
        let config = PlexClientConfig { base_url: "https://plex.test:32400".into(), token: "dummy-private-token".into(), ..Default::default() };
        assert!(!format!("{config:?}").contains("dummy-private-token"));
        let client = PlexClient::new(config).unwrap();
        assert!(!format!("{client:?}").contains("dummy-private-token"));
        let request = client.media_request("https://plex.test:32400/file?X-Plex-Token=dummy-private-token&signature=a%20b%2Bc").build().unwrap();
        assert_eq!(request.url().query(), Some("signature=a%20b%2Bc"));
        assert!(request.headers()["X-Plex-Token"].is_sensitive());
        let public = public_media_request("https://public.test/file?signature=a%20b%2Bc").build().unwrap();
        assert_eq!(public.url().query(), Some("signature=a%20b%2Bc"));
        let foreign = client.media_request("https://foreign.test/file?X-Plex-Token=dummy-private-token").build().unwrap();
        assert!(foreign.url().query().is_none());
        assert!(!foreign.headers().contains_key("X-Plex-Token"));
    }

    #[test]
    fn media_credentials_are_scoped_to_the_plex_server_origin() {
        let client = PlexClient::new(PlexClientConfig {
            base_url: "https://plex.example:32400".into(), token: "test-token".into(),
            ..Default::default()
        }).unwrap();
        for url in ["https://podcast.example/episode.mp3", "https://plex.example:443/file.mp3",
            "http://plex.example:32400/file.mp3", "https://plex.example.attacker.test/file.mp3"] {
            let request = client.media_request(url).build().unwrap();
            assert!(!request.headers().contains_key("X-Plex-Token"));
            assert!(!request.headers().contains_key("X-Plex-Client-Identifier"));
        }
        let request = client.media_request("https://plex.example:32400/library/parts/42/file.mp3").build().unwrap();
        assert_eq!(request.headers()["X-Plex-Token"], "test-token");
    }

    #[tokio::test]
    async fn token_bearing_media_requests_do_not_follow_cross_origin_redirects() {
        let destination = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (client, server) = mock_http(vec![format!(
            "HTTP/1.1 302 Found\r\nLocation: http://{}/episode.mp3\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            destination.local_addr().unwrap()
        )]).await;
        assert!(client.fetch_bytes(&client.build_url("/file.mp3")).await.is_err());
        assert_eq!(server.await.unwrap().len(), 1);
        assert!(tokio::time::timeout(std::time::Duration::from_millis(100), destination.accept()).await.is_err(),
            "the foreign origin must never receive the Plex request");
    }

    async fn mock_http(responses: Vec<String>) -> (PlexClient, tokio::task::JoinHandle<Vec<String>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = PlexClient::new(PlexClientConfig {
            base_url: format!("http://{}", listener.local_addr().unwrap()),
            token: "test-token".to_string(),
            client_id: "test-client".to_string(),
            ..Default::default()
        }).unwrap();
        let server = tokio::spawn(async move {
            let mut requests = Vec::new();
            for response in responses {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut buffer = [0u8; 4096];
                while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                    let size = socket.read(&mut buffer).await.unwrap();
                    assert!(size > 0, "client disconnected before sending headers");
                    request.extend_from_slice(&buffer[..size]);
                    assert!(request.len() < 65536, "request headers too large");
                }
                requests.push(String::from_utf8(request).unwrap());
                socket.write_all(response.as_bytes()).await.unwrap();
                socket.shutdown().await.unwrap();
            }
            requests
        });
        (client, server)
    }

    #[tokio::test]
    async fn test_http_retry_and_plex_headers() {
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            let body = r#"{"MediaContainer":{"size":1}}"#;
            let (client, server) = mock_http(vec![
                "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(),
                format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body),
            ]).await;
            let result: serde_json::Value = client.get("/library/sections").await.unwrap();
            assert_eq!(result["size"], 1);
            let requests = server.await.unwrap();
            assert_eq!(requests.len(), 2);
            for request in requests {
                assert!(request.starts_with("GET /library/sections?includeLoudnessRamps=1 HTTP/1.1\r\n"));
                let headers = request.to_ascii_lowercase();
                assert!(headers.contains("x-plex-token: test-token\r\n"));
                assert!(headers.contains("x-plex-client-identifier: test-client\r\n"));
                assert!(headers.contains("x-plex-product: hibiki\r\n"));
                assert!(headers.contains("accept: application/json\r\n"));
            }
        }).await.expect("mock HTTP request timed out");
    }

    #[tokio::test]
    async fn test_media_fetch_rejects_truncated_body() {
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            let (client, server) = mock_http(vec![
                "HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\ndata".to_string(),
            ]).await;
            let url = client.build_url("/library/parts/1/file.flac");
            assert!(client.fetch_bytes(&url).await.is_err(), "incomplete audio must not be accepted");
            let requests = server.await.unwrap();
            assert_eq!(requests.len(), 1);
            assert!(requests[0].to_ascii_lowercase().contains("x-plex-token: test-token\r\n"));
        }).await.expect("mock media request timed out");
    }

    #[test]
    fn test_build_url() {
        let client = PlexClient::new(PlexClientConfig {
            base_url: "http://localhost:32400".to_string(),
            token: "test-token".to_string(),
            ..Default::default()
        }).unwrap();

        assert_eq!(client.build_url("/library/sections"), "http://localhost:32400/library/sections?includeLoudnessRamps=1");
        assert_eq!(client.build_url("library/sections"), "http://localhost:32400/library/sections?includeLoudnessRamps=1");
        // Paths with existing query params get & instead of ?
        assert_eq!(client.build_url("/library/metadata/123?type=audio"), "http://localhost:32400/library/metadata/123?type=audio&includeLoudnessRamps=1");
    }

    #[test]
    fn test_client_creation() {
        let result = PlexClient::new(PlexClientConfig {
            base_url: "http://localhost:32400".to_string(),
            token: "test-token".to_string(),
            ..Default::default()
        });

        assert!(result.is_ok());
    }
}

#[cfg(test)]
mod playlist_create_once_tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    #[tokio::test]
    async fn playlist_creates_use_one_bounded_nonredirecting_request_and_one_positive_id() {
        for case in 0..8 {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/proxy", listener.local_addr().unwrap());
            let (stop_tx, mut stop_rx) = tokio::sync::oneshot::channel();
            let server = tokio::spawn(async move {
                let mut count = 0;
                loop {
                    let (mut stream, _) = tokio::select! {
                        _ = &mut stop_rx => break,
                        accepted = listener.accept() => accepted.unwrap(),
                    };
                    count += 1;
                    let mut header = vec![]; let mut buffer = [0;4096];
                    while !header.windows(4).any(|part| part == b"\r\n\r\n") {
                        let size = stream.read(&mut buffer).await.unwrap(); assert!(size > 0);
                        header.extend_from_slice(&buffer[..size]); assert!(header.len() < 65536);
                    }
                    let request = String::from_utf8(header).unwrap();
                    let head = request.lines().next().unwrap().split_whitespace().collect::<Vec<_>>();
                    assert_eq!(head[0], "POST");
                    let url = url::Url::parse(&format!("http://synthetic{}", head[1])).unwrap();
                    assert_eq!(url.path(), "/proxy/playlists");
                    let query = url.query_pairs().into_owned().collect::<std::collections::BTreeMap<_,_>>();
                    assert_eq!(query.get("title").unwrap(), "Hibiki QA fixture");
                    assert_eq!(query.get("type").unwrap(), "audio"); assert_eq!(query.get("smart").unwrap(), "0");
                    assert_eq!(query.get("uri").unwrap(), if case == 7 { "" } else { "server://synthetic/com.plexapp.plugins.library/library/metadata/1,2,1" });
                    assert!(!query.contains_key("includeLoudnessRamps"));
                    assert!(request.to_lowercase().contains("x-plex-token: synthetic-token"));
                    let status = if case == 1 {503} else if case == 2 {302} else {200};
                    let entries = match case {
                        4 => "[]",
                        5 => "[{\"ratingKey\":\"41\"},{\"ratingKey\":\"42\"}]",
                        6 => "[{\"ratingKey\":\"0\"}]",
                        _ => "[{\"ratingKey\":\"41\",\"title\":\"Hibiki QA fixture\",\"playlistType\":\"audio\"}]",
                    };
                    let body = format!("{{\"MediaContainer\":{{\"Metadata\":{entries}}}}}");
                    let length = if case == 3 {crate::http_response::MAX_JSON_BYTES + 1} else {body.len()};
                    let response = format!("HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {length}\r\nLocation: /unexpected-redirect\r\nConnection: close\r\n\r\n{body}");
                    stream.write_all(response.as_bytes()).await.unwrap();
                }
                count
            });
            let mut client = PlexClient::new(PlexClientConfig {base_url:base,token:"synthetic-token".into(),..Default::default()}).unwrap();
            client.machine_identifier = "synthetic".into();
            let ids: &[i64] = if case == 7 { &[] } else { &[1,2,1] };
            let outcome = tokio::time::timeout(std::time::Duration::from_secs(10), client.create_playlist("Hibiki QA fixture",5,ids)).await;
            let _ = stop_tx.send(());
            assert_eq!(server.await.unwrap(),1,"create must not retry or follow redirects");
            let result = outcome.expect("single create request did not finish");
            if case == 0 || case == 7 {assert_eq!(result.unwrap().rating_key,41);}
            else {let error=result.unwrap_err().to_string();assert!(!error.contains("synthetic-token"));}
        }
    }
}

#[cfg(test)]
mod playlist_append_once_tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    #[tokio::test]
    async fn ordinary_multiitem_append_uses_one_library_uri_without_retry_or_redirect() {
        for status in [200,503,302] {
            let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base=format!("http://{}/proxy",listener.local_addr().unwrap());
            let (stop,mut stopped)=tokio::sync::oneshot::channel();
            let server=tokio::spawn(async move {
                let mut count=0;
                loop {
                    let (mut stream,_)=tokio::select!{_= &mut stopped=>break, accepted=listener.accept()=>accepted.unwrap()};count+=1;
                    let mut header=Vec::new();let mut buffer=[0u8;4096];
                    while !header.windows(4).any(|w|w==b"\r\n\r\n") {let n=stream.read(&mut buffer).await.unwrap();assert!(n>0);header.extend_from_slice(&buffer[..n]);assert!(header.len()<65536);}
                    let request=String::from_utf8(header).unwrap();let first=request.lines().next().unwrap().split_whitespace().collect::<Vec<_>>();assert_eq!(first[0],"PUT");
                    let url=url::Url::parse(&format!("http://synthetic{}",first[1])).unwrap();assert_eq!(url.path(),"/proxy/playlists/42/items");
                    let pairs=url.query_pairs().into_owned().collect::<std::collections::BTreeMap<_,_>>();assert_eq!(pairs.len(),1);assert_eq!(pairs["uri"],"server://synthetic/com.plexapp.plugins.library/library/metadata/1,2,1");
                    assert!(request.to_lowercase().contains("x-plex-token: synthetic-token"));
                    stream.write_all(format!("HTTP/1.1 {status} Fixture\r\nContent-Length: 0\r\nLocation: /unexpected\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
                } count
            });
            let mut client=PlexClient::new(PlexClientConfig{base_url:base,token:"synthetic-token".into(),..Default::default()}).unwrap();client.machine_identifier="synthetic".into();
            let outcome=tokio::time::timeout(std::time::Duration::from_secs(10),client.add_items(42,&[1,2,1])).await.unwrap();let _=stop.send(());assert_eq!(server.await.unwrap(),1);
            assert_eq!(outcome.is_ok(),status==200);
        }
    }
}

#[cfg(test)]
impl PlexClient {
    /// Read-only status proof for the ignored manifest-owned live QA cleanup.
    pub(crate) async fn qa_playlist_status_once(&self, id: i64) -> Result<u16> {
        if id <= 0 { anyhow::bail!("Invalid QA playlist ID") }
        let response=self.metadata_mutation_client.get(self.build_endpoint_url(&format!("/playlists/{id}")))
            .header("X-Plex-Token",token_header(&self.token)).header("Accept","application/json")
            .send().await.map_err(|e|e.without_url()).context("QA status proof unavailable")?;
        Ok(response.status().as_u16())
    }
}
