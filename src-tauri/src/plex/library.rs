//! Library operations (sections, browse, search, tags)
#![allow(dead_code)]

use super::{PlexClient, MediaContainer, Hub, LibrarySection, PlexMedia, Track, Album};
use super::playlist::SearchFilter;
use anyhow::{Result, Context};
use serde::{Serialize, Deserialize};
use serde::de::DeserializeOwned;
use tracing::{debug, instrument};

/// Character for browsing by first letter
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Character {
    /// Character (A-Z, "#", etc.)
    #[serde(default)]
    pub character: String,
}

/// Tag for genres, moods, styles
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Tag {
    /// Tag name — Plex returns this as `title` in the genre/mood/style directory
    #[serde(alias = "tag", rename(deserialize = "title"), default)]
    pub tag: String,
    /// Number of items with this tag
    #[serde(rename = "count", default, deserialize_with = "crate::plex::models::serde_string_or_i64_opt::deserialize")]
    pub count: Option<i64>,
}

#[derive(Deserialize)]
struct RatedPageContainer {
    #[serde(flatten)] container: MediaContainer<PlexMedia>,
    #[serde(default, deserialize_with = "super::models::serde_string_or_i64_opt::deserialize")]
    offset: Option<i64>,
}
#[derive(Deserialize)]
struct MixPageContainer {
    #[serde(flatten)] container: MediaContainer<Track>,
    #[serde(default, deserialize_with = "super::models::serde_string_or_i64_opt::deserialize")]
    offset: Option<i64>,
}

/// Library operations implementation
impl PlexClient {
    /// One bounded, rated collection page. UI browsing must never drain the endpoint.
    pub async fn rated_items_page(&self, section_id: i64, kind: &str, offset: i32, limit: i32) -> Result<(Vec<PlexMedia>, i64)> {
        let media_type = match kind { "artist" => "8", "album" => "9", "track" => "10", _ => anyhow::bail!("Unsupported rated collection") };
        anyhow::ensure!(offset >= 0 && (1..=500).contains(&limit), "Invalid rated collection page");
        let params = vec![
            ("type".into(), media_type.into()), ("userRating>>".into(), "0".into()),
            ("sort".into(), "lastRatedAt:desc".into()),
            ("X-Plex-Container-Start".into(), offset.to_string()), ("X-Plex-Container-Size".into(), limit.to_string()),
        ];
        let url = build_url_from_params(&self.build_url(&format!("/library/sections/{section_id}/all")), &params);
        let page: RatedPageContainer = self.get_url(&url).await?;
        anyhow::ensure!(page.offset.is_none_or(|start|start == i64::from(offset)), "Plex repeated a rated collection page");
        let container = page.container;
        anyhow::ensure!(container.metadata.len() <= limit as usize, "Plex ignored rated collection pagination");
        Ok((container.metadata, container.total_size.unwrap_or(0)))
    }

    pub async fn mix_tracks_page(&self, key: &str, offset: i32, limit: i32) -> Result<super::playlist::PlaylistItemsPage> {
        anyhow::ensure!(key.starts_with('/') && !key.starts_with("//") && offset >= 0 && (1..=500).contains(&limit), "Invalid mix page");
        let parsed = url::Url::parse(&format!("http://plex.invalid{key}"))?;
        let mut params: Vec<(String, String)> = parsed.query_pairs().filter(|(name, _)| !matches!(name.as_ref(), "X-Plex-Container-Start" | "X-Plex-Container-Size" | "type")).map(|(k,v)| (k.into_owned(),v.into_owned())).collect();
        params.extend([("type".into(), "10".into()), ("X-Plex-Container-Start".into(), offset.to_string()), ("X-Plex-Container-Size".into(), limit.to_string())]);
        let url = build_url_from_params(&self.build_url(parsed.path()), &params);
        let page: MixPageContainer = self.get_url(&url).await?;
        anyhow::ensure!(page.offset.is_none_or(|start|start == i64::from(offset)), "Plex repeated a mix page");
        let container = page.container;
        anyhow::ensure!(container.metadata.len() <= limit as usize, "Plex ignored mix pagination");
        Ok(super::playlist::PlaylistItemsPage { items: container.metadata, total: container.total_size.unwrap_or(0), offset: Some(i64::from(offset)) })
    }
    /// Get all library sections
    ///
    /// # Returns
    /// * `Result<Vec<LibrarySection>>` - List of all library sections
    ///
    /// # Example
    /// ```no_run
    /// # use plex::{PlexClient, PlexClientConfig, LibrarySection};
    /// # tokio_test::block_on(async {
    /// let client = PlexClient::new(PlexClientConfig::default()).unwrap();
    /// let sections: Vec<LibrarySection> = client.get_all_sections().await?;
    /// # Ok::<(), anyhow::Error>(())
    /// # });
    /// ```
    #[instrument(skip(self))]
    pub async fn get_all_sections(&self) -> Result<Vec<LibrarySection>> {
        let url = self.build_url("/library/sections");
        debug!("Fetching library sections from {}", url);

        let container: MediaContainer<LibrarySection> = self
            .get_url(&url)
            .await
            .context("Failed to fetch library sections")?;

        // Library sections are returned under the "Directory" key (not "Metadata")
        Ok(container.directory)
    }

