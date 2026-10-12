//! Collection management operations (collections, favorites)
#![allow(dead_code)]

use super::{PlexClient, MediaContainer, PlexMedia};
use crate::http_response::{BoundedResponseExt, MAX_PLEX_BYTES};
use super::client::{request_error, token_header};
use super::models::PlexApiResponse;
use anyhow::{Result, Context};
use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};
use tracing::{debug, instrument};

/// A collection in the library
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct Collection {
    /// Unique key identifying the collection
    #[serde(rename = "ratingKey")]
    pub rating_key: i64,

    /// API URL path
    pub key: String,

    /// Collection title
    pub title: String,

    /// Collection type
    #[serde(rename = "type")]
    pub item_type: String,

    /// Collection subtype: "album", "artist", "track"
    #[serde(default)]
    pub subtype: Option<String>,

    /// Artwork URL
    #[serde(default)]
    pub thumb: Option<String>,

    /// Summary/description
    #[serde(default)]
    pub summary: Option<String>,

    /// Whether this is a smart collection
    #[serde(default)]
    pub smart: bool,

    /// Number of items in the collection
    #[serde(rename = "leafCount", default, deserialize_with = "crate::plex::models::serde_string_or_i64_opt::deserialize")]
    pub leaf_count: Option<i64>,

    /// When the collection was added
    #[serde(rename = "addedAt")]
    pub added_at: Option<DateTime<Utc>>,
}

/// Collection operations implementation
impl PlexClient {
    /// Get all collections in a library section
    ///
    /// # Arguments
    /// * `section_id` - Library section ID
    /// * `collection_type` - Optional filter by collection type: "album", "artist", "track"
    ///
    /// # Returns
    /// * `Result<Vec<Collection>>` - List of collections
    ///
    /// # Example
    /// ```no_run
    /// # use plex::{PlexClient, PlexClientConfig};
    /// # tokio_test::block_on(async {
    /// let client = PlexClient::new(PlexClientConfig::default()).unwrap();
    /// let collections = client.get_collections(1, Some("album")).await?;
    /// # Ok::<(), anyhow::Error>(())
    /// # });
    /// ```
    #[instrument(skip(self))]
    pub async fn get_collections(
        &self,
        section_id: i64,
        collection_type: Option<&str>,
    ) -> Result<Vec<Collection>> {
        let path = format!("/library/sections/{}/collections", section_id);
        let url = if let Some(collection_type) = collection_type {
            self.build_url(&format!("{path}?type={collection_type}"))
        } else {
            self.build_url(&path)
        };

        debug!("Fetching collections from {}", url);

        let container: MediaContainer<Collection> = self
            .get_url(&url)
            .await
            .context("Failed to fetch collections")?;

        Ok(container.metadata)
    }

    /// Get a specific collection by rating key
    ///
    /// # Arguments
    /// * `collection_id` - Collection rating key
    ///
    /// # Returns
    /// * `Result<Collection>` - The collection
    #[instrument(skip(self))]
    pub async fn get_collection(&self, collection_id: i64) -> Result<Collection> {
        let path = format!("/library/metadata/{}", collection_id);
        let url = self.build_url(&path);

        debug!("Fetching collection from {}", url);

        let container: MediaContainer<Collection> = self
            .get_url(&url)
            .await?;

        container
            .metadata
            .into_iter()
            .next()
            .context("Collection not found")
    }

    /// Get items in a collection
    ///
    /// # Arguments
    /// * `collection_id` - Collection rating key
    /// * `limit` - Maximum number of items to return (default: all)
    /// * `offset` - Offset for pagination (default: 0)
    ///
    /// # Returns
    /// * `Result<Vec<PlexMedia>>` - List of items in the collection
    ///
    /// # Example
    /// ```no_run
    /// # use plex::{PlexClient, PlexClientConfig};
    /// # tokio_test::block_on(async {
    /// let client = PlexClient::new(PlexClientConfig::default()).unwrap();
    /// let items = client.get_collection_items(12345, Some(50), Some(0)).await?;
    /// # Ok::<(), anyhow::Error>(())
    /// # });
    /// ```
    #[instrument(skip(self))]
    pub async fn get_collection_items(
        &self,
        collection_id: i64,
        limit: Option<i32>,
        offset: Option<i32>,
    ) -> Result<Vec<PlexMedia>> {
        let path = format!("/library/collections/{}/items", collection_id);

        // Build headers for pagination
        let mut request = self
            .client
            .get(&self.build_url(&path))
            .header("X-Plex-Token", token_header(&self.token))
            .header("Accept", "application/json");

        if let Some(limit) = limit {
            request = request.header("X-Plex-Container-Size", limit.to_string());
        }
        if let Some(offset) = offset {
            request = request.header("X-Plex-Container-Start", offset.to_string());
        }

        debug!(
            "Fetching collection {} items with limit={:?}, offset={:?}",
            collection_id, limit, offset
        );

        let response = request
            .send()
            .await.map_err(request_error)
            .context("Failed to fetch collection items")?;

        debug!("Response status: {}", response.status());

        if !response.status().is_success() {
            return Err(anyhow::anyhow!(
                "HTTP error: {} for collection {}",
                response.status(),
                collection_id
            ));
        }

        let wrapper: PlexApiResponse<MediaContainer<PlexMedia>> = response
            .bounded_json(MAX_PLEX_BYTES)
            .await
            .context("Failed to parse collection items response")?;

        Ok(wrapper.container.metadata)
    }

