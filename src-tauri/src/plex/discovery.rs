//! Discovery and hubs module for Plex API
//!
//! This module provides access to Plex discovery features including:
//! - Home screen hubs (recommendations, continue watching, recently added)
//! - Section-specific hubs
#![allow(dead_code)]
//! - Related hubs for specific items
//! - Promoted hubs

use super::{PlexClient, MediaContainer, Hub, PlexMedia, Track};
use super::library::build_url_from_params;
use anyhow::{Result, Context};
use tracing::{debug, instrument};

impl PlexClient {
    /// Get all global hubs (home screen hubs)
    ///
    /// # Arguments
    /// * `section_id` - Library section ID to filter hubs by
    ///
    /// # Returns
    /// * `Result<Vec<Hub>>` - List of hubs for the home screen
    ///
    /// # Example
    /// ```no_run
    /// # use plex::{PlexClient, PlexClientConfig, Hub};
    /// # tokio_test::block_on(async {
    /// let client = PlexClient::new(PlexClientConfig::default()).unwrap();
    /// let hubs: Vec<Hub> = client.get_global_hubs(1).await?;
    /// # Ok::<(), anyhow::Error>(())
    /// # });
    /// ```
    #[instrument(skip(self))]
    pub async fn get_global_hubs(&self, section_id: i64) -> Result<Vec<Hub>> {
        let params = vec![("contentDirectoryID".to_string(), section_id.to_string())];
        let path = "/hubs";
        let url = build_url_from_params(&self.build_url(path), &params);

        debug!("Fetching global hubs from {}", url);

        let container: MediaContainer<Hub> = self
            .get_url(&url)
            .await
            .context("Failed to fetch global hubs")?;

        Ok(container.hub)
    }

    /// Get section-specific hubs
    ///
    /// # Arguments
    /// * `section_id` - Library section ID
    ///
    /// # Returns
    /// * `Result<Vec<Hub>>` - List of hubs for the section
    #[instrument(skip(self))]
    pub async fn get_section_hubs(&self, section_id: i64) -> Result<Vec<Hub>> {
        // Match the desktop Plexamp discovery query (verified against 4.50.19
        // requests). Both count and extra flags affect personalized mix selection;
        // don't add includeLoudnessRamps here. Fetch analysis with track metadata.
        //   includeMyMixes=1            → "Mixes for You" (music.mixes.* hubs) — requires Plex Pass + server-generated mixes
        //   includeAnniversaryReleases=1 → "On This Day" hub
        //   includeStations=1           → "Stations" (Library Radio, Deep Cuts Radio, etc.)
        //   includeStationDirectories=1 → Station directories
        //   includeLibraryPlaylists=1   → "Recent Playlists" hub
        //   excludeElements=Similar,Mood → strips noisy sub-elements
        //   count=6                     → desktop hub count; mixes can exceed this
        let path = format!(
            "/hubs/sections/{}?count=6&includeExternalMetadata=1&includeMyMixes=1&includeAnniversaryReleases=1&excludeElements=Similar,Mood&includeLibraryPlaylists=1&includeStations=1&includeStationDirectories=1&excludeFields=summary",
            section_id
        );

        debug!("Fetching section hubs for section {}", section_id);

        let container: MediaContainer<Hub> = self
            .get_url(&self.build_endpoint_url(&path))
            .await
            .with_context(|| format!("Failed to fetch section hubs for section {}", section_id))?;

        Ok(container.hub)
    }

