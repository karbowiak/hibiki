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
        .user_agent(concat!(
            "Hibiki/",
            env!("CARGO_PKG_VERSION"),
            " (https://github.com/karbowiak/hibiki)"
        ))
        .build()
        .expect("Failed to build MusicBrainz HTTP client")
});

struct RequestLimiter(tokio::sync::Mutex<Option<tokio::time::Instant>>);
impl RequestLimiter {
    fn new() -> Self {
        Self(tokio::sync::Mutex::new(None))
    }

    async fn wait(&self) {
        // FIFO asynchronous admission covers every endpoint, including the
        // artist search followed by its detail lookup. Cancellation drops the
        // guard; a delayed wake reserves from now so requests cannot burst.
        let mut next = self.0.lock().await;
        if let Some(deadline) = *next {
            tokio::time::sleep_until(deadline).await;
        }
        *next = Some(tokio::time::Instant::now() + std::time::Duration::from_secs(1));
    }
}
static LIMITER: Lazy<RequestLimiter> = Lazy::new(RequestLimiter::new);

async fn musicbrainz_get(request: reqwest::RequestBuilder) -> Result<reqwest::Response> {
    LIMITER.wait().await;
    request
        .send()
        .await
        .map_err(|error| error.without_url())
        .context("MusicBrainz request failed")
}

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
    #[serde(default, rename = "artist-credit")]
    artist_credit: Vec<MBArtistCredit>,
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
    pub wikidata_url: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct MusicBrainzAlbumInfo {
    pub artist: String,
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
    let search_resp: MBSearchResult<MBArtistSearchItem> =
        musicbrainz_get(MB_CLIENT.get(format!("{}/artist", MB_BASE)).query(&[
            ("query", format!("artist:{}", artist)),
            ("fmt", "json".to_string()),
            ("limit", "5".to_string()),
        ]))
        .await
        .context("Failed to reach MusicBrainz artist search")?
        .error_for_status()
        .map_err(|error| error.without_url())
        .context("MusicBrainz artist search returned error status")?
        .bounded_json(MAX_JSON_BYTES)
        .await
        .context("Failed to parse MusicBrainz artist search response")?;

    if search_resp.artists.is_empty() {
        return Ok(None);
    }

    let mut matches = search_resp
        .artists
        .iter()
        .filter(|a| a.name.trim().to_lowercase() == artist.trim().to_lowercase());
    let Some(best) = matches.next() else {
        return Ok(None);
    };
    if matches.any(|other| other.id != best.id) {
        return Ok(None);
    }

    let mbid = &best.id;

    // Step 2: fetch full artist detail with URL relations for Wikipedia link
    let detail: MBArtistDetail = musicbrainz_get(
        MB_CLIENT
            .get(format!("{}/artist/{}", MB_BASE, mbid))
            .query(&[("inc", "tags+url-rels"), ("fmt", "json")]),
    )
    .await
    .context("Failed to reach MusicBrainz artist detail")?
    .error_for_status()
    .map_err(|error| error.without_url())
    .context("MusicBrainz artist detail returned error status")?
    .bounded_json(MAX_JSON_BYTES)
    .await
    .context("Failed to parse MusicBrainz artist detail")?;

    if detail.id != *mbid || detail.name.trim().to_lowercase() != artist.trim().to_lowercase() {
        return Ok(None);
    }

    let wikipedia_url = detail
        .relations
        .iter()
        .find(|r| r.rel_type == "wikipedia")
        .and_then(|r| r.url.as_ref())
        .map(|u| u.resource.clone());

    let wikidata_url = detail
        .relations
        .iter()
        .find(|r| r.rel_type == "wikidata")
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
        wikidata_url,
    }))
}

fn matched_release_group<'a>(
    groups: &'a [MBReleaseGroupSearchItem],
    artist: &str,
    album: &str,
) -> Option<&'a MBReleaseGroupSearchItem> {
    // Exact single-artist credit only. Multiple matching release groups are
    // genuinely ambiguous (editions/homonyms); never choose search rank.
    let mut matches = groups.iter().filter(|group| {
        group.title.trim().to_lowercase() == album.trim().to_lowercase()
            && group.artist_credit.len() == 1
            && group.artist_credit[0].artist.name.trim().to_lowercase()
                == artist.trim().to_lowercase()
    });
    let first = matches.next()?;
    if matches.any(|other| other.id != first.id) {
        return None;
    }
    Some(first)
}