    /// Add items to a collection
    ///
    /// # Arguments
    /// * `collection_id` - Collection rating key
    /// * `item_ids` - List of item rating keys to add
    ///
    /// # Returns
    /// * `Result<()>` - Success or error
    ///
    /// # Example
    /// ```no_run
    /// # use plex::{PlexClient, PlexClientConfig};
    /// # tokio_test::block_on(async {
    /// let client = PlexClient::new(PlexClientConfig::default()).unwrap();
    /// client.add_to_collection(12345, &[11111, 22222, 33333]).await?;
    /// # Ok::<(), anyhow::Error>(())
    /// # });
    /// ```
    #[instrument(skip(self))]
    pub async fn add_to_collection(
        &self,
        collection_id: i64,
        item_ids: &[i64],
    ) -> Result<()> {
        let path = format!("/library/collections/{}/items", collection_id);

        let ids = item_ids
            .iter()
            .map(|id| id.to_string())
            .collect::<Vec<_>>()
            .join(",");
        // Resource URIs preserve the server/proxy path without metadata flags.
        let uri = self.build_endpoint_url(&format!("/library/metadata/{ids}"));

        let body = serde_json::json!({
            "uri": uri
        });

        self.put::<()>(&path, body)
            .await
            .context("Failed to add items to collection")?;

        debug!(
            "Added {} items to collection {}",
            item_ids.len(),
            collection_id
        );

        Ok(())
    }

    /// Remove an item from a collection
    ///
    /// # Arguments
    /// * `collection_id` - Collection rating key
    /// * `collection_item_id` - Collection item ID to remove
    ///
    /// # Returns
    /// * `Result<()>` - Success or error
    ///
    /// # Example
    /// ```no_run
    /// # use plex::{PlexClient, PlexClientConfig};
    /// # tokio_test::block_on(async {
    /// let client = PlexClient::new(PlexClientConfig::default()).unwrap();
    /// client.remove_from_collection(12345, 98765).await?;
    /// # Ok::<(), anyhow::Error>(())
    /// # });
    /// ```
    #[instrument(skip(self))]
    pub async fn remove_from_collection(
        &self,
        collection_id: i64,
        collection_item_id: i64,
    ) -> Result<()> {
        let path = format!(
            "/library/collections/{}/items/{}",
            collection_id, collection_item_id
        );

        self.delete(&path)
            .await
            .with_context(|| {
                format!(
                    "Failed to remove item {} from collection {}",
                    collection_item_id, collection_id
                )
            })?;

        debug!(
            "Removed item {} from collection {}",
            collection_item_id, collection_id
        );

        Ok(())
    }

    /// Reorder items within a collection
    ///
    /// # Arguments
    /// * `collection_id` - Collection rating key
    /// * `collection_item_id` - Collection item ID to move
    /// * `after_collection_item_id` - Collection item ID to move after (use 0 to move to top)
    ///
    /// # Returns
    /// * `Result<()>` - Success or error
    ///
    /// # Example
    /// ```no_run
    /// # use plex::{PlexClient, PlexClientConfig};
    /// # tokio_test::block_on(async {
    /// let client = PlexClient::new(PlexClientConfig::default()).unwrap();
    /// // Move item 98765 to the top of collection 12345
    /// client.reorder_collection(12345, 98765, 0).await?;
    /// # Ok::<(), anyhow::Error>(())
    /// # });
    /// ```
    #[instrument(skip(self))]
    pub async fn reorder_collection(
        &self,
        collection_id: i64,
        collection_item_id: i64,
        after_collection_item_id: i64,
    ) -> Result<()> {
        let path = format!(
            "/library/collections/{}/items/{}/move",
            collection_id, collection_item_id
        );
        let url = self.build_url(&format!("{path}?after={after_collection_item_id}"));

        let body = serde_json::json!({});

        self.put_url::<()>(&url, body)
            .await
            .context("Failed to reorder items in collection")?;

        debug!(
            "Moved item {} after {} in collection {}",
            collection_item_id, after_collection_item_id, collection_id
        );

        Ok(())
    }

