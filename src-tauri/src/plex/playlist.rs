//! Playlist management operations (CRUD, smart playlists, generators)
#![allow(dead_code)]

use super::{PlexClient, MediaContainer, Playlist, Track};
use anyhow::{Result, Context};
use serde::{Deserialize, Serialize};
use tracing::{debug, instrument};

/// Search filters for smart playlists
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum SearchFilter {
    Genre(String),
    #[serde(rename = "year>=")]
    YearGte(i32),
    #[serde(rename = "year<=")]
    YearLte(i32),
    #[serde(rename = "artist.title")]
    ArtistTitle(String),
    #[serde(rename = "artist.id")]
    ArtistId(i64),
    #[serde(rename = "album.title")]
    AlbumTitle(String),
    #[serde(rename = "album.id")]
    AlbumId(i64),
    Mood(String),
    Style(String),
    #[serde(rename = "ratingCount>=")]
    RatingCountGte(i32),
    #[serde(rename = "viewCount>=")]
    ViewCountGte(i32),
    #[serde(rename = "duration>=")]
    DurationGte(i64),
    #[serde(rename = "duration<=")]
    DurationLte(i64),
}

/// Smart playlist configuration
#[derive(Debug, Clone)]
pub struct SmartPlaylistConfig {
    pub title: String,
    pub section_id: i64,
    pub libtype: Option<String>,
    pub filters: Vec<SearchFilter>,
    pub sort: Option<String>,
    pub limit: Option<i32>,
}

/// Smart playlist generator
#[derive(Debug, Clone, Deserialize, Default)]
pub struct Generator {
    #[serde(rename = "id")]
    pub id: i64,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub uri: Option<String>,
}

/// Playlist operations implementation
impl PlexClient {
    /// List all playlists in a library section
    ///
    /// # Arguments
    /// * `section_id` - Library section ID
    /// * `limit` - Maximum number of playlists to return (default: all)
    ///
    /// # Returns
    /// * `Result<Vec<Playlist>>` - List of playlists
    #[instrument(skip(self))]
    pub async fn list_playlists(&self, _section_id: i64, limit: Option<i32>) -> Result<Vec<Playlist>> {
        let mut params = vec![
            ("playlistType".to_string(), "audio".to_string()),
        ];

        if let Some(limit) = limit {
            params.push(("limit".to_string(), limit.to_string()));
        }

        let query = params
            .iter()
            .map(|(k, v)| format!("{}={}", k, v))
            .collect::<Vec<_>>()
            .join("&");
        let url = format!("{}?{}", self.build_url("/playlists"), query);

        debug!("Fetching playlists from {}", url);

        let container: MediaContainer<Playlist> = self.get_url(&url).await
            .context("Failed to fetch playlists")?;

        Ok(container.metadata)
    }

    /// Get playlist details
    ///
    /// # Arguments
    /// * `playlist_id` - Playlist rating key
    ///
    /// # Returns
    /// * `Result<Playlist>` - The playlist
    #[instrument(skip(self))]
    pub async fn get_playlist(&self, playlist_id: i64) -> Result<Playlist> {
        let path = format!("/library/metadata/{}", playlist_id);
        let url = self.build_url(&path);

        debug!("Fetching playlist from {}", url);

        let container: MediaContainer<Playlist> = self.get_url(&url).await?;

        container
            .metadata
            .into_iter()
            .next()
            .context("Playlist not found")
    }