    /// Get a specific library section
    ///
    /// # Arguments
    /// * `section_id` - Library section ID
    ///
    /// # Returns
    /// * `Result<LibrarySection>` - The library section
    #[instrument(skip(self))]
    pub async fn get_section(&self, section_id: i64) -> Result<LibrarySection> {
        // /sections/{id} is a browsing interstitial (Directory keys such as
        // "all" and "genre"), not a LibrarySection record with its stable UUID.
        let url = self.build_url("/library/sections");
        debug!("Fetching library section {} from {}", section_id, url);

        let container: MediaContainer<LibrarySection> = self
            .get_url(&url)
            .await
            .with_context(|| format!("Failed to fetch library section {}", section_id))?;

        container
            .directory
            .into_iter()
            .chain(container.metadata)
            .find(|section| section.key == section_id)
            .context("Section not found")
    }

    /// Browse a library section by type
    ///
    /// # Arguments
    /// * `section_id` - Library section ID
    /// * `libtype` - Media type: "track", "album", or "artist"
    /// * `filters` - Optional search filters
    /// * `sort` - Optional sort string (e.g., "addedAt:desc", "title:asc")
    /// * `limit` - Optional limit on number of results
    /// * `offset` - Optional offset for pagination
    ///
    /// # Returns
    /// * `Result<Vec<PlexMedia>>` - List of media items
    ///
    /// # Example
    /// ```no_run
    /// # use plex::{PlexClient, PlexClientConfig, SearchFilter};
    /// # tokio_test::block_on(async {
    /// let client = PlexClient::new(PlexClientConfig::default()).unwrap();
    /// let filters = vec![SearchFilter::Genre("Rock".to_string())];
    /// let tracks = client
    ///     .browse_section(1, Some("track"), Some(&filters), Some("addedAt:desc"), Some(50), None)
    ///     .await?;
    /// # Ok::<(), anyhow::Error>(())
    /// # });
    /// ```
    #[instrument(skip(self, filters))]
    pub async fn browse_section(
        &self,
        section_id: i64,
        libtype: Option<&str>,
        filters: Option<&[SearchFilter]>,
        sort: Option<&str>,
        limit: Option<i32>,
        offset: Option<i32>,
    ) -> Result<Vec<PlexMedia>> {
        let mut params = Vec::new();

        if let Some(libtype) = libtype {
            params.push(("type".to_string(), libtype.to_string()));
        }

        if let Some(sort) = sort {
            params.push(("sort".to_string(), sort.to_string()));
        }

        if let Some(limit) = limit {
            params.push(("limit".to_string(), limit.to_string()));
        }

        if let Some(offset) = offset {
            params.push(("offset".to_string(), offset.to_string()));
        }

        if let Some(filters) = filters {
            for filter in filters {
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
                params.push(("filter".to_string(), param));
            }
        }

        let path = format!("/library/sections/{}/all", section_id);
        let url = build_url_from_params(&self.build_url(&path), &params);

        debug!("Browsing section {} with URL: {}", section_id, url);

        let container: MediaContainer<PlexMedia> = self
            .get_url(&url)
            .await
            .with_context(|| format!("Failed to browse section {}", section_id))?;

        Ok(container.metadata)
    }

