//! Play queue management
//!
//! Play queues are the core mechanism PlexAmp uses to manage what's playing,
//! what's up next, shuffle state, and repeat mode. A queue is created server-side
//! from a track, album, playlist, or station URI, then referenced by ID during playback.
#![allow(dead_code)]

use super::{PlexClient, PlayQueue};
use crate::plex::models::{MediaContainer, MetaWithStations, PlexApiResponse, StationRef};
use crate::http_response::{BoundedResponseExt, MAX_PLEX_BYTES};
use super::client::{request_error, token_header};
use anyhow::{Context, Result};
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::{debug, instrument};
use url::Url;
use uuid::Uuid;

impl PlexClient {
    /// Create a new play queue from a library URI.
    ///
    /// The `uri` should be a library URI in the format:
    /// `library://{section_uuid}/item/{track_key}` for a single track, or
    /// `library://{section_uuid}/directory/{album_key}/children` for an album.
    ///
    /// A simpler alternative accepted by most servers:
    /// `/library/metadata/{rating_key}` (single item) or
    /// `/library/metadata/{rating_key}/children` (album/playlist children).
    ///
    /// # Arguments
    /// * `uri` - Library URI for the content to queue
    /// * `shuffle` - Whether to shuffle the queue
    /// * `repeat` - Repeat mode: 0=off, 1=repeat-one, 2=repeat-all
    ///
    /// # Returns
    /// * `Result<PlayQueue>` - The created play queue
    #[instrument(skip(self))]
    pub async fn create_play_queue(
        &self,
        uri: &str,
        shuffle: bool,
        repeat: i32,
    ) -> Result<PlayQueue> {
        let base = self.build_url("/playQueues");
        let mut url = Url::parse(&base).context("Failed to parse playQueues URL")?;

        url.query_pairs_mut()
            .append_pair("type", "audio")
            .append_pair("uri", uri)
            .append_pair("shuffle", if shuffle { "1" } else { "0" })
            .append_pair("repeat", &repeat.to_string())
            .append_pair("includeChapters", "1")
            .append_pair("includeRelated", "1");

        let url_str = url.to_string();
        debug!("Creating play queue: {}", url_str);

        let response = self
            .client
            .post(&url_str)
            .header("X-Plex-Token", token_header(&self.token))
            .header("Accept", "application/json")
            .send()
            .await.map_err(request_error)
            .context("Failed to create play queue")?;

        if !response.status().is_success() {
            return Err(anyhow::anyhow!(
                "HTTP error: {} creating play queue",
                response.status()
            ));
        }

        let wrapper: PlexApiResponse<PlayQueue> = response
            .bounded_json(MAX_PLEX_BYTES)
            .await
            .context("Failed to parse play queue response")?;

        debug!("Created play queue ID={}", wrapper.container.id);
        Ok(wrapper.container)
    }

    /// Fetch an existing play queue by ID.
    #[instrument(skip(self))]
    pub async fn get_play_queue(&self, queue_id: i64) -> Result<PlayQueue> {
        let path = format!("/playQueues/{}", queue_id);
        debug!("Fetching play queue {}", queue_id);

        let queue: PlayQueue = self
            .get(&path)
            .await
            .context("Failed to fetch play queue")?;

        Ok(queue)
    }

    /// Add items to an existing play queue.
    ///
    /// # Arguments
    /// * `queue_id` - The play queue ID
    /// * `uri` - Library URI of the items to add
    /// * `next` - If true, insert after current item; if false, append to end
    #[instrument(skip(self))]
    pub async fn add_to_play_queue(
        &self,
        queue_id: i64,
        uri: &str,
        next: bool,
    ) -> Result<PlayQueue> {
        let base = self.build_url(&format!("/playQueues/{}/items", queue_id));
        let mut url = Url::parse(&base).context("Failed to parse URL")?;

        url.query_pairs_mut()
            .append_pair("uri", uri)
            .append_pair("next", if next { "1" } else { "0" });

        let url_str = url.to_string();
        debug!("Adding to play queue {}: {}", queue_id, url_str);

        let response = self
            .client
            .put(&url_str)
            .header("X-Plex-Token", token_header(&self.token))
            .header("Accept", "application/json")
            .send()
            .await.map_err(request_error)
            .context("Failed to add to play queue")?;

        if !response.status().is_success() {
            return Err(anyhow::anyhow!(
                "HTTP error: {} adding to play queue",
                response.status()
            ));
        }

        let wrapper: PlexApiResponse<PlayQueue> = response
            .bounded_json(MAX_PLEX_BYTES)
            .await
            .context("Failed to parse play queue response")?;

        Ok(wrapper.container)
    }