/// Search for an album (release group) by artist and album name.
pub async fn get_album_info(artist: &str, album: &str) -> Result<Option<MusicBrainzAlbumInfo>> {
    let query = format!("releasegroup:{} AND artist:{}", album, artist);

    let search_resp: MBSearchResult<MBReleaseGroupSearchItem> =
        musicbrainz_get(MB_CLIENT.get(format!("{}/release-group", MB_BASE)).query(&[
            ("query", query.as_str()),
            ("fmt", "json"),
            ("limit", "5"),
        ]))
        .await
        .context("Failed to reach MusicBrainz release-group search")?
        .error_for_status()
        .map_err(|error| error.without_url())
        .context("MusicBrainz release-group search returned error status")?
        .bounded_json(MAX_JSON_BYTES)
        .await
        .context("Failed to parse MusicBrainz release-group search response")?;

    if search_resp.release_groups.is_empty() {
        return Ok(None);
    }

    let Some(best) = matched_release_group(&search_resp.release_groups, artist, album) else {
        return Ok(None);
    };

    let mut tags: Vec<String> = best
        .tags
        .iter()
        .filter(|t| t.count > 0)
        .map(|t| t.name.clone())
        .collect();
    tags.sort();
    tags.dedup();

    Ok(Some(MusicBrainzAlbumInfo {
        artist: best.artist_credit[0].artist.name.clone(),
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
        format!(
            "recording:{} AND artist:{} AND release:{}",
            track, artist, album
        )
    };

    let search_resp: MBRecordingSearchResult =
        musicbrainz_get(MB_CLIENT.get(format!("{}/recording", MB_BASE)).query(&[
            ("query", query.as_str()),
            ("fmt", "json"),
            ("limit", "5"),
        ]))
        .await
        .context("Failed to reach MusicBrainz recording search")?
        .error_for_status()
        .map_err(|error| error.without_url())
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
                && r.artist_credit
                    .iter()
                    .any(|ac| ac.artist.name.to_lowercase() == artist.to_lowercase())
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;

    async fn yield_tasks() {
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
    }

    #[test]
    fn release_group_selection_requires_one_exact_artist_credit_and_title() {
        fn group(id: &str, artist: &str, title: &str) -> MBReleaseGroupSearchItem {
            serde_json::from_value(serde_json::json!({"id":id,"title":title,"artist-credit":[{"artist":{"name":artist}}]})).unwrap()
        }
        let matches = vec![
            group("wrong", "Other", "Album"),
            group("right", "Artist", "Album"),
        ];
        assert_eq!(
            matched_release_group(&matches, "artist", "album")
                .unwrap()
                .id,
            "right"
        );
        assert!(matched_release_group(&matches, "Artist", "Album Deluxe").is_none());
        assert!(matched_release_group(
            &[group("a", "Artist", "Album"), group("b", "Artist", "Album")],
            "Artist",
            "Album"
        )
        .is_none());
        let no_credit: MBReleaseGroupSearchItem =
            serde_json::from_value(serde_json::json!({"id":"a","title":"Album"})).unwrap();
        assert!(matched_release_group(&[no_credit], "Artist", "Album").is_none());
        let multiple: MBReleaseGroupSearchItem = serde_json::from_value(serde_json::json!({"id":"a","title":"Album","artist-credit":[{"artist":{"name":"Artist"}},{"artist":{"name":"Guest"}}]})).unwrap();
        assert!(matched_release_group(&[multiple], "Artist", "Album").is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn endpoint_admission_is_shared_and_waiting_calls_remain_one_second_apart() {
        let limiter = Arc::new(RequestLimiter::new());
        let start = tokio::time::Instant::now();
        let (send, mut receive) = tokio::sync::mpsc::unbounded_channel();
        let mut tasks = Vec::new();
        for endpoint in ["artist search", "artist detail", "album", "recording"] {
            let limiter = limiter.clone();
            let send = send.clone();
            tasks.push(tokio::spawn(async move {
                limiter.wait().await;
                send.send((endpoint, tokio::time::Instant::now())).unwrap();
            }));
            yield_tasks().await;
        }
        assert_eq!(receive.try_recv().unwrap(), ("artist search", start));
        assert!(receive.try_recv().is_err());
        for (offset, endpoint) in ["artist detail", "album", "recording"].iter().enumerate() {
            tokio::time::advance(Duration::from_secs(1)).await;
            yield_tasks().await;
            assert_eq!(
                receive.try_recv().unwrap(),
                (*endpoint, start + Duration::from_secs(offset as u64 + 1))
            );
            assert!(receive.try_recv().is_err());
        }
        for task in tasks {
            task.await.unwrap();
        }
    }

    #[tokio::test(start_paused = true)]
    async fn cancellation_and_delayed_executor_wake_do_not_release_a_request_burst() {
        let limiter = Arc::new(RequestLimiter::new());
        limiter.wait().await;
        let cancelled = {
            let limiter = limiter.clone();
            tokio::spawn(async move { limiter.wait().await })
        };
        yield_tasks().await;
        cancelled.abort();
        let mut tasks = Vec::new();
        for _ in 0..3 {
            let limiter = limiter.clone();
            tasks.push(tokio::spawn(async move {
                limiter.wait().await;
                tokio::time::Instant::now()
            }));
            yield_tasks().await;
        }
        tokio::time::advance(Duration::from_secs(30)).await;
        let mut times = Vec::new();
        for task in tasks {
            times.push(task.await.unwrap());
        }
        assert!(times
            .windows(2)
            .all(|pair| pair[1] - pair[0] >= Duration::from_secs(1)));
    }
}

fn identity_aliases(value: &serde_json::Value) -> Vec<crate::public_metadata::identity::Alias> {
    use crate::public_metadata::identity::{bounded_text, Alias};
    value
        .get("aliases")
        .and_then(serde_json::Value::as_array)
        .map(|aliases| {
            aliases
                .iter()
                .take(32)
                .filter_map(|alias| {
                    Some(Alias {
                        name: bounded_text(alias.get("name")?.as_str()?)?,
                        locale: alias
                            .get("locale")
                            .and_then(serde_json::Value::as_str)
                            .and_then(bounded_text),
                        r#type: alias
                            .get("type")
                            .and_then(serde_json::Value::as_str)
                            .and_then(bounded_text),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}
fn identity_candidate(
    value: &serde_json::Value,
    kind: &str,
) -> Option<crate::public_metadata::identity::Candidate> {
    use crate::public_metadata::identity::*;
    use serde_json::Value;
    let id = value.get("id")?.as_str()?.to_lowercase();
    if !valid_id(&id) {
        return None;
    }
    let title = bounded_text(
        value
            .get(if kind == "artist" { "name" } else { "title" })?
            .as_str()?,
    )?;
    let artist_credits = if kind == "artist" {
        vec![Credit {
            name: title.clone(),
            mbid: Some(id.clone()),
        }]
    } else {
        value
            .get("artist-credit")?
            .as_array()?
            .iter()
            .take(16)
            .filter_map(|credit| {
                Some(Credit {
                    name: bounded_text(credit.get("artist")?.get("name")?.as_str()?)?,
                    mbid: credit
                        .pointer("/artist/id")
                        .and_then(Value::as_str)
                        .filter(|id| valid_id(id))
                        .map(|id| id.to_lowercase()),
                })
            })
            .collect::<Vec<_>>()
    };
    if artist_credits.is_empty() {
        return None;
    }
    let artist = artist_credits
        .iter()
        .map(|credit| credit.name.as_str())
        .collect::<Vec<_>>()
        .join(" & ");
    if artist.len() > 512 {
        return None;
    }
    let wikidata_qid = value
        .get("relations")
        .and_then(Value::as_array)
        .and_then(|relations| {
            relations.iter().find_map(|relation| {
                if relation.get("type").and_then(Value::as_str) != Some("wikidata") {
                    return None;
                }
                wikidata_qid(relation.pointer("/url/resource")?.as_str()?)
            })
        });
    Some(Candidate {
        provider: "musicbrainz".into(),
        kind: kind.into(),
        id: id.clone(),
        title,
        artist,
        aliases: identity_aliases(value),
        disambiguation: value
            .get("disambiguation")
            .and_then(Value::as_str)
            .and_then(bounded_text),
        artist_type: if kind == "artist" {
            value
                .get("type")
                .and_then(Value::as_str)
                .and_then(bounded_text)
        } else {
            value
                .get("primary-type")
                .and_then(Value::as_str)
                .and_then(bounded_text)
        },
        area: value
            .pointer("/area/name")
            .and_then(Value::as_str)
            .and_then(bounded_text),
        release_date: value
            .get("first-release-date")
            .and_then(Value::as_str)
            .and_then(bounded_text),
        identifiers: Identifiers {
            artist_mbid: if kind == "artist" {
                Some(id.clone())
            } else if artist_credits.len() == 1 {
                artist_credits[0].mbid.clone()
            } else {
                None
            },
            release_group_mbid: (kind == "album").then_some(id),
            wikidata_qid,
        },
        artist_credits,
        connection_id: None,
    })
}
fn lucene_phrase(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}
#[tauri::command]
pub async fn musicbrainz_search_identities(
    app: tauri::AppHandle,
    kind: String,
    artist: String,
    title: Option<String>,
    query: Option<String>,
) -> std::result::Result<Vec<crate::public_metadata::identity::Candidate>, String> {
    use tauri::Manager;
    if app.state::<crate::commands::PlexState>().is_offline().await {
        return Err("MusicBrainz identity lookup is unavailable offline.".into());
    }

    let title = title.unwrap_or_default();
    let text = query
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or(if kind == "artist" {
            artist.trim()
        } else {
            title.trim()
        });
    if !matches!(kind.as_str(), "artist" | "album")
        || text.is_empty()
        || text.len() > 512
        || artist.len() > 512
    {
        return Err("Enter an artist or album search within 512 characters.".into());
    }
    let query = if kind == "artist" {
        format!(
            "artist:{} OR alias:{}",
            lucene_phrase(text),
            lucene_phrase(text)
        )
    } else {
        format!(
            "(releasegroup:{} OR alias:{}) AND artist:{}",
            lucene_phrase(text),
            lucene_phrase(text),
            lucene_phrase(artist.trim())
        )
    };
    let resource = if kind == "artist" {
        "artist"
    } else {
        "release-group"
    };
    let response: serde_json::Value =
        musicbrainz_get(MB_CLIENT.get(format!("{MB_BASE}/{resource}")).query(&[
            ("query", query.as_str()),
            ("fmt", "json"),
            ("limit", "20"),
        ]))
        .await
        .map_err(|_| "MusicBrainz identity search failed. Retry later.")?
        .error_for_status()
        .map_err(|_| "MusicBrainz identity search is unavailable. Retry later.")?
        .bounded_json(MAX_JSON_BYTES)
        .await
        .map_err(|_| "MusicBrainz identity response was invalid.")?;
    let items = response
        .get(if kind == "artist" {
            "artists"
        } else {
            "release-groups"
        })
        .and_then(serde_json::Value::as_array)
        .ok_or("MusicBrainz identity response was invalid.")?;
    let mut candidates = vec![];
    for value in items.iter().take(20) {
        if let Some(candidate) = identity_candidate(value, &kind) {
            if !candidates
                .iter()
                .any(|old: &crate::public_metadata::identity::Candidate| old.id == candidate.id)
            {
                candidates.push(candidate);
            }
        }
    }
    Ok(candidates)
}
#[tauri::command]
pub async fn musicbrainz_review_identity(
    app: tauri::AppHandle,
    kind: String,
    id: String,
) -> std::result::Result<crate::public_metadata::identity::Review, String> {
    use tauri::Manager;
    if app.state::<crate::commands::PlexState>().is_offline().await {
        return Err("MusicBrainz identity lookup is unavailable offline.".into());
    }

    use crate::public_metadata::identity::*;
    use serde_json::{json, Value};
    if !matches!(kind.as_str(), "artist" | "album") || !valid_id(&id) {
        return Err("Invalid MusicBrainz identity.".into());
    }
    let resource = if kind == "artist" {
        "artist"
    } else {
        "release-group"
    };
    let include = if kind == "artist" {
        "tags+aliases+url-rels"
    } else {
        "tags+artist-credits+aliases"
    };
    let value: Value = musicbrainz_get(
        MB_CLIENT
            .get(format!("{MB_BASE}/{resource}/{}", id.to_lowercase()))
            .query(&[("fmt", "json"), ("inc", include)]),
    )
    .await
    .map_err(|_| "MusicBrainz identity lookup failed. Retry later.")?
    .error_for_status()
    .map_err(|_| "MusicBrainz identity is unavailable. Retry later.")?
    .bounded_json(MAX_JSON_BYTES)
    .await
    .map_err(|_| "MusicBrainz identity response was invalid.")?;
    let candidate = identity_candidate(&value, &kind)
        .filter(|candidate| candidate.id.eq_ignore_ascii_case(&id))
        .ok_or("MusicBrainz returned a different or incomplete identity.")?;
    let mut fields = serde_json::Map::new();
    fields.insert("title".into(), json!(candidate.title));
    fields.insert("artist".into(), json!(candidate.artist));
    fields.insert("mbid".into(), json!(candidate.id));
    let mut tags = value
        .get("tags")
        .and_then(Value::as_array)
        .map(|tags| {
            tags.iter()
                .take(128)
                .filter(|tag| {
                    tag.get("count")
                        .and_then(Value::as_i64)
                        .is_some_and(|count| count > 0)
                })
                .filter_map(|tag| {
                    tag.get("name")
                        .and_then(Value::as_str)
                        .and_then(bounded_text)
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    tags.sort();
    tags.dedup();
    tags.truncate(64);
    fields.insert("tags".into(), json!(tags));
    if let Some(area) = &candidate.area {
        fields.insert("area".into(), json!(area));
    }
    if let Some(kind) = &candidate.artist_type {
        if candidate.kind == "artist" {
            fields.insert("artistType".into(), json!(kind));
        }
    }
    if let Some(date) = &candidate.release_date {
        fields.insert("releaseDate".into(), json!(date));
    }
    if let Some(date) = value
        .pointer("/life-span/begin")
        .and_then(Value::as_str)
        .and_then(bounded_text)
    {
        fields.insert("beginDate".into(), json!(date));
    }
    if let Some(link) = value
        .get("relations")
        .and_then(Value::as_array)
        .and_then(|relations| {
            relations
                .iter()
                .find(|relation| relation.get("type").and_then(Value::as_str) == Some("wikipedia"))
        })
        .and_then(|relation| relation.pointer("/url/resource"))
        .and_then(Value::as_str)
    {
        if link.len() <= 2048 {
            if let Ok(url) = url::Url::parse(link) {
                if url.scheme() == "https"
                    && url.host_str().is_some_and(|host| {
                        host == "wikipedia.org" || host.ends_with(".wikipedia.org")
                    })
                    && url.username().is_empty()
                    && url.password().is_none()
                {
                    fields.insert("wikipediaUrl".into(), json!(url.to_string()));
                }
            }
        }
    }
    Ok(Review {
        candidate,
        fields: Value::Object(fields),
        field_origins: std::collections::BTreeMap::new(),
        reviewed_at: now(),
    })
}

#[cfg(test)]
mod identity_tests {
    use super::*;
    #[test]
    fn canonical_artist_review_keeps_aliases_and_verified_identifiers() {
        let id = "51497a0b-fd77-48dc-9cb0-bfe8ce205173";
        let value = serde_json::json!({"id":id,"name":"Canonical Artist","type":"Person","disambiguation":"Japanese vocalist","area":{"name":"Japan"},"aliases":[{"name":"Translated Artist","locale":"en","type":"Artist name"}],"relations":[{"type":"wikidata","url":{"resource":"https://www.wikidata.org/wiki/Q123"}}]});
        let candidate = identity_candidate(&value, "artist").unwrap();
        assert_eq!(candidate.id, id);
        assert_eq!(candidate.aliases[0].name, "Translated Artist");
        assert_eq!(candidate.identifiers.artist_mbid.as_deref(), Some(id));
        assert_eq!(candidate.identifiers.wikidata_qid.as_deref(), Some("Q123"));
        assert_eq!(
            candidate.disambiguation.as_deref(),
            Some("Japanese vocalist")
        );
        let mut bad = value;
        bad["id"] = serde_json::json!("../../secret");
        assert!(identity_candidate(&bad, "artist").is_none());
    }
    #[test]
    fn multi_artist_release_groups_never_invent_single_artist_identity() {
        let value = serde_json::json!({"id":"51497a0b-fd77-48dc-9cb0-bfe8ce205173","title":"残夢","aliases":[{"name":"Zanmu","locale":"en"}],"first-release-date":"2024-07-09","artist-credit":[{"artist":{"id":"fde1a1f9-a32e-4abf-b0de-f894c6720f4a","name":"Artist A"}},{"artist":{"id":"ca195d97-30d9-4870-8a52-7fd3c2e175c3","name":"Artist B"}}]});
        let candidate = identity_candidate(&value, "album").unwrap();
        assert_eq!(candidate.artist_credits.len(), 2);
        assert!(candidate.identifiers.artist_mbid.is_none());
        assert!(candidate.identifiers.release_group_mbid.is_some());
        assert_eq!(candidate.aliases[0].name, "Zanmu");
        assert_eq!(
            lucene_phrase("Quoted \"Name\" \\ path"),
            "\"Quoted \\\"Name\\\" \\\\ path\""
        );
    }
}
