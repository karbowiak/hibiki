#![allow(dead_code)]
//! Apple iTunes Search API — album artwork, genres, and release dates.
//!
//! No API key or authentication required. All endpoints are public.
//! Rate limit: ~20 requests/minute per IP (well within normal usage).
//!
//! API docs: https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/

use crate::http_response::{BoundedResponseExt, MAX_JSON_BYTES};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

const ITUNES_SEARCH: &str = "https://itunes.apple.com/search";

// ---------------------------------------------------------------------------
// Private response models (deserialization only)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all(deserialize = "camelCase"))]
struct ItunesResponse<T> {
    results: Vec<T>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all(deserialize = "camelCase"))]
struct ItunesArtistResult {
    artist_name: String,
    #[serde(default)]
    primary_genre_name: String,
    #[serde(default)]
    artist_link_url: String,
    #[serde(default)]
    artist_id: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all(deserialize = "camelCase"))]
struct ItunesAlbumResult {
    collection_name: String,
    artist_name: String,
    #[serde(default)]
    artwork_url100: String,
    #[serde(default)]
    primary_genre_name: String,
    #[serde(default)]
    release_date: String,
    #[serde(default)]
    track_count: u32,
    #[serde(default)]
    collection_view_url: String,
}

// ---------------------------------------------------------------------------
// Public return types (serialized to TypeScript via Tauri)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Clone)]
pub struct ItunesArtistInfo {
    pub name: String,
    pub genre: String,
    pub apple_music_url: String,
    pub artist_id: u64,
}

#[derive(Debug, Serialize, Clone)]
pub struct ItunesAlbumInfo {
    pub title: String,
    pub artist: String,
    /// Full-resolution album cover (~1000×1000) from Apple CDN.
    /// Derived by scaling the 100×100 thumbnail URL. Null if unavailable.
    pub cover_url: Option<String>,
    pub genre: String,
    /// ISO date string e.g. "2001-03-07"
    pub release_date: String,
    pub track_count: u32,
    pub apple_music_url: String,
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Scale an iTunes thumbnail URL to ~1000×1000.
///
/// iTunes CDN URLs end with a segment like `100x100bb.jpg` or `600x600bb.jpg`.
/// We replace that dimension prefix with `1000x1000` for high resolution.
fn scale_artwork(url: &str) -> Option<String> {
    if url.is_empty() {
        return None;
    }
    // Find "bb." (the boundary between size-segment and extension)
    if let Some(bb_pos) = url.rfind("bb.") {
        let before = &url[..bb_pos];
        if let Some(slash_pos) = before.rfind('/') {
            let size_segment = &before[slash_pos + 1..];
            if size_segment.contains('x') {
                return Some(format!(
                    "{}/1000x1000bb.{}",
                    &before[..slash_pos],
                    &url[bb_pos + 3..]
                ));
            }
        }
    }
    // No recognized size segment — return original
    Some(url.to_string())
}

/// Extract the date portion from an iTunes ISO-8601 timestamp.
///
/// `"2001-03-07T08:00:00Z"` → `"2001-03-07"`
fn parse_date(s: &str) -> String {
    s.split('T').next().unwrap_or(s).to_string()
}

// ---------------------------------------------------------------------------
// Public API functions
// ---------------------------------------------------------------------------

/// Search for an artist by name and return the best match with genre info.
pub async fn search_artist(artist: &str) -> Result<Option<ItunesArtistInfo>> {
    let resp = crate::itunes_throttle::itunes_get(
        ITUNES_SEARCH,
        &[
            ("term", artist),
            ("media", "music"),
            ("entity", "musicArtist"),
            ("limit", "5"),
        ],
    )
    .await
    .context("Failed to reach iTunes artist search")?
    .bounded_json::<ItunesResponse<ItunesArtistResult>>(MAX_JSON_BYTES)
    .await
    .context("Failed to parse iTunes artist search response")?;

    if resp.results.is_empty() {
        return Ok(None);
    }

    // Prefer exact name match (case-insensitive), fall back to first result.
    let item = resp
        .results
        .iter()
        .find(|a| a.artist_name.to_lowercase() == artist.to_lowercase())
        .or_else(|| resp.results.first())
        .unwrap();

    Ok(Some(ItunesArtistInfo {
        name: item.artist_name.clone(),
        genre: item.primary_genre_name.clone(),
        apple_music_url: item.artist_link_url.clone(),
        artist_id: item.artist_id,
    }))
}

/// Search for an album and return enriched info (artwork, genre, release date).
pub async fn search_album(artist: &str, album: &str) -> Result<Option<ItunesAlbumInfo>> {
    let query = format!("{} {}", artist, album);
    let resp = crate::itunes_throttle::itunes_get(
        ITUNES_SEARCH,
        &[
            ("term", query.as_str()),
            ("media", "music"),
            ("entity", "album"),
            ("limit", "10"),
        ],
    )
    .await
    .context("Failed to reach iTunes album search")?
    .bounded_json::<ItunesResponse<ItunesAlbumResult>>(MAX_JSON_BYTES)
    .await
    .context("Failed to parse iTunes album search response")?;

    if resp.results.is_empty() {
        return Ok(None);
    }

    // Best match: exact artist + title → exact artist only → first result.
    let best = resp
        .results
        .iter()
        .find(|a| {
            a.artist_name.to_lowercase() == artist.to_lowercase()
                && a.collection_name.to_lowercase() == album.to_lowercase()
        })
        .or_else(|| {
            resp.results
                .iter()
                .find(|a| a.artist_name.to_lowercase() == artist.to_lowercase())
        })
        .or_else(|| resp.results.first())
        .unwrap();

    Ok(Some(ItunesAlbumInfo {
        title: best.collection_name.clone(),
        artist: best.artist_name.clone(),
        cover_url: scale_artwork(&best.artwork_url100),
        genre: best.primary_genre_name.clone(),
        release_date: parse_date(&best.release_date),
        track_count: best.track_count,
        apple_music_url: best.collection_view_url.clone(),
    }))
}