    /// Search within a library section
    ///
    /// # Arguments
    /// * `section_id` - Library section ID
    /// * `query` - Search query string
    /// * `libtype` - Optional media type: "track", "album", or "artist"
    /// * `filters` - Optional search filters
    /// * `sort` - Optional sort string (e.g., "addedAt:desc", "title:asc")
    /// * `limit` - Optional limit on number of results
    ///
    /// # Returns
    /// * `Result<Vec<PlexMedia>>` - List of matching media items
    ///
    /// # Example
    /// ```no_run
    /// # use plex::{PlexClient, PlexClientConfig, SearchFilter};
    /// # tokio_test::block_on(async {
    /// let client = PlexClient::new(PlexClientConfig::default()).unwrap();
    /// let filters = vec![SearchFilter::YearGte(2000)];
    /// let results = client
    ///     .search(1, "Beatles", Some("track"), Some(&filters), None, None)
    ///     .await?;
    /// # Ok::<(), anyhow::Error>(())
    /// # });
    /// ```
    #[instrument(skip(self))]
    pub async fn search(
        &self,
        section_id: i64,
        query: &str,
        libtype: Option<&str>,
        _filters: Option<&[SearchFilter]>,
        _sort: Option<&str>,
        limit: Option<i32>,
    ) -> Result<Vec<PlexMedia>> {
        let wanted = match libtype {
            None => None,
            Some("8" | "artist") => Some("artist"),
            Some("9" | "album") => Some("album"),
            Some("10" | "track") => Some("track"),
            Some(_) => anyhow::bail!("Unsupported music search type"),
        };
        // Use /hubs/search which returns categorised results across all music types
        // (tracks, albums, artists) without requiring a numeric type parameter.
        let mut params = vec![
            ("query".to_string(), query.to_string()),
            ("sectionId".to_string(), section_id.to_string()),
        ];

        if let Some(limit) = limit {
            params.push(("limit".to_string(), limit.to_string()));
        }

        let url = build_url_from_params(&self.build_url("/hubs/search"), &params);

        debug!("Searching section {} with URL: {}", section_id, url);

        let container: MediaContainer<Hub> = self
            .get_url(&url)
            .await
            .with_context(|| format!("Failed to search for '{}'", query))?;

        // Flatten all hub metadata into a single list
        Ok(container.hub.into_iter().flat_map(|h| h.metadata)
            .filter(|item| wanted.is_none_or(|kind| item.item_type() == kind)).collect())
    }

    /// Fetch all items from a paginated Plex endpoint.
    /// Loops with X-Plex-Container-Start/Size until all items are collected.
    async fn fetch_all_paged<T: DeserializeOwned + Default>(
        &self,
        section_id: i64,
        base_params: &[(String, String)],
        page_size: i32,
    ) -> Result<Vec<T>> {
        let mut all_items = Vec::new();
        let mut offset: i32 = 0;

        loop {
            let mut params = base_params.to_vec();
            params.push(("X-Plex-Container-Size".to_string(), page_size.to_string()));
            params.push(("X-Plex-Container-Start".to_string(), offset.to_string()));

            let path = format!("/library/sections/{}/all", section_id);
            let url = build_url_from_params(&self.build_url(&path), &params);

            debug!("Fetching paged items (offset={}, size={}) from {}", offset, page_size, url);

            let container: MediaContainer<T> = self
                .get_url(&url)
                .await
                .with_context(|| format!("Failed to fetch paged items from section {}", section_id))?;

            let count = container.metadata.len() as i32;
            all_items.extend(container.metadata);

            let total = container.total_size.unwrap_or(all_items.len() as i64);
            if all_items.len() as i64 >= total || count < page_size {
                break;
            }
            offset += count;
        }

        Ok(all_items)
    }

    /// Get artists with a user rating set (liked/rated artists)
    #[instrument(skip(self))]
    pub async fn liked_artists(&self, section_id: i64, limit: Option<i32>) -> Result<Vec<super::models::Artist>> {
        if let Some(limit) = limit {
            let (items, _) = self.rated_items_page(section_id, "artist", 0, limit.clamp(1, 500)).await?;
            return Ok(items.into_iter().filter_map(|item| match item { PlexMedia::Artist(item) => Some(item), _ => None }).collect());
        }
        let params = vec![
            ("type".to_string(), "8".to_string()),
            ("sort".to_string(), "lastRatedAt:desc".to_string()),
            ("userRating>>".to_string(), "0".to_string()),
        ];
        let all: Vec<PlexMedia> = self.fetch_all_paged(section_id, &params, 100).await?;
        Ok(all.into_iter().filter_map(|m| match m {
            PlexMedia::Artist(a) => Some(a),
            _ => None,
        }).collect())
    }

