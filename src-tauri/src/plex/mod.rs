//! Plex API client library
//!
//! This module provides a high-performance, type-safe client for interacting with
//! the Plex Media Server API. It includes support for:
//!
//! - Audio operations (sonic analysis, tracks, albums)
//! - Library browsing (hubs, search, filters)
//! - Playlist management (smart playlists, CRUD operations)
//! - History tracking (sessions, scrobble, timeline)
//! - Collection management (favorites, collections)
//!
//! # Example
//!
//! ```no_run
//! use plex::client::{PlexClient, PlexClientConfig};
//!
//! # tokio_test::block_on(async {
//! let config = PlexClientConfig {
//!     base_url: "http://localhost:32400".to_string(),
//!     token: "your-token".to_string(),
//!     ..Default::default()
//! };
//!
//! let client = PlexClient::new(config)?;
//! # Ok::<(), anyhow::Error>(())
//! # });
//! ```

pub mod audio;
pub mod artwork;
pub mod auth;
pub mod client;
pub mod cache_scope;
pub mod lyrics;
pub mod collection;
pub mod discovery;
pub mod history;
pub mod library;
pub mod models;
pub mod playlist;
pub mod playqueue;
pub mod server;
pub mod streaming;
pub mod tls;

// Re-exports for convenience
pub use auth::{load as load_settings, update as update_settings};
pub use client::{PlexClient, PlexClientConfig};
pub use history::PlaybackState;
pub use library::Tag;
pub use models::*;