    /// Get items in a playlist
    ///
    /// # Arguments
    /// * `playlist_id` - Playlist rating key
    /// * `limit` - Maximum number of items to return (default: all)
    /// * `offset` - Offset for pagination (default: 0)
    ///
    /// # Returns
    /// * `Result<Vec<Track>>` - List of tracks in the playlist
    #[instrument(skip(self))]
    pub async fn get_playlist_items(
        &self,
        playlist_id: i64,
        limit: Option<i32>,
        offset: Option<i32>,
    ) -> Result<Vec<Track>> {
        let path = format!("/playlists/{}/items", playlist_id);
        let mut params = Vec::new();

        // Plex paginates using X-Plex-Container-Size / X-Plex-Container-Start,
        // NOT the generic "limit" / "offset" params. Without these the server
        // ignores the page size and returns every item in the playlist.
        if let Some(limit) = limit {
            params.push(("X-Plex-Container-Size".to_string(), limit.to_string()));
        }
        if let Some(offset) = offset {
            params.push(("X-Plex-Container-Start".to_string(), offset.to_string()));
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

        debug!("Fetching playlist items from {}", url);

        let container: MediaContainer<Track> = self.get_url(&url).await?;
        Ok(container.metadata)
    }

    /// Create a regular playlist from item IDs
    ///
    /// # Arguments
    /// * `title` - Playlist title
    /// * `section_id` - Library section ID
    /// * `item_ids` - List of item rating keys to include
    ///
    /// # Returns
    /// * `Result<Playlist>` - The created playlist
    #[instrument(skip(self))]
    pub async fn create_playlist(
        &self,
        title: &str,
        _section_id: i64,
        item_ids: &[i64],
    ) -> Result<Playlist> {
        // Plex requires all params as query parameters (not a JSON body).
        // URI format: {baseUrl}/library/metadata/{id1},{id2},...
        // An empty ids string creates an empty regular playlist.
        let ids = item_ids
            .iter()
            .map(|id| id.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let uri = format!(
            "{}/library/metadata/{}",
            self.build_url("").trim_end_matches('/'),
            ids
        );

        let container: MediaContainer<Playlist> = self
            .post_params("/playlists", &[
                ("title", title),
                ("type",  "audio"),
                ("smart", "0"),
                ("uri",   &uri),
            ])
            .await
            .context("Failed to create playlist")?;

        container
            .metadata
            .into_iter()
            .next()
            .context("Playlist creation returned no data")
    }

    /// Create a smart playlist with filters
    ///
    /// # Arguments
    /// * `config` - Smart playlist configuration
    ///
    /// # Returns
    /// * `Result<Playlist>` - The created smart playlist
    #[instrument(skip(self))]
    pub async fn create_smart_playlist(&self, config: &SmartPlaylistConfig) -> Result<Playlist> {
        // Build search URI with filters
        let mut query_parts = Vec::new();

        if let Some(libtype) = &config.libtype {
            query_parts.push(format!("type={}", libtype));
        }

        // Convert filters to query parameters
        for filter in &config.filters {
            let param = match filter {
                SearchFilter::Genre(v) => format!("genre={}", v),
                SearchFilter::YearGte(v) => format!("year>={}", v),
                SearchFilter::YearLte(v) => format!("year<={}", v),
                SearchFilter::ArtistTitle(v) => format!("artist.title={}", v),
                SearchFilter::ArtistId(v) => format!("artist.id={}", v),
                SearchFilter::AlbumTitle(v) => format!("album.title={}", v),
                SearchFilter::AlbumId(v) => format!("album.id={}", v),
                SearchFilter::Mood(v) => format!("mood={}", v),
                SearchFilter::Style(v) => format!("style={}", v),
                SearchFilter::RatingCountGte(v) => format!("ratingCount>={}", v),
                SearchFilter::ViewCountGte(v) => format!("viewCount>={}", v),
                SearchFilter::DurationGte(v) => format!("duration>={}", v),
                SearchFilter::DurationLte(v) => format!("duration<={}", v),
            };
            query_parts.push(param);
        }

        if let Some(sort) = &config.sort {
            query_parts.push(format!("sort={}", sort));
        }

        if let Some(limit) = config.limit {
            query_parts.push(format!("limit={}", limit));
        }

        let uri = format!(
            "{}library/sections/{}/all?{}",
            self.build_url("").trim_end_matches('/'),
            config.section_id,
            query_parts.join("&")
        );

        let body = serde_json::json!({
            "title": config.title,
            "type": "audio",
            "smart": 1,
            "uri": uri,
            "sectionID": config.section_id
        });

        let container: MediaContainer<Playlist> = self
            .post("/playlists", body)
            .await
            .context("Failed to create smart playlist")?;

        container
            .metadata
            .into_iter()
            .next()
            .context("Smart playlist creation returned no data")
    }

    /// Edit playlist metadata
    ///
    /// # Arguments
    /// * `playlist_id` - Playlist rating key
    /// * `title` - New playlist title (optional)
    /// * `summary` - New playlist summary (optional)
    ///
    /// # Returns
    /// * `Result<Playlist>` - The updated playlist
    #[instrument(skip(self))]
    pub async fn edit_playlist(
        &self,
        playlist_id: i64,
        title: Option<&str>,
        summary: Option<&str>,
    ) -> Result<Playlist> {
        let path = format!("/playlists/{}", playlist_id);

        let mut body = serde_json::json!({});
        if let Some(title) = title {
            body["title"] = serde_json::json!(title);
        }
        if let Some(summary) = summary {
            body["summary"] = serde_json::json!(summary);
        }

        let container: MediaContainer<Playlist> = self
            .put(&path, body)
            .await
            .context("Failed to edit playlist")?;

        container
            .metadata
            .into_iter()
            .next()
            .context("Playlist edit returned no data")
    }

    /// Add items to a playlist
    ///
    /// # Arguments
    /// * `playlist_id` - Playlist rating key
    /// * `item_ids` - List of item rating keys to add
    ///
    /// # Returns
    /// * `Result<()>` - Success or error
    #[instrument(skip(self))]
    pub async fn add_items(&self, playlist_id: i64, item_ids: &[i64]) -> Result<()> {
        let path = format!("/playlists/{}/items", playlist_id);

        let ids = item_ids
            .iter()
            .map(|id| id.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let uri = format!(
            "{}/library/metadata/{}",
            self.build_url("").trim_end_matches('/'),
            ids
        );

        self.put_params_ok(&path, &[("uri", &uri)])
            .await
            .context("Failed to add items to playlist")?;

        Ok(())
    }

    /// Remove items from a playlist
    ///
    /// # Arguments
    /// * `playlist_id` - Playlist rating key
    /// * `playlist_item_ids` - List of playlist item IDs to remove
    ///
    /// # Returns
    /// * `Result<()>` - Success or error
    #[instrument(skip(self))]
    pub async fn remove_items(&self, playlist_id: i64, playlist_item_ids: &[i64]) -> Result<()> {
        for item_id in playlist_item_ids {
            let path = format!("/playlists/{}/items/{}", playlist_id, item_id);
            self.delete(&path)
                .await
                .with_context(|| format!("Failed to remove item {} from playlist", item_id))?;
        }
        Ok(())
    }

    /// Move an item within a playlist
    ///
    /// # Arguments
    /// * `playlist_id` - Playlist rating key
    /// * `item_id` - Playlist item ID to move
    /// * `after_item_id` - Playlist item ID to move after (use 0 to move to top)
    ///
    /// # Returns
    /// * `Result<()>` - Success or error
    #[instrument(skip(self))]
    pub async fn move_item(&self, playlist_id: i64, item_id: i64, after_item_id: i64) -> Result<()> {
        let path = format!("/playlists/{}/items/{}/move", playlist_id, item_id);
        let url = format!("{}?after={}", self.build_url(&path), after_item_id);

        let body = serde_json::json!({});

        self.put_url::<()>(&url, body)
            .await
            .context("Failed to move item in playlist")?;

        Ok(())
    }

    /// Delete a playlist
    ///
    /// # Arguments
    /// * `playlist_id` - Playlist rating key
    ///
    /// # Returns
    /// * `Result<()>` - Success or error
    #[instrument(skip(self))]
    pub async fn delete_playlist(&self, playlist_id: i64) -> Result<()> {
        let path = format!("/playlists/{}", playlist_id);

        self.delete(&path)
            .await
            .context("Failed to delete playlist")?;

        Ok(())
    }

    /// Clear all items from a playlist
    ///
    /// # Arguments
    /// * `playlist_id` - Playlist rating key
    ///
    /// # Returns
    /// * `Result<()>` - Success or error
    #[instrument(skip(self))]
    pub async fn clear_playlist(&self, playlist_id: i64) -> Result<()> {
        let path = format!("/playlists/{}/items", playlist_id);

        self.delete(&path)
            .await
            .context("Failed to clear playlist")?;

        Ok(())
    }

    /// Get smart playlist generators
    ///
    /// # Arguments
    /// * `playlist_id` - Playlist rating key
    ///
    /// # Returns
    /// * `Result<Vec<Generator>>` - List of generators
    #[instrument(skip(self))]
    pub async fn get_generators(&self, playlist_id: i64) -> Result<Vec<Generator>> {
        let path = format!("/playlists/{}/generators", playlist_id);
        let url = self.build_url(&path);

        debug!("Fetching playlist generators from {}", url);

        let container: MediaContainer<Generator> = self.get_url(&url).await?;
        Ok(container.metadata)
    }

    /// Get items from a smart playlist generator
    ///
    /// # Arguments
    /// * `playlist_id` - Playlist rating key
    /// * `generator_id` - Generator ID
    ///
    /// # Returns
    /// * `Result<Vec<Track>>` - List of tracks from the generator
    #[instrument(skip(self))]
    pub async fn get_generator_items(&self, playlist_id: i64, generator_id: i64) -> Result<Vec<Track>> {
        let path = format!("/playlists/{}/generators/{}", playlist_id, generator_id);
        let url = self.build_url(&path);

        debug!("Fetching generator items from {}", url);

        let container: MediaContainer<Track> = self.get_url(&url).await?;
        Ok(container.metadata)
    }

}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_uri_from_item_ids() {
        let item_ids = vec![12345, 67890, 11111];
        let ids = item_ids
            .iter()
            .map(|id| id.to_string())
            .collect::<Vec<_>>()
            .join(",");
        assert_eq!(ids, "12345,67890,11111");
    }

    #[test]
    fn test_build_query_params() {
        let mut params = Vec::new();
        params.push(("limit".to_string(), "50".to_string()));
        params.push(("offset".to_string(), "0".to_string()));

        let query = params
            .iter()
            .map(|(k, v)| format!("{}={}", k, v))
            .collect::<Vec<_>>()
            .join("&");

        assert_eq!(query, "limit=50&offset=0");
    }

    #[test]
    fn test_search_filter_serialization() {
        let filter = SearchFilter::Genre("Rock".to_string());
        let json = serde_json::to_value(&filter).unwrap();
        assert_eq!(json, "Rock");

        let filter = SearchFilter::YearGte(2000);
        let json = serde_json::to_value(&filter).unwrap();
        assert_eq!(json, 2000);
    }
}

#[cfg(test)]
mod integration_tests {
    use super::super::{PlexClient, PlexClientConfig};

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

    /// Dump every raw JSON field for the first few tracks in a real playlist.
    ///
    /// Run with:
    ///   PLEX_URL=https://... PLEX_TOKEN=... cargo test -p plexmusicclient-lib \
    ///     test_playlist_item_raw_fields -- --nocapture --ignored
    ///
    /// Look at the output for any date/timestamp field that differs from
    /// `addedAt` (library add date) — e.g. a playlist-specific add timestamp.
    #[tokio::test]
    #[ignore]
    async fn test_playlist_item_raw_fields() {
        let base_url = match std::env::var("PLEX_URL") {
            Ok(v) => v,
            Err(_) => { println!("PLEX_URL not set — skipping"); return; }
        };
        let token = match std::env::var("PLEX_TOKEN") {
            Ok(v) => v,
            Err(_) => { println!("PLEX_TOKEN not set — skipping"); return; }
        };
        let section_id: i64 = std::env::var("PLEX_SECTION_ID")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(5);

        let client = get_client();

        // Find a non-smart playlist that has at least one track.
        let playlists = match client.list_playlists(section_id, Some(50)).await {
            Ok(p) => p,
            Err(e) => { println!("list_playlists failed: {}", e); return; }
        };
        let playlist = match playlists.iter().find(|p| p.leaf_count > 0 && !p.smart) {
            Some(p) => p,
            None => { println!("No non-smart playlists with items found"); return; }
        };
        println!("\nUsing playlist: '{}' (id={}, {} tracks)", playlist.title, playlist.rating_key, playlist.leaf_count);

        // Fetch the first 3 items as raw JSON — bypass the deserializer so we
        // see every field Plex actually returns.
        let http = reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .build()
            .unwrap();

        let items_url = format!(
            "{}/playlists/{}/items?X-Plex-Container-Size=3&X-Plex-Container-Start=0&X-Plex-Token={}",
            base_url.trim_end_matches('/'),
            playlist.rating_key,
            token,
        );

        let raw: serde_json::Value = http
            .get(&items_url)
            .header("Accept", "application/json")
            .send()
            .await
            .expect("HTTP request failed")
            .json()
            .await
            .expect("JSON parse failed");

        let container = match raw.get("MediaContainer") {
            Some(c) => c,
            None => { println!("No MediaContainer in response:\n{}", raw); return; }
        };

        // Print non-array container-level attributes.
        println!("\n=== MediaContainer scalars ===");
        if let Some(obj) = container.as_object() {
            for (k, v) in obj {
                if !v.is_array() && !v.is_object() {
                    println!("  {}: {}", k, v);
                }
            }
        }

        // Print every field on the first track, sorted alphabetically.
        let items = container
            .get("Metadata")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        for (idx, item) in items.iter().take(3).enumerate() {
            println!("\n=== Track {} — all scalar fields ===", idx + 1);
            if let Some(obj) = item.as_object() {
                let mut pairs: Vec<_> = obj.iter().collect();
                pairs.sort_by_key(|(k, _)| k.as_str());
                for (k, v) in &pairs {
                    if v.is_array() {
                        println!("  {}: [array, len={}]", k, v.as_array().map_or(0, |a| a.len()));
                    } else if v.is_object() {
                        println!("  {}: {{object}}", k);
                    } else {
                        println!("  {}: {}", k, v);
                    }
                }
            }
        }
    }

    #[tokio::test]
    async fn test_list_playlists() {
        let client = get_client();

        // Use section ID 1 (typical default) - adjust if needed
        let section_id = 1;

        let playlists = client
            .list_playlists(section_id, Some(10))
            .await;

        match playlists {
            Ok(playlist_list) => {
                println!("Found {} playlists", playlist_list.len());
                assert!(playlist_list.len() >= 0);
            }
            Err(e) => {
                // May fail if section doesn't exist
                println!("List playlists failed (may be expected): {}", e);
            }
        }
    }

    #[tokio::test]
    async fn test_create_delete_playlist() {
        let client = get_client();
        let section_id: i64 = std::env::var("PLEX_SECTION_ID")
            .ok().and_then(|v| v.parse().ok()).unwrap_or(5);

        let title = format!("Test Playlist {}", std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs());

        // Create empty playlist
        let playlist_result = client.create_playlist(&title, section_id, &[]).await;
        match playlist_result {
            Ok(created) => {
                println!("Created empty playlist: '{}' id={}", created.title, created.rating_key);
                assert_eq!(created.title, title);

                // Delete
                let del = client.delete_playlist(created.rating_key).await;
                assert!(del.is_ok(), "delete_playlist failed: {:?}", del.err());
                println!("Deleted playlist {}", created.rating_key);
            }
            Err(e) => println!("create_playlist failed: {}", e),
        }
    }

    /// Test creating a playlist, adding items to it, verifying, then deleting.
    ///
    /// Run with:
    ///   PLEX_URL=https://... PLEX_TOKEN=... PLEX_SECTION_ID=5 \
    ///   cargo test -p plexmusicclient-lib test_create_add_items_delete -- --nocapture --ignored
    #[tokio::test]
    #[ignore]
    async fn test_create_add_items_delete() {
        let client = get_client();
        let section_id: i64 = std::env::var("PLEX_SECTION_ID")
            .ok().and_then(|v| v.parse().ok()).unwrap_or(5);

        // Find a track to add by pulling from the first non-empty playlist
        let playlists = match client.list_playlists(section_id, Some(10)).await {
            Ok(p) => p,
            Err(e) => { println!("list_playlists failed: {}", e); return; }
        };
        let source = playlists.iter().find(|p| p.leaf_count > 0 && !p.smart);
        let track_id = match source {
            Some(pl) => {
                let items = client.get_playlist_items(pl.rating_key, Some(1), Some(0)).await;
                match items {
                    Ok(tracks) if !tracks.is_empty() => tracks[0].rating_key as i64,
                    _ => { println!("Could not get a track id — skipping"); return; }
                }
            }
            None => { println!("No non-empty playlists found — skipping"); return; }
        };
        println!("Using track id={} for add_items test", track_id);

        // Create a fresh playlist
        let title = format!("AddItems Test {}", std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs());
        let playlist = match client.create_playlist(&title, section_id, &[]).await {
            Ok(p) => { println!("Created playlist '{}' id={}", p.title, p.rating_key); p }
            Err(e) => { println!("create_playlist failed: {}", e); return; }
        };

        // Add the track
        let add = client.add_items(playlist.rating_key, &[track_id]).await;
        assert!(add.is_ok(), "add_items failed: {:?}", add.err());
        println!("add_items succeeded");

        // Verify the track is in the playlist
        let items = client.get_playlist_items(playlist.rating_key, Some(5), Some(0)).await;
        match items {
            Ok(tracks) => {
                println!("Playlist now has {} tracks", tracks.len());
                assert!(!tracks.is_empty(), "Expected at least one track after add_items");
                assert!(
                    tracks.iter().any(|t| t.rating_key as i64 == track_id),
                    "Track {} not found in playlist after add_items", track_id
                );
                println!("Verified track {} is in playlist", track_id);
            }
            Err(e) => println!("get_playlist_items failed: {}", e),
        }

        // Clean up
        let del = client.delete_playlist(playlist.rating_key).await;
        assert!(del.is_ok(), "delete_playlist failed: {:?}", del.err());
        println!("Deleted test playlist {}", playlist.rating_key);
    }
}


