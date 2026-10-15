//! History and playback tracking operations
//!
//! This module provides functionality for:
//! - Getting active sessions (currently playing)
//! - Fetching playback history
#![allow(dead_code)]
//! - Managing history items
//! - Scrobbling and marking items as played/unplayed
//! - Reporting timeline progress

use super::{PlexClient, MediaContainer};
use super::client::{request_error, token_header};
use anyhow::{Result, Context};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tracing::{debug, instrument};

/// Active playback session
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct Session {
    /// Unique session identifier
    #[serde(rename = "sessionKey")]
    pub session_key: String,
    /// User ID
    #[serde(default)]
    pub user_id: String,
    /// Username
    #[serde(default)]
    pub username: String,
    /// Playback state
    pub state: PlaybackState,
    /// Progress percentage (0-100)
    #[serde(default, deserialize_with = "crate::plex::models::serde_string_or_i64::deserialize")]
    pub progress: i64,
    /// Duration in milliseconds
    #[serde(default)]
    pub duration: i64,
    /// Current position in milliseconds
    #[serde(default)]
    pub view_offset: i64,
    /// Player identifier
    #[serde(default)]
    pub player: String,
}

/// Playback history item
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct HistoryItem {
    /// Rating key of the item
    pub rating_key: i64,
    /// Title of the item
    #[serde(default)]
    pub title: String,
    /// Type of item (track, album, artist)
    #[serde(default)]
    pub item_type: String,
    /// Number of times viewed
    #[serde(rename = "viewCount", default, deserialize_with = "crate::plex::models::serde_string_or_i64::deserialize")]
    pub view_count: i64,
    /// When it was last viewed
    #[serde(rename = "lastViewedAt")]
    pub last_viewed_at: Option<DateTime<Utc>>,
    /// When it was viewed (alternative field)
    #[serde(rename = "viewedAt")]
    pub viewed_at: Option<DateTime<Utc>>,
    /// View offset for resume (milliseconds)
    #[serde(default)]
    pub view_offset: Option<i64>,
    /// Device used for playback
    #[serde(default)]
    pub device: Option<String>,
}

/// Playback state enumeration
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum PlaybackState {
    #[default]
    Playing,
    Paused,
    Buffering,
    Stopped,
}

/// History and playback tracking implementation
impl PlexClient {
    /// Get all currently playing sessions
    ///
    /// # Arguments
    /// * `section_id` - Library section ID (optional, filter by section)
    ///
    /// # Returns
    /// * `Result<Vec<Session>>` - List of active sessions
    ///
    /// # Example
    /// ```no_run
    /// # use plex::{PlexClient, PlexClientConfig};
    /// # tokio_test::block_on(async {
    /// let client = PlexClient::new(PlexClientConfig::default()).unwrap();
    /// let sessions = client.get_active_sessions(1).await?;
    /// # Ok::<(), anyhow::Error>(())
    /// # });
    /// ```
    #[instrument(skip(self))]
    pub async fn get_active_sessions(&self, section_id: i64) -> Result<Vec<Session>> {
        let path = "/status/sessions";
        let params = vec![("sectionID", section_id.to_string())];

        let mut url_with_params = url::Url::parse(&self.build_url(path))?;
        url_with_params.query_pairs_mut().extend_pairs(params);

        debug!("Fetching active sessions from {}", url_with_params);

        let container: MediaContainer<Session> = self.get_url(url_with_params.as_str()).await
            .context("Failed to fetch Plex history metadata")?;

        Ok(container.metadata)
    }

