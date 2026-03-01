//! Play queue management
//!
//! Play queues are the core mechanism PlexAmp uses to manage what's playing,
//! what's up next, shuffle state, and repeat mode. A queue is created server-side
//! from a track, album, playlist, or station URI, then referenced by ID during playback.
#![allow(dead_code)]

use super::{PlexClient, PlayQueue};
use crate::plex::models::PlexApiResponse;
use anyhow::{Context, Result};
use tracing::{debug, instrument};
use url::Url;

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
            .header("X-Plex-Token", &self.token)
            .header("Accept", "application/json")
            .send()
            .await
            .context("Failed to create play queue")?;

        if !response.status().is_success() {
            return Err(anyhow::anyhow!(
                "HTTP error: {} creating play queue",
                response.status()
            ));
        }

        let wrapper: PlexApiResponse<PlayQueue> = response
            .json()
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
            .header("X-Plex-Token", &self.token)
            .header("Accept", "application/json")
            .send()
            .await
            .context("Failed to add to play queue")?;

        if !response.status().is_success() {
            return Err(anyhow::anyhow!(
                "HTTP error: {} adding to play queue",
                response.status()
            ));
        }

        let wrapper: PlexApiResponse<PlayQueue> = response
            .json()
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
            .header("X-Plex-Token", &self.token)
            .header("Accept", "application/json")
            .send()
            .await
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

    /// Create a radio play queue seeded from any Plex item.
    ///
    /// Uses PlexAmp's `plex://radio` URI scheme to generate a server-side station
    /// that streams sonically-curated recommendations continuously.
    ///
    /// # Arguments
    /// * `rating_key` - Rating key of the seed item (track, album, or artist)
    /// * `degrees_of_separation` - Recommendation diversity: `None` = unlimited (-1),
    ///   0 = closest matches only, 3+ = adventurous
    /// * `include_external` - Include content from external/cloud sources
    /// * `shuffle` - Shuffle the initial queue
    #[instrument(skip(self))]
    pub async fn create_radio_queue(
        &self,
        rating_key: i64,
        degrees_of_separation: Option<i32>,
        include_external: bool,
        shuffle: bool,
    ) -> Result<PlayQueue> {
        let station_key = format!(
            "/library/metadata/{}/station/{}",
            rating_key,
            uuid::Uuid::new_v4(),
        );
        let degrees = degrees_of_separation.unwrap_or(-1);
        let radio_uri = format!(
            "plex://radio?stationKey={station_key}&initialRatingKey={rating_key}&degreesOfSeparation={degrees}&includeExternal={ext}",
            ext = if include_external { "true" } else { "false" },
        );
        debug!(
            "Creating radio queue: ratingKey={} stationKey={}",
            rating_key, station_key
        );
        // Reuse create_play_queue — the plex://radio URI is treated like any other library URI.
        self.create_play_queue(&radio_uri, shuffle, 0).await
    }

    /// Create a smart-shuffle (Guest DJ) play queue.
    ///
    /// Same as `create_radio_queue` but sends `smartShuffle=1` and a DJ-specific
    /// `X-Plex-Client-Identifier` header. Plex uses this to enable the AI-curated
    /// "Guest DJ" persona that generates more contextually intelligent recommendations.
    ///
    /// # Arguments
    /// * `rating_key` - Rating key of the seed item
    /// * `degrees_of_separation` - Recommendation diversity (`None` = unlimited)
    /// * `include_external` - Include external sources
    /// * `client_id` - Stable installation UUID; `-transient-deejay` is appended
    #[instrument(skip(self))]
    pub async fn create_smart_shuffle_queue(
        &self,
        rating_key: i64,
        degrees_of_separation: Option<i32>,
        include_external: bool,
        client_id: &str,
    ) -> Result<PlayQueue> {
        let station_key = format!(
            "/library/metadata/{}/station/{}",
            rating_key,
            uuid::Uuid::new_v4(),
        );
        let degrees = degrees_of_separation.unwrap_or(-1);
        let radio_uri = format!(
            "plex://radio?stationKey={station_key}&initialRatingKey={rating_key}&degreesOfSeparation={degrees}&includeExternal={ext}",
            ext = if include_external { "true" } else { "false" },
        );

        let base = self.build_url("/playQueues");
        let mut url = Url::parse(&base).context("Failed to parse playQueues URL")?;
        url.query_pairs_mut()
            .append_pair("type", "audio")
            .append_pair("uri", &radio_uri)
            .append_pair("shuffle", "1")
            .append_pair("smartShuffle", "1")
            .append_pair("includeChapters", "1")
            .append_pair("includeRelated", "1");

        let dj_id = format!("{}-transient-deejay", client_id);
        debug!(
            "Creating smart shuffle queue: ratingKey={} djId={}",
            rating_key, dj_id
        );

        let response = self
            .client
            .post(&url.to_string())
            .header("X-Plex-Token", &self.token)
            .header("X-Plex-Client-Identifier", &dj_id)
            .header("Accept", "application/json")
            .send()
            .await
            .context("Failed to create smart shuffle queue")?;

        if !response.status().is_success() {
            return Err(anyhow::anyhow!(
                "HTTP {} creating smart shuffle queue",
                response.status()
            ));
        }

        let wrapper: PlexApiResponse<PlayQueue> = response
            .json()
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
}
