//! Plex API HTTP client with retry logic and connection pooling
#![allow(dead_code)]

use reqwest::header::{HeaderMap, HeaderValue};
use reqwest_middleware::{ClientBuilder, ClientWithMiddleware};
use reqwest_retry::RetryTransientMiddleware;
use reqwest_retry::policies::ExponentialBackoff;
use serde::de::DeserializeOwned;
use anyhow::{Result, Context};
use tracing::{debug, instrument};

use crate::plex::models::PlexApiResponse;

const PRODUCT_NAME: &str = "Plexify";
const PRODUCT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Configuration for the PlexClient
#[derive(Debug, Clone)]
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
            client_id: String::from("plexify-client"),
            max_connections: 100,
            debug: false,
            accept_invalid_certs: false,
        }
    }
}

/// Plex API client with retry logic and connection pooling
#[derive(Debug, Clone)]
pub struct PlexClient {
    base_url: String,
    pub token: String,
    pub client_id: String,
    pub client: ClientWithMiddleware,
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

        // Build HTTP client
        let client = reqwest::Client::builder()
            .pool_max_idle_per_host(config.max_connections)
            // 120s: smart playlists with 100k+ tracks can take a long time to
            // evaluate server-side even with correct pagination params.
            .timeout(std::time::Duration::from_secs(120))
            .danger_accept_invalid_certs(config.accept_invalid_certs)
            .default_headers(default_headers)
            .build()
            .context("Failed to build HTTP client")?;

        // Add middleware
        let client = ClientBuilder::new(client)
            .with(retry_middleware)
            .build();