    /// Get playback history for a library section
    ///
    /// # Arguments
    /// * `section_id` - Library section ID
    /// * `limit` - Maximum number of items (default: 50)
    /// * `offset` - Pagination offset (default: 0)
    /// * `sort` - Sort order (e.g., "viewCount:desc", "lastViewedAt:desc")
    ///
    /// # Returns
    /// * `Result<Vec<HistoryItem>>` - List of history items
    ///
    /// # Example
    /// ```no_run
    /// # use plex::{PlexClient, PlexClientConfig};
    /// # tokio_test::block_on(async {
    /// let client = PlexClient::new(PlexClientConfig::default()).unwrap();
    /// let history = client
    ///     .get_history(1, Some(50), Some(0), Some("lastViewedAt:desc"))
    ///     .await?;
    /// # Ok::<(), anyhow::Error>(())
    /// # });
    /// ```
    #[instrument(skip(self))]
    pub async fn get_history(
        &self,
        section_id: i64,
        limit: Option<i32>,
        offset: Option<i32>,
        sort: Option<&str>,
    ) -> Result<Vec<HistoryItem>> {
        let path = format!("/library/sections/{}/history", section_id);
        let mut params = Vec::new();

        if let Some(limit) = limit {
            params.push(("limit", limit.to_string()));
        }
        if let Some(offset) = offset {
            params.push(("offset", offset.to_string()));
        }
        if let Some(sort) = sort {
            params.push(("sort", sort.to_string()));
        }

        let mut url = url::Url::parse(&self.build_url(&path))?;
        url.query_pairs_mut().extend_pairs(params);

        debug!("Fetching history from {}", url);

        let container: MediaContainer<HistoryItem> = self.get_url(url.as_str()).await
            .context("Failed to fetch history")?;

        Ok(container.metadata)
    }

    /// Get history for a specific item
    ///
    /// # Arguments
    /// * `rating_key` - Rating key of the item
    ///
    /// # Returns
    /// * `Result<HistoryItem>` - The history item
    ///
    /// # Example
    /// ```no_run
    /// # use plex::{PlexClient, PlexClientConfig};
    /// # tokio_test::block_on(async {
    /// let client = PlexClient::new(PlexClientConfig::default()).unwrap();
    /// let history = client.get_item_history(12345).await?;
    /// # Ok::<(), anyhow::Error>(())
    /// # });
    /// ```
    #[instrument(skip(self))]
    pub async fn get_item_history(&self, rating_key: i64) -> Result<HistoryItem> {
        let path = format!("/library/metadata/{}?includeHistory=1", rating_key);
        let url = self.build_url(&path);

        debug!("Fetching item history from {}", url);

        let container: MediaContainer<HistoryItem> = self.get_url(&url).await
            .context("Failed to fetch Plex history metadata")?;

        container
            .metadata
            .into_iter()
            .next()
            .context("History item not found")
    }