    /// Get albums with a user rating set (liked/rated albums)
    #[instrument(skip(self))]
    pub async fn liked_albums(&self, section_id: i64, limit: Option<i32>) -> Result<Vec<super::models::Album>> {
        if let Some(limit) = limit {
            let (items, _) = self.rated_items_page(section_id, "album", 0, limit.clamp(1, 500)).await?;
            return Ok(items.into_iter().filter_map(|item| match item { PlexMedia::Album(item) => Some(item), _ => None }).collect());
        }
        let params = vec![
            ("type".to_string(), "9".to_string()),
            ("sort".to_string(), "lastRatedAt:desc".to_string()),
            ("userRating>>".to_string(), "0".to_string()),
        ];
        let all: Vec<PlexMedia> = self.fetch_all_paged(section_id, &params, 100).await?;
        Ok(all.into_iter().filter_map(|m| match m {
            PlexMedia::Album(a) => Some(a),
            _ => None,
        }).collect())
    }

    /// Get tracks with a user rating set (liked/rated tracks)
    #[instrument(skip(self))]
    pub async fn liked_tracks(&self, section_id: i64, limit: Option<i32>) -> Result<Vec<Track>> {
        if let Some(limit) = limit {
            let (items, _) = self.rated_items_page(section_id, "track", 0, limit.clamp(1, 500)).await?;
            return Ok(items.into_iter().filter_map(|item| match item { PlexMedia::Track(item) => Some(item), _ => None }).collect());
        }
        let params = vec![
            ("type".to_string(), "10".to_string()),
            ("sort".to_string(), "lastRatedAt:desc".to_string()),
            ("userRating>>".to_string(), "0".to_string()),
        ];
        self.fetch_all_paged(section_id, &params, 100).await
    }

    /// Fetch the tracks for a "Mix for You" hub item.
    ///
    /// Hub mix items (from the `music.mixes` hub) carry a `key` that is an API
    /// path for the mix's track list. Plex does not always include `type=10` in
    /// the key, so this method appends it when missing.
    ///
    /// # Arguments
    /// * `key` - The `key` field from the hub mix item (e.g. `/library/sections/5/all?artist.id=548757`)
    ///
    /// # Returns
    /// * `Result<Vec<Track>>` - Tracks in the mix (shuffled by the server)
    #[instrument(skip(self))]
    pub async fn mix_tracks(&self, key: &str) -> Result<Vec<Track>> {
        let path = if key.contains("type=10") {
            key.to_string()
        } else if key.contains('?') {
            format!("{}&type=10", key)
        } else {
            format!("{}?type=10", key)
        };

        debug!("Fetching mix tracks from {}", path);

        let url = self.build_url(&path);
        let container: MediaContainer<Track> = self
            .get_url(&url)
            .await
            .with_context(|| format!("Failed to fetch mix tracks from {}", path))?;

        Ok(container.metadata)
    }

    /// Get available characters for browsing by first letter
    ///
    /// # Arguments
    /// * `section_id` - Library section ID
    ///
    /// # Returns
    /// * `Result<Vec<Character>>` - List of available characters (A-Z, "#", etc.)
    #[instrument(skip(self))]
    pub async fn browse_characters(&self, section_id: i64) -> Result<Vec<Character>> {
        let path = format!("/library/sections/{}/firstCharacter", section_id);
        let url = self.build_url(&path);

        debug!("Fetching characters for section {} from {}", section_id, url);

        let container: MediaContainer<Character> = self
            .get_url(&url)
            .await
            .with_context(|| format!("Failed to fetch characters for section {}", section_id))?;

        Ok(container.metadata)
    }

    /// Browse items by first character
    ///
    /// # Arguments
    /// * `section_id` - Library section ID
    /// * `character` - Character to browse (A-Z, "#", etc.)
    /// * `libtype` - Optional media type: "track", "album", or "artist"
    /// * `limit` - Optional limit on number of results
    ///
    /// # Returns
    /// * `Result<Vec<PlexMedia>>` - List of media items starting with the character
    #[instrument(skip(self))]
    pub async fn browse_by_character(
        &self,
        section_id: i64,
        character: &str,
        libtype: Option<&str>,
        limit: Option<i32>,
    ) -> Result<Vec<PlexMedia>> {
        let mut params = vec![("title".to_string(), format!("{}^", character))];

        if let Some(libtype) = libtype {
            params.push(("type".to_string(), libtype.to_string()));
        }

        if let Some(limit) = limit {
            params.push(("limit".to_string(), limit.to_string()));
        }

        let path = format!("/library/sections/{}/all", section_id);
        let url = build_url_from_params(&self.build_url(&path), &params);

        debug!(
            "Browsing section {} by character '{}' from {}",
            section_id, character, url
        );

        let container: MediaContainer<PlexMedia> = self
            .get_url(&url)
            .await
            .with_context(|| {
                format!(
                    "Failed to browse section {} by character '{}'",
                    section_id, character
                )
            })?;

        Ok(container.metadata)
    }

