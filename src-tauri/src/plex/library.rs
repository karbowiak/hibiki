//! Library operations (sections, browse, search, tags)
#![allow(dead_code)]

use super::{PlexClient, MediaContainer, Hub, LibrarySection, PlexMedia, Track};
use super::playlist::SearchFilter;
use anyhow::{Result, Context};
use serde::{Serialize, Deserialize};
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

/// Library operations implementation
impl PlexClient {
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
        let url = self.build_url(&format!("/library/sections/{}", section_id));
        debug!("Fetching library section {} from {}", section_id, url);

        let container: MediaContainer<LibrarySection> = self
            .get_url(&url)
            .await
            .with_context(|| format!("Failed to fetch library section {}", section_id))?;

        container
            .metadata
            .into_iter()
            .next()
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
        _libtype: Option<&str>,
        _filters: Option<&[SearchFilter]>,
        _sort: Option<&str>,
        limit: Option<i32>,
    ) -> Result<Vec<PlexMedia>> {
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
        Ok(container.hub.into_iter().flat_map(|h| h.metadata).collect())
    }

    /// Get artists with a user rating set (liked/rated artists)
    ///
    /// # Arguments
    /// * `section_id` - Library section ID
    /// * `limit` - Optional limit on number of results
    ///
    /// # Returns
    /// * `Result<Vec<super::models::Artist>>` - List of rated artists, sorted by most recently rated
    #[instrument(skip(self))]
    pub async fn liked_artists(&self, section_id: i64, limit: Option<i32>) -> Result<Vec<super::models::Artist>> {
        let mut params = vec![
            ("type".to_string(), "8".to_string()),
            ("sort".to_string(), "lastRatedAt:desc".to_string()),
            ("userRating>>".to_string(), "0".to_string()),
        ];

        if let Some(limit) = limit {
            params.push(("limit".to_string(), limit.to_string()));
        }

        let path = format!("/library/sections/{}/all", section_id);
        let url = build_url_from_params(&self.build_url(&path), &params);

        debug!("Fetching liked artists for section {} from {}", section_id, url);

        let container: MediaContainer<PlexMedia> = self
            .get_url(&url)
            .await
            .with_context(|| format!("Failed to fetch liked artists for section {}", section_id))?;

        Ok(container.metadata.into_iter().filter_map(|m| match m {
            PlexMedia::Artist(a) => Some(a),
            _ => None,
        }).collect())
    }

    /// Get albums with a user rating set (liked/rated albums)
    ///
    /// # Arguments
    /// * `section_id` - Library section ID
    /// * `limit` - Optional limit on number of results
    ///
    /// # Returns
    /// * `Result<Vec<super::models::Album>>` - List of rated albums, sorted by most recently rated
    #[instrument(skip(self))]
    pub async fn liked_albums(&self, section_id: i64, limit: Option<i32>) -> Result<Vec<super::models::Album>> {
        let mut params = vec![
            ("type".to_string(), "9".to_string()),
            ("sort".to_string(), "lastRatedAt:desc".to_string()),
            ("userRating>>".to_string(), "0".to_string()),
        ];

        if let Some(limit) = limit {
            params.push(("limit".to_string(), limit.to_string()));
        }

        let path = format!("/library/sections/{}/all", section_id);
        let url = build_url_from_params(&self.build_url(&path), &params);

        debug!("Fetching liked albums for section {} from {}", section_id, url);

        let container: MediaContainer<PlexMedia> = self
            .get_url(&url)
            .await
            .with_context(|| format!("Failed to fetch liked albums for section {}", section_id))?;

        Ok(container.metadata.into_iter().filter_map(|m| match m {
            PlexMedia::Album(a) => Some(a),
            _ => None,
        }).collect())
    }

    /// Get tracks with a user rating set (liked/rated tracks)
    ///
    /// # Arguments
    /// * `section_id` - Library section ID
    /// * `limit` - Optional limit on number of results
    ///
    /// # Returns
    /// * `Result<Vec<Track>>` - List of rated tracks, sorted by most recently rated
    #[instrument(skip(self))]
    pub async fn liked_tracks(&self, section_id: i64, limit: Option<i32>) -> Result<Vec<Track>> {
        let mut params = vec![
            ("type".to_string(), "10".to_string()),
            ("sort".to_string(), "lastRatedAt:desc".to_string()),
            ("userRating>>".to_string(), "0".to_string()),
        ];

        if let Some(limit) = limit {
            params.push(("limit".to_string(), limit.to_string()));
        }

        let path = format!("/library/sections/{}/all", section_id);
        let url = build_url_from_params(&self.build_url(&path), &params);

        debug!("Fetching liked tracks for section {} from {}", section_id, url);

        let container: MediaContainer<PlexMedia> = self
            .get_url(&url)
            .await
            .with_context(|| format!("Failed to fetch liked tracks for section {}", section_id))?;

        Ok(container.metadata.into_iter().filter_map(|m| match m {
            PlexMedia::Track(t) => Some(t),
            _ => None,
        }).collect())
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
        let container: MediaContainer<PlexMedia> = self
            .get_url(&url)
            .await
            .with_context(|| format!("Failed to fetch mix tracks from {}", path))?;

        Ok(container.metadata.into_iter().filter_map(|m| match m {
            PlexMedia::Track(t) => Some(t),
            _ => None,
        }).collect())
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
    ///
    /// # Returns
    /// * `Result<Vec<PlexMedia>>` - List of media items with the tag
    #[instrument(skip(self))]
    pub async fn get_by_tag(
        &self,
        section_id: i64,
        tag_type: &str,
        tag_name: &str,
        libtype: Option<&str>,
        limit: Option<i32>,
    ) -> Result<Vec<PlexMedia>> {
        let mut params = vec![
            (tag_type.to_string(), tag_name.to_string()),
        ];

        if let Some(libtype) = libtype {
            params.push(("type".to_string(), libtype.to_string()));
        }

        if let Some(limit) = limit {
            params.push(("limit".to_string(), limit.to_string()));
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

        Ok(container.metadata)
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
        let query = params
            .iter()
            .map(|(k, v)| format!("{}={}", k, v))
            .collect::<Vec<_>>()
            .join("&");
        format!("{}?{}", base_url, query)
    }
}

/// Build query string from parameters
fn build_query_string(params: &[(&str, String)]) -> String {
    params
        .iter()
        .map(|(k, v)| format!("{}={}", k, v))
        .collect::<Vec<_>>()
        .join("&")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_query_string() {
        let params = vec![
            ("type", "track".to_string()),
            ("sort", "addedAt:desc".to_string()),
            ("limit", "50".to_string()),
        ];

        let query = build_query_string(&params);
        assert_eq!(query, "type=track&sort=addedAt:desc&limit=50");
    }
}