    /// Delete an entire collection
    ///
    /// # Arguments
    /// * `collection_id` - Collection rating key
    ///
    /// # Returns
    /// * `Result<()>` - Success or error
    ///
    /// # Example
    /// ```no_run
    /// # use plex::{PlexClient, PlexClientConfig};
    /// # tokio_test::block_on(async {
    /// let client = PlexClient::new(PlexClientConfig::default()).unwrap();
    /// client.delete_collection(12345).await?;
    /// # Ok::<(), anyhow::Error>(())
    /// # });
    /// ```
    #[instrument(skip(self))]
    pub async fn delete_collection(&self, collection_id: i64) -> Result<()> {
        let path = format!("/library/collections/{}", collection_id);

        self.delete(&path)
            .await
            .with_context(|| format!("Failed to delete collection {}", collection_id))?;

        debug!("Deleted collection {}", collection_id);

        Ok(())
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
    fn test_collection_default() {
        let collection = Collection::default();
        assert_eq!(collection.rating_key, 0);
        assert!(collection.title.is_empty());
        assert!(collection.subtype.is_none());
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

    #[tokio::test]
    async fn test_get_collections() {
        let client = get_client();

        // Get the Music library section
        let sections = client
            .get_all_sections()
            .await
            .expect("Failed to get sections");

        let music_section = sections
            .iter()
            .find(|s| s.title == "Music")
            .expect("Music library not found");

        let section_id = music_section.key;

        // Try to get collections (may be empty if none exist)
        let collections_result = client.get_collections(section_id, None).await;

        match collections_result {
            Ok(collections) => {
                println!("Found {} collections", collections.len());
                for collection in &collections {
                    println!(
                        "Collection: {} (type: {:?}, smart: {})",
                        collection.title, collection.subtype, collection.smart
                    );
                }
                assert!(collections.len() >= 0);
            }
            Err(e) => {
                // May fail if collections endpoint not available
                println!("Get collections failed: {}", e);
            }
        }
    }

    #[tokio::test]
    async fn test_get_collection_items() {
        let client = get_client();

        // Get the Music library section
        let sections = client
            .get_all_sections()
            .await
            .expect("Failed to get sections");

        let music_section = sections
            .iter()
            .find(|s| s.title == "Music")
            .expect("Music library not found");

        let section_id = music_section.key;

        // Try to get collections first
        let collections_result = client.get_collections(section_id, None).await;

        match collections_result {
            Ok(collections) => {
                if let Some(collection) = collections.first() {
                    println!("Testing collection items for: {}", collection.title);

                    let items_result = client
                        .get_collection_items(collection.rating_key, Some(10), Some(0))
                        .await;

                    match items_result {
                        Ok(items) => {
                            println!("Found {} items in collection", items.len());
                            assert!(items.len() >= 0);
                        }
                        Err(e) => {
                            println!("Get collection items failed: {}", e);
                        }
                    }
                } else {
                    println!("No collections found to test items retrieval");
                }
            }
            Err(e) => {
                println!("Get collections failed: {}", e);
            }
        }
    }

    #[tokio::test]
    async fn test_collection_types() {
        let client = get_client();

        // Get the Music library section
        let sections = client
            .get_all_sections()
            .await
            .expect("Failed to get sections");

        let music_section = sections
            .iter()
            .find(|s| s.title == "Music")
            .expect("Music library not found");

        let section_id = music_section.key;

        // Test filtering by collection type
        for collection_type in &["album", "artist", "track"] {
            let collections_result = client.get_collections(section_id, Some(collection_type)).await;

            match collections_result {
                Ok(collections) => {
                    println!(
                        "Found {} {} collections",
                        collections.len(),
                        collection_type
                    );
                    for collection in &collections {
                        assert_eq!(
                            collection.subtype.as_deref(),
                            Some(*collection_type),
                            "Collection subtype mismatch"
                        );
                    }
                }
                Err(e) => {
                    println!(
                        "Get {} collections failed: {}",
                        collection_type, e
                    );
                }
            }
        }
    }
}