    /// Get tags (genres, moods, styles) for a library section
    ///
    /// # Arguments
    /// * `section_id` - Library section ID
    /// * `tag_type` - Type of tag: "genre", "mood", or "style"
    ///
    /// # Returns
    /// * `Result<Vec<Tag>>` - List of tags
    ///
    /// # Example
    /// ```no_run
    /// # use plex::{PlexClient, PlexClientConfig, Tag};
    /// # tokio_test::block_on(async {
    /// let client = PlexClient::new(PlexClientConfig::default()).unwrap();
    /// let genres: Vec<Tag> = client.get_tags(1, "genre").await?;
    /// # Ok::<(), anyhow::Error>(())
    /// # });
    /// ```
    #[instrument(skip(self))]
    pub async fn get_tags(&self, section_id: i64, tag_type: &str) -> Result<Vec<Tag>> {
        // e.g. /library/sections/5/genre  (or /mood, /style)
        let path = format!("/library/sections/{}/{}", section_id, tag_type);
        let url = self.build_url(&path);

        debug!(
            "Fetching {} tags for section {} from {}",
            tag_type, section_id, url
        );

        let container: MediaContainer<Tag> = self
            .get_url(&url)
            .await
            .with_context(|| {
                format!(
                    "Failed to fetch {} tags for section {}",
                    tag_type, section_id
                )
            })?;

        // Genre/mood/style tags come back in the Directory key, not Metadata
        Ok(container.directory)
    }

    /// Get items by tag (genre, mood, style)
    ///
    /// # Arguments
    /// * `section_id` - Library section ID
    /// * `tag_type` - Type of tag: "genre", "mood", or "style"
    /// * `tag_name` - Name of the tag (e.g., "Rock", "Chill")
    /// * `libtype` - Optional media type: "track", "album", or "artist"
    /// * `limit` - Optional limit on number of results
    /// * `offset` - Optional start offset for pagination
    ///
    /// # Returns
    /// * `Result<(Vec<PlexMedia>, i64)>` - (page of items, total matching count)
    #[instrument(skip(self))]
    pub async fn get_by_tag(
        &self,
        section_id: i64,
        tag_type: &str,
        tag_name: &str,
        libtype: Option<&str>,
        limit: Option<i32>,
        offset: Option<i32>,
    ) -> Result<(Vec<PlexMedia>, i64)> {
        let mut params = vec![
            (tag_type.to_string(), tag_name.to_string()),
        ];

        if let Some(libtype) = libtype {
            params.push(("type".to_string(), libtype.to_string()));
        }

        if let Some(limit) = limit {
            params.push(("X-Plex-Container-Size".to_string(), limit.to_string()));
        }

        if let Some(offset) = offset {
            params.push(("X-Plex-Container-Start".to_string(), offset.to_string()));
        }

        let path = format!("/library/sections/{}/all", section_id);
        let url = build_url_from_params(&self.build_url(&path), &params);

        debug!(
            "Fetching items with {}='{}' for section {} from {}",
            tag_type, tag_name, section_id, url
        );

        let container: MediaContainer<PlexMedia> = self
            .get_url(&url)
            .await
            .with_context(|| {
                format!(
                    "Failed to fetch items with {}='{}' for section {}",
                    tag_type, tag_name, section_id
                )
            })?;

        let total = container.total_size.unwrap_or(container.metadata.len() as i64);
        Ok((container.metadata, total))
    }

    /// Get On Deck items (continue listening)
    ///
    /// # Arguments
    /// * `section_id` - Library section ID
    ///
    /// # Returns
    /// * `Result<Vec<PlexMedia>>` - List of on deck media items
    #[instrument(skip(self))]
    pub async fn on_deck(&self, section_id: i64) -> Result<Vec<PlexMedia>> {
        let path = format!("/library/sections/{}/onDeck", section_id);
        let url = self.build_url(&path);

        debug!("Fetching on deck items for section {} from {}", section_id, url);

        let container: MediaContainer<PlexMedia> = self
            .get_url(&url)
            .await
            .with_context(|| format!("Failed to fetch on deck items for section {}", section_id))?;

        Ok(container.metadata)
    }