    /// Remove an item from a play queue.
    ///
    /// # Arguments
    /// * `queue_id` - The play queue ID
    /// * `item_id` - The `playQueueItemID` of the item to remove
    #[instrument(skip(self))]
    pub async fn remove_from_play_queue(&self, queue_id: i64, item_id: i64) -> Result<()> {
        let path = format!("/playQueues/{}/items/{}", queue_id, item_id);
        debug!("Removing item {} from play queue {}", item_id, queue_id);
        self.delete(&path)
            .await
            .context("Failed to remove item from play queue")
    }

    /// Move an item within a play queue.
    ///
    /// # Arguments
    /// * `queue_id` - The play queue ID
    /// * `item_id` - The `playQueueItemID` to move
    /// * `after_item_id` - Move it after this `playQueueItemID` (0 = move to front)
    #[instrument(skip(self))]
    pub async fn move_play_queue_item(
        &self,
        queue_id: i64,
        item_id: i64,
        after_item_id: i64,
    ) -> Result<()> {
        let path = format!(
            "/playQueues/{}/items/{}/move?after={}",
            queue_id, item_id, after_item_id
        );
        debug!(
            "Moving item {} in queue {} after {}",
            item_id, queue_id, after_item_id
        );

        let response = self
            .client
            .put(&self.build_url(&path))
            .header("X-Plex-Token", token_header(&self.token))
            .header("Accept", "application/json")
            .send()
            .await.map_err(request_error)
            .context("Failed to move play queue item")?;

        if !response.status().is_success() {
            return Err(anyhow::anyhow!(
                "HTTP error: {} moving play queue item",
                response.status()
            ));
        }

        Ok(())
    }

    /// Delete a play queue.
    #[instrument(skip(self))]
    pub async fn delete_play_queue(&self, queue_id: i64) -> Result<()> {
        let path = format!("/playQueues/{}", queue_id);
        debug!("Deleting play queue {}", queue_id);
        self.delete(&path)
            .await
            .context("Failed to delete play queue")
    }

    /// Resolve the station key for an artist.
    ///
    /// Tries three strategies in order:
    ///   1. `GET /library/metadata/{id}?includeStations=1` → inline `Station[0].key`
    ///   2. `GET /library/metadata/{id}/stations`          → first station playlist key
    ///   3. UUID-based fallback (same as track radio)       → always succeeds
    async fn resolve_artist_station_key(&self, rating_key: i64) -> String {
        // Strategy 1: inline stations via ?includeStations=1
        let path = format!(
            "/library/metadata/{}?includeStations=1&excludeFields=summary",
            rating_key
        );
        if let Ok(container) = self.get::<MediaContainer<MetaWithStations>>(&path).await {
            if let Some(key) = container
                .metadata
                .into_iter()
                .next()
                .and_then(|m| m.stations.into_iter().next())
                .map(|s| s.key)
                .filter(|k| !k.is_empty())
            {
                debug!("Artist station key (inline): {}", key);
                return key;
            }
        }

        // Strategy 2: dedicated /stations sub-resource
        let path2 = format!("/library/metadata/{}/stations", rating_key);
        if let Ok(container) = self.get::<MediaContainer<StationRef>>(&path2).await {
            if let Some(s) = container.metadata.into_iter().next().filter(|s| !s.key.is_empty()) {
                debug!("Artist station key (/stations): {}", s.key);
                return s.key;
            }
        }

        // Strategy 3: UUID-based fallback (may still work for some servers)
        let fallback = Self::track_station_key(rating_key);
        debug!("Artist station key (UUID fallback): {}", fallback);
        fallback
    }

    /// Build the radio station key for a track/album (UUID-based, no server call).
    fn track_station_key(rating_key: i64) -> String {
        format!(
            "/library/metadata/{}/station/{}?type=10",
            rating_key,
            Uuid::new_v4(),
        )
    }

    /// Fetch up to 20 tracks from a playlist and return a pseudo-randomly chosen rating_key.
    ///
    /// Called once per `create_radio_queue("playlist", ...)` invocation (including each
    /// automatic refill), so successive calls use different seeds and cover the playlist's
    /// full sonic range over time.
    async fn playlist_sample_track(&self, playlist_id: i64) -> Result<i64> {
        let tracks = self.get_playlist_items(playlist_id, Some(20), Some(0)).await?;
        if tracks.is_empty() {
            return Err(anyhow::anyhow!("Playlist {} has no tracks", playlist_id));
        }
        // Pseudo-random: subsecond nanoseconds mod count — no extra dependency needed.
        let idx = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .subsec_nanos() as usize
            % tracks.len();
        Ok(tracks[idx].rating_key)
    }

