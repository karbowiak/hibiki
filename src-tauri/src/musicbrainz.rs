#![allow(dead_code)]
//! MusicBrainz public API integration — artist info, tags/genres, and release data.
//!
//! No API key or authentication is required. Rate limit: 1 req/sec.
//! A proper User-Agent header is required by the MusicBrainz API.

use crate::http_response::{BoundedResponseExt, MAX_JSON_BYTES};
use anyhow::{Context, Result};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};

const MB_BASE: &str = "https://musicbrainz.org/ws/2";

static MB_CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .user_agent("Plexify/1.0 (https://github.com/plexify)")
        .build()
        .expect("Failed to build MusicBrainz HTTP client")
});

// ---------------------------------------------------------------------------
// Private response models (deserialization only)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, Default)]
struct MBSearchResult<T> {
    #[serde(default)]
    artists: Vec<T>,
    #[serde(default, rename = "release-groups")]
    release_groups: Vec<T>,
}

#[derive(Debug, Deserialize, Default)]
struct MBArtistSearchItem {
    id: String,
    name: String,
    #[serde(default)]
    score: u32,
    #[serde(default, rename = "type")]
    artist_type: Option<String>,
    #[serde(default)]
    area: Option<MBArea>,
    #[serde(default)]
    tags: Vec<MBTag>,
    #[serde(default, rename = "life-span")]
    life_span: Option<MBLifeSpan>,
}

#[derive(Debug, Deserialize)]
struct MBArtistDetail {
    id: String,
    name: String,
    #[serde(default, rename = "type")]
    artist_type: Option<String>,
    #[serde(default)]
    area: Option<MBArea>,
    #[serde(default)]
    tags: Vec<MBTag>,
    #[serde(default, rename = "life-span")]
    life_span: Option<MBLifeSpan>,
    #[serde(default)]
    relations: Vec<MBRelation>,
}

#[derive(Debug, Deserialize)]
struct MBArea {
    #[serde(default)]
    name: String,
}

#[derive(Debug, Deserialize)]
struct MBTag {
    #[serde(default)]
    name: String,
    #[serde(default)]
    count: i32,
}

#[derive(Debug, Deserialize)]
struct MBLifeSpan {
    #[serde(default)]
    begin: Option<String>,
    #[serde(default)]
    ended: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct MBRelation {
    #[serde(default, rename = "type")]
    rel_type: String,
    #[serde(default)]
    url: Option<MBUrl>,
}

#[derive(Debug, Deserialize)]
struct MBUrl {
    #[serde(default)]
    resource: String,
}

#[derive(Debug, Deserialize, Default)]
struct MBReleaseGroupSearchItem {
    id: String,
    title: String,
    #[serde(default)]
    score: u32,
    #[serde(default, rename = "primary-type")]
    primary_type: Option<String>,
    #[serde(default, rename = "first-release-date")]
    first_release_date: Option<String>,
    #[serde(default)]
    tags: Vec<MBTag>,
}

#[derive(Debug, Deserialize, Default)]
struct MBRecordingSearchResult {
    #[serde(default)]
    recordings: Vec<MBRecordingSearchItem>,
}

#[derive(Debug, Deserialize, Default)]
struct MBRecordingSearchItem {
    id: String,
    title: String,
    #[serde(default)]
    score: u32,
    #[serde(default, rename = "artist-credit")]
    artist_credit: Vec<MBArtistCredit>,
    #[serde(default)]
    releases: Vec<MBRecordingRelease>,
}

#[derive(Debug, Deserialize, Default)]
struct MBArtistCredit {
    #[serde(default)]
    artist: MBArtistCreditArtist,
}

#[derive(Debug, Deserialize, Default)]
struct MBArtistCreditArtist {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
}

#[derive(Debug, Deserialize, Default)]
struct MBRecordingRelease {
    #[serde(default)]
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default, rename = "release-group")]
    release_group: Option<MBRecordingReleaseGroup>,
}