    /// Get recently added items
    ///
    /// # Arguments
    /// * `section_id` - Library section ID
    /// * `libtype` - Optional media type: "track", "album", or "artist"
    /// * `limit` - Optional limit on number of results
    ///
    /// # Returns
    /// * `Result<Vec<PlexMedia>>` - List of recently added media items
    #[instrument(skip(self))]
    pub async fn recently_added(
        &self,
        section_id: i64,
        libtype: Option<&str>,
        limit: Option<i32>,
    ) -> Result<Vec<PlexMedia>> {
        let mut params = vec![
            ("sort".to_string(), "addedAt:desc".to_string()),
        ];

        if let Some(libtype) = libtype {
            params.push(("type".to_string(), libtype.to_string()));
        }

        if let Some(limit) = limit {
            params.push(("limit".to_string(), limit.to_string()));
        }

        let path = format!("/library/sections/{}/recentlyAdded", section_id);
        let url = build_url_from_params(&self.build_url(&path), &params);

        debug!("Fetching recently added items for section {} from {}", section_id, url);

        let container: MediaContainer<PlexMedia> = self
            .get_url(&url)
            .await
            .with_context(|| {
                format!("Failed to fetch recently added items for section {}", section_id)
            })?;

        Ok(container.metadata)
    }

    /// Recent album releases, independently of the date imported into Plex.
    pub async fn latest_releases(&self, section_id: i64, limit: Option<i32>) -> Result<Vec<Album>> {
        self.latest_releases_on(section_id, limit, chrono::Utc::now().date_naive())
            .await
    }

