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

        let query = params
            .iter()
            .map(|(k, v)| format!("{}={}", k, v))
            .collect::<Vec<_>>()
            .join("&");

        let url_with_params = format!("{}?{}", self.build_url(path), query);

        debug!("Fetching active sessions from {}", url_with_params);

        let response = self
            .client
            .get(&url_with_params)
            .header("X-Plex-Token", &self.token)
            .header("Accept", "application/json")
            .send()
            .await
            .context("Failed to fetch active sessions")?;

        debug!("Response status: {}", response.status());

        if !response.status().is_success() {
            return Err(anyhow::anyhow!(
                "HTTP error: {} for URL: {}",
                response.status(),
                url_with_params
            ));
        }

        let container: MediaContainer<Session> = response
            .json()
            .await
            .context("Failed to parse active sessions response")?;

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

        let url = if params.is_empty() {
            self.build_url(&path)
        } else {
            let query = params
                .iter()
                .map(|(k, v)| format!("{}={}", k, v))
                .collect::<Vec<_>>()
                .join("&");
            format!("{}?{}", self.build_url(&path), query)
        };

        debug!("Fetching history from {}", url);

        let container: MediaContainer<HistoryItem> = self.get_url(&url).await
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

        let response = self
            .client
            .get(&url)
            .header("X-Plex-Token", &self.token)
            .header("Accept", "application/json")
            .send()
            .await
            .context("Failed to fetch item history")?;

        debug!("Response status: {}", response.status());

        if !response.status().is_success() {
            return Err(anyhow::anyhow!(
                "HTTP error: {} for URL: {}",
                response.status(),
                url
            ));
        }

        let container: MediaContainer<HistoryItem> = response
            .json()
            .await
            .context("Failed to parse item history response")?;

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
            .header("X-Plex-Token", &self.token)
            .header("Accept", "application/json")
            .send()
            .await
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
            .header("X-Plex-Token", &self.token)
            .header("Accept", "application/json")
            .send()
            .await
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
            .header("X-Plex-Token", &self.token)
            .header("Accept", "application/json")
            .send()
            .await
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
            .header("X-Plex-Token", &self.token)
            .header("Accept", "application/json")
            .send()
            .await
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
    /// * `client_id` - Client identifier (optional, defaults to "plexify")
    ///
    /// # Returns
    /// * `Result<()>` - Success or error
    ///
    /// # Example
    /// ```no_run
    /// # use plex::{PlexClient, PlexClientConfig, PlaybackState};
    /// # tokio_test::block_on(async {
    /// let client = PlexClient::new(PlexClientConfig::default()).unwrap();
    /// client.report_timeline(12345, PlaybackState::Playing, 30000, 180000, None).await?;
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
        client_id: Option<&str>,
    ) -> Result<()> {
        let client_identifier = client_id.unwrap_or("plexify");

        // Serialize the state to lowercase string
        let state_str = match state {
            PlaybackState::Playing => "playing",
            PlaybackState::Paused => "paused",
            PlaybackState::Buffering => "buffering",
            PlaybackState::Stopped => "stopped",
        };

        // hasMDE=1 is required by PMS 1.29+ — without it the server returns 400.
        let path = format!(
            "/:/timeline?hasMDE=1&ratingKey={}&key=/library/metadata/{}&state={}&time={}&duration={}&identifier=com.plexapp.plugins.library&clientIdentifier={}",
            rating_key, rating_key, state_str, time, duration, client_identifier
        );
        let url = self.build_url(&path);

        debug!("Reporting timeline: {}", url);

        let response = self
            .client
            .get(&url)
            .header("X-Plex-Token", &self.token)
            .header("X-Plex-Client-Identifier", client_identifier)
            .header("Accept", "application/json")
            .send()
            .await
            .context("Failed to report timeline")?;

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
            .header("X-Plex-Token", &self.token)
            .header("Accept", "application/json")
            .send()
            .await
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
        let client_identifier = "plexify";

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
        if let Err(e) = client.report_timeline(999999, PlaybackState::Playing, 30000, 180000, None).await {
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