        Ok(Self {
            base_url: config.base_url,
            token: config.token,
            client_id: config.client_id,
            client,
        })
    }

    /// Perform a GET request and deserialize the JSON response.
    ///
    /// Plex wraps every response in `{"MediaContainer": <T>}`. This method
    /// automatically unwraps that envelope and returns the inner value.
    ///
    /// # Arguments
    /// * `path` - API path (e.g., "/library/sections")
    #[instrument(skip(self))]
    pub async fn get<T>(&self, path: &str) -> Result<T>
    where
        T: DeserializeOwned,
    {
        let url = self.build_url(path);
        debug!("GET request to {}", url);

        let response = self
            .client
            .get(&url)
            .header("X-Plex-Token", &self.token)
            .header("Accept", "application/json")
            .send()
            .await
            .context("GET request failed")?;

        debug!("Response status: {}", response.status());

        if !response.status().is_success() {
            return Err(anyhow::anyhow!(
                "HTTP error: {} for URL: {}",
                response.status(),
                url
            ));
        }

        let wrapper = response
            .json::<PlexApiResponse<T>>()
            .await
            .context("Failed to parse JSON response")?;

        Ok(wrapper.container)
    }

    /// Fetch raw response text — for non-JSON endpoints (e.g., TTML/LRC lyrics).
    pub async fn get_text(&self, path: &str) -> Result<String> {
        let url = self.build_url(path);
        let response = self.client.get(&url)
            .header("X-Plex-Token", &self.token)
            .send().await.context("GET request failed")?;
        if !response.status().is_success() {
            return Err(anyhow::anyhow!("HTTP error: {} for URL: {}", response.status(), url));
        }
        response.text().await.context("Failed to read response text")
    }

    /// Fetch raw response text — for debugging API responses in tests.
    #[cfg(test)]
    pub async fn get_raw(&self, path: &str) -> Result<String> {
        let url = self.build_url(path);
        let response = self.client.get(&url)
            .header("X-Plex-Token", &self.token)
            .header("Accept", "application/json")
            .send().await.context("GET request failed")?;
        response.text().await.context("Failed to read response text")
    }

    /// Perform a POST request with a JSON body.
    ///
    /// Automatically unwraps the Plex `{"MediaContainer": <T>}` envelope.
    #[instrument(skip(self, body))]
    pub async fn post<T>(&self, path: &str, body: serde_json::Value) -> Result<T>
    where
        T: DeserializeOwned,
    {
        let url = self.build_url(path);
        debug!("POST request to {}", url);

        let response = self
            .client
            .post(&url)
            .header("X-Plex-Token", &self.token)
            .header("Accept", "application/json")
            .json(&body)
            .send()
            .await
            .context("POST request failed")?;

        debug!("Response status: {}", response.status());

        if !response.status().is_success() {
            return Err(anyhow::anyhow!(
                "HTTP error: {} for URL: {}",
                response.status(),
                url
            ));
        }

        let wrapper = response
            .json::<PlexApiResponse<T>>()
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
    #[instrument(skip(self, body))]
    pub async fn put<T>(&self, path: &str, body: serde_json::Value) -> Result<T>
    where
        T: DeserializeOwned,
    {
        let url = self.build_url(path);
        debug!("PUT request to {}", url);
        debug!("Request body: {}", body);

        let response = self
            .client
            .put(&url)
            .header("X-Plex-Token", &self.token)
            .header("Accept", "application/json")
            .json(&body)
            .send()
            .await
            .context("PUT request failed")?;

        debug!("Response status: {}", response.status());

        if !response.status().is_success() {
            return Err(anyhow::anyhow!(
                "HTTP error: {} for URL: {}",
                response.status(),
                url
            ));
        }

        let json = response
            .json::<T>()
            .await
            .context("Failed to parse JSON response")?;

        Ok(json)
    }

    /// Perform a DELETE request
    ///
    /// # Arguments
    /// * `path` - API path
    ///
    /// # Returns
    /// * `Result<()>` - Success or an error
    #[instrument(skip(self))]
    pub async fn delete(&self, path: &str) -> Result<()> {
        let url = self.build_url(path);
        debug!("DELETE request to {}", url);

        let response = self
            .client
            .delete(&url)
            .header("X-Plex-Token", &self.token)
            .header("Accept", "application/json")
            .send()
            .await
            .context("DELETE request failed")?;

        debug!("Response status: {}", response.status());

        if !response.status().is_success() {
            return Err(anyhow::anyhow!(
                "HTTP error: {} for URL: {}",
                response.status(),
                url
            ));
        }

        Ok(())
    }

    /// Perform a GET request against a pre-built full URL (no `build_url` call).
    ///
    /// Use this when you already have the complete URL including query params.
    /// Like `get()`, automatically unwraps the Plex `{"MediaContainer": <T>}` envelope.
    #[instrument(skip(self))]
    pub async fn get_url<T>(&self, url: &str) -> Result<T>
    where
        T: DeserializeOwned,
    {
        debug!("GET request to {}", url);

        let response = self
            .client
            .get(url)
            .header("X-Plex-Token", &self.token)
            .header("Accept", "application/json")
            .send()
            .await
            .context("GET request failed")?;

        debug!("Response status: {}", response.status());

        if !response.status().is_success() {
            return Err(anyhow::anyhow!(
                "HTTP error: {} for URL: {}",
                response.status(),
                url
            ));
        }

        let wrapper = response
            .json::<PlexApiResponse<T>>()
            .await
            .context("Failed to parse JSON response")?;

        Ok(wrapper.container)
    }

    /// Perform a PUT request against a pre-built full URL (no `build_url` call).
    ///
    /// Use this when the URL already contains query params (e.g. `?after=N`).
    #[instrument(skip(self, body))]
    pub async fn put_url<T>(&self, url: &str, body: serde_json::Value) -> Result<T>
    where
        T: DeserializeOwned,
    {
        debug!("PUT request to {}", url);

        let response = self
            .client
            .put(url)
            .header("X-Plex-Token", &self.token)
            .header("Accept", "application/json")
            .json(&body)
            .send()
            .await
            .context("PUT request failed")?;

        debug!("Response status: {}", response.status());

        if !response.status().is_success() {
            return Err(anyhow::anyhow!(
                "HTTP error: {} for URL: {}",
                response.status(),
                url
            ));
        }

        response
            .json::<T>()
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
        let base = self.base_url.trim_end_matches('/');
        let path = path.trim_start_matches('/');
        format!("{}/{}", base, path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_url() {
        let client = PlexClient::new(PlexClientConfig {
            base_url: "http://localhost:32400".to_string(),
            token: "test-token".to_string(),
            ..Default::default()
        }).unwrap();

        assert_eq!(client.build_url("/library/sections"), "http://localhost:32400/library/sections");
        assert_eq!(client.build_url("library/sections"), "http://localhost:32400/library/sections");
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