    /// Build a `library://abc/station/` URI for play queue creation.
    ///
    /// This is the universally compatible format used by PlexAmp for servers
    /// that don't advertise the "universal" PlayQueue feature.  The station
    /// key (with appended radio params) is percent-encoded inside the path.
    fn build_radio_uri(station_key: &str, rating_key: i64, include_external: bool, degrees: i32) -> String {
        // Append radio params — use ? or & depending on whether the station key
        // already carries query params (track station keys end with ?type=10).
        let sep = if station_key.contains('?') { '&' } else { '?' };
        let station_with_params = format!(
            "{}{}initialRatingKey={}&includeSharedContent={}&maxDegreesOfSeparation={}",
            station_key,
            sep,
            rating_key,
            if include_external { 1 } else { 0 },
            degrees,
        );
        // PlexAmp: `library://abc/station/${encodeURIComponent(path)}`
        let encoded: String = url::form_urlencoded::byte_serialize(station_with_params.as_bytes()).collect();
        format!("library://abc/station/{}", encoded)
    }

    /// Create a radio play queue seeded from any Plex item.
    ///
    /// Mirrors PlexAmp's `buildRadioPlayQueueUri` + `buildPlayQueueUri` logic:
    /// resolves the station key (server-side for artists, UUID-based for
    /// tracks/albums), wraps it in `library://abc/station/{encoded}`, then
    /// POSTs to `/playQueues?type=audio&uri=…`.
    ///
    /// # Arguments
    /// * `rating_key` - Rating key of the seed item
    /// * `item_type`  - `"artist"` | `"album"` | `"playlist"` | `"track"` (or any other value → track path)
    /// * `degrees_of_separation` - Diversity: `None` = unlimited (-1)
    /// * `include_external` - Include tracks from external/cloud sources
    /// * `shuffle` - Shuffle the initial queue
    #[instrument(skip(self))]
    pub async fn create_radio_queue(
        &self,
        rating_key: i64,
        item_type: &str,
        degrees_of_separation: Option<i32>,
        include_external: bool,
        shuffle: bool,
    ) -> Result<PlayQueue> {
        let degrees = degrees_of_separation.unwrap_or(-1);

        // For albums/playlists, resolve a real track as the sonic seed:
        // - Album: first track (album-level station URIs return only metadata, no audio)
        // - Playlist: pseudo-random track from the first 20 items so each refill call
        //   samples a different sonic neighbourhood and covers the playlist's full range.
        let seed_key = match item_type {
            "album" => match self.album_tracks(rating_key).await {
                Ok(tracks) if !tracks.is_empty() => {
                    debug!("Album radio: using first track {} as seed", tracks[0].rating_key);
                    tracks[0].rating_key
                }
                _ => rating_key,
            },
            "playlist" => match self.playlist_sample_track(rating_key).await {
                Ok(key) => {
                    debug!("Playlist radio: sampled track {} as seed", key);
                    key
                }
                _ => rating_key,
            },
            _ => rating_key,
        };

        let station_key = if item_type == "artist" {
            self.resolve_artist_station_key(rating_key).await
        } else {
            Self::track_station_key(seed_key)
        };

        let radio_uri = Self::build_radio_uri(&station_key, seed_key, include_external, degrees);
        debug!("Creating radio queue: ratingKey={} seedKey={} uri={}", rating_key, seed_key, radio_uri);
        self.create_play_queue(&radio_uri, shuffle, 0).await
    }