#[derive(Debug, Deserialize, Default)]
struct MBRecordingReleaseGroup {
    #[serde(default)]
    id: String,
}

// ---------------------------------------------------------------------------
// Public return types (serialized to TypeScript via Tauri)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Clone)]
pub struct MusicBrainzArtistInfo {
    pub mbid: String,
    pub name: String,
    pub artist_type: Option<String>,
    pub area: Option<String>,
    pub tags: Vec<String>,
    pub begin_date: Option<String>,
    pub wikipedia_url: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct MusicBrainzAlbumInfo {
    pub mbid: String,
    pub title: String,
    pub release_type: Option<String>,
    pub first_release_date: Option<String>,
    pub tags: Vec<String>,
}

/// MBIDs resolved for a recording — used by ListenBrainz for proper matching.
#[derive(Debug, Serialize, Clone)]
pub struct MusicBrainzRecordingMbids {
    pub recording_mbid: String,
    pub artist_mbids: Vec<String>,
    pub release_mbid: Option<String>,
    pub release_group_mbid: Option<String>,
}

// ---------------------------------------------------------------------------
// Public API functions
// ---------------------------------------------------------------------------

/// Search for an artist by name, fetch full detail by MBID for relations (Wikipedia URL).
pub async fn get_artist_info(artist: &str) -> Result<Option<MusicBrainzArtistInfo>> {
    // Step 1: search for artist
    let search_resp: MBSearchResult<MBArtistSearchItem> = MB_CLIENT
        .get(format!("{}/artist", MB_BASE))
        .query(&[
            ("query", format!("artist:{}", artist)),
            ("fmt", "json".to_string()),
            ("limit", "5".to_string()),
        ])
        .send()
        .await.map_err(|error| error.without_url())
        .context("Failed to reach MusicBrainz artist search")?
        .error_for_status().map_err(|error| error.without_url())
        .context("MusicBrainz artist search returned error status")?
        .bounded_json(MAX_JSON_BYTES)
        .await
        .context("Failed to parse MusicBrainz artist search response")?;

    if search_resp.artists.is_empty() {
        return Ok(None);
    }

    // Prefer exact case-insensitive name match; fall back to highest score
    let best = search_resp
        .artists
        .iter()
        .find(|a| a.name.to_lowercase() == artist.to_lowercase())
        .or_else(|| search_resp.artists.first())
        .unwrap();

    let mbid = &best.id;

    // Step 2: fetch full artist detail with URL relations for Wikipedia link
    let detail: MBArtistDetail = MB_CLIENT
        .get(format!("{}/artist/{}", MB_BASE, mbid))
        .query(&[("inc", "tags+url-rels"), ("fmt", "json")])
        .send()
        .await.map_err(|error| error.without_url())
        .context("Failed to reach MusicBrainz artist detail")?
        .error_for_status().map_err(|error| error.without_url())
        .context("MusicBrainz artist detail returned error status")?
        .bounded_json(MAX_JSON_BYTES)
        .await
        .context("Failed to parse MusicBrainz artist detail")?;

    let wikipedia_url = detail
        .relations
        .iter()
        .find(|r| r.rel_type == "wikipedia")
        .and_then(|r| r.url.as_ref())
        .map(|u| u.resource.clone());

    let mut tags: Vec<String> = detail
        .tags
        .iter()
        .filter(|t| t.count > 0)
        .map(|t| t.name.clone())
        .collect();
    tags.sort();
    tags.dedup();

    Ok(Some(MusicBrainzArtistInfo {
        mbid: detail.id,
        name: detail.name,
        artist_type: detail.artist_type,
        area: detail.area.map(|a| a.name),
        tags,
        begin_date: detail.life_span.and_then(|ls| ls.begin),
        wikipedia_url,
    }))
}

/// Search for an album (release group) by artist and album name.
pub async fn get_album_info(artist: &str, album: &str) -> Result<Option<MusicBrainzAlbumInfo>> {
    let query = format!("releasegroup:{} AND artist:{}", album, artist);

    let search_resp: MBSearchResult<MBReleaseGroupSearchItem> = MB_CLIENT
        .get(format!("{}/release-group", MB_BASE))
        .query(&[
            ("query", query.as_str()),
            ("fmt", "json"),
            ("limit", "5"),
        ])
        .send()
        .await.map_err(|error| error.without_url())
        .context("Failed to reach MusicBrainz release-group search")?
        .error_for_status().map_err(|error| error.without_url())
        .context("MusicBrainz release-group search returned error status")?
        .bounded_json(MAX_JSON_BYTES)
        .await
        .context("Failed to parse MusicBrainz release-group search response")?;

    if search_resp.release_groups.is_empty() {
        return Ok(None);
    }

    let best = search_resp
        .release_groups
        .iter()
        .find(|rg| rg.title.to_lowercase() == album.to_lowercase())
        .or_else(|| search_resp.release_groups.first())
        .unwrap();

    let mut tags: Vec<String> = best
        .tags
        .iter()
        .filter(|t| t.count > 0)
        .map(|t| t.name.clone())
        .collect();
    tags.sort();
    tags.dedup();

    Ok(Some(MusicBrainzAlbumInfo {
        mbid: best.id.clone(),
        title: best.title.clone(),
        release_type: best.primary_type.clone(),
        first_release_date: best.first_release_date.clone(),
        tags,
    }))
}

/// Look up a recording by artist + track name and return MBIDs for ListenBrainz.
///
/// Searches MusicBrainz recordings, optionally filtering by album name for better
/// matching. Returns recording MBID, artist MBIDs, release MBID, and release group MBID.
pub async fn lookup_recording_mbids(
    artist: &str,
    track: &str,
    album: &str,
) -> Result<Option<MusicBrainzRecordingMbids>> {
    let query = if album.is_empty() {
        format!("recording:{} AND artist:{}", track, artist)
    } else {
        format!("recording:{} AND artist:{} AND release:{}", track, artist, album)
    };

    let search_resp: MBRecordingSearchResult = MB_CLIENT
        .get(format!("{}/recording", MB_BASE))
        .query(&[
            ("query", query.as_str()),
            ("fmt", "json"),
            ("limit", "5"),
        ])
        .send()
        .await.map_err(|error| error.without_url())
        .context("Failed to reach MusicBrainz recording search")?
        .error_for_status().map_err(|error| error.without_url())
        .context("MusicBrainz recording search returned error status")?
        .bounded_json(MAX_JSON_BYTES)
        .await
        .context("Failed to parse MusicBrainz recording search response")?;

    if search_resp.recordings.is_empty() {
        return Ok(None);
    }

    // Prefer exact title + artist match
    let best = search_resp
        .recordings
        .iter()
        .find(|r| {
            r.title.to_lowercase() == track.to_lowercase()
                && r.artist_credit.iter().any(|ac| {
                    ac.artist.name.to_lowercase() == artist.to_lowercase()
                })
        })
        .or_else(|| {
            search_resp
                .recordings
                .iter()
                .find(|r| r.title.to_lowercase() == track.to_lowercase())
        })
        .or_else(|| search_resp.recordings.first())
        .unwrap();

    let artist_mbids: Vec<String> = best
        .artist_credit
        .iter()
        .map(|ac| ac.artist.id.clone())
        .filter(|id| !id.is_empty())
        .collect();

    // Find the best matching release (prefer album name match)
    let matched_release = if !album.is_empty() {
        best.releases
            .iter()
            .find(|r| r.title.to_lowercase() == album.to_lowercase())
            .or_else(|| best.releases.first())
    } else {
        best.releases.first()
    };

    let release_mbid = matched_release.map(|r| r.id.clone());
    let release_group_mbid = matched_release
        .and_then(|r| r.release_group.as_ref())
        .map(|rg| rg.id.clone());

    Ok(Some(MusicBrainzRecordingMbids {
        recording_mbid: best.id.clone(),
        artist_mbids,
        release_mbid,
        release_group_mbid,
    }))
}