    async fn latest_releases_on(
        &self,
        section_id: i64,
        limit: Option<i32>,
        today: chrono::NaiveDate,
    ) -> Result<Vec<Album>> {
        anyhow::ensure!(section_id > 0, "Invalid music library section");
        let limit = limit.unwrap_or(30).clamp(1, 50);
        let tomorrow = today
            .succ_opt()
            .context("Invalid release date boundary")?
            .and_hms_opt(0, 0, 0)
            .unwrap()
            .and_utc()
            .timestamp();
        // Plex date filters use an exclusive 'before' operator. Filtering on
        // the server before pagination prevents future preorders filling the shelf.
        let params = vec![
            ("type".to_owned(), "9".to_owned()),
            ("sort".to_owned(), "originallyAvailableAt:desc".to_owned()),
            ("originallyAvailableAt<<".to_owned(), tomorrow.to_string()),
            ("X-Plex-Container-Start".to_owned(), "0".to_owned()),
            ("X-Plex-Container-Size".to_owned(), limit.to_string()),
            ("limit".to_owned(), limit.to_string()),
        ];
        let path = format!("/library/sections/{section_id}/all");
        let url = build_url_from_params(&self.build_url(&path), &params);
        let container: MediaContainer<PlexMedia> = self
            .get_url(&url)
            .await
            .context("Failed to fetch latest album releases")?;
        let release_date = |album: &Album| {
            album
                .originally_available_at
                .as_deref()
                .and_then(|value| chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").ok())
        };
        let mut albums: Vec<_> = container
            .metadata
            .into_iter()
            .filter_map(|item| {
                let PlexMedia::Album(album) = item else {
                    return None;
                };
                if release_date(&album).is_some_and(|date| date > today) {
                    return None;
                }
                Some(album)
            })
            .take(limit as usize)
            .collect();
        // Defend against servers ignoring date/sort parameters; unknown dates
        // remain last within this bounded result, never ordered by addedAt.
        albums.sort_by_key(|album| std::cmp::Reverse(release_date(album)));
        Ok(albums)
    }

    /// Find library section by title
    ///
    /// # Arguments
    /// * `title` - Library section title (e.g., "Music")
    ///
    /// # Returns
    /// * `Result<Option<LibrarySection>>` - The matching section, if found
    #[instrument(skip(self))]
    pub async fn find_section_by_title(&self, title: &str) -> Result<Option<LibrarySection>> {
        let sections = self.get_all_sections().await?;
        let section = sections.into_iter().find(|s| s.title == title);
        Ok(section)
    }
}

/// Build URL from parameters
pub(super) fn build_url_from_params(base_url: &str, params: &[(String, String)]) -> String {
    if params.is_empty() {
        base_url.to_string()
    } else {
        let query = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(params.iter().map(|(key, value)| (key.as_str(), value.as_str())))
            .finish();
        let separator = if base_url.contains('?') { "&" } else { "?" };
        format!("{}{}{}", base_url, separator, query)
    }
}

/// Build query string from parameters
fn build_query_string(params: &[(&str, String)]) -> String {
    url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(params.iter().map(|(key, value)| (*key, value.as_str())))
        .finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plex::PlexClientConfig;

    #[tokio::test]
    async fn latest_releases_request_albums_by_release_date_with_bounded_paging_and_date_filter() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let body = serde_json::json!({"MediaContainer": {"Metadata": [
            {"type":"album", "ratingKey":"2", "title":"Old release imported recently", "originallyAvailableAt":"2019-01-01", "addedAt":1800000000},
            {"type":"album", "ratingKey":"7", "title":"Unknown release date", "addedAt":1800000000},
            {"type":"album", "ratingKey":"13", "title":"Future preorder", "originallyAvailableAt":"2026-10-13", "addedAt":1700000000},
            {"type":"track", "ratingKey":"99", "title":"Not an album"},
            {"type":"album", "ratingKey":"10", "title":"Recent release imported years ago", "originallyAvailableAt":"2026-10-10", "addedAt":1700000000},
            {"type":"album", "ratingKey":"12", "title":"Released today", "originallyAvailableAt":"2026-10-12", "addedAt":1700000000}
        ]}}).to_string();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(2)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 1024];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let read = stream.read(&mut buffer).unwrap();
                assert!(read > 0 && request.len() < 16 * 1024);
                request.extend_from_slice(&buffer[..read]);
            }
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
            String::from_utf8(request)
                .unwrap()
                .lines()
                .next()
                .unwrap()
                .to_owned()
        });
        let client = PlexClient::new(PlexClientConfig {
            base_url: format!("http://{address}/proxy"),
            token: "offline-fixture".into(),
            ..Default::default()
        })
        .unwrap();
        let today = chrono::NaiveDate::from_ymd_opt(2026, 10, 12).unwrap();
        let albums = client
            .latest_releases_on(7, Some(1000), today)
            .await
            .unwrap();
        assert_eq!(
            albums
                .iter()
                .map(|album| album.rating_key)
                .collect::<Vec<_>>(),
            vec![12, 10, 2, 7]
        );
        let request = server.join().unwrap();
        let target = request.split_whitespace().nth(1).unwrap();
        let url = url::Url::parse(&format!("http://{address}{target}")).unwrap();
        assert_eq!(url.path(), "/proxy/library/sections/7/all");
        let query: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(query.get("type").unwrap(), "9");
        assert_eq!(query.get("sort").unwrap(), "originallyAvailableAt:desc");
        assert_eq!(query.get("X-Plex-Container-Start").unwrap(), "0");
        assert_eq!(query.get("X-Plex-Container-Size").unwrap(), "50");
        assert_eq!(query.get("limit").unwrap(), "50");
        let tomorrow = today
            .succ_opt()
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap()
            .and_utc()
            .timestamp();
        assert_eq!(
            query.get("originallyAvailableAt<<").unwrap(),
            &tomorrow.to_string()
        );
        assert!(client.latest_releases_on(-1, None, today).await.is_err());
    }


    #[test]
    fn test_build_query_string() {
        let params = vec![
            ("type", "track".to_string()),
            ("sort", "addedAt:desc".to_string()),
            ("limit", "50".to_string()),
        ];

        let query = build_query_string(&params);
        assert_eq!(query, "type=track&sort=addedAt%3Adesc&limit=50");
    }

    #[test]
    fn search_labels_remain_one_query_parameter_with_existing_url_parameters() {
        let label = "Yoshiko & Tatsunoshin + Bumble Bee #日本語 ? limit=0";
        let url = build_url_from_params("http://localhost:32400/hubs/search?existing=1", &[
            ("query".into(), label.into()), ("sectionId".into(), "1".into())
        ]);
        let parsed = url::Url::parse(&url).unwrap();
        let pairs: Vec<_> = parsed.query_pairs().collect();
        assert_eq!(pairs.len(), 3);
        assert_eq!(pairs[0], ("existing".into(), "1".into()));
        assert_eq!(pairs[1], ("query".into(), label.into()));
        assert_eq!(pairs[2], ("sectionId".into(), "1".into()));
        assert_eq!(parsed.fragment(), None);
    }
}

#[cfg(test)]
mod integration_tests {
    use crate::plex::client::{PlexClient, PlexClientConfig};

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