    /// Create a smart-shuffle (Guest DJ) play queue.
    ///
    /// Same as `create_radio_queue` but sends `smartShuffle=1` and a DJ-specific
    /// `X-Plex-Client-Identifier` header so Plex enables its AI-curated Guest DJ mode.
    ///
    /// # Arguments
    /// * `rating_key` - Rating key of the seed item
    /// * `item_type`  - `"artist"` | `"track"` | `"album"`
    /// * `dj_mode`    - DJ personality key (e.g. `"stretch"`, `"twin"`, `"twofer"`, `"anno"`, `"groupie"`)
    /// * `degrees_of_separation` - Diversity (`None` = unlimited)
    /// * `include_external` - Include external sources
    /// * `client_id` - Stable installation UUID; `-transient-deejay` is appended
    #[instrument(skip(self))]
    pub async fn create_smart_shuffle_queue(
        &self,
        rating_key: i64,
        item_type: &str,
        dj_mode: Option<&str>,
        degrees_of_separation: Option<i32>,
        include_external: bool,
        client_id: &str,
    ) -> Result<PlayQueue> {
        let degrees = degrees_of_separation.unwrap_or(-1);

        let station_key = if item_type == "artist" {
            self.resolve_artist_station_key(rating_key).await
        } else {
            Self::track_station_key(rating_key)
        };

        let radio_uri = Self::build_radio_uri(&station_key, rating_key, include_external, degrees);
        let dj_id = format!("{}-transient-deejay", client_id);
        debug!("Creating smart shuffle queue: ratingKey={} djId={} djMode={:?}", rating_key, dj_id, dj_mode);

        let base = self.build_url("/playQueues");
        let mut url = Url::parse(&base).context("Failed to parse playQueues URL")?;
        url.query_pairs_mut()
            .append_pair("type", "audio")
            .append_pair("uri", &radio_uri)
            .append_pair("shuffle", "1")
            .append_pair("smartShuffle", "1");
        if let Some(mode) = dj_mode {
            url.query_pairs_mut().append_pair("shuffleMode", mode);
        }
        url.query_pairs_mut()
            .append_pair("includeChapters", "1")
            .append_pair("includeRelated", "1");

        let response = self
            .client
            .post(&url.to_string())
            .header("X-Plex-Token", token_header(&self.token))
            .header("X-Plex-Client-Identifier", &dj_id)
            .header("Accept", "application/json")
            .send()
            .await.map_err(request_error)
            .context("Failed to create smart shuffle queue")?;

        if !response.status().is_success() {
            return Err(anyhow::anyhow!(
                "HTTP {} creating smart shuffle queue",
                response.status()
            ));
        }

        let wrapper: PlexApiResponse<PlayQueue> = response
            .bounded_json(MAX_PLEX_BYTES)
            .await
            .context("Failed to parse smart shuffle queue response")?;

        debug!("Created smart shuffle queue ID={}", wrapper.container.id);
        Ok(wrapper.container)
    }

    /// Build a library URI for a single track or item.
    ///
    /// Convenience helper: given a section UUID and a track/album/playlist rating key,
    /// returns the URI suitable for `create_play_queue`.
    pub fn build_item_uri(section_uuid: &str, item_key: &str) -> String {
        format!("library://{}/item/{}", section_uuid, item_key)
    }

    /// Build a library URI for an album or playlist's children.
    pub fn build_directory_uri(section_uuid: &str, item_key: &str) -> String {
        format!("library://{}/directory/{}/children", section_uuid, item_key)
    }
}