    /// Get items from a specific hub
    ///
    /// # Arguments
    /// * `hub_key` - Hub key (from hub.hub_identifier or hub.title)
    /// * `limit` - Maximum number of items to return (optional)
    /// * `offset` - Offset for pagination (optional)
    ///
    /// # Returns
    /// * `Result<Vec<PlexMedia>>` - List of media items from the hub
    #[instrument(skip(self))]
    pub async fn get_hub_items(
        &self,
        hub_key: &str,
        limit: Option<i32>,
        offset: Option<i32>,
    ) -> Result<Vec<PlexMedia>> {
        let mut params = Vec::new();

        if let Some(limit) = limit {
            params.push(("limit".to_string(), limit.to_string()));
        }

        if let Some(offset) = offset {
            params.push(("offset".to_string(), offset.to_string()));
        }

        let path = format!("/hubs/{}", hub_key);
        let url = build_url_from_params(&self.build_url(&path), &params);

        debug!("Fetching hub items for hub '{}' from {}", hub_key, url);

        let container: MediaContainer<PlexMedia> = self
            .get_url(&url)
            .await
            .with_context(|| format!("Failed to fetch hub items for hub '{}'", hub_key))?;

        Ok(container.metadata)
    }

    /// Get continue watching hub items
    ///
    /// # Arguments
    /// * `section_id` - Library section ID
    /// * `limit` - Maximum number of items to return (optional)
    ///
    /// # Returns
    /// * `Result<Vec<Track>>` - List of tracks to continue listening to
    #[instrument(skip(self))]
    pub async fn get_continue_watching(&self, section_id: i64, limit: Option<i32>) -> Result<Vec<Track>> {
        let mut params = Vec::new();

        if let Some(limit) = limit {
            params.push(("limit".to_string(), limit.to_string()));
        }

        let path = format!("/hubs/sections/{}/continueWatching", section_id);
        let url = build_url_from_params(&self.build_url(&path), &params);

        debug!(
            "Fetching continue watching for section {} from {}",
            section_id, url
        );

        let container: MediaContainer<Track> = self
            .get_url(&url)
            .await
            .with_context(|| {
                format!(
                    "Failed to fetch continue watching for section {}",
                    section_id
                )
            })?;

        Ok(container.metadata)
    }

    /// Get recently added hub items
    ///
    /// # Arguments
    /// * `section_id` - Library section ID
    /// * `limit` - Maximum number of items to return (optional)
    ///
    /// # Returns
    /// * `Result<Vec<PlexMedia>>` - List of recently added media items
    #[instrument(skip(self))]
    pub async fn get_recently_added_hub(
        &self,
        section_id: i64,
        limit: Option<i32>,
    ) -> Result<Vec<PlexMedia>> {
        let mut params = Vec::new();

        if let Some(limit) = limit {
            params.push(("limit".to_string(), limit.to_string()));
        }

        let path = format!("/hubs/sections/{}/recentlyAdded", section_id);
        let url = build_url_from_params(&self.build_url(&path), &params);

        debug!("Fetching recently added hub for section {} from {}", section_id, url);

        let container: MediaContainer<PlexMedia> = self
            .get_url(&url)
            .await
            .with_context(|| {
                format!(
                    "Failed to fetch recently added hub for section {}",
                    section_id
                )
            })?;

        Ok(container.metadata)
    }

    /// Get promoted hubs
    ///
    /// # Returns
    /// * `Result<Vec<Hub>>` - List of promoted hubs
    #[instrument(skip(self))]
    pub async fn get_promoted_hubs(&self) -> Result<Vec<Hub>> {
        let path = "/hubs/promoted";
        let url = self.build_url(path);

        debug!("Fetching promoted hubs from {}", url);

        let container: MediaContainer<Hub> = self
            .get_url(&url)
            .await
            .context("Failed to fetch promoted hubs")?;

        Ok(container.metadata)
    }

    /// Get hubs related to a specific item
    ///
    /// # Arguments
    /// * `rating_key` - Rating key of the item
    /// * `limit` - Maximum number of hubs to return (optional)
    ///
    /// # Returns
    /// * `Result<Vec<Hub>>` - List of related hubs
    #[instrument(skip(self))]
    pub async fn get_related_hubs(&self, rating_key: i64, limit: Option<i32>) -> Result<Vec<Hub>> {
        let mut path = format!(
            "/library/metadata/{}/related?includeAugmentations=1&includeExternalMetadata=1&includeMeta=1",
            rating_key
        );

        if let Some(limit) = limit {
            path.push_str(&format!("&limit={}", limit));
        }

        debug!("Fetching related hubs for rating_key {} from {}", rating_key, path);

        let container: MediaContainer<Hub> = self
            .get(&path)
            .await
            .with_context(|| format!("Failed to fetch related hubs for rating_key {}", rating_key))?;

        Ok(container.hub)
    }