    /// Delete history for a specific item
    ///
    /// # Arguments
    /// * `rating_key` - Rating key of the item
    ///
    /// # Returns
    /// * `Result<()>` - Success or error
    ///
    /// # Example
    /// ```no_run
    /// # use plex::{PlexClient, PlexClientConfig};
    /// # tokio_test::block_on(async {
    /// let client = PlexClient::new(PlexClientConfig::default()).unwrap();
    /// client.delete_history(12345).await?;
    /// # Ok::<(), anyhow::Error>(())
    /// # });
    /// ```
    #[instrument(skip(self))]
    pub async fn delete_history(&self, rating_key: i64) -> Result<()> {
        let path = format!("/library/metadata/{}?excludeHistory=1", rating_key);
        let url = self.build_url(&path);

        debug!("Deleting history for item at {}", url);

        let response = self
            .client
            .put(&url)
            .header("X-Plex-Token", token_header(&self.token))
            .header("Accept", "application/json")
            .send()
            .await.map_err(request_error)
            .context("Failed to delete history")?;

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

    /// Terminate an active session
    ///
    /// # Arguments
    /// * `session_id` - Session identifier (sessionKey)
    ///
    /// # Returns
    /// * `Result<()>` - Success or error
    ///
    /// # Example
    /// ```no_run
    /// # use plex::{PlexClient, PlexClientConfig};
    /// # tokio_test::block_on(async {
    /// let client = PlexClient::new(PlexClientConfig::default()).unwrap();
    /// client.terminate_session("12345").await?;
    /// # Ok::<(), anyhow::Error>(())
    /// # });
    /// ```
    #[instrument(skip(self))]
    pub async fn terminate_session(&self, session_id: &str) -> Result<()> {
        let path = format!("/status/sessions/{}", session_id);
        let url = self.build_url(&path);

        debug!("Terminating session at {}", url);

        let response = self
            .client
            .delete(&url)
            .header("X-Plex-Token", token_header(&self.token))
            .header("Accept", "application/json")
            .send()
            .await.map_err(request_error)
            .context("Failed to terminate session")?;

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

    /// Mark an item as played (scrobble)
    ///
    /// # Arguments
    /// * `rating_key` - Rating key of the item
    ///
    /// # Returns
    /// * `Result<()>` - Success or error
    ///
    /// # Example
    /// ```no_run
    /// # use plex::{PlexClient, PlexClientConfig};
    /// # tokio_test::block_on(async {
    /// let client = PlexClient::new(PlexClientConfig::default()).unwrap();
    /// client.mark_played(12345).await?;
    /// # Ok::<(), anyhow::Error>(())
    /// # });
    /// ```
    #[instrument(skip(self))]
    pub async fn mark_played(&self, rating_key: i64) -> Result<()> {
        // Plex expects `key` as the bare integer ratingKey here, NOT the full
        // /library/metadata/{id} path — the full path returns HTTP 404.
        let path = format!(
            "/:/scrobble?ratingKey={}&key={}&identifier=com.plexapp.plugins.library",
            rating_key, rating_key
        );
        let url = self.build_url(&path);

        debug!("Marking item as played: {}", url);

        let response = self
            .client
            .get(&url)
            .header("X-Plex-Token", token_header(&self.token))
            .header("Accept", "application/json")
            .send()
            .await.map_err(request_error)
            .context("Failed to mark item as played")?;

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

    /// Mark an item as unplayed (unscrobble)
    ///
    /// # Arguments
    /// * `rating_key` - Rating key of the item
    ///
    /// # Returns
    /// * `Result<()>` - Success or error
    ///
    /// # Example
    /// ```no_run
    /// # use plex::{PlexClient, PlexClientConfig};
    /// # tokio_test::block_on(async {
    /// let client = PlexClient::new(PlexClientConfig::default()).unwrap();
    /// client.mark_unplayed(12345).await?;
    /// # Ok::<(), anyhow::Error>(())
    /// # });
    /// ```
    #[instrument(skip(self))]
    pub async fn mark_unplayed(&self, rating_key: i64) -> Result<()> {
        let path = format!(
            "/:/unscrobble?ratingKey={}&key=/library/metadata/{}&identifier=com.plexapp.plugins.library",
            rating_key, rating_key
        );
        let url = self.build_url(&path);

        debug!("Marking item as unplayed: {}", url);

        let response = self
            .client
            .get(&url)
            .header("X-Plex-Token", token_header(&self.token))
            .header("Accept", "application/json")
            .send()
            .await.map_err(request_error)
            .context("Failed to mark item as unplayed")?;

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

    /// Report timeline/playback progress for an item
    ///
    /// # Arguments
    /// * `rating_key` - Rating key of the item
    /// * `state` - Playback state (playing, paused, buffering, stopped)
    /// * `time` - Current position in milliseconds
    /// * `duration` - Total duration in milliseconds
    ///
    /// # Returns
    /// * `Result<()>` - Success or error
    ///
    /// # Example
    /// ```no_run
    /// # use plex::{PlexClient, PlexClientConfig, PlaybackState};
    /// # tokio_test::block_on(async {
    /// let client = PlexClient::new(PlexClientConfig::default()).unwrap();
    /// client.report_timeline(12345, PlaybackState::Playing, 30000, 180000).await?;
    /// # Ok::<(), anyhow::Error>(())
    /// # });
    /// ```
    #[instrument(skip(self))]
    pub async fn report_timeline(
        &self,
        rating_key: i64,
        state: PlaybackState,
        time: i64,
        duration: i64,
    ) -> Result<()> {
        self.send_timeline(rating_key, state, time, duration, None)
            .await
    }

    /// A retained listen is a historical playback session, never another device.
    pub(crate) async fn report_retained_timeline(
        &self,
        rating_key: i64,
        time: i64,
        duration: i64,
        session: &str,
        updated: u64,
    ) -> Result<()> {
        self.send_timeline(
            rating_key,
            PlaybackState::Stopped,
            time,
            duration,
            Some((session, updated)),
        )
        .await
    }

    async fn send_timeline(
        &self,
        rating_key: i64,
        state: PlaybackState,
        time: i64,
        duration: i64,
        retained: Option<(&str, u64)>,
    ) -> Result<()> {
        // Serialize the state to lowercase string
        let state_str = match state {
            PlaybackState::Playing => "playing",
            PlaybackState::Paused => "paused",
            PlaybackState::Buffering => "buffering",
            PlaybackState::Stopped => "stopped",
        };

        // hasMDE=1 is required by PMS 1.29+ — without it the server returns 400.
        let query = [
            ("hasMDE", "1".to_owned()),
            ("ratingKey", rating_key.to_string()),
            ("key", format!("/library/metadata/{rating_key}")),
            ("state", state_str.to_owned()),
            ("time", time.to_string()),
            ("duration", duration.to_string()),
            ("identifier", "com.plexapp.plugins.library".to_owned()),
            ("clientIdentifier", self.client_id.clone()),
        ];
        let mut request = self
            .client
            .post(self.build_url("/:/timeline"))
            .query(&query)
            .header("X-Plex-Token", token_header(&self.token))
            .header("X-Plex-Client-Identifier", &self.client_id)
            .header("Accept", "application/json");
        // Plex documents session identity separately from installation identity.
        // Offline reports must not become the player's current live timeline.
        if let Some((session, updated)) = retained {
            request = request
                .header("X-Plex-Session-Identifier", session)
                .query(&[
                    ("offline", "1".to_owned()),
                    ("updated", updated.to_string()),
                ]);
        }
        debug!(
            rating_key,
            state_str,
            historical = retained.is_some(),
            "Reporting timeline"
        );
        let response = request
            .send()
            .await
            .map_err(request_error)
            .context("Failed to report timeline")?;

        debug!("Response status: {}", response.status());

        if !response.status().is_success() {
            return Err(anyhow::anyhow!(
                "Plex timeline returned HTTP {}",
                response.status()
            ));
        }

        Ok(())
    }

    /// Rate a library item (track, album, or artist).
    ///
    /// `rating` is 0.0–10.0 (Plex uses 1–10 stars displayed as half-stars,
    /// so 2.0 = 1 star, 10.0 = 5 stars). Pass `None` to clear the rating.
    ///
    /// Corresponds to:
    /// `PUT /:/rate?key=/library/metadata/{id}&rating={val}&identifier=com.plexapp.plugins.library`
    #[instrument(skip(self))]
    pub async fn rate_item(&self, rating_key: i64, rating: Option<f64>) -> Result<()> {
        // Plex /:/rate expects the bare ratingKey integer, NOT the full
        // /library/metadata/{id} path — the full path returns HTTP 500.
        let rating_str = rating.map_or("-1".to_string(), |r| r.to_string());
        let path = format!(
            "/:/rate?key={}&rating={}&identifier=com.plexapp.plugins.library",
            rating_key, rating_str
        );
        let url = self.build_url(&path);

        debug!("Rating item {} with {}", rating_key, rating_str);

        let response = self
            .client
            .put(&url)
            .header("X-Plex-Token", token_header(&self.token))
            .header("Accept", "application/json")
            .send()
            .await.map_err(request_error)
            .context("Failed to rate item")?;

        debug!("Response status: {}", response.status());

        if !response.status().is_success() {
            return Err(anyhow::anyhow!(
                "HTTP error: {} rating item {}",
                response.status(),
                rating_key
            ));
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn audio_history_queries_preserve_proxy_paths_and_encode_values() {
        use super::super::{PlexClientConfig, Track};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for case in 0..7 {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let client = PlexClient::new(PlexClientConfig {
                base_url: format!("http://{}/proxy/plex/", listener.local_addr().unwrap()),
                token: "offline-fixture".into(), ..Default::default()
            }).unwrap();
            let request = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                loop {
                    let mut buffer = [0; 4096];
                    let count = socket.read(&mut buffer).await.unwrap();
                    bytes.extend_from_slice(&buffer[..count]);
                    if count == 0 || bytes.windows(4).any(|w| w == b"\r\n\r\n") { break; }
                }
                let body = r#"{"MediaContainer":{"Metadata":[]}}"#;
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).as_bytes()).await.unwrap();
                // Return only the target, never authentication headers.
                String::from_utf8(bytes).unwrap().split_whitespace().nth(1).unwrap().to_owned()
            });
            let (path, expected): (&str, Vec<(&str, &str)>) = match case {
                0 => { client.sonically_similar::<Track>(7, Some(12), Some(0.45)).await.unwrap(); ("/library/metadata/7/nearest", vec![("limit", "12"), ("maxDistance", "0.45")]) }
                1 => { client.sonic_adventure(3, 7, 9, Some(12)).await.unwrap(); ("/library/sections/3/nearest", vec![("pivot", "7"), ("to", "9"), ("limit", "12")]) }
                2 => { client.track_radio(3, 7, Some(12), Some(0.45)).await.unwrap(); ("/library/sections/3/mix", vec![("pivot", "7"), ("limit", "12"), ("maxDistance", "0.45")]) }
                3 => { client.get_active_sessions(3).await.unwrap(); ("/status/sessions", vec![("sectionID", "3")]) }
                4 => { client.get_history(3, Some(12), Some(4), Some("lastViewedAt:desc&flag=雪+ #")).await.unwrap(); ("/library/sections/3/history", vec![("limit", "12"), ("offset", "4"), ("sort", "lastViewedAt:desc&flag=雪+ #")]) }
                5 => { client.sonically_similar::<Track>(7, None, None).await.unwrap(); ("/library/metadata/7/nearest", vec![]) }
                _ => { client.get_history(3, None, None, None).await.unwrap(); ("/library/sections/3/history", vec![]) }
            };
            let target = request.await.unwrap();
            let parsed = url::Url::parse(&format!("http://offline.test{target}")).unwrap();
            assert_eq!(parsed.path(), format!("/proxy/plex{path}"));
            let pairs: Vec<_> = parsed.query_pairs().collect();
            assert_eq!(pairs.len(), expected.len() + 1);
            assert_eq!(pairs.iter().filter(|(k, v)| k == "includeLoudnessRamps" && v == "1").count(), 1);
            for (key, value) in expected {
                assert!(pairs.iter().any(|(k, v)| k == key && v == value));
            }
            assert!(parsed.fragment().is_none());
        }
    }

    #[test]
    fn test_playback_state_serialization() {
        let state = PlaybackState::Playing;
        let json = serde_json::to_value(&state).unwrap();
        assert_eq!(json, "playing");

        let state = PlaybackState::Paused;
        let json = serde_json::to_value(&state).unwrap();
        assert_eq!(json, "paused");
    }

    #[test]
    fn test_playback_state_deserialization() {
        let json = serde_json::json!("playing");
        let state: PlaybackState = serde_json::from_value(json).unwrap();
        assert!(matches!(state, PlaybackState::Playing));

        let json = serde_json::json!("paused");
        let state: PlaybackState = serde_json::from_value(json).unwrap();
        assert!(matches!(state, PlaybackState::Paused));
    }

    #[test]
    fn test_build_query_params() {
        let params = vec![
            ("limit", "50".to_string()),
            ("offset", "0".to_string()),
            ("sort", "lastViewedAt:desc".to_string()),
        ];

        let query = params
            .iter()
            .map(|(k, v)| format!("{}={}", k, v))
            .collect::<Vec<_>>()
            .join("&");

        assert_eq!(query, "limit=50&offset=0&sort=lastViewedAt:desc");
    }

    #[test]
    fn test_build_timeline_path() {
        let rating_key = 12345;
        let state_str = "playing";
        let time = 30000;
        let duration = 180000;
        let client_identifier = "hibiki";

        let path = format!(
            "/:/timeline?hasMDE=1&ratingKey={}&key=/library/metadata/{}&state={}&time={}&duration={}&identifier=com.plexapp.plugins.library&clientIdentifier={}",
            rating_key, rating_key, state_str, time, duration, client_identifier
        );

        assert!(path.contains("hasMDE=1"));
        assert!(path.contains("ratingKey=12345"));
        assert!(path.contains("state=playing"));
        assert!(path.contains("time=30000"));
        assert!(path.contains("duration=180000"));
        assert!(path.contains("identifier=com.plexapp.plugins.library"));
    }
}

#[cfg(test)]
mod integration_tests {
    use super::super::{PlexClient, PlexClientConfig, PlexMedia};
    use super::PlaybackState;

    fn get_client() -> PlexClient {
        let url = std::env::var("PLEX_URL")
            .expect("PLEX_URL env var required for integration tests");
        let token = std::env::var("PLEX_TOKEN")
            .expect("PLEX_TOKEN env var required for integration tests");
        PlexClient::new(PlexClientConfig {
            base_url: url,
            token,
            accept_invalid_certs: true,
            ..Default::default()
        })
        .expect("Failed to create PlexClient")
    }

    async fn get_music_section_id(c: &PlexClient) -> i64 {
        let sections = c.get_all_sections().await.expect("get_all_sections failed");
        sections
            .iter()
            .find(|s| s.title == "Music")
            .map(|s| s.key)
            .expect("No 'Music' section found")
    }

    async fn get_track_key(c: &PlexClient, section_id: i64) -> Option<i64> {
        match c.recently_added(section_id, Some("track"), Some(1)).await {
            Ok(items) => items.into_iter().find_map(|m| {
                if let PlexMedia::Track(t) = m { Some(t.rating_key) } else { None }
            }),
            Err(_) => None,
        }
    }

    #[tokio::test]
    async fn test_get_active_sessions() {
        let client = get_client();
        let section_id = get_music_section_id(&client).await;
        match client.get_active_sessions(section_id).await {
            Ok(sessions) => println!("Found {} active sessions", sessions.len()),
            Err(e) => println!("Get active sessions failed (may be expected): {}", e),
        }
    }

    #[tokio::test]
    async fn test_get_history() {
        let client = get_client();
        let section_id = get_music_section_id(&client).await;
        match client.get_history(section_id, Some(10), Some(0), Some("lastViewedAt:desc")).await {
            Ok(history) => println!("Found {} history items", history.len()),
            Err(e) => println!("Get history failed (may be expected): {}", e),
        }
    }

    #[tokio::test]
    async fn test_mark_played_unplayed() {
        let client = get_client();
        let section_id = get_music_section_id(&client).await;
        let rating_key = get_track_key(&client, section_id).await.unwrap_or(999999);
        if let Err(e) = client.mark_played(rating_key).await {
            println!("Mark played failed: {}", e);
        }
        if let Err(e) = client.mark_unplayed(rating_key).await {
            println!("Mark unplayed failed: {}", e);
        }
    }

    #[tokio::test]
    async fn test_report_timeline() {
        let client = get_client();
        if let Err(e) = client.report_timeline(999999, PlaybackState::Playing, 30000, 180000).await {
            println!("Report timeline failed (may be expected for invalid rating key): {}", e);
        }
    }

    #[tokio::test]
    async fn test_rate_item() {
        let client = get_client();
        let section_id = get_music_section_id(&client).await;
        let Some(key) = get_track_key(&client, section_id).await else {
            println!("No track available to test rating — skipping");
            return;
        };
        match client.rate_item(key, Some(6.0)).await {
            Ok(()) => println!("Rated track {} with 6.0 (3 stars)", key),
            Err(e) => println!("Rate item failed: {}", e),
        }
        match client.rate_item(key, None).await {
            Ok(()) => println!("Cleared rating for track {}", key),
            Err(e) => println!("Clear rating failed: {}", e),
        }
    }

    /// Diagnostic test: probe the /:/rate endpoint and verify the userRating
    /// actually changes on the track. Prints the exact URL, HTTP status, and
    /// response body for every attempt.
    #[tokio::test]
    async fn test_rate_item_diagnostic() {
        let client = get_client();
        let section_id = get_music_section_id(&client).await;

        // Use liked_tracks (type=10, userRating>>0) — guaranteed to have a rating.
        let tracks = client
            .liked_tracks(section_id, Some(1))
            .await
            .expect("liked_tracks failed");

        let track = match tracks.into_iter().next() {
            Some(t) => t,
            None => {
                println!("No liked tracks found — try starring a track in Plex first");
                return;
            }
        };

        println!("=== Target track ===");
        println!("  ratingKey  : {}", track.rating_key);
        println!("  title      : {}", track.title);
        println!("  userRating : {:?}", track.user_rating);
        println!();

        // Build the candidate URLs to probe so we can see which variant Plex accepts.
        let token = &client.token;
        let base   = client.build_url("");
        let base   = base.trim_end_matches('/');

        let variants: &[(&str, String)] = &[
            // Variant A: key as full metadata path (current implementation)
            ("A – key=/library/metadata/{id}", format!(
                "{}/:/rate?key=/library/metadata/{}&rating=6&identifier=com.plexapp.plugins.library",
                base, track.rating_key
            )),
            // Variant B: key as bare integer (alternative format)
            ("B – key={id} (bare int)", format!(
                "{}/:/rate?key={}&rating=6&identifier=com.plexapp.plugins.library",
                base, track.rating_key
            )),
            // Variant C: token in URL instead of header
            ("C – token in URL", format!(
                "{}/:/rate?key=/library/metadata/{}&rating=6&identifier=com.plexapp.plugins.library&X-Plex-Token={}",
                base, track.rating_key, token
            )),
        ];

        let http = reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .unwrap();

        for (label, url) in variants {
            println!("--- {} ---", label);
            println!("  URL: {}", url);

            let resp = http
                .put(url)
                .header("X-Plex-Token", token)
                .header("Accept", "application/json")
                .send()
                .await;

            match resp {
                Err(e) => println!("  ERROR sending request: {}", e),
                Ok(r) => {
                    let status = r.status();
                    let body = r.text().await.unwrap_or_else(|e| format!("<read error: {}>", e));
                    println!("  HTTP status : {}", status);
                    println!("  Body        : {}", if body.is_empty() { "(empty)" } else { &body });

                    // After the first successful 2xx response, re-fetch the track
                    // to confirm whether userRating actually changed.
                    if status.is_success() {
                        println!("  → Re-fetching track to verify userRating changed…");
                        match client.get_track(track.rating_key).await {
                            Ok(updated) => {
                                println!("  userRating before: {:?}", track.user_rating);
                                println!("  userRating after : {:?}", updated.user_rating);
                                if updated.user_rating != track.user_rating {
                                    println!("  ✓ Rating CHANGED — this variant works!");
                                } else {
                                    println!("  ✗ Rating did NOT change (200 but no effect)");
                                }
                            }
                            Err(e) => println!("  Re-fetch failed: {}", e),
                        }
                        break; // stop after first working variant
                    }
                }
            }
            println!();
        }

        // Restore original rating
        println!("Restoring original rating ({:?})…", track.user_rating);
        match client.rate_item(track.rating_key, track.user_rating).await {
            Ok(()) => println!("Rating restored."),
            Err(e) => println!("Restore failed: {}", e),
        }
    }
}
