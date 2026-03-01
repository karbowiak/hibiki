//! Audio operations (sonic analysis, tracks, albums, artists)
#![allow(dead_code)]

use super::{PlexClient, MediaContainer, Track, Album, Playlist, Hub, LevelsContainer, Level};
use anyhow::{Result, Context};
use tracing::{debug, instrument};

/// Audio operations implementation
impl PlexClient {
    /// Get tracks/albums/artists sonically similar to a given item
    ///
    /// # Arguments
    /// * `rating_key` - Rating key of reference item
    /// * `limit` - Maximum number of results to return (default: 50)
    /// * `max_distance` - Maximum sonic distance (0.0 - 1.0, default: 0.25)
    ///
    /// # Returns
    /// * `Result<Vec<T>>` - List of sonically similar items
    ///
    /// # Generic Parameters
    /// * `T` - Type to deserialize into (Track, Album, or Artist)
    ///
    /// # Example
    /// ```no_run
    /// # use plex::{PlexClient, PlexClientConfig, Track};
    /// # tokio_test::block_on(async {
    /// let client = PlexClient::new(PlexClientConfig::default()).unwrap();
    /// let similar_tracks: Vec<Track> = client
    ///     .sonically_similar(12345, Some(50), Some(0.25))
    ///     .await?;
    /// # Ok::<(), anyhow::Error>(())
    /// # });
    /// ```
    #[instrument(skip(self))]
    pub async fn sonically_similar<T>(
        &self,
        rating_key: i64,
        limit: Option<i32>,
        max_distance: Option<f64>,
    ) -> Result<Vec<T>>
    where
        T: serde::de::DeserializeOwned + std::default::Default,
    {
        let path = format!("/library/metadata/{}/nearest", rating_key);
        let mut params = Vec::new();

        if let Some(limit) = limit {
            params.push(("limit", limit.to_string()));
        }
        if let Some(max_distance) = max_distance {
            params.push(("maxDistance", max_distance.to_string()));
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

        debug!("Sonic similarity request to {}", url);

        // Make direct HTTP request since we have a full URL
        let response = self
            .client
            .get(&url)
            .header("X-Plex-Token", &self.token)
            .header("Accept", "application/json")
            .send()
            .await
            .context("Sonic similarity request failed")?;

        debug!("Response status: {}", response.status());

        if !response.status().is_success() {
            return Err(anyhow::anyhow!(
                "HTTP error: {} for URL: {}",
                response.status(),
                url
            ));
        }

        let container: MediaContainer<T> = response
            .json()
            .await
            .context("Failed to parse JSON response")?;

        Ok(container.metadata)
    }

    /// Generate a sonic adventure between two tracks
    ///
    /// # Arguments
    /// * `section_id` - Library section ID
    /// * `from_track_id` - Starting track rating key
    /// * `to_track_id` - Target track rating key
    /// * `limit` - Maximum number of tracks in adventure (default: 20)
    ///
    /// # Returns
    /// * `Result<Vec<Track>>` - List of tracks forming the adventure
    ///
    /// # Example
    /// ```no_run
    /// # use plex::{PlexClient, PlexClientConfig, Track};
    /// # tokio_test::block_on(async {
    /// let client = PlexClient::new(PlexClientConfig::default()).unwrap();
    /// let adventure: Vec<Track> = client
    ///     .sonic_adventure(1, 12345, 67890, Some(20))
    ///     .await?;
    /// # Ok::<(), anyhow::Error>(())
    /// # });
    /// ```
    #[instrument(skip(self))]
    pub async fn sonic_adventure(
        &self,
        section_id: i64,
        from_track_id: i64,
        to_track_id: i64,
        limit: Option<i32>,
    ) -> Result<Vec<Track>> {
        let path = format!("/library/sections/{}/nearest", section_id);
        let mut params = vec![
            ("pivot", from_track_id.to_string()),
            ("to", to_track_id.to_string()),
        ];

        if let Some(limit) = limit {
            params.push(("limit", limit.to_string()));
        }

        let query = params
            .iter()
            .map(|(k, v)| format!("{}={}", k, v))
            .collect::<Vec<_>>()
            .join("&");

        let url = format!("{}?{}", self.build_url(&path), query);

        debug!("Sonic adventure request to {}", url);

        let response = self
            .client
            .get(&url)
            .header("X-Plex-Token", &self.token)
            .header("Accept", "application/json")
            .send()
            .await
            .context("Sonic adventure request failed")?;

        debug!("Response status: {}", response.status());

        if !response.status().is_success() {
            return Err(anyhow::anyhow!(
                "HTTP error: {} for URL: {}",
                response.status(),
                url
            ));
        }

        let container: MediaContainer<Track> = response
            .json()
            .await
            .context("Failed to parse JSON response")?;

        Ok(container.metadata)
    }

    /// Generate a radio playlist from a track
    ///
    /// # Arguments
    /// * `section_id` - Library section ID
    /// * `rating_key` - Starting track rating key
    /// * `limit` - Maximum number of tracks in playlist (default: 50)
    /// * `max_distance` - Maximum sonic distance (default: 0.25)
    ///
    /// # Returns
    /// * `Result<Vec<Track>>` - List of tracks for radio
    #[instrument(skip(self))]
    pub async fn track_radio(
        &self,
        section_id: i64,
        rating_key: i64,
        limit: Option<i32>,
        max_distance: Option<f64>,
    ) -> Result<Vec<Track>> {
        let path = format!("/library/sections/{}/mix", section_id);
        let mut params = vec![("pivot", rating_key.to_string())];

        if let Some(limit) = limit {
            params.push(("limit", limit.to_string()));
        }
        if let Some(max_distance) = max_distance {
            params.push(("maxDistance", max_distance.to_string()));
        }

        let query = params
            .iter()
            .map(|(k, v)| format!("{}={}", k, v))
            .collect::<Vec<_>>()
            .join("&");

        let url = format!("{}?{}", self.build_url(&path), query);

        debug!("Track radio request to {}", url);

        let response = self
            .client
            .get(&url)
            .header("X-Plex-Token", &self.token)
            .header("Accept", "application/json")
            .send()
            .await
            .context("Track radio request failed")?;

        debug!("Response status: {}", response.status());

        if !response.status().is_success() {
            return Err(anyhow::anyhow!(
                "HTTP error: {} for URL: {}",
                response.status(),
                url
            ));
        }

        let container: MediaContainer<Track> = response
            .json()
            .await
            .context("Failed to parse JSON response")?;

        Ok(container.metadata)
    }

    /// Get all tracks for an album
    ///
    /// # Arguments
    /// * `rating_key` - Album rating key
    ///
    /// # Returns
    /// * `Result<Vec<Track>>` - List of tracks in the album
    #[instrument(skip(self))]
    pub async fn album_tracks(&self, rating_key: i64) -> Result<Vec<Track>> {
        let path = format!("/library/metadata/{}/children", rating_key);

        debug!("Fetching album tracks from {}", path);

        let container: MediaContainer<Track> = self.get(&path).await
            .context("Failed to fetch album tracks")?;

        Ok(container.metadata)
    }

    /// Get a specific track by rating key
    ///
    /// # Arguments
    /// * `rating_key` - Track rating key
    ///
    /// # Returns
    /// * `Result<Track>` - The track
    #[instrument(skip(self))]
    pub async fn get_track(&self, rating_key: i64) -> Result<Track> {
        let path = format!("/library/metadata/{}", rating_key);

        debug!("Fetching track from {}", path);

        let container: MediaContainer<Track> = self.get(&path).await
            .context("Failed to fetch track")?;

        container
            .metadata
            .into_iter()
            .next()
            .context("Track not found")
    }

    /// Get an artist by rating key
    #[instrument(skip(self))]
    pub async fn get_artist(&self, rating_key: i64) -> Result<super::Artist> {
        let path = format!("/library/metadata/{}", rating_key);
        let container: MediaContainer<super::Artist> = self.get(&path).await
            .with_context(|| format!("Failed to fetch artist {}", rating_key))?;
        container.metadata.into_iter().next().context("Artist not found")
    }

    /// Get an album by rating key, including reviews and enriched metadata.
    #[instrument(skip(self))]
    pub async fn get_album(&self, rating_key: i64) -> Result<Album> {
        let path = format!("/library/metadata/{}?includeReviews=1", rating_key);
        let container: MediaContainer<Album> = self.get(&path).await
            .with_context(|| format!("Failed to fetch album {}", rating_key))?;
        container.metadata.into_iter().next().context("Album not found")
    }

    /// Get albums for an artist using the section-specific endpoint.
    ///
    /// Uses `/library/sections/{section_id}/all?artist.id={id}&type=9` which
    /// mirrors the Plex Web approach. Supports a `format` parameter for filtering
    /// by album type (e.g. `"EP,Single"` for singles and EPs).
    ///
    /// # Arguments
    /// * `section_id` - Library section ID (Music section)
    /// * `rating_key` - Artist rating key
    /// * `format` - Optional comma-separated format filter (e.g. `"EP,Single"`)
    ///              When `None`, returns full albums (excludes EP and Single format)
    #[instrument(skip(self))]
    pub async fn artist_albums_in_section(
        &self,
        section_id: i64,
        rating_key: i64,
        format: Option<&str>,
    ) -> Result<Vec<Album>> {
        let mut path = format!(
            "/library/sections/{}/all?artist.id={}&type=9&resolveTags=1&sort=year:desc,originallyAvailableAt:desc",
            section_id, rating_key
        );
        if let Some(fmt) = format {
            path.push_str(&format!("&format={}", fmt));
        } else {
            // No format filter means all albums (let caller decide what to show)
        }
        debug!("Fetching artist albums in section {} for artist {}", section_id, rating_key);
        let container: MediaContainer<Album> = self.get(&path).await
            .context("Failed to fetch artist albums")?;
        Ok(container.metadata)
    }

    /// Get albums for an artist, with an optional format filter.
    ///
    /// Falls back to `/library/all?type=9&artist.id={id}` for servers where
    /// `/children` returns empty. Use `artist_albums_in_section` when sectionId
    /// is available for better deduplication.
    ///
    /// # Arguments
    /// * `rating_key` - Artist rating key
    /// * `format_filter` - Optional format filter:
    ///   - `None` → all albums
    ///   - `Some("Single")` → only singles
    ///   - `Some("!Single")` → excludes singles (full albums + EPs)
    #[instrument(skip(self))]
    pub async fn artist_albums(&self, rating_key: i64, format_filter: Option<&str>) -> Result<Vec<Album>> {
        let mut path = format!("/library/all?type=9&artist.id={}", rating_key);
        if let Some(fmt) = format_filter {
            if let Some(stripped) = fmt.strip_prefix('!') {
                path.push_str(&format!("&album.format!={}", stripped));
            } else {
                path.push_str(&format!("&album.format={}", fmt));
            }
        }

        debug!("Fetching artist albums from {}", path);

        let container: MediaContainer<Album> = self.get(&path).await
            .context("Failed to fetch artist albums")?;

        Ok(container.metadata)
    }

    /// Get popular tracks for an artist, sorted by play/rating count.
    ///
    /// Uses `/library/all?type=10&artist.id={id}&sort=ratingCount:desc` —
    /// the correct Plex endpoint for popular tracks sorted by play count.
    ///
    /// # Arguments
    /// * `rating_key` - Artist rating key
    /// * `limit` - Maximum number of tracks to return (default: 100)
    #[instrument(skip(self))]
    pub async fn artist_popular_tracks(
        &self,
        rating_key: i64,
        limit: Option<i32>,
    ) -> Result<Vec<Track>> {
        let limit_val = limit.unwrap_or(100);
        let path = format!(
            "/library/all?type=10&artist.id={}&sort=ratingCount:desc&limit={}",
            rating_key, limit_val
        );

        debug!("Fetching artist popular tracks from {}", path);

        let container: MediaContainer<Track> = self.get(&path).await
            .context("Failed to fetch artist popular tracks")?;

        Ok(container.metadata)
    }

    /// Get popular tracks for an artist using the `/popularLeaves` endpoint.
    ///
    /// This is the correct PlexAmp-style endpoint (uses play counts / external ratings).
    #[instrument(skip(self))]
    pub async fn artist_popular_leaves(
        &self,
        rating_key: i64,
        limit: Option<i32>,
    ) -> Result<Vec<Track>> {
        let mut path = format!("/library/metadata/{}/popularLeaves", rating_key);
        if let Some(l) = limit {
            path = format!("{}?limit={}", path, l);
        }
        debug!("Fetching artist popular leaves from {}", path);
        let container: MediaContainer<Track> = self.get(&path).await
            .context("Failed to fetch artist popular leaves")?;
        Ok(container.metadata)
    }

    /// Get metadata-based similar artists for an artist.
    ///
    /// Returns artists from the metadata provider (AllMusic/MusicBrainz) that
    /// exist in the library.
    #[instrument(skip(self))]
    pub async fn artist_similar(&self, rating_key: i64) -> Result<Vec<super::Artist>> {
        let path = format!("/library/metadata/{}/similar", rating_key);
        debug!("Fetching similar artists for {}", rating_key);
        let container: MediaContainer<super::Artist> = self.get(&path).await
            .context("Failed to fetch similar artists")?;
        Ok(container.metadata)
    }

    /// Get sonically similar artists for a given artist.
    ///
    /// Uses `/library/metadata/{id}/nearest` which performs sonic analysis to
    /// find artists with similar sound. This is the same endpoint used by
    /// Plex Web and PlexAmp for the "Sonically Similar" section.
    ///
    /// # Arguments
    /// * `rating_key` - Artist rating key
    /// * `limit` - Max artists to return (default: 30)
    /// * `max_distance` - Max sonic distance 0.0-1.0 (default: 0.25)
    #[instrument(skip(self))]
    pub async fn artist_sonically_similar(
        &self,
        rating_key: i64,
        limit: Option<i32>,
        max_distance: Option<f64>,
    ) -> Result<Vec<super::Artist>> {
        let limit_val = limit.unwrap_or(30);
        let max_dist = max_distance.unwrap_or(0.25);
        let path = format!(
            "/library/metadata/{}/nearest?limit={}&maxDistance={}&excludeParentID=-1",
            rating_key, limit_val, max_dist
        );
        debug!("Fetching sonically similar artists for {}", rating_key);
        let container: MediaContainer<super::Artist> = self.get(&path).await
            .context("Failed to fetch sonically similar artists")?;
        Ok(container.metadata)
    }

    /// Get popular tracks for an artist using the section-specific endpoint.
    ///
    /// Uses `group=title` for server-side deduplication and filters out
    /// compilations and live albums. This matches the Plex Web approach.
    ///
    /// # Arguments
    /// * `section_id` - Library section ID (Music section)
    /// * `rating_key` - Artist rating key
    /// * `limit` - Max tracks to return (default: 10)
    #[instrument(skip(self))]
    pub async fn artist_popular_tracks_in_section(
        &self,
        section_id: i64,
        rating_key: i64,
        limit: Option<i32>,
    ) -> Result<Vec<Track>> {
        let limit_val = limit.unwrap_or(10);
        let path = format!(
            "/library/sections/{}/all?album.subformat!=Compilation,Live&artist.id={}&group=title&limit={}&ratingCount>=1&resolveTags=1&sort=ratingCount:desc&type=10",
            section_id, rating_key, limit_val
        );
        debug!("Fetching popular tracks in section {} for artist {}", section_id, rating_key);
        let container: MediaContainer<Track> = self.get(&path).await
            .context("Failed to fetch artist popular tracks")?;
        Ok(container.metadata)
    }

    // -----------------------------------------------------------------------
    // Phase 2: PlexAmp / Sonic station features
    // -----------------------------------------------------------------------

    /// Get radio stations seeded from an artist.
    ///
    /// Returns playlists of `playlistType = "audio"` and `radio = true`.
    /// Corresponds to `GET /library/metadata/{id}/stations`.
    #[instrument(skip(self))]
    pub async fn artist_stations(&self, rating_key: i64) -> Result<Vec<Playlist>> {
        let path = format!("/library/metadata/{}/stations", rating_key);
        debug!("Fetching artist stations for {}", rating_key);
        let container: MediaContainer<Playlist> = self.get(&path)
            .await
            .context("Failed to fetch artist stations")?;
        Ok(container.metadata)
    }

    /// Get all music stations available in a library section.
    ///
    /// Returns discovery hubs from `GET /hubs/sections/{id}?includeStations=1`.
    /// Hubs whose `hub_identifier` contains "stations" hold the station playlists.
    /// Uses the same parameters as PlexAmp to get full station directory metadata.
    #[instrument(skip(self))]
    pub async fn section_stations(&self, section_id: i64) -> Result<Vec<Hub>> {
        let path = format!(
            "/hubs/sections/{}?includeStations=1&includeStationDirectories=1&count=8",
            section_id
        );
        debug!("Fetching section stations for section {}", section_id);
        let container: MediaContainer<Hub> = self.get(&path)
            .await
            .context("Failed to fetch section stations")?;
        Ok(container.hub)
    }

    /// Compute a sonic path (adventure) between two tracks.
    ///
    /// Uses the `/computePath` endpoint which finds intermediate tracks that
    /// bridge the sonic gap between `from_id` and `to_id`.
    ///
    /// Corresponds to `GET /library/sections/{id}/computePath?pivot={from}&to={to}`.
    #[instrument(skip(self))]
    pub async fn compute_sonic_path(
        &self,
        section_id: i64,
        from_id: i64,
        to_id: i64,
    ) -> Result<Vec<Track>> {
        let path = format!(
            "/library/sections/{}/computePath?pivot={}&to={}",
            section_id, from_id, to_id
        );
        debug!(
            "Computing sonic path in section {} from {} to {}",
            section_id, from_id, to_id
        );
        let container: MediaContainer<Track> = self.get(&path)
            .await
            .context("Failed to compute sonic path")?;
        Ok(container.metadata)
    }

    /// Get loudness/peak level data for a media stream.
    ///
    /// `stream_id` is the `id` from `track.media[0].parts[0]` (or a stream ID
    /// from the part's stream list). `sub_sample` controls the resolution
    /// (128 = one sample per 128 audio frames, default used by PlexAmp).
    ///
    /// Corresponds to `GET /library/streams/{id}/levels?subSample={n}`.
    #[instrument(skip(self))]
    pub async fn get_stream_levels(
        &self,
        stream_id: i64,
        sub_sample: Option<i32>,
    ) -> Result<Vec<Level>> {
        let sub = sub_sample.unwrap_or(128);
        let path = format!("/library/streams/{}/levels?subSample={}", stream_id, sub);
        debug!("Fetching stream levels for stream {}", stream_id);
        let container: LevelsContainer = self.get(&path)
            .await
            .context("Failed to fetch stream levels")?;
        Ok(container.levels)
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_build_query_string() {
        let params = vec![
            ("limit", "50".to_string()),
            ("maxDistance", "0.25".to_string()),
        ];

        let query = params
            .iter()
            .map(|(k, v)| format!("{}={}", k, v))
            .collect::<Vec<_>>()
            .join("&");

        assert_eq!(query, "limit=50&maxDistance=0.25");
    }
}

#[cfg(test)]
mod integration_tests {
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

    async fn get_music_section_id(c: &PlexClient) -> i64 {
        let sections = c.get_all_sections().await.expect("get_all_sections failed");
        sections
            .iter()
            .find(|s| s.title == "Music")
            .map(|s| s.key)
            .expect("No 'Music' section found")
    }

    /// Get a track and an artist rating key from recently added tracks.
    async fn get_test_keys(c: &PlexClient, section_id: i64) -> Option<(i64, i64, i64)> {
        let items = c.recently_added(section_id, Some("track"), Some(5)).await.ok()?;
        let track = items.into_iter().find_map(|m| {
            if let PlexMedia::Track(t) = m { Some(t) } else { None }
        })?;
        let track_key = track.rating_key;
        let album_key: i64 = track.parent_key.trim_start_matches("/library/metadata/")
            .parse().ok()?;
        let artist_key: i64 = track.grandparent_key.trim_start_matches("/library/metadata/")
            .parse().ok()?;
        Some((track_key, album_key, artist_key))
    }

    #[tokio::test]
    async fn test_get_track() {
        let client = get_client();
        let section_id = get_music_section_id(&client).await;
        let Some((track_key, _, _)) = get_test_keys(&client, section_id).await else {
            println!("No tracks available — skipping");
            return;
        };
        match client.get_track(track_key).await {
            Ok(t) => println!("Got track: {} — {}", t.grandparent_title, t.title),
            Err(e) => println!("get_track failed: {}", e),
        }
    }

    #[tokio::test]
    async fn test_get_artist_albums() {
        let client = get_client();
        let section_id = get_music_section_id(&client).await;
        let Some((_, _, artist_key)) = get_test_keys(&client, section_id).await else {
            println!("No tracks available — skipping");
            return;
        };
        match client.artist_albums(artist_key, None).await {
            Ok(albums) => println!("Got {} albums for artist {}", albums.len(), artist_key),
            Err(e) => println!("artist_albums failed: {}", e),
        }
    }

    #[tokio::test]
    async fn test_get_album_tracks() {
        let client = get_client();
        let section_id = get_music_section_id(&client).await;
        let Some((_, album_key, _)) = get_test_keys(&client, section_id).await else {
            println!("No tracks available — skipping");
            return;
        };
        match client.album_tracks(album_key).await {
            Ok(tracks) => println!("Got {} tracks in album {}", tracks.len(), album_key),
            Err(e) => println!("album_tracks failed: {}", e),
        }
    }

    #[tokio::test]
    async fn test_get_artist_popular_tracks() {
        let client = get_client();
        let section_id = get_music_section_id(&client).await;
        let Some((_, _, artist_key)) = get_test_keys(&client, section_id).await else {
            println!("No tracks available — skipping");
            return;
        };
        match client.artist_popular_tracks(artist_key, Some(5)).await {
            Ok(tracks) => println!("Got {} popular tracks for artist {}", tracks.len(), artist_key),
            Err(e) => println!("artist_popular_tracks failed: {}", e),
        }
    }

    #[tokio::test]
    async fn test_get_sonically_similar() {
        let client = get_client();
        let section_id = get_music_section_id(&client).await;
        let Some((track_key, _, _)) = get_test_keys(&client, section_id).await else {
            println!("No tracks available — skipping");
            return;
        };
        match client.sonically_similar::<super::Track>(track_key, Some(5), None).await {
            Ok(tracks) => println!("Got {} sonically similar tracks", tracks.len()),
            Err(e) => println!("sonically_similar failed (may need sonic analysis): {}", e),
        }
    }

    #[tokio::test]
    async fn test_get_track_radio() {
        let client = get_client();
        let section_id = get_music_section_id(&client).await;
        let Some((track_key, _, _)) = get_test_keys(&client, section_id).await else {
            println!("No tracks available — skipping");
            return;
        };
        match client.track_radio(section_id, track_key, Some(10), None).await {
            Ok(tracks) => println!("Got {} tracks in radio mix", tracks.len()),
            Err(e) => println!("track_radio failed: {}", e),
        }
    }

    #[tokio::test]
    async fn test_get_artist_stations() {
        let client = get_client();
        let section_id = get_music_section_id(&client).await;
        let Some((_, _, artist_key)) = get_test_keys(&client, section_id).await else {
            println!("No tracks available — skipping");
            return;
        };
        match client.artist_stations(artist_key).await {
            Ok(stations) => println!("Got {} artist stations", stations.len()),
            Err(e) => println!("artist_stations failed (may not be available): {}", e),
        }
    }

    #[tokio::test]
    async fn test_get_section_stations() {
        let client = get_client();
        let section_id = get_music_section_id(&client).await;
        match client.section_stations(section_id).await {
            Ok(hubs) => println!("Got {} station hubs for section {}", hubs.len(), section_id),
            Err(e) => println!("section_stations failed (may not be available): {}", e),
        }
    }

    #[tokio::test]
    async fn test_compute_sonic_path() {
        let client = get_client();
        let section_id = get_music_section_id(&client).await;
        let items = match client.recently_added(section_id, Some("track"), Some(5)).await {
            Ok(v) => v,
            Err(e) => { println!("recently_added failed: {}", e); return; }
        };
        let keys: Vec<i64> = items.into_iter().filter_map(|m| {
            if let PlexMedia::Track(t) = m { Some(t.rating_key) } else { None }
        }).collect();
        if keys.len() < 2 {
            println!("Need at least 2 tracks for sonic path — skipping");
            return;
        }
        match client.compute_sonic_path(section_id, keys[0], keys[1]).await {
            Ok(tracks) => println!("Sonic path has {} intermediate tracks", tracks.len()),
            Err(e) => println!("compute_sonic_path failed (may need analysis): {}", e),
        }
    }

    #[tokio::test]
    async fn test_get_stream_levels() {
        let client = get_client();
        let section_id = get_music_section_id(&client).await;
        let Some((track_key, _, _)) = get_test_keys(&client, section_id).await else {
            println!("No tracks available — skipping");
            return;
        };
        let track = match client.get_track(track_key).await {
            Ok(t) => t,
            Err(e) => { println!("get_track failed: {}", e); return; }
        };
        let stream_id = match track.media.first().and_then(|m| m.parts.first()) {
            Some(part) => part.id,
            None => { println!("No media parts found — skipping"); return; }
        };
        match client.get_stream_levels(stream_id, Some(128)).await {
            Ok(levels) => println!("Got {} level samples for stream {}", levels.len(), stream_id),
            Err(e) => println!("get_stream_levels failed (may need loudness analysis): {}", e),
        }
    }

    // Pinponpanpon — ratingKey 548757 on the test server (music section ID 5).
    // Used to verify artist page endpoints with a known artist that has
    // popular tracks, singles/EPs, and similar artists in the library.
    const PINPONPANPON_KEY: i64 = 548757;
    const MUSIC_SECTION_ID: i64 = 5;

    #[tokio::test]
    async fn test_pinponpanpon_popular_leaves() {
        let client = get_client();
        match client.artist_popular_leaves(PINPONPANPON_KEY, Some(10)).await {
            Ok(tracks) => {
                println!("Popular leaves for Pinponpanpon: {} tracks", tracks.len());
                for t in &tracks {
                    println!("  - {} | album: {} | duration: {}ms | rating: {:?}",
                        t.title, t.parent_title, t.duration, t.user_rating);
                }
                assert!(!tracks.is_empty(), "Expected popular tracks for Pinponpanpon");
            }
            Err(e) => println!("artist_popular_leaves failed: {}", e),
        }
    }

    /// Verify the album format-filter approach: non-singles vs singles via album.format filter.
    #[tokio::test]
    async fn test_pinponpanpon_albums_format_split() {
        let client = get_client();

        // Full albums / EPs (everything that is NOT a Single)
        let non_singles = client.artist_albums(PINPONPANPON_KEY, Some("!Single")).await
            .expect("non-singles failed");
        println!("Non-singles (albums/EPs): {}", non_singles.len());
        let mut seen = std::collections::HashSet::new();
        for a in non_singles.iter().filter(|a| seen.insert(a.rating_key)) {
            println!("  - {} ({})", a.title, a.year);
        }

        // Singles
        let singles = client.artist_albums(PINPONPANPON_KEY, Some("Single")).await
            .expect("singles failed");
        println!("Singles: {}", singles.len());
        seen.clear();
        for a in singles.iter().filter(|a| seen.insert(a.rating_key)) {
            println!("  - {} ({})", a.title, a.year);
        }

        assert!(!singles.is_empty() || !non_singles.is_empty(), "Expected releases for Pinponpanpon");
    }

    #[tokio::test]
    async fn test_pinponpanpon_similar() {
        let client = get_client();
        match client.artist_similar(PINPONPANPON_KEY).await {
            Ok(artists) => {
                println!("Similar artists for Pinponpanpon: {}", artists.len());
                for a in &artists {
                    println!("  - {} (ratingKey: {})", a.title, a.rating_key);
                }
            }
            Err(e) => println!("artist_similar failed: {}", e),
        }
    }

    /// Test the ACTUAL Plex web app approach for albums:
    /// /library/metadata/{id}/children?excludeAllLeaves=1
    #[tokio::test]
    async fn test_pinponpanpon_children_exclude_leaves() {
        use serde_json::Value;

        let client = get_client();
        let url = client.build_url(&format!(
            "/library/metadata/{}/children?excludeAllLeaves=1",
            PINPONPANPON_KEY
        ));
        let resp = client.client.get(&url)
            .header("X-Plex-Token", &client.token)
            .header("Accept", "application/json")
            .send().await.expect("request failed");
        let body: Value = resp.json().await.expect("parse failed");
        let mc = body.get("MediaContainer").unwrap();
        let size = mc.get("size");
        println!("/children?excludeAllLeaves=1 size: {:?}", size);
        if let Some(items) = mc.get("Metadata").and_then(|v| v.as_array()) {
            println!("  Metadata count: {}", items.len());
            for item in items.iter().take(5) {
                let title = item.get("title").and_then(|v| v.as_str()).unwrap_or("?");
                let format_val = item.get("Format").and_then(|v| v.as_array())
                    .and_then(|a| a.first())
                    .and_then(|f| f.get("tag"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("Album");
                println!("  - {} [{}]", title, format_val);
            }
        }
        if let Some(dirs) = mc.get("Directory").and_then(|v| v.as_array()) {
            println!("  Directory count: {}", dirs.len());
        }
    }

    /// Test the ACTUAL Plex web app endpoint for singles/EPs:
    /// /library/sections/{id}/all?artist.id={id}&type=9&format=EP,Single
    #[tokio::test]
    async fn test_pinponpanpon_singles_eps_format_param() {
        let client = get_client();
        let path = format!(
            "/library/sections/{}/all?artist.id={}&type=9&format=EP,Single&sort=year:desc",
            MUSIC_SECTION_ID, PINPONPANPON_KEY
        );
        let container: super::super::MediaContainer<super::super::Album> =
            client.get(&path).await.expect("request failed");
        println!("Singles/EPs via format=EP,Single: {} results", container.metadata.len());
        let mut seen = std::collections::HashSet::new();
        for a in container.metadata.iter().filter(|a| seen.insert(a.rating_key)) {
            println!("  - {} ({}) subformat={:?}", a.title, a.year,
                a.subformat.iter().map(|t| t.tag.as_str()).collect::<Vec<_>>());
        }
    }

    /// Test the ACTUAL Plex web app popular tracks endpoint:
    /// /library/sections/{id}/all?album.subformat!=Compilation,Live&artist.id={id}&group=title&limit=100&ratingCount>=1&sort=ratingCount:desc&type=10
    #[tokio::test]
    async fn test_pinponpanpon_popular_tracks_actual() {
        let client = get_client();
        let path = format!(
            "/library/sections/{}/all?album.subformat!=Compilation,Live&artist.id={}&group=title&limit=10&ratingCount>=1&resolveTags=1&sort=ratingCount:desc&type=10",
            MUSIC_SECTION_ID, PINPONPANPON_KEY
        );
        let container: super::super::MediaContainer<super::super::Track> =
            client.get(&path).await.expect("request failed");
        println!("Popular tracks (actual method): {} results", container.metadata.len());
        for t in &container.metadata {
            println!("  - {} | ratingCount={:?}", t.title, t.rating_count);
        }
    }

    /// Test the /related endpoint (actual Plex web app approach for related hubs).
    /// /library/metadata/{id}/related?includeAugmentations=1&includeExternalMetadata=1&includeMeta=1
    #[tokio::test]
    async fn test_pinponpanpon_related_endpoint() {
        use serde_json::Value;

        let client = get_client();
        let url = client.build_url(&format!(
            "/library/metadata/{}/related?includeAugmentations=1&includeExternalMetadata=1&includeMeta=1",
            PINPONPANPON_KEY
        ));
        let resp = client.client.get(&url)
            .header("X-Plex-Token", &client.token)
            .header("Accept", "application/json")
            .send().await.expect("request failed");
        let status = resp.status();
        let body: Value = resp.json().await.expect("parse failed");
        let mc = body.get("MediaContainer").unwrap();
        println!("/related status: {}", status);
        println!("/related MediaContainer keys: {:?}", mc.as_object().map(|o| o.keys().collect::<Vec<_>>()));

        // Check each possible key
        for key in &["Hub", "Metadata", "Directory"] {
            if let Some(arr) = mc.get(key).and_then(|v| v.as_array()) {
                println!("  '{}': {} items", key, arr.len());
                for item in arr.iter().take(5) {
                    let title = item.get("title").and_then(|v| v.as_str()).unwrap_or("?");
                    let hub_id = item.get("hubIdentifier").and_then(|v| v.as_str()).unwrap_or("?");
                    let typ = item.get("type").and_then(|v| v.as_str()).unwrap_or("?");
                    let size = item.get("size");
                    println!("    - title={} id={} type={} size={:?}", title, hub_id, typ, size);
                }
            }
        }
    }

    /// Test the ACTUAL Plex web app sonically similar artists endpoint:
    /// /library/metadata/{id}/nearest?limit=30&maxDistance=0.25&excludeParentID=-1
    /// Called on the ARTIST's ratingKey, not a track.
    #[tokio::test]
    async fn test_pinponpanpon_sonically_similar_artists() {
        use serde_json::Value;

        let client = get_client();
        let url = client.build_url(&format!(
            "/library/metadata/{}/nearest?limit=30&maxDistance=0.25&excludeParentID=-1&includeMeta=1",
            PINPONPANPON_KEY
        ));
        let resp = client.client.get(&url)
            .header("X-Plex-Token", &client.token)
            .header("Accept", "application/json")
            .send().await.expect("request failed");
        let status = resp.status();
        println!("/nearest status: {}", status);
        let body: Value = resp.json().await.expect("parse failed");
        let mc = body.get("MediaContainer").unwrap();
        println!("MediaContainer keys: {:?}", mc.as_object().map(|o| o.keys().collect::<Vec<_>>()));
        println!("size: {:?}", mc.get("size"));

        for key in &["Metadata", "Directory", "Hub"] {
            if let Some(arr) = mc.get(key).and_then(|v| v.as_array()) {
                println!("  '{}': {} items", key, arr.len());
                for item in arr.iter().take(5) {
                    let title = item.get("title").and_then(|v| v.as_str()).unwrap_or("?");
                    let typ = item.get("type").and_then(|v| v.as_str()).unwrap_or("?");
                    let distance = item.get("distance");
                    println!("    - type={} title={} distance={:?}", typ, title, distance);
                }
            }
        }
    }

    /// Test filtering albums by format using the section search.
    /// Tries to separate singles from full albums using the album.format filter.
    #[tokio::test]
    async fn test_pinponpanpon_albums_format_filter() {
        use serde_json::Value;

        let client = get_client();
        let section_id = get_music_section_id(&client).await;

        // Try to get only "Single" format albums using URL filter
        for filter_key in &["album.format", "album.subformat"] {
            let path = format!(
                "/library/sections/{}/all?type=9&artist.id={}&{}=Single",
                section_id, PINPONPANPON_KEY, filter_key
            );
            let url = client.build_url(&path);
            let resp = client.client.get(&url)
                .header("X-Plex-Token", &client.token)
                .header("Accept", "application/json")
                .send().await.expect("request failed");
            let body: Value = resp.json().await.expect("parse failed");
            let count = body.get("MediaContainer")
                .and_then(|mc| mc.get("Metadata"))
                .and_then(|v| v.as_array())
                .map(|a| a.len())
                .unwrap_or(0);
            let size = body.get("MediaContainer").and_then(|mc| mc.get("size")).unwrap_or(&serde_json::Value::Null);
            println!("Filter '{}=Single': count={} size={}", filter_key, count, size);
        }

        // Also check: albums with no format (full albums) - try album.format!=Single
        let path = format!(
            "/library/sections/{}/all?type=9&artist.id={}&album.format!=Single",
            section_id, PINPONPANPON_KEY
        );
        let url = client.build_url(&path);
        let resp = client.client.get(&url)
            .header("X-Plex-Token", &client.token)
            .header("Accept", "application/json")
            .send().await.expect("request failed");
        let body: Value = resp.json().await.expect("parse failed");
        let mc = body.get("MediaContainer").unwrap();
        println!("Filter 'album.format!=Single': size={:?}", mc.get("size"));
        if let Some(items) = mc.get("Metadata").and_then(|v| v.as_array()) {
            println!("  {} results", items.len());
            for item in items.iter().take(3) {
                println!("  - {}", item.get("title").and_then(|v| v.as_str()).unwrap_or("?"));
            }
        }
    }

    /// Verify albums via /library/all?type=9&artist.id={id} and check if Format tag is included.
    #[tokio::test]
    async fn test_pinponpanpon_albums_via_library_all() {
        use serde_json::Value;

        let client = get_client();
        let path = format!("/library/all?type=9&artist.id={}", PINPONPANPON_KEY);
        let url = client.build_url(&path);
        let resp = client.client.get(&url)
            .header("X-Plex-Token", &client.token)
            .header("Accept", "application/json")
            .send().await.expect("request failed");
        let body: Value = resp.json().await.expect("parse failed");
        if let Some(items) = body.get("MediaContainer").and_then(|mc| mc.get("Metadata")).and_then(|v| v.as_array()) {
            println!("List endpoint album count: {}", items.len());
            for item in items.iter().take(4) {
                let title = item.get("title").and_then(|v| v.as_str()).unwrap_or("?");
                let format_val = item.get("Format");
                let subformat_val = item.get("Subformat");
                println!("  list: title={} Format={:?} Subformat={:?}", title, format_val, subformat_val);
            }
        }
    }

    /// Check Format/Subformat fields in detailed album metadata.
    /// Fetches multiple albums to see which ones have these tags.
    #[tokio::test]
    async fn test_album_format_fields() {
        use serde_json::Value;

        let client = get_client();
        // Get several albums for pinponpanpon
        let path = format!("/library/all?type=9&artist.id={}", PINPONPANPON_KEY);
        let container: super::super::MediaContainer<super::super::Album> =
            client.get(&path).await.expect("list failed");

        println!("Checking Format/Subformat fields for {} albums:", container.metadata.len());
        // Test first 6 unique albums (skip duplicates by collecting seen ratingKeys)
        let mut seen = std::collections::HashSet::new();
        let unique_albums: Vec<_> = container.metadata.iter()
            .filter(|a| seen.insert(a.rating_key))
            .take(8)
            .collect();

        for album in &unique_albums {
            let detail_path = format!("/library/metadata/{}", album.rating_key);
            let url = client.build_url(&detail_path);
            let resp = client.client.get(&url)
                .header("X-Plex-Token", &client.token)
                .header("Accept", "application/json")
                .send().await.expect("request failed");
            let body: Value = resp.json().await.expect("parse failed");
            if let Some(item) = body.get("MediaContainer").and_then(|mc| mc.get("Metadata"))
                .and_then(|v| v.as_array()).and_then(|a| a.first()) {
                let title = item.get("title").and_then(|v| v.as_str()).unwrap_or("?");
                let leaf_count = item.get("leafCount").and_then(|v| v.as_i64());
                let format_val = item.get("Format");
                let subformat_val = item.get("Subformat");
                println!("  {} (leafCount={:?}) | Format={:?} | Subformat={:?}",
                    title, leaf_count, format_val, subformat_val);
            }
        }
    }

    /// Verify popular tracks via /library/all?type=10&artist.id={id}&sort=ratingCount:desc
    #[tokio::test]
    async fn test_pinponpanpon_popular_tracks_via_library_all() {
        let client = get_client();
        let path = format!(
            "/library/all?type=10&artist.id={}&sort=ratingCount:desc&limit=10",
            PINPONPANPON_KEY
        );
        let container: super::super::MediaContainer<super::super::Track> =
            client.get(&path).await.expect("request failed");
        println!("Popular tracks via /library/all: {}", container.metadata.len());
        for t in &container.metadata {
            println!("  - {} | ratingCount={:?}", t.title, t.rating_count);
        }
    }

    /// Raw JSON diagnostic — dumps the structure of /library/metadata/{id}/children
    /// so we can see exactly which container key albums appear under.
    #[tokio::test]
    async fn test_pinponpanpon_children_raw() {
        use serde_json::Value;

        let client = get_client();
        let url = client.build_url(&format!("/library/metadata/{}/children", PINPONPANPON_KEY));
        let resp = client
            .client
            .get(&url)
            .header("X-Plex-Token", &client.token)
            .header("Accept", "application/json")
            .send()
            .await
            .expect("request failed");

        let status = resp.status();
        println!("Status: {}", status);
        let body: Value = resp.json().await.expect("parse failed");

        // Print top-level keys
        if let Some(obj) = body.as_object() {
            println!("Top-level keys: {:?}", obj.keys().collect::<Vec<_>>());
        }

        // Print full body (truncated)
        let body_str = serde_json::to_string_pretty(&body).unwrap_or_default();
        let truncated = if body_str.len() > 3000 { &body_str[..3000] } else { &body_str };
        println!("Full body (truncated):\n{}", truncated);

        // Drill into MediaContainer
        if let Some(mc) = body.get("MediaContainer") {
            if let Some(obj) = mc.as_object() {
                println!("MediaContainer keys: {:?}", obj.keys().collect::<Vec<_>>());
                println!("size: {:?}", mc.get("size"));

                // Check each possible array key
                for key in &["Metadata", "Directory", "Hub"] {
                    if let Some(arr) = mc.get(key).and_then(|v| v.as_array()) {
                        println!("'{}' count: {}", key, arr.len());
                        if let Some(first) = arr.first() {
                            let type_field = first.get("type").and_then(|v| v.as_str()).unwrap_or("?");
                            let title = first.get("title").and_then(|v| v.as_str()).unwrap_or("?");
                            let subformat = first.get("Subformat");
                            println!("  First item: type={} title={} Subformat={:?}", type_field, title, subformat);
                        }
                    }
                }
            }
        }
    }

    /// Verify that artist_albums returns directory results when children endpoint
    /// uses Directory instead of Metadata.
    #[tokio::test]
    async fn test_pinponpanpon_albums_directory() {
        let client = get_client();
        let path = format!("/library/metadata/{}/children", PINPONPANPON_KEY);
        // Use get() which unwraps MediaContainer<Album>
        let container: super::super::MediaContainer<super::super::Album> = client.get(&path).await.expect("get failed");
        println!("Metadata count: {}", container.metadata.len());
        println!("Directory count: {}", container.directory.len());
        println!("Hub count: {}", container.hub.len());

        // Print whichever has items
        let items = if !container.metadata.is_empty() {
            &container.metadata
        } else if !container.directory.is_empty() {
            &container.directory
        } else {
            println!("All three keys are empty!");
            return;
        };

        for a in items {
            let sf = if a.subformat.is_empty() {
                "Album".to_string()
            } else {
                a.subformat.iter().map(|t| t.tag.as_str()).collect::<Vec<_>>().join(", ")
            };
            println!("  - {} ({}) → [{}]", a.title, a.year, sf);
        }
    }
}
