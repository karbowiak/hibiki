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

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistRecordingSearch { title: String, artists: Vec<String>, duration_ms: u64 }
fn exact_playlist_recording(value: &serde_json::Value, source: &PlaylistRecordingSearch) -> Option<String> {
    let normalized = |text: &str| text.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
    let rows = value["recordings"].as_array()?;
    let count = value["count"].as_u64().or_else(|| value["recording-count"].as_u64())?;
    if count != rows.len() as u64 || rows.len() > 25 || source.duration_ms == 0 { return None; }
    let mut expected = source.artists.iter().map(|name| normalized(name)).collect::<Vec<_>>(); expected.sort(); expected.dedup();
    if expected.is_empty() { return None; }
    let mut found = std::collections::HashSet::new();
    for row in rows {
        if normalized(row["title"].as_str()?) != normalized(&source.title) { continue; }
        let Some(duration) = row["length"].as_u64() else { continue; };
        if duration.abs_diff(source.duration_ms) > 2000 || duration.min(source.duration_ms) == 0 ||
            duration.abs_diff(source.duration_ms) as f64 / duration.min(source.duration_ms) as f64 > 0.02 { continue; }
        let mut credits = row["artist-credit"].as_array()?.iter().filter_map(|credit| credit["artist"]["name"].as_str()).map(normalized).collect::<Vec<_>>();
        credits.sort(); credits.dedup();
        if credits != expected { continue; }
        let id = row["id"].as_str()?;
        if id.len() == 36 { found.insert(uuid::Uuid::parse_str(id).ok()?.to_string()); }
    }
    (found.len() == 1).then(|| found.into_iter().next().unwrap())
}
/// Optional playlist export only. No generic Plex MBID or first fuzzy hit can
/// become a recording identity; all credits, title/version and duration agree.
#[tauri::command]
pub async fn musicbrainz_playlist_recording(source: PlaylistRecordingSearch) -> Result<Option<String>, String> {
    if source.title.trim().is_empty() || source.title.len() > 500 || source.artists.is_empty() || source.artists.len() > 30 ||
        source.artists.iter().any(|name| name.trim().is_empty() || name.len() > 500) || source.duration_ms == 0 || source.duration_ms > 86_400_000 {
        return Err("Complete song metadata is needed to verify a recording.".into());
    }
    let query = format!("recording:{} AND artist:{}", lucene_phrase(&source.title), lucene_phrase(&source.artists[0]));
    let response = musicbrainz_get(MB_CLIENT.get(format!("{MB_BASE}/recording")).query(&[("query", query.as_str()), ("fmt", "json"), ("limit", "25")])).await
        .map_err(|_| "Recording lookup unavailable")?;
    if !response.status().is_success() { return Err("Recording lookup unavailable".into()); }
    let value = response.bounded_json(MAX_JSON_BYTES).await.map_err(|_| "Recording lookup unavailable")?;
    Ok(exact_playlist_recording(&value, &source))
}

#[cfg(test)]
mod playlist_metadata_identity_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn recording_search_requires_complete_unique_version_credits_and_duration_evidence() {
        let source = PlaylistRecordingSearch { title: "夜の歌 (Live)".into(), artists: vec!["Artist A".into(), "Artist B".into()], duration_ms: 180000 };
        let id = "11111111-1111-4111-8111-111111111111";
        let exact = json!({"id":id,"title":source.title,"length":180200,"artist-credit":[{"artist":{"name":"Artist B"}},{"artist":{"name":"Artist A"}}]});
        let response = json!({"count":1,"recordings":[exact]});
        assert_eq!(exact_playlist_recording(&response, &source).as_deref(), Some(id));
        for change in [json!({"title":"夜の歌"}), json!({"length":184000}), json!({"length":null}),
            json!({"artist-credit":[{"artist":{"name":"Other"}}]})] {
            let mut invalid = response.clone();
            for (key, value) in change.as_object().unwrap() { invalid["recordings"][0][key] = value.clone(); }
            assert!(exact_playlist_recording(&invalid, &source).is_none());
        }
        let mut partial = response.clone(); partial["count"] = json!(26);
        assert!(exact_playlist_recording(&partial, &source).is_none());
        let mut ambiguous = response;
        let mut other = ambiguous["recordings"][0].clone(); other["id"] = json!("22222222-2222-4222-8222-222222222222");
        ambiguous["recordings"].as_array_mut().unwrap().push(other); ambiguous["count"] = json!(2);
        assert!(exact_playlist_recording(&ambiguous, &source).is_none());
    }
}

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

