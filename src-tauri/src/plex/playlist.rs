//! Playlist management operations (CRUD, smart playlists, generators)
#![allow(dead_code)]

use super::{PlexClient, MediaContainer, Playlist, Track};
use super::client::{request_error, token_header};
use super::models::PlexApiResponse;
use crate::http_response::{BoundedResponseExt, MAX_PLEX_BYTES};
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

#[derive(Debug, Serialize)]
pub struct PlaylistItemsPage {
    pub items: Vec<Track>,
    pub total: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<i64>,
}

#[derive(Deserialize)]
struct PlaylistPageContainer {
    #[serde(flatten)]
    container: MediaContainer<Track>,
    #[serde(default, deserialize_with = "super::models::serde_string_or_i64_opt::deserialize")]
    offset: Option<i64>,
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
        let url = self.build_url(&format!("/playlists?{query}"));

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
        Ok(self.get_playlist_items_page(playlist_id, limit, offset).await?.items)
    }

    /// Retain the server's totalSize without changing the legacy array API.
    pub async fn get_playlist_items_page(
        &self,
        playlist_id: i64,
        limit: Option<i32>,
        offset: Option<i32>,
    ) -> Result<PlaylistItemsPage> {
        if limit.is_some_and(|size| size < 0) || offset.is_some_and(|start| start < 0) {
            anyhow::bail!("Playlist page size must not be negative and offset must not be negative");
        }
        let path = format!("/playlists/{}/items", playlist_id);
        let mut params = Vec::new();

        // Plex paginates using X-Plex-Container-Size / X-Plex-Container-Start,
        // NOT the generic "limit" / "offset" params. Without these the server
        // ignores the page size and returns every item in the playlist.
        if let Some(limit) = limit {
            params.push(("X-Plex-Container-Size".to_string(), limit.to_string()));
        }
        if limit.is_some() || offset.is_some() {
            params.push(("X-Plex-Container-Start".to_string(), offset.unwrap_or(0).to_string()));
        }

        // build_url already carries includeLoudnessRamps. RequestBuilder::query
        // appends paging arguments correctly instead of introducing a second '?'.
        let url = self.build_url(&path);

        debug!("Fetching playlist items from {}", url);

        let response = self.client.get(&url)
            .query(&params)
            .header("X-Plex-Token", token_header(&self.token))
            .header("Accept", "application/json")
            .send().await.map_err(request_error).context("Playlist page request failed")?;
        if !response.status().is_success() {
            anyhow::bail!("Playlist page returned HTTP {}", response.status());
        }
        let read_header = |name: &str| -> Result<Option<i64>> {
            response.headers().get(name).map(|value| {
                let parsed = value.to_str().context("Invalid playlist pagination header")?
                    .parse::<i64>().context("Invalid playlist pagination header")?;
                anyhow::ensure!(parsed >= 0, "Invalid playlist pagination header");
                Ok(parsed)
            }).transpose()
        };
        let header_offset = read_header("X-Plex-Container-Start")?;
        let header_total = read_header("X-Plex-Container-Total-Size")?;
        let wrapper = response.bounded_plex_json::<PlexApiResponse<PlaylistPageContainer>>(MAX_PLEX_BYTES)
            .await.context("Failed to parse playlist page")?;
        let page = wrapper.container;
        if page.offset.is_some() && header_offset.is_some() && page.offset != header_offset {
            anyhow::bail!("Plex returned conflicting playlist page offsets; reload the playlist to continue");
        }
        let actual_offset = page.offset.or(header_offset);
        if limit.is_some_and(|size| page.container.metadata.len() > size as usize) {
            anyhow::bail!("Plex returned more playlist items than requested; reload the playlist to continue");
        }
        if let Some(start) = actual_offset {
            if start < 0 || (!page.container.metadata.is_empty() && start != i64::from(offset.unwrap_or(0))) {
                anyhow::bail!("Plex returned a nonadvancing playlist page; reload the playlist to continue");
            }
        }
        let body_total = page.container.total_size.filter(|total| *total >= 0);
        if body_total.is_some_and(|total| total > 0) && header_total.is_some_and(|total| total > 0) && body_total != header_total {
            anyhow::bail!("Plex returned conflicting playlist totals; reload the playlist to continue");
        }
        Ok(PlaylistItemsPage {
            // Unknown totals stay unknown. Never trim or infer a new offset from
            // an oversized response: that could silently discard valid entries.
            total: body_total.filter(|total| *total > 0).or(header_total).unwrap_or(0),
            items: page.container.metadata,
            offset: actual_offset,
        })
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
        // URI format: server://{machineIdentifier}/com.plexapp.plugins.library/library/metadata/{id}
        // Plex expects one library URI with an ordered comma-separated ID list.
        // Repeating the entire URI for each ID is accepted as an empty playlist.
        let ids = item_ids.iter().map(i64::to_string).collect::<Vec<_>>().join(",");
        let uri = if item_ids.is_empty() { String::new() } else {
            format!("server://{}/com.plexapp.plugins.library/library/metadata/{}",
                self.machine_identifier, ids)
        };


        let container: MediaContainer<Playlist> = self
            .create_playlist_once(&[
                ("title", title),
                ("type",  "audio"),
                ("smart", "0"),
                ("uri",   &uri),
            ])
            .await
            .context("Failed to create playlist")?;

        if container.metadata.len() != 1 {
            anyhow::bail!("Plex did not confirm one created playlist identifier");
        }
        let playlist = container.metadata.into_iter().next().unwrap();
        if playlist.rating_key <= 0 {
            anyhow::bail!("Plex did not confirm a valid created playlist identifier");
        }
        Ok(playlist)
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

        // This is a resource URI inside the request body, not a metadata
        // request URL. Runtime query flags must not become part of its path.
        let uri = self.build_endpoint_url(&format!(
            "/library/sections/{}/all?{}", config.section_id, query_parts.join("&")
        ));

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
    /// * `Result<()>` - Success or error
    #[instrument(skip(self))]
    pub async fn edit_playlist(
        &self,
        playlist_id: i64,
        title: Option<&str>,
        summary: Option<&str>,
    ) -> Result<()> {
        if playlist_id <= 0 || self.offline_only {
            anyhow::bail!("Reconnect to Plex before editing this playlist");
        }
        if title.is_some_and(|text| text.trim().is_empty() || text.len() > 2000)
            || summary.is_some_and(|text| text.len() > 5000) {
            anyhow::bail!("Invalid playlist metadata");
        }
        let path = format!("/playlists/{}", playlist_id);
        let mut params: Vec<(&str, &str)> = Vec::new();
        if let Some(t) = title { params.push(("title", t)); }
        if let Some(s) = summary { params.push(("summary", s)); }
        if params.is_empty() { return Ok(()); }
        self.put_metadata_params_once(&path, &params).await.context("Plex did not confirm the playlist metadata")?;
        let actual = self.get_playlist(playlist_id).await.context("Playlist metadata outcome requires reconciliation")?;
        if actual.rating_key != playlist_id
            || title.is_some_and(|text| actual.title != text)
            || summary.is_some_and(|text| actual.summary.as_deref().unwrap_or("") != text) {
            anyhow::bail!("Playlist metadata outcome requires reconciliation");
        }
        Ok(())
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

        let ids = item_ids.iter().map(i64::to_string).collect::<Vec<_>>().join(",");
        let uri = format!("server://{}/com.plexapp.plugins.library/library/metadata/{}", self.machine_identifier, ids);
        // Appending is non-idempotent: never retry an unconfirmed request.
        self.put_metadata_params_once(&path, &[("uri", uri.as_str())])
            .await.context("Plex did not confirm the playlist append")?;

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
        let url = self.build_url(&format!("{path}?after={after_item_id}"));

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
    async fn playlist_response(body: serde_json::Value, headers: &str) -> (PlexClient, tokio::task::JoinHandle<String>) {
        playlist_response_at(body, headers, "").await
    }

    async fn playlist_response_at(body: serde_json::Value, headers: &str, prefix: &str) -> (PlexClient, tokio::task::JoinHandle<String>) {
        playlist_bytes_response_at(body.to_string().into_bytes(), headers, prefix).await
    }

    async fn playlist_bytes_response_at(json: Vec<u8>, headers: &str, prefix: &str) -> (PlexClient, tokio::task::JoinHandle<String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = PlexClient::new(super::super::PlexClientConfig {
            base_url: format!("http://{}{prefix}", listener.local_addr().unwrap()),
            token: "synthetic-test-token".into(), ..Default::default()
        }).unwrap();
        let mut response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{}Connection: close\r\n\r\n", json.len(), headers).into_bytes();
        response.extend_from_slice(&json);
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            loop {
                let mut bytes = [0; 4096];
                let n = socket.read(&mut bytes).await.unwrap();
                request.extend_from_slice(&bytes[..n]);
                if n == 0 { break }
                if let Some(end) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&request[..end]);
                    let length = headers.lines().find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length").then(|| value.trim().parse::<usize>().ok()).flatten()
                    }).unwrap_or(0);
                    if request.len() >= end + 4 + length { break }
                }
            }
            socket.write_all(&response).await.unwrap();
            String::from_utf8(request).unwrap()
        });
        (client, task)
    }

    #[tokio::test]
    async fn playlist_paging_recovers_invalid_utf8_values_without_losing_membership() {
        let body = b"{\"MediaContainer\":{\"offset\":2000,\"totalSize\":3000,\"Metadata\":[{\"ratingKey\":\"7\",\"title\":\"Bad \xfe text\",\"playlistItemID\":11},{\"ratingKey\":\"8\",\"title\":\"Valid\",\"playlistItemID\":12}]}}";
        let (client, request) = playlist_bytes_response_at(body.to_vec(), "", "").await;
        let page = client.get_playlist_items_page(1, Some(2), Some(2000)).await.unwrap();
        assert_eq!(page.items.len(), 2);
        assert!(page.items[0].title.contains('\u{fffd}'));
        assert_eq!(page.items[0].playlist_item_id, Some(11));
        assert_eq!(page.items[1].title, "Valid");
        assert_eq!(page.total, 3000);
        assert_eq!(page.offset, Some(2000));
        request.await.unwrap();
    }

    #[tokio::test]
    async fn mutation_resource_uris_preserve_reverse_proxy_paths_without_runtime_flags() {
        let (client, request) = playlist_response_at(serde_json::json!({"MediaContainer":{"Metadata":[{"ratingKey":"1","title":"Synthetic"}]}}), "", "/plex").await;
        client.create_smart_playlist(&SmartPlaylistConfig {
            title: "Synthetic".into(), section_id: 7, libtype: Some("10".into()),
            filters: vec![SearchFilter::YearGte(2020)], sort: Some("title:asc".into()), limit: Some(20)
        }).await.unwrap();
        let request = request.await.unwrap();
        let body: serde_json::Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
        let uri = url::Url::parse(body["uri"].as_str().unwrap()).unwrap();
        assert_eq!(uri.path(), "/plex/library/sections/7/all");
        let query: std::collections::HashMap<_, _> = uri.query_pairs().collect();
        assert_eq!(query.get("type").map(|v| v.as_ref()), Some("10"));
        assert_eq!(query.get("year>").map(|v| v.as_ref()), Some("2020"));
        assert_eq!(query.get("limit").map(|v| v.as_ref()), Some("20"));
        assert!(!query.contains_key("includeLoudnessRamps"));

        let (client, request) = playlist_response_at(serde_json::Value::Null, "", "/plex/").await;
        client.add_to_collection(7, &[11, 12]).await.unwrap();
        let request = request.await.unwrap();
        let body: serde_json::Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
        let uri = url::Url::parse(body["uri"].as_str().unwrap()).unwrap();
        assert_eq!(uri.path(), "/plex/library/metadata/11,12");
        assert!(uri.query().is_none());
    }

    #[tokio::test]
    async fn adjacent_plex_queries_preserve_filters_and_ordering() {
        // Exercise the real request builders against an isolated synthetic server.
        for case in 0..9 {
            let (client, request) = playlist_response(
                if case < 7 { serde_json::json!({"MediaContainer":{"Metadata":[]}}) } else { serde_json::Value::Null }, ""
            ).await;
            let expected: Vec<(&str, &str)> = match case {
                0 => { client.list_playlists(1, Some(2)).await.unwrap(); vec![("playlistType", "audio"), ("limit", "2")] }
                1 => { client.sonically_similar::<Track>(7, Some(2), Some(0.3)).await.unwrap(); vec![("limit", "2"), ("maxDistance", "0.3")] }
                2 => { client.sonic_adventure(1, 7, 8, Some(2)).await.unwrap(); vec![("pivot", "7"), ("to", "8"), ("limit", "2")] }
                3 => { client.track_radio(1, 7, Some(2), Some(0.3)).await.unwrap(); vec![("pivot", "7"), ("limit", "2"), ("maxDistance", "0.3")] }
                4 => { client.get_active_sessions(1).await.unwrap(); vec![("sectionID", "1")] }
                5 => { client.get_history(1, Some(2), Some(4), Some("lastViewedAt:desc")).await.unwrap(); vec![("limit", "2"), ("offset", "4"), ("sort", "lastViewedAt:desc")] }
                6 => { client.get_collections(1, Some("8")).await.unwrap(); vec![("type", "8")] }
                7 => { client.move_item(1, 11, 12).await.unwrap(); vec![("after", "12")] }
                _ => { client.reorder_collection(1, 11, 12).await.unwrap(); vec![("after", "12")] }
            };
            let request = request.await.unwrap();
            let target = request.split_whitespace().nth(1).unwrap();
            let url = url::Url::parse(&format!("http://synthetic.test{target}")).unwrap();
            let query: std::collections::HashMap<_, _> = url.query_pairs().collect();
            assert_eq!(query.get("includeLoudnessRamps").map(|value| value.as_ref()), Some("1"), "case {case}");
            for (key, value) in expected {
                assert_eq!(query.get(key).map(|value| value.as_ref()), Some(value), "case {case}, parameter {key}");
            }
        }
    }

    #[tokio::test]
    async fn playlist_paging_preserves_header_offsets_totals_and_duplicate_occurrences() {
        let (client, request) = playlist_response(serde_json::json!({"MediaContainer":{"Metadata":[
            {"ratingKey":"7","title":"Synthetic","playlistItemID":11},
            {"ratingKey":"7","title":"Synthetic","playlistItemID":12}
        ]}}), "X-Plex-Container-Start: 4\r\nX-Plex-Container-Total-Size: 500\r\n").await;
        let page = client.get_playlist_items_page(1, Some(2), Some(4)).await.unwrap();
        assert_eq!(page.items.len(), 2);
        assert_eq!(page.items[0].playlist_item_id, Some(11));
        assert_eq!(page.items[1].playlist_item_id, Some(12));
        assert_eq!(page.total, 500);
        assert_eq!(page.offset, Some(4));
        let request = request.await.unwrap();
        let target = request.split_whitespace().nth(1).unwrap();
        let url = url::Url::parse(&format!("http://synthetic.test{target}")).unwrap();
        let query: std::collections::HashMap<_, _> = url.query_pairs().collect();
        assert_eq!(query.get("includeLoudnessRamps").map(|value| value.as_ref()), Some("1"));
        assert_eq!(query.get("X-Plex-Container-Size").map(|value| value.as_ref()), Some("2"));
        assert_eq!(query.get("X-Plex-Container-Start").map(|value| value.as_ref()), Some("4"));
    }

    #[tokio::test]
    async fn playlist_paging_rejects_oversized_and_nonadvancing_responses_without_trimming() {
        for (container, headers) in [
            (serde_json::json!({"Metadata":[{"ratingKey":"7"},{"ratingKey":"8"}],"totalSize":500}), ""),
            (serde_json::json!({"Metadata":[{"ratingKey":"7"}],"offset":0}), ""),
            (serde_json::json!({"Metadata":[{"ratingKey":"7"}],"offset":4}), "X-Plex-Container-Start: 0\r\n"),
        ] {
            let (client, request) = playlist_response(serde_json::json!({"MediaContainer":container}), headers).await;
            assert!(client.get_playlist_items_page(1, Some(1), Some(4)).await.is_err());
            request.await.unwrap();
        }
    }

    #[tokio::test]
    async fn playlist_paging_allows_zero_size_unknown_totals_and_empty_terminal_pages() {
        let (client, request) = playlist_response(serde_json::json!({"MediaContainer":{"Metadata":[]}}), "X-Plex-Container-Total-Size: 500\r\n").await;
        let page = client.get_playlist_items_page(1, Some(0), None).await.unwrap();
        assert_eq!(page.total, 500);
        assert!(page.items.is_empty());
        assert!(request.await.unwrap().contains("X-Plex-Container-Size=0&X-Plex-Container-Start=0"));
        let (client, request) = playlist_response(serde_json::json!({"MediaContainer":{"Metadata":[{"ratingKey":"7"}],"offset":"4"}}), "").await;
        let page = client.get_playlist_items_page(1, Some(2), Some(4)).await.unwrap();
        assert_eq!(page.total, 0);
        assert_eq!(page.offset, Some(4));
        request.await.unwrap();
        let (client, request) = playlist_response(serde_json::json!({"MediaContainer":{"Metadata":[],"offset":0}}), "").await;
        assert!(client.get_playlist_items_page(1, Some(2), Some(500)).await.unwrap().items.is_empty());
        request.await.unwrap();
    }

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