    /// Diagnostic: print raw JSON fields for a liked track to see what Plex returns.
    #[tokio::test]
    #[ignore]
    async fn test_liked_tracks_raw_json() {
        let client = get_client();
        let section_id = get_music_section_id(&client).await;

        let path = format!(
            "/library/sections/{}/all?type=10&sort=lastRatedAt:desc&userRating>>=0&limit=1",
            section_id
        );
        let raw = client.get_raw(&path).await.expect("get_raw failed");

        // Parse and pretty-print just the first track
        let json: serde_json::Value = serde_json::from_str(&raw).expect("invalid JSON");
        let first_track = &json["MediaContainer"]["Metadata"][0];

        println!("\n=== Raw Plex JSON for first liked track ===\n");

        // Print all top-level keys
        if let Some(obj) = first_track.as_object() {
            println!("Top-level keys:");
            for key in obj.keys() {
                println!("  {}", key);
            }
        }

        // Print audio-related fields
        println!("\n--- Audio fields ---");
        for key in &[
            "audioBitrate", "audioChannels", "audioCodec",
            "bitrate", "codec", "container",
            "lastRatedAt", "userRating",
        ] {
            println!("  {}: {}", key, first_track[key]);
        }

        // Print Media array
        println!("\n--- Media array ---");
        let media = &first_track["Media"];
        if media.is_null() {
            println!("  Media: NULL / ABSENT");
        } else if let Some(arr) = media.as_array() {
            println!("  Media has {} entries", arr.len());
            if let Some(m) = arr.first() {
                if let Some(obj) = m.as_object() {
                    println!("  Media[0] keys:");
                    for key in obj.keys() {
                        println!("    {}", key);
                    }
                    println!("  Media[0].bitrate: {}", m["bitrate"]);
                    println!("  Media[0].audioCodec: {}", m["audioCodec"]);
                    println!("  Media[0].audioChannels: {}", m["audioChannels"]);
                    println!("  Media[0].container: {}", m["container"]);
                }

                // Print Part/Stream info
                let parts = &m["Part"];
                if let Some(parts_arr) = parts.as_array() {
                    println!("\n  Media[0].Part has {} entries", parts_arr.len());
                    if let Some(p) = parts_arr.first() {
                        if let Some(obj) = p.as_object() {
                            println!("  Part[0] keys:");
                            for key in obj.keys() {
                                println!("    {}", key);
                            }
                        }
                        let streams = &p["Stream"];
                        if streams.is_null() {
                            println!("  Part[0].Stream: NULL / ABSENT");
                        } else if let Some(streams_arr) = streams.as_array() {
                            println!("  Part[0].Stream has {} entries", streams_arr.len());
                            for (i, s) in streams_arr.iter().enumerate() {
                                println!(
                                    "    Stream[{}]: type={}, codec={}, bitrate={}, channels={}, samplingRate={}, bitDepth={}",
                                    i,
                                    s["streamType"],
                                    s["codec"],
                                    s["bitrate"],
                                    s["channels"],
                                    s["samplingRate"],
                                    s["bitDepth"],
                                );
                            }
                        }
                    }
                }
            }
        }

        // Also test: what does our deserialized Track look like?
        println!("\n--- Deserialized Track fields ---");
        let tracks = client.liked_tracks(section_id, Some(1)).await.expect("liked_tracks failed");
        if let Some(t) = tracks.first() {
            println!("  title: {}", t.title);
            println!("  audio_bitrate: {:?}", t.audio_bitrate);
            println!("  audio_codec: {:?}", t.audio_codec);
            println!("  audio_channels: {:?}", t.audio_channels);
            println!("  last_rated_at: {:?}", t.last_rated_at);
            println!("  user_rating: {:?}", t.user_rating);
            println!("  media count: {}", t.media.len());
            if let Some(m) = t.media.first() {
                println!("  media[0].bitrate: {:?}", m.bitrate);
                println!("  media[0].audio_codec: {:?}", m.audio_codec);
                println!("  media[0].audio_channels: {:?}", m.audio_channels);
                println!("  media[0].parts count: {}", m.parts.len());
                if let Some(p) = m.parts.first() {
                    println!("  media[0].parts[0].streams count: {}", p.streams.len());
                    for (i, s) in p.streams.iter().enumerate() {
                        println!(
                            "    stream[{}]: type={:?}, codec={:?}, bitrate={:?}, channels={:?}",
                            i, s.stream_type, s.codec, s.bitrate, s.channels
                        );
                    }
                }
            }
        }
    }
}