/// Only exact recording IDs or exact release-track relationships; no name search.
#[derive(Clone,Copy)]
pub(crate) enum ExactPlaylistIdentity { Recording,ReleaseTrack }
pub(crate) async fn exact_playlist_identity_json(kind:ExactPlaylistIdentity,id:&str,current:&impl Fn()->bool)->Result<serde_json::Value> {
    exact_playlist_identity_from(&MB_CLIENT,MB_BASE,&LIMITER,kind,id,current).await
}
async fn exact_playlist_identity_from(client:&reqwest::Client,base:&str,limiter:&RequestLimiter,kind:ExactPlaylistIdentity,id:&str,current:&impl Fn()->bool)->Result<serde_json::Value> {
    if !current(){anyhow::bail!("Recording connection changed")}
    let canonical=uuid::Uuid::parse_str(id).context("Invalid exact MusicBrainz reference")?;
    if id.len()!=36||canonical.to_string()!=id {anyhow::bail!("Invalid exact MusicBrainz reference")}
    let request=match kind {
        ExactPlaylistIdentity::Recording=>client.get(format!("{base}/recording/{id}")).query(&[("inc","artist-credits"),("fmt","json")]),
        ExactPlaylistIdentity::ReleaseTrack=>client.get(format!("{base}/release")).query(&[("track",id),("inc","recordings+artist-credits"),("fmt","json"),("limit","5")]),
    };
    limiter.wait().await;
    if !current(){anyhow::bail!("Recording connection changed")}
    let response=request.send().await.map_err(|e|e.without_url()).context("Exact MusicBrainz read unavailable")?;
    if !current(){anyhow::bail!("Recording connection changed")}
    if !response.status().is_success(){anyhow::bail!("Exact MusicBrainz read unavailable")}
    let value=response.bounded_json(MAX_JSON_BYTES).await.context("Invalid exact MusicBrainz response")?;
    if !current(){anyhow::bail!("Recording connection changed")}
    Ok(value)
}
#[cfg(test)]
mod playlist_exact_tests {
    use super::*;
    use std::sync::{Arc,atomic::{AtomicBool,Ordering}};
    use tokio::io::{AsyncReadExt,AsyncWriteExt};
    #[tokio::test]
    async fn exact_playlist_reads_use_canonical_endpoints_bounded_json_and_current_context() {
        let id="11111111-1111-4111-8111-111111111111";
        for case in 0..4 {
            let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let base=format!("http://{}/ws/2",listener.local_addr().unwrap());
            let live=Arc::new(AtomicBool::new(true));let server_live=live.clone();
            let server=tokio::spawn(async move {
                let (mut stream,_)=tokio::time::timeout(std::time::Duration::from_secs(8),listener.accept()).await.unwrap().unwrap();let mut bytes=Vec::new();let mut buffer=[0;4096];
                while !bytes.windows(4).any(|w|w==b"\r\n\r\n") {let n=tokio::time::timeout(std::time::Duration::from_secs(5),stream.read(&mut buffer)).await.unwrap().unwrap();assert!(n>0);bytes.extend_from_slice(&buffer[..n]);assert!(bytes.len()<65536)}
                let request=String::from_utf8(bytes).unwrap();let line=request.lines().next().unwrap().split_whitespace().collect::<Vec<_>>();assert_eq!(line[0],"GET");let url=url::Url::parse(&format!("http://fixture{}",line[1])).unwrap();
                let query=url.query_pairs().into_owned().collect::<std::collections::BTreeMap<_,_>>();assert_eq!(query["fmt"],"json");assert!(!query.contains_key("query"));
                if case==1 {assert_eq!(url.path(),"/ws/2/release");assert_eq!(query["track"],id);assert_eq!(query["limit"],"5");assert_eq!(query["inc"],"recordings+artist-credits");}else{assert_eq!(url.path(),format!("/ws/2/recording/{id}"));assert_eq!(query["inc"],"artist-credits");}
                if case==3 {server_live.store(false,Ordering::SeqCst)}
                let body="{}";let length=if case==2{MAX_JSON_BYTES+1}else{body.len()};stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n{body}").as_bytes()).await.unwrap();
            });
            let limiter=RequestLimiter::new();let client=reqwest::Client::builder().timeout(std::time::Duration::from_secs(5)).build().unwrap();let kind=if case==1{ExactPlaylistIdentity::ReleaseTrack}else{ExactPlaylistIdentity::Recording};
            let outcome=exact_playlist_identity_from(&client,&base,&limiter,kind,id,&||live.load(Ordering::SeqCst)).await;assert_eq!(outcome.is_ok(),case<2);server.await.unwrap();
        }
    }
}
