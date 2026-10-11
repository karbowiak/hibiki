#![allow(dead_code)]
//! Deezer public API integration — artist images, album art, genres, and fan counts.
//!
//! No API key or authentication is required. All endpoints are public.
//! Rate limit: ~50 requests / 5 seconds per IP (well within normal usage).

use crate::http_response::{BoundedResponseExt, MAX_JSON_BYTES};
use anyhow::{Context, Result};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};

const DEEZER_BASE: &str = "https://api.deezer.com";

static DEEZER_CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .expect("Failed to build Deezer HTTP client")
});

// ---------------------------------------------------------------------------
// Private response models (deserialization only)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct DeezerList<T> {
    data: Vec<T>,
}

#[derive(Debug, Deserialize)]
struct DeezerArtistItem {
    name: String,
    #[serde(default)]
    picture_xl: String,
    #[serde(default)]
    nb_fan: u64,
    #[serde(default)]
    nb_album: u64,
    #[serde(default)]
    link: String,
}

#[derive(Debug, Deserialize)]
struct DeezerAlbumSearchItem {
    id: u64,
    title: String,
    #[serde(default)]
    cover_xl: String,
    #[serde(default)]
    link: String,
    artist: DeezerArtistRef,
}

#[derive(Debug, Deserialize, Default)]
struct DeezerArtistRef {
    #[serde(default)]
    name: String,
}

#[derive(Debug, Deserialize)]
struct DeezerAlbumDetail {
    title: String,
    #[serde(default)]
    cover_xl: String,
    #[serde(default)]
    link: String,
    #[serde(default)]
    fans: u64,
    #[serde(default)]
    release_date: String,
    #[serde(default)]
    label: String,
    #[serde(default)]
    genres: DeezerGenres,
    #[serde(default)]
    artist: DeezerArtistRef,
}

#[derive(Debug, Deserialize, Default)]
struct DeezerGenres {
    #[serde(default, rename = "data")]
    items: Vec<DeezerGenreItem>,
}

#[derive(Debug, Deserialize)]
struct DeezerGenreItem {
    name: String,
}

// ---------------------------------------------------------------------------
// Public return types (serialized to TypeScript via Tauri)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Clone)]
pub struct DeezerArtistInfo {
    pub name: String,
    pub fans: u64,
    pub nb_albums: u64,
    /// Full-resolution artist image (1000×1000) from Deezer CDN.
    /// `None` if the artist has no image.
    pub image_url: Option<String>,
    pub deezer_url: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct DeezerAlbumInfo {
    pub title: String,
    pub artist: String,
    /// Full-resolution album cover (1000×1000) from Deezer CDN.
    /// `None` if the album has no cover image.
    pub cover_url: Option<String>,
    pub genres: Vec<String>,
    pub fans: u64,
    /// ISO date string e.g. "2001-03-07"
    pub release_date: String,
    pub label: String,
    pub deezer_url: String,
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Deezer uses an empty image hash (double-slash in the path) when no image
/// exists for an artist/album. Return `None` in that case.
fn clean_image(url: String) -> Option<String> {
    if url.is_empty() {
        return None;
    }
    // Strip the https:// protocol prefix then check for remaining //
    // which indicates an empty hash segment in the CDN URL.
    let after_protocol = url.splitn(3, '/').nth(2).unwrap_or("");
    if after_protocol.contains("//") {
        None
    } else {
        Some(url)
    }
}

// ---------------------------------------------------------------------------
// Public API functions
// ---------------------------------------------------------------------------

/// Search for an artist by name and return the best match with image and stats.
pub async fn search_artist(artist: &str) -> Result<Option<DeezerArtistInfo>> {
    let resp = DEEZER_CLIENT
        .get(format!("{}/search/artist", DEEZER_BASE))
        .query(&[("q", artist), ("limit", "5")])
        .send()
        .await.map_err(|error| error.without_url())
        .context("Failed to reach Deezer artist search")?
        .error_for_status().map_err(|error| error.without_url())
        .context("Deezer artist search returned error status")?
        .bounded_json::<DeezerList<DeezerArtistItem>>(MAX_JSON_BYTES)
        .await
        .context("Failed to parse Deezer artist search response")?;

    if resp.data.is_empty() {
        return Ok(None);
    }

    // Prefer an exact case-insensitive name match; fall back to first result.
    let item = resp
        .data
        .iter()
        .find(|a| a.name.to_lowercase() == artist.to_lowercase())
        .or_else(|| resp.data.first())
        .unwrap();

    Ok(Some(DeezerArtistInfo {
        name: item.name.clone(),
        fans: item.nb_fan,
        nb_albums: item.nb_album,
        image_url: clean_image(item.picture_xl.clone()),
        deezer_url: item.link.clone(),
    }))
}

/// Search for an album and return enriched info (cover, genres, fans, label).
///
/// Makes two requests: search → detail. Results should be cached by the caller.
pub async fn search_album(artist: &str, album: &str) -> Result<Option<DeezerAlbumInfo>> {
    let query = format!("{} {}", artist, album);
    let search_resp = DEEZER_CLIENT
        .get(format!("{}/search/album", DEEZER_BASE))
        .query(&[("q", query.as_str()), ("limit", "10")])
        .send()
        .await.map_err(|error| error.without_url())
        .context("Failed to reach Deezer album search")?
        .error_for_status().map_err(|error| error.without_url())
        .context("Deezer album search returned error status")?
        .bounded_json::<DeezerList<DeezerAlbumSearchItem>>(MAX_JSON_BYTES)
        .await
        .context("Failed to parse Deezer album search response")?;

    if search_resp.data.is_empty() {
        return Ok(None);
    }

    // Best match: exact artist + album title, then just artist match, then first.
    let best = search_resp
        .data
        .iter()
        .find(|a| {
            a.artist.name.to_lowercase() == artist.to_lowercase()
                && a.title.to_lowercase() == album.to_lowercase()
        })
        .or_else(|| {
            search_resp
                .data
                .iter()
                .find(|a| a.artist.name.to_lowercase() == artist.to_lowercase())
        })
        .or_else(|| search_resp.data.first())
        .unwrap();

    let album_id = best.id;

    // Fetch full album detail for genres, fans, release date, label.
    let detail: DeezerAlbumDetail = DEEZER_CLIENT
        .get(format!("{}/album/{}", DEEZER_BASE, album_id))
        .send()
        .await.map_err(|error| error.without_url())
        .context("Failed to reach Deezer album detail")?
        .error_for_status().map_err(|error| error.without_url())
        .context("Deezer album detail returned error status")?
        .bounded_json(MAX_JSON_BYTES)
        .await
        .context("Failed to parse Deezer album detail")?;

    Ok(Some(DeezerAlbumInfo {
        title: detail.title,
        artist: detail.artist.name,
        cover_url: clean_image(detail.cover_xl),
        genres: detail.genres.items.into_iter().map(|g| g.name).collect(),
        fans: detail.fans,
        release_date: detail.release_date,
        label: detail.label,
        deezer_url: detail.link,
    }))
}