#[cfg(test)]
mod contract_tests {
    use super::*;
    use super::super::{PlexClientConfig, Track, PlexMedia};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn fixture(body: &str, oversized: bool) -> (PlexClient, tokio::sync::oneshot::Receiver<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let body = body.to_owned();
        let (send, receive) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = vec![0; 8192];
            let size = stream.read(&mut request).await.unwrap();
            let _ = send.send(String::from_utf8_lossy(&request[..size]).into_owned());
            let length = if oversized { MAX_PLEX_BYTES + 1 } else { body.len() };
            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
            let _ = stream.write_all(body.as_bytes()).await;
        });
        let client = PlexClient::new(PlexClientConfig { base_url: format!("http://{address}"), token: "synthetic-token".into(), ..Default::default() }).unwrap();
        (client, receive)
    }

    async fn queue_action(client: &PlexClient, action: usize) -> Result<PlayQueue> {
        match action {
            0 => client.create_play_queue("/library/metadata/7", false, 0).await,
            1 => client.add_to_play_queue(55, "/library/metadata/7", true).await,
            2 => client.create_smart_shuffle_queue(7, "track", Some("sonicallySimilar"), None, false, "fixture-installation").await,
            _ => client.get_play_queue(55).await,
        }
    }

    #[tokio::test]
    async fn queue_response_envelopes_and_occurrences_survive_all_entry_points() {
        let body = r#"{"MediaContainer":{"playQueueID":"55","playQueueTotalCount":"2","Metadata":[{"ratingKey":"7","title":"First"},{"ratingKey":"7","title":"Second"}]}}"#;
        for action in 0..4 {
            let (client, receive) = fixture(body, false).await;
            let queue = queue_action(&client, action).await.unwrap();
            assert_eq!(queue.id, 55);
            assert_eq!(queue.total_count, 2);
            assert_eq!(queue.items.iter().map(|track| track.title.as_str()).collect::<Vec<_>>(), ["First", "Second"]);
            let request = receive.await.unwrap();
            assert!(request.to_ascii_lowercase().contains("accept: application/json"));
            assert!(request.contains(if action == 1 { "PUT /playQueues/55/items?" } else if action == 3 { "GET /playQueues/55?" } else { "POST /playQueues?" }));
        }
    }

    #[tokio::test]
    async fn oversized_queue_bodies_are_rejected_before_reading() {
        for action in 0..4 {
            let (client, _) = fixture("", true).await;
            let error = queue_action(&client, action).await.unwrap_err().to_string();
            assert!(error.contains("Failed to parse") || error.contains("Failed to fetch"));
            assert!(!error.contains("synthetic-token"));
        }
    }

    #[tokio::test]
    async fn sonic_and_collection_reads_unwrap_the_real_media_container() {
        let body = r#"{"MediaContainer":{"Metadata":[{"type":"track","ratingKey":"7","title":"First"},{"type":"track","ratingKey":"7","title":"Second"}]}}"#;
        for action in 0..4 {
            let (client, receive) = fixture(body, false).await;
            let titles = match action {
                0 => client.sonically_similar::<Track>(7, Some(2), None).await.unwrap().into_iter().map(|track| track.title).collect::<Vec<_>>(),
                1 => client.sonic_adventure(1, 7, 9, Some(2)).await.unwrap().into_iter().map(|track| track.title).collect(),
                2 => client.track_radio(1, 7, Some(2), None).await.unwrap().into_iter().map(|track| track.title).collect(),
                _ => client.get_collection_items(1, Some(2), Some(3)).await.unwrap().into_iter().map(|item| match item { PlexMedia::Track(track) => track.title, _ => panic!("wrong mapped item") }).collect(),
            };
            assert_eq!(titles, ["First", "Second"]);
            if action == 3 {
                let request = receive.await.unwrap().to_ascii_lowercase();
                assert!(request.contains("x-plex-container-size: 2"));
                assert!(request.contains("x-plex-container-start: 3"));
            }
        }
    }

    #[tokio::test]
    async fn direct_metadata_helpers_share_response_limits() {
        for action in 0..6 {
            let (client, _) = fixture("", true).await;
            let result = match action {
                0 => client.sonically_similar::<Track>(7, None, None).await.map(|_| ()),
                1 => client.sonic_adventure(1, 7, 9, None).await.map(|_| ()),
                2 => client.track_radio(1, 7, None, None).await.map(|_| ()),
                3 => client.get_collection_items(1, None, None).await.map(|_| ()),
                4 => client.get_active_sessions(1).await.map(|_| ()),
                _ => client.get_item_history(7).await.map(|_| ()),
            };
            assert!(format!("{:#}", result.unwrap_err()).contains("byte limit"));
        }
    }

    #[tokio::test]
    async fn playlist_pages_retain_total_size_and_duplicate_occurrences() {
        let body = r#"{"MediaContainer":{"totalSize":"500","Metadata":[{"ratingKey":"7","playlistItemID":"10","title":"First"},{"ratingKey":"7","playlistItemID":"11","title":"Second"}]}}"#;
        let (client, receive) = fixture(body, false).await;
        let page = client.get_playlist_items_page(5, Some(2), Some(100)).await.unwrap();
        assert_eq!(page.total, 500);
        assert_eq!(page.items.len(), 2);
        assert_eq!(page.items[0].playlist_item_id, Some(10));
        assert_eq!(page.items[1].playlist_item_id, Some(11));
        let request = receive.await.unwrap();
        assert!(request.contains("X-Plex-Container-Size=2"));
        assert!(request.contains("X-Plex-Container-Start=100"));
        let (client, _) = fixture(body, false).await;
        assert_eq!(client.get_playlist_items(5, Some(2), Some(100)).await.unwrap().len(), 2);
        let (client, _) = fixture(r#"{"MediaContainer":{"Metadata":[{"ratingKey":"7","title":"First"}]}}"#, false).await;
        let unknown = client.get_playlist_items_page(5, Some(2), Some(100)).await.unwrap();
        assert_eq!(unknown.items.len(), 1);
        assert_eq!(unknown.total, 0);
        let (client, _) = fixture(r#"{"MediaContainer":{}}"#, false).await;
        let page = client.get_playlist_items_page(5, Some(2), Some(100)).await.unwrap();
        assert_eq!(page.items.len(), 0);
        assert_eq!(page.total, 0);
        let (client, _) = fixture(r#"{"MediaContainer":{"totalSize":0}}"#, false).await;
        assert_eq!(client.get_playlist_items_page(5, Some(2), Some(100)).await.unwrap().total, 0);
    }

    #[tokio::test]
    async fn typed_search_filters_returned_hubs_without_inventing_query_parameters() {
        let body = r#"{"MediaContainer":{"Hub":[{"title":"Results","hubIdentifier":"fixture","Metadata":[{"type":"track","ratingKey":"7","title":"Track"},{"type":"artist","ratingKey":"8","title":"Artist"}]}]}}"#;
        for (kind, expected) in [(None, 2), (Some("8"), 1), (Some("artist"), 1), (Some("9"), 0)] {
            let (client, receive) = fixture(body, false).await;
            let items = client.search(1, "fixture", kind, None, None, Some(50)).await.unwrap();
            assert_eq!(items.len(), expected);
            let request = receive.await.unwrap();
            assert!(request.contains("sectionId=1"));
            assert!(!request.contains("type="));
            if kind == Some("8") { assert_eq!(items[0].item_type(), "artist"); }
        }
    }
}

#[cfg(test)]
mod integration_tests {
    use serde_json::Value;
    use super::super::{PlexClient, PlexClientConfig, PlexMedia};

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

    async fn get_music_section(c: &PlexClient) -> (i64, Option<String>) {
        let sections = c.get_all_sections().await.expect("get_all_sections failed");
        let section = sections
            .iter()
            .find(|s| s.title == "Music")
            .expect("No 'Music' section found");
        (section.key, section.uuid.clone())
    }

    async fn get_track_key(c: &PlexClient, section_id: i64) -> Option<i64> {
        match c.recently_added(section_id, Some("track"), Some(2)).await {
            Ok(items) => items.into_iter().find_map(|m| {
                if let PlexMedia::Track(t) = m { Some(t.rating_key) } else { None }
            }),
            Err(_) => None,
        }
    }

    #[tokio::test]
    async fn test_play_queue_lifecycle() {
        let client = get_client();
        let (section_id, uuid) = get_music_section(&client).await;

        let track_key = match get_track_key(&client, section_id).await {
            Some(k) => k,
            None => { println!("No tracks available — skipping play queue test"); return; }
        };

        // Build URI using the section UUID if available, otherwise use direct path
        let uri = match &uuid {
            Some(u) => PlexClient::build_item_uri(u, &format!("/library/metadata/{}", track_key)),
            None => format!("/library/metadata/{}", track_key),
        };

        // Create queue
        let queue = match client.create_play_queue(&uri, false, 0).await {
            Ok(q) => {
                println!("Created play queue {} with {} items", q.id, q.total_count);
                q
            }
            Err(e) => {
                println!("create_play_queue failed: {}", e);
                return;
            }
        };

        let queue_id = queue.id;

        // Fetch the queue
        match client.get_play_queue(queue_id).await {
            Ok(q) => println!("Fetched play queue {}, selected_item={}", q.id, q.selected_item_id),
            Err(e) => println!("get_play_queue failed: {}", e),
        }

        // Add another track if we have a second one
        let items = client.recently_added(section_id, Some("track"), Some(5)).await.unwrap_or_default();
        let second_key = items.into_iter().filter_map(|m| {
            if let PlexMedia::Track(t) = m { Some(t.rating_key) } else { None }
        }).find(|&k| k != track_key);

        if let Some(k2) = second_key {
            let uri2 = match &uuid {
                Some(u) => PlexClient::build_item_uri(u, &format!("/library/metadata/{}", k2)),
                None => format!("/library/metadata/{}", k2),
            };
            match client.add_to_play_queue(queue_id, &uri2, false).await {
                Ok(q) => println!("Added track {} to queue, now {} items", k2, q.total_count),
                Err(e) => println!("add_to_play_queue failed: {}", e),
            }
        }

        // Delete the queue
        match client.delete_play_queue(queue_id).await {
            Ok(()) => println!("Deleted play queue {}", queue_id),
            Err(e) => println!("delete_play_queue failed: {}", e),
        }
    }

    // -----------------------------------------------------------------------
    // Radio queue tests with known items
    //
    // Artist: 544945   Album: 637022   Track: 548362   Section: 5
    // -----------------------------------------------------------------------

    const RADIO_ARTIST_KEY: i64 = 544945;
    const RADIO_ALBUM_KEY:  i64 = 637022;
    const RADIO_TRACK_KEY:  i64 = 548362;

    /// Inspect what station key resolve_artist_station_key returns for the known artist.
    /// Prints which strategy succeeded and what URI is built from the resolved key.
    #[tokio::test]
    async fn test_resolve_artist_station_key() {
        let client = get_client();
        println!("resolve_artist_station_key for artist {}", RADIO_ARTIST_KEY);
        let key = client.resolve_artist_station_key(RADIO_ARTIST_KEY).await;
        println!("  → station key: {}", key);

        // Also show the full URI that would be sent to /playQueues
        let uri = PlexClient::build_radio_uri(&key, RADIO_ARTIST_KEY, false, -1);
        println!("  → radio URI: {}", uri);
    }

    /// Test create_radio_queue for the known TRACK.
    /// This is the simplest case — a track key should always work.
    #[tokio::test]
    async fn test_create_radio_queue_for_track() {
        let client = get_client();
        println!("create_radio_queue: track pivot={}", RADIO_TRACK_KEY);
        match client.create_radio_queue(RADIO_TRACK_KEY, "track", None, false, false).await {
            Ok(q) => {
                println!("  → OK: queue id={} items={}", q.id, q.items.len());
                for t in q.items.iter().take(5) {
                    println!("    - [{}] {} — {}", t.rating_key, t.grandparent_title, t.title);
                }
            }
            Err(e) => println!("  → FAIL: {}", e),
        }
    }

    /// Test create_radio_queue for the known ARTIST.
    /// This goes through resolve_artist_station_key + build_radio_uri + POST /playQueues.
    #[tokio::test]
    async fn test_create_radio_queue_for_artist() {
        let client = get_client();
        println!("create_radio_queue: artist pivot={}", RADIO_ARTIST_KEY);
        match client.create_radio_queue(RADIO_ARTIST_KEY, "artist", None, false, false).await {
            Ok(q) => {
                println!("  → OK: queue id={} items={}", q.id, q.items.len());
                for t in q.items.iter().take(5) {
                    println!("    - [{}] {} — {}", t.rating_key, t.grandparent_title, t.title);
                }
                if q.items.is_empty() {
                    println!("  ! Queue empty — server did not produce tracks for this URI");
                }
            }
            Err(e) => println!("  → FAIL: {}", e),
        }
    }

    /// Test create_radio_queue for the known ALBUM.
    #[tokio::test]
    async fn test_create_radio_queue_for_album() {
        let client = get_client();
        println!("create_radio_queue: album pivot={}", RADIO_ALBUM_KEY);
        match client.create_radio_queue(RADIO_ALBUM_KEY, "album", None, false, false).await {
            Ok(q) => {
                println!("  → OK: queue id={} items={}", q.id, q.items.len());
                for t in q.items.iter().take(5) {
                    println!("    - [{}] {} — {}", t.rating_key, t.grandparent_title, t.title);
                }
                if q.items.is_empty() {
                    println!("  ! Queue empty — server did not produce tracks for this URI");
                }
            }
            Err(e) => println!("  → FAIL: {}", e),
        }
    }

    /// Raw probe: what does GET /library/metadata/{artistId}?includeStations=1 return?
    /// Prints the full response body (truncated) so we can see the exact JSON shape.
    #[tokio::test]
    async fn test_artist_include_stations_raw() {
        let client = get_client();
        let url = client.build_url(&format!(
            "/library/metadata/{}?includeStations=1&excludeFields=summary",
            RADIO_ARTIST_KEY
        ));
        println!("GET {}", url);
        let resp = client.client.get(&url)
            .header("X-Plex-Token", &client.token)
            .header("Accept", "application/json")
            .send().await.expect("request failed");
        println!("  Status: {}", resp.status());
        let body: serde_json::Value = resp.json().await.expect("parse failed");
        let body_str = serde_json::to_string_pretty(&body).unwrap_or_default();
        // Print up to 4000 chars so we can see Station arrays if present
        let truncated = if body_str.len() > 4000 { &body_str[..4000] } else { &body_str };
        println!("{}", truncated);
    }

    /// Raw probe: GET /library/sections/5/mix?pivot={trackKey}
    /// Shows the raw response for the sonic mix endpoint.
    #[tokio::test]
    async fn test_mix_endpoint_raw_track() {
        let client = get_client();
        let url = client.build_url(&format!(
            "/library/sections/5/mix?pivot={}&limit=5",
            RADIO_TRACK_KEY
        ));
        println!("GET {}", url);
        let resp = client.client.get(&url)
            .header("X-Plex-Token", &client.token)
            .header("Accept", "application/json")
            .send().await.expect("request failed");
        println!("  Status: {}", resp.status());
        let body: serde_json::Value = resp.json().await.expect("parse failed");
        let body_str = serde_json::to_string_pretty(&body).unwrap_or_default();
        let truncated = if body_str.len() > 4000 { &body_str[..4000] } else { &body_str };
        println!("{}", truncated);
    }

    /// Test create_radio_queue for a dynamically-fetched audio PLAYLIST.
    /// Fetches the first audio playlist with ≥1 track and verifies that
    /// the returned queue contains at least one playable item.
    #[tokio::test]
    async fn test_create_radio_queue_for_playlist() {
        use super::super::Playlist;
        let client = get_client();

        // Fetch the user's audio playlists (limit to 20 to keep it fast)
        let playlists: Vec<Playlist> = match client.list_playlists(0, Some(20)).await {
            Ok(p) => p,
            Err(e) => {
                println!("list_playlists failed: {} — skipping", e);
                return;
            }
        };

        // Pick the first one that has tracks
        let playlist = match playlists.iter().find(|p| p.leaf_count > 0) {
            Some(p) => p,
            None => {
                println!("No audio playlists with tracks found — skipping");
                return;
            }
        };

        println!(
            "Playlist radio test: '{}' (key={}, tracks={})",
            playlist.title, playlist.rating_key, playlist.leaf_count
        );

        match client.create_radio_queue(playlist.rating_key, "playlist", None, false, false).await {
            Ok(q) => {
                println!("  → OK: queue id={} items={}", q.id, q.items.len());
                for t in q.items.iter().take(5) {
                    println!("    - [{}] {} — {}", t.rating_key, t.grandparent_title, t.title);
                }
                let playable = q.items.iter().filter(|t| {
                    t.media.first()
                        .and_then(|m| m.parts.first())
                        .map_or(false, |p| !p.key.is_empty())
                }).count();
                println!("  → playable: {}/{}", playable, q.items.len());
                assert!(q.items.len() > 0, "Expected at least 1 item in playlist radio queue");
            }
            Err(e) => println!("  → FAIL: {}", e),
        }
    }

    /// Raw probe: GET /library/sections/5/mix?pivot={artistKey}
    /// Reveals whether the /mix endpoint accepts artist keys.
    #[tokio::test]
    async fn test_mix_endpoint_raw_artist() {
        let client = get_client();
        let url = client.build_url(&format!(
            "/library/sections/5/mix?pivot={}&limit=5",
            RADIO_ARTIST_KEY
        ));
        println!("GET {}", url);
        let resp = client.client.get(&url)
            .header("X-Plex-Token", &client.token)
            .header("Accept", "application/json")
            .send().await.expect("request failed");
        println!("  Status: {}", resp.status());
        let body: serde_json::Value = resp.json().await.expect("parse failed");
        let body_str = serde_json::to_string_pretty(&body).unwrap_or_default();
        let truncated = if body_str.len() > 4000 { &body_str[..4000] } else { &body_str };
        println!("{}", truncated);
    }

    /// Probe: fetch a known track and dump the raw JSON
    /// to see where startRamp/endRamp appear (Track level? Stream level? Both?).
    /// Note: includeLoudnessRamps=1 is added globally by build_url().
    #[tokio::test]
    async fn test_loudness_ramps_raw() {
        let client = get_client();
        let url = client.build_url(&format!(
            "/library/metadata/{}",
            RADIO_TRACK_KEY
        ));
        println!("GET {}", url);
        let resp = client.client.get(&url)
            .header("X-Plex-Token", &client.token)
            .header("Accept", "application/json")
            .send().await.expect("request failed");
        println!("  Status: {}", resp.status());
        let body: serde_json::Value = resp.json().await.expect("parse failed");

        // Search for startRamp/endRamp anywhere in the JSON tree
        fn find_ramps(v: &Value, path: &str) {
            match v {
                Value::Object(map) => {
                    for (k, val) in map {
                        if k == "startRamp" || k == "endRamp" {
                            println!("  FOUND {}.{} = {:?}", path, k, val);
                        }
                        find_ramps(val, &format!("{}.{}", path, k));
                    }
                }
                Value::Array(arr) => {
                    for (i, val) in arr.iter().enumerate() {
                        find_ramps(val, &format!("{}[{}]", path, i));
                    }
                }
                _ => {}
            }
        }
        find_ramps(&body, "root");

        // Also dump the first track's top-level keys
        if let Some(track) = body.pointer("/MediaContainer/Metadata/0") {
            println!("\n  Track top-level keys:");
            if let Value::Object(map) = track {
                for k in map.keys() {
                    println!("    - {}", k);
                }
            }
        }
    }

    /// Probe: fetch a play queue and check for ramps (includeLoudnessRamps=1 added by build_url).
    #[tokio::test]
    async fn test_play_queue_ramps() {
        let client = get_client();
        let (_, uuid) = get_music_section(&client).await;
        let uri = match &uuid {
            Some(u) => PlexClient::build_item_uri(u, &format!("/library/metadata/{}", RADIO_TRACK_KEY)),
            None => format!("/library/metadata/{}", RADIO_TRACK_KEY),
        };
        let queue = match client.create_play_queue(&uri, false, 0).await {
            Ok(q) => q,
            Err(e) => { println!("create_play_queue failed: {}", e); return; }
        };

        // Check if the first track in the queue has ramps
        if let Some(track) = queue.items.first() {
            println!("Track {} '{}' by {}", track.rating_key, track.title, track.grandparent_title);
            println!("  start_ramp: {:?}", track.start_ramp);
            println!("  end_ramp:   {:?}", track.end_ramp);
            // Also check streams
            if let Some(media) = track.media.first() {
                if let Some(part) = media.parts.first() {
                    for stream in &part.streams {
                        if stream.stream_type == Some(2) {
                            println!("  stream.start_ramp: {:?}", stream.start_ramp);
                            println!("  stream.end_ramp:   {:?}", stream.end_ramp);
                        }
                    }
                }
            }
        }

        let _ = client.delete_play_queue(queue.id).await;
    }
}