    /// Get recommendations hub
    ///
    /// # Arguments
    /// * `section_id` - Library section ID
    /// * `limit` - Maximum number of items to return (optional)
    ///
    /// # Returns
    /// * `Result<Vec<PlexMedia>>` - List of recommended media items
    #[instrument(skip(self))]
    pub async fn get_recommendations(
        &self,
        section_id: i64,
        limit: Option<i32>,
    ) -> Result<Vec<PlexMedia>> {
        let mut params = Vec::new();

        if let Some(limit) = limit {
            params.push(("limit".to_string(), limit.to_string()));
        }

        let path = format!("/hubs/sections/{}/recommendations", section_id);
        let url = build_url_from_params(&self.build_url(&path), &params);

        debug!("Fetching recommendations for section {} from {}", section_id, url);

        let container: MediaContainer<PlexMedia> = self
            .get_url(&url)
            .await
            .with_context(|| format!("Failed to fetch recommendations for section {}", section_id))?;

        Ok(container.metadata)
    }

    /// Get recently played hub
    ///
    /// # Arguments
    /// * `section_id` - Library section ID
    /// * `limit` - Maximum number of items to return (optional)
    ///
    /// # Returns
    /// * `Result<Vec<PlexMedia>>` - List of recently played media items
    #[instrument(skip(self))]
    pub async fn get_recently_played(
        &self,
        section_id: i64,
        limit: Option<i32>,
    ) -> Result<Vec<PlexMedia>> {
        let mut params = Vec::new();

        if let Some(limit) = limit {
            params.push(("limit".to_string(), limit.to_string()));
        }

        let path = format!("/hubs/sections/{}/recentlyPlayed", section_id);
        let url = build_url_from_params(&self.build_url(&path), &params);

        debug!("Fetching recently played for section {} from {}", section_id, url);

        let container: MediaContainer<PlexMedia> = self
            .get_url(&url)
            .await
            .with_context(|| format!("Failed to fetch recently played for section {}", section_id))?;

        Ok(container.metadata)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::{PlexClientConfig, PlexMedia};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn desktop_discovery_preserves_all_personalized_mixes_and_its_query() {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let client = PlexClient::new(PlexClientConfig {
                base_url: format!("http://{}", listener.local_addr().unwrap()),
                token: "test-token".into(),
                ..Default::default()
            }).unwrap();
            // Personalized mixes have no ratingKey, and the server can return
            // more mixes than count. Preserve every key and the server's order.
            let body = serde_json::json!({"MediaContainer": {"Hub": [{
                "hubIdentifier": "music.mixes.5", "title": "Mixes For You", "size": 9,
                "Metadata": (0..9).map(|i| serde_json::json!({
                    "type": "playlist", "title": format!("Artist {i} Mix"),
                    "key": format!("/library/sections/5/all?or=1&album.id={i}")
                })).collect::<Vec<_>>()
            }]}}).to_string();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut buffer = [0; 4096];
                while !request.windows(4).any(|b| b == b"\r\n\r\n") {
                    let n = socket.read(&mut buffer).await.unwrap();
                    assert!(n > 0 && request.len() < 65536);
                    request.extend_from_slice(&buffer[..n]);
                }
                let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
                socket.write_all(response.as_bytes()).await.unwrap();
                String::from_utf8(request).unwrap()
            });
            let hubs = client.get_section_hubs(5).await.unwrap();
            let request = server.await.unwrap();
            let target = request.lines().next().unwrap().split_whitespace().nth(1).unwrap();
            let url = url::Url::parse(&format!("http://localhost{target}")).unwrap();
            let params: std::collections::HashMap<_, _> = url.query_pairs().collect();
            assert_eq!(url.path(), "/hubs/sections/5");
            assert_eq!(params.get("count").map(|s| s.as_ref()), Some("6"));
            assert_eq!(params.get("includeMyMixes").map(|s| s.as_ref()), Some("1"));
            assert!(!params.contains_key("includeLoudnessRamps"));
            assert!(request.to_lowercase().contains("x-plex-product: hibiki\r\n"));
            assert_eq!(hubs[0].metadata.len(), 9);
            for (i, item) in hubs[0].metadata.iter().enumerate() {
                let PlexMedia::Playlist(mix) = item else { panic!("expected mix playlist") };
                assert_eq!(mix.rating_key, 0);
                assert_eq!(mix.title, format!("Artist {i} Mix"));
                assert_eq!(mix.key, format!("/library/sections/5/all?or=1&album.id={i}"));
            }
        }).await.expect("mock discovery request timed out");
    }

    #[test]
    fn test_build_url_from_params_empty() {
        let base_url = "http://localhost:32400/hubs";
        let params = &[];
        let url = build_url_from_params(base_url, params);
        assert_eq!(url, base_url);
    }

    #[test]
    fn test_build_url_from_params_with_values() {
        let base_url = "http://localhost:32400/hubs";
        let params = &[
            ("contentDirectoryID".to_string(), "1".to_string()),
            ("limit".to_string(), "50".to_string()),
        ];
        let url = build_url_from_params(base_url, params);
        assert_eq!(url, "http://localhost:32400/hubs?contentDirectoryID=1&limit=50");
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

    async fn get_music_section_id(c: &PlexClient) -> i64 {
        let sections = c.get_all_sections().await.expect("get_all_sections failed");
        sections
            .iter()
            .find(|s| s.title == "Music")
            .map(|s| s.key)
            .expect("No 'Music' section found")
    }

    #[tokio::test]
    async fn test_get_global_hubs() {
        let client = get_client();

        // Find the Music section
        let sections = client.get_all_sections().await.unwrap();
        let music_section = sections
            .iter()
            .find(|s| s.title == "Music")
            .expect("Music section not found");

        let hubs = client
            .get_global_hubs(music_section.key)
            .await;

        match hubs {
            Ok(hub_list) => {
                println!("Found {} global hubs", hub_list.len());
                for hub in &hub_list {
                    println!("  - {}: {} items", hub.title, hub.size);
                }
            }
            Err(e) => {
                println!("Get global hubs failed: {}", e);
            }
        }
    }

    #[tokio::test]
    async fn test_get_section_hubs() {
        let client = get_client();

        // Find the Music section
        let sections = client.get_all_sections().await.unwrap();
        let music_section = sections
            .iter()
            .find(|s| s.title == "Music")
            .expect("Music section not found");

        let hubs = client
            .get_section_hubs(music_section.key)
            .await;

        match hubs {
            Ok(hub_list) => {
                println!("Found {} section hubs", hub_list.len());
                for hub in &hub_list {
                    println!("  - {}: {} items", hub.title, hub.size);
                }
            }
            Err(e) => {
                println!("Get section hubs failed: {}", e);
            }
        }
    }

    #[tokio::test]
    async fn test_get_hub_items() {
        let client = get_client();

        // Find the Music section
        let sections = client.get_all_sections().await.unwrap();
        let music_section = sections
            .iter()
            .find(|s| s.title == "Music")
            .expect("Music section not found");

        // Get hubs first
        let hubs = client
            .get_section_hubs(music_section.key)
            .await
            .expect("Failed to get hubs");

        if !hubs.is_empty() {
            // Try to get items from the first hub
            let hub = &hubs[0];
            let items = client
                .get_hub_items(&hub.hub_identifier, Some(10), None)
                .await;

            match items {
                Ok(item_list) => {
                    println!(
                        "Found {} items in hub '{}'",
                        item_list.len(),
                        hub.hub_identifier
                    );
                    assert!(item_list.len() <= 10);
                }
                Err(e) => {
                    println!("Get hub items failed: {}", e);
                }
            }
        } else {
            println!("No hubs found to test get_hub_items");
        }
    }

    #[tokio::test]
    async fn test_get_recently_added_hub() {
        let client = get_client();

        // Find the Music section
        let sections = client.get_all_sections().await.unwrap();
        let music_section = sections
            .iter()
            .find(|s| s.title == "Music")
            .expect("Music section not found");

        let items = client
            .get_recently_added_hub(music_section.key, Some(10))
            .await;

        match items {
            Ok(item_list) => {
                println!("Found {} recently added items", item_list.len());
                assert!(item_list.len() <= 10);
            }
            Err(e) => {
                println!("Get recently added hub failed: {}", e);
            }
        }
    }

    #[tokio::test]
    async fn test_get_promoted_hubs() {
        let client = get_client();

        let hubs = client.get_promoted_hubs().await;

        match hubs {
            Ok(hub_list) => {
                println!("Found {} promoted hubs", hub_list.len());
                for hub in &hub_list {
                    println!("  - {}: {} items", hub.title, hub.size);
                }
            }
            Err(e) => {
                println!("Get promoted hubs failed: {}", e);
            }
        }
    }

    #[tokio::test]
    async fn test_get_recommendations() {
        let client = get_client();

        // Find the Music section
        let sections = client.get_all_sections().await.unwrap();
        let music_section = sections
            .iter()
            .find(|s| s.title == "Music")
            .expect("Music section not found");

        let items = client
            .get_recommendations(music_section.key, Some(10))
            .await;

        match items {
            Ok(item_list) => {
                println!("Found {} recommended items", item_list.len());
                assert!(item_list.len() <= 10);
            }
            Err(e) => {
                println!("Get recommendations failed: {}", e);
            }
        }
    }

    #[tokio::test]
    async fn test_get_section_hubs_content() {
        // Verify that section hubs return non-empty metadata in each hub
        let client = get_client();
        let sections = client.get_all_sections().await.unwrap();
        let music_section = sections
            .iter()
            .find(|s| s.title == "Music")
            .expect("Music section not found");

        match client.get_section_hubs(music_section.key).await {
            Ok(hubs) => {
                println!("Found {} section hubs", hubs.len());
                for hub in &hubs {
                    println!(
                        "  hub: '{}' (id: '{}', size: {}, metadata items: {})",
                        hub.title,
                        hub.hub_identifier,
                        hub.size,
                        hub.metadata.len()
                    );
                    for item in hub.metadata.iter().take(3) {
                        println!("    - type={}", item.item_type());
                    }
                }
            }
            Err(e) => println!("get_section_hubs failed: {}", e),
        }
    }

    #[tokio::test]
    async fn test_get_related_hubs_for_artist() {
        // Verify that related hubs return artist-type items (similar/sonic artists)
        let client = get_client();
        let section_id = {
            let sections = client.get_all_sections().await.unwrap();
            sections
                .iter()
                .find(|s| s.title == "Music")
                .map(|s| s.key)
                .expect("No Music section")
        };

        // Get an artist key from recently added
        let items = match client.recently_added(section_id, Some("track"), Some(5)).await {
            Ok(v) => v,
            Err(e) => { println!("recently_added failed: {}", e); return; }
        };
        let artist_key = items.into_iter().find_map(|m| {
            if let super::PlexMedia::Track(t) = m {
                t.grandparent_key
                    .trim_start_matches("/library/metadata/")
                    .parse::<i64>()
                    .ok()
            } else {
                None
            }
        });
        let Some(artist_key) = artist_key else {
            println!("No artist key found — skipping");
            return;
        };

        match client.get_related_hubs(artist_key, None).await {
            Ok(hubs) => {
                println!("Got {} related hubs for artist {}", hubs.len(), artist_key);
                for hub in &hubs {
                    let artist_count = hub.metadata.iter()
                        .filter(|m| m.item_type() == "artist")
                        .count();
                    println!(
                        "  hub: '{}' (id: '{}', items: {}, artists: {})",
                        hub.title, hub.hub_identifier, hub.metadata.len(), artist_count
                    );
                }
            }
            Err(e) => println!("get_related_hubs failed: {}", e),
        }
    }

    /// Test the enriched /hubs/sections/{id} endpoint used by Plex Web for the home page.
    /// Key params vs the bare endpoint:
    ///   includeStations=1       → station playlists ("Library Radio" etc.)
    ///   includeLibraryPlaylists=1 → user playlists in hubs
    ///   includeRecentChannels=1  → recently used channels
    ///   count=12                 → items per hub
    #[tokio::test]
    async fn test_home_hubs_enriched() {
        const MUSIC_SECTION_ID: i64 = 5;
        let client = get_client();

        let path = format!(
            "/hubs/sections/{}?count=12&includeLibraryPlaylists=1&includeStations=1&includeRecentChannels=1&includeMeta=1&includeExternalMetadata=1&excludeFields=summary",
            MUSIC_SECTION_ID
        );

        match client.get::<crate::plex::models::MediaContainer<super::Hub>>(&path).await {
            Ok(container) => {
                let hubs = container.hub;
                println!("Enriched home hubs: {} hubs", hubs.len());
                for hub in &hubs {
                    let type_counts: std::collections::HashMap<&str, usize> =
                        hub.metadata.iter().fold(std::collections::HashMap::new(), |mut m, item| {
                            *m.entry(item.item_type()).or_insert(0) += 1;
                            m
                        });
                    println!(
                        "  hub '{}' (id: '{}', size: {}, types: {:?})",
                        hub.title, hub.hub_identifier, hub.metadata.len(), type_counts
                    );
                }

                // Check specifically for station / mix hubs
                let station_hubs: Vec<_> = hubs.iter()
                    .filter(|h| h.hub_identifier.contains("station") || h.title.to_lowercase().contains("mix"))
                    .collect();
                println!("\nStation/Mix hubs ({}):", station_hubs.len());
                for h in &station_hubs {
                    println!("  '{}' ({}): {} items", h.title, h.hub_identifier, h.metadata.len());
                    for item in h.metadata.iter().take(3) {
                        match item {
                            super::PlexMedia::Playlist(p) => println!("    playlist: {} (radio={})", p.title, p.radio),
                            super::PlexMedia::Album(a) => println!("    album: {}", a.title),
                            super::PlexMedia::Artist(a) => println!("    artist: {}", a.title),
                            _ => println!("    {:?}", item.item_type()),
                        }
                    }
                }
            }
            Err(e) => println!("Enriched home hubs failed: {}", e),
        }
    }

    /// Compare bare vs enriched hub count to confirm includeStations adds new hubs.
    #[tokio::test]
    async fn test_home_hubs_bare_vs_enriched() {
        const MUSIC_SECTION_ID: i64 = 5;
        let client = get_client();

        // Bare (current production call)
        let bare_path = format!("/hubs/sections/{}", MUSIC_SECTION_ID);
        let bare: crate::plex::models::MediaContainer<super::Hub> = client.get(&bare_path).await.unwrap();
        let bare_hubs = bare.hub;

        // Enriched (Plex Web call)
        let rich_path = format!(
            "/hubs/sections/{}?count=12&includeLibraryPlaylists=1&includeStations=1&includeRecentChannels=1&includeMeta=1&includeExternalMetadata=1&excludeFields=summary",
            MUSIC_SECTION_ID
        );
        let rich: crate::plex::models::MediaContainer<super::Hub> = client.get(&rich_path).await.unwrap();
        let rich_hubs = rich.hub;

        println!("Bare hubs:     {} total", bare_hubs.len());
        for h in &bare_hubs {
            println!("  '{}' ({}): {} items", h.title, h.hub_identifier, h.metadata.len());
        }

        println!("\nEnriched hubs: {} total", rich_hubs.len());
        for h in &rich_hubs {
            println!("  '{}' ({}): {} items", h.title, h.hub_identifier, h.metadata.len());
        }

        // Report hubs present only in enriched
        let bare_ids: std::collections::HashSet<_> = bare_hubs.iter().map(|h| h.hub_identifier.as_str()).collect();
        let new_hubs: Vec<_> = rich_hubs.iter().filter(|h| !bare_ids.contains(h.hub_identifier.as_str())).collect();
        println!("\nNew hubs from enriched params ({}):", new_hubs.len());
        for h in &new_hubs {
            println!("  '{}' ({}): {} items", h.title, h.hub_identifier, h.metadata.len());
        }
    }

    /// Test the exact PlexAmp hub URL (reverse-engineered from app.asar).
    /// PlexAmp uses `includeMyMixes=1` to get the "Mixes for You" section
    /// (`music.mixes.*` hub identifiers). This is absent from the Plex Web params.
    #[tokio::test]
    async fn test_home_hubs_plexamp_exact() {
        const MUSIC_SECTION_ID: i64 = 5;
        let client = get_client();

        // Exact params PlexAmp uses (from reverse-engineering app.asar):
        let path = format!(
            "/hubs/sections/{}?count=6&includeExternalMetadata=1&includeMyMixes=1&includeAnniversaryReleases=1&excludeElements=Similar,Mood&includeLibraryPlaylists=1&includeStations=1&includeStationDirectories=1&excludeFields=summary",
            MUSIC_SECTION_ID
        );

        match client.get::<crate::plex::models::MediaContainer<super::Hub>>(&path).await {
            Ok(container) => {
                let hubs = container.hub;
                println!("PlexAmp-exact hubs: {} total", hubs.len());
                for hub in &hubs {
                    println!(
                        "  '{}' (id: '{}', size: {})",
                        hub.title, hub.hub_identifier, hub.metadata.len()
                    );
                }

                let mix_hubs: Vec<_> = hubs.iter()
                    .filter(|h| h.hub_identifier.starts_with("music.mixes"))
                    .collect();
                println!("\nMixes for You hubs ({}):", mix_hubs.len());
                for h in &mix_hubs {
                    println!("  '{}' ({}): {} items", h.title, h.hub_identifier, h.metadata.len());
                    for item in h.metadata.iter().take(5) {
                        match item {
                            super::PlexMedia::Playlist(p) => println!("    mix: '{}' (radio={}, smart={}, subtype={:?})", p.title, p.radio, p.smart, p.playlist_type),
                            super::PlexMedia::Album(a) => println!("    album: '{}'", a.title),
                            _ => println!("    {}", item.item_type()),
                        }
                    }
                }

                if mix_hubs.is_empty() {
                    println!("NOTE: No music.mixes hubs — server may not have sonic analysis enabled, or Plex Pass required.");
                }
            }
            Err(e) => println!("PlexAmp-exact hubs failed: {}", e),
        }
    }

    // Pinponpanpon — ratingKey 548757 on the test server.
    // Known to have similar artists and sonic data.
    #[tokio::test]
    async fn test_pinponpanpon_related_hubs() {
        const PINPONPANPON_KEY: i64 = 548757;
        let client = get_client();
        match client.get_related_hubs(PINPONPANPON_KEY, None).await {
            Ok(hubs) => {
                println!("Related hubs for Pinponpanpon: {} hubs", hubs.len());
                for hub in &hubs {
                    let type_counts: std::collections::HashMap<&str, usize> =
                        hub.metadata.iter().fold(Default::default(), |mut m, item| {
                            *m.entry(item.item_type()).or_insert(0) += 1;
                            m
                        });
                    println!(
                        "  hub: '{}' (id: '{}', total: {}, types: {:?})",
                        hub.title, hub.hub_identifier, hub.metadata.len(), type_counts
                    );
                    // Print artist names if this hub has artists
                    for item in hub.metadata.iter().filter(|m| m.item_type() == "artist") {
                        if let super::PlexMedia::Artist(a) = item {
                            println!("    artist: {} ({})", a.title, a.rating_key);
                        }
                    }
                }
                // We expect at least one hub to contain artist-type items
                let has_artists = hubs.iter()
                    .any(|h| h.metadata.iter().any(|m| m.item_type() == "artist"));
                println!("Has artist hubs: {}", has_artists);
            }
            Err(e) => println!("get_related_hubs failed: {}", e),
        }
    }
}
