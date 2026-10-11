#![allow(dead_code)]
//! Last.fm API integration — authentication, scrobbling, now-playing, love/unlove,
//! and public metadata (artist info, track info, album info).
//!
//! # Security
//! The API secret NEVER leaves this module. All signing is done here in Rust.
//! Tauri commands pass credentials through from `PlexSettings` loaded from disk;
//! the TypeScript frontend only ever receives session keys and display data.
//!
//! # Auth flow
//! 1. `get_token(api_key)`       — returns a temporary token + auth URL
//! 2. Open auth URL in browser   — user grants access
//! 3. `get_session(api_key, api_secret, token)` — exchanges token for permanent session key
//! 4. Store session key in `PlexSettings.lastfm_session_key`

use crate::http_response::{BoundedResponseExt, MAX_JSON_BYTES};
use anyhow::{bail, Context, Result};
use md5::{Digest, Md5};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const LASTFM_BASE: &str = "https://ws.audioscrobbler.com/2.0/";

static LASTFM_CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .expect("Failed to build Last.fm HTTP client")
});

// ---------------------------------------------------------------------------
// Private response models (deserialization only)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct TokenResponse {
    token: String,
}

#[derive(Debug, Deserialize)]
struct SessionInner {
    name: String,
    key: String,
}

#[derive(Debug, Deserialize)]
struct SessionResponse {
    session: SessionInner,
}

#[derive(Debug, Deserialize)]
struct UserInner {
    name: String,
    url: String,
    #[serde(rename = "playcount", default)]
    play_count: String,
}

#[derive(Debug, Deserialize)]
struct UserInfoResponse {
    user: UserInner,
}

#[derive(Debug, Deserialize)]
struct ArtistStats {
    #[serde(default)]
    listeners: String,
    #[serde(default)]
    playcount: String,
}

#[derive(Debug, Deserialize)]
struct BioPart {
    #[serde(default)]
    summary: String,
}

#[derive(Debug, Deserialize)]
struct TagItem {
    name: String,
}

#[derive(Debug, Deserialize)]
struct TagList {
    #[serde(default, rename = "tag")]
    tags: Vec<TagItem>,
}

#[derive(Debug, Deserialize)]
struct ImageItem {
    #[serde(rename = "#text", default)]
    url: String,
    #[serde(default)]
    size: String,
}

#[derive(Debug, Deserialize)]
struct SimilarArtistItem {
    name: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    image: Vec<ImageItem>,
}

#[derive(Debug, Deserialize)]
struct SimilarArtistList {
    #[serde(default, rename = "artist")]
    artists: Vec<SimilarArtistItem>,
}

#[derive(Debug, Deserialize)]
struct ArtistInner {
    name: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    stats: Option<ArtistStats>,
    #[serde(default)]
    bio: Option<BioPart>,
    #[serde(default)]
    tags: Option<TagList>,
    #[serde(default)]
    similar: Option<SimilarArtistList>,
}

#[derive(Debug, Deserialize)]
struct ArtistInfoResponse {
    artist: ArtistInner,
}

#[derive(Debug, Deserialize)]
struct TrackArtistInner {
    #[serde(default)]
    name: String,
}

#[derive(Debug, Deserialize)]
struct WikiPart {
    #[serde(default)]
    summary: String,
}

#[derive(Debug, Deserialize)]
struct TrackInner {
    name: String,
    #[serde(default)]
    artist: Option<TrackArtistInner>,
    #[serde(default)]
    listeners: String,
    #[serde(default)]
    playcount: String,
    #[serde(default)]
    wiki: Option<WikiPart>,
    #[serde(default, rename = "toptags")]
    top_tags: Option<TagList>,
}

#[derive(Debug, Deserialize)]
struct TrackInfoResponse {
    track: TrackInner,
}

#[derive(Debug, Deserialize)]
struct AlbumInner {
    name: String,
    #[serde(default)]
    artist: String,
    #[serde(default)]
    wiki: Option<WikiPart>,
    #[serde(default)]
    tags: Option<TagList>,
}

#[derive(Debug, Deserialize)]
struct AlbumInfoResponse {
    album: AlbumInner,
}

/// Returned by any Last.fm API call that fails at the application level
/// (HTTP 200 but body contains `{"error": N, "message": "..."}`).
#[derive(Debug, Deserialize)]
struct LastfmError {
    error: u32,
    message: String,
}

// ---------------------------------------------------------------------------
// Public return types (serialized to TypeScript via Tauri)
// ---------------------------------------------------------------------------

/// Step 1 of auth — frontend opens `auth_url` in the system browser.
#[derive(Debug, Serialize, Clone)]
pub struct LastfmAuthToken {
    pub token: String,
    pub auth_url: String,
}

/// Returned after successful authentication — store `session_key` in settings.
#[derive(Debug, Serialize, Clone)]
pub struct LastfmSession {
    pub username: String,
    #[serde(skip_serializing)]
    pub session_key: String,
}

/// Basic user info (fetched after auth to show the username in Settings).
#[derive(Debug, Serialize, Clone)]
pub struct LastfmUserInfo {
    pub username: String,
    pub url: String,
    pub play_count: u64,
}

/// Artist from the "similar artists" list.
#[derive(Debug, Serialize, Clone)]
pub struct LastfmSimilarArtist {
    pub name: String,
    pub url: String,
    pub image_url: Option<String>,
}

/// Full artist metadata returned by `artist.getInfo`.
#[derive(Debug, Serialize, Clone)]
pub struct LastfmArtistInfo {
    pub name: String,
    pub url: String,
    pub listeners: u64,
    pub play_count: u64,
    /// Plain-text biography (HTML tags stripped).
    pub bio: String,
    pub tags: Vec<String>,
    pub similar: Vec<LastfmSimilarArtist>,}

/// Track metadata returned by `track.getInfo`.
#[derive(Debug, Serialize, Clone)]
pub struct LastfmTrackInfo {
    pub name: String,
    pub artist: String,
    pub listeners: u64,
    pub play_count: u64,
    pub tags: Vec<String>,
    /// Short wiki summary (may contain HTML).
    pub wiki: Option<String>,
}

/// Album metadata returned by `album.getInfo`.
#[derive(Debug, Serialize, Clone)]
pub struct LastfmAlbumInfo {
    pub name: String,
    pub artist: String,
    pub tags: Vec<String>,
    /// Short wiki summary (may contain HTML).
    pub wiki: Option<String>,
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Build an HMAC-free API signature as required by Last.fm:
/// sort all params (except `format` and `callback`) alphabetically,
/// concatenate key+value pairs, append the API secret, then MD5.
fn sign(params: &BTreeMap<&str, &str>, api_secret: &str) -> String {
    let mut s = String::new();
    for (k, v) in params {
        if *k != "format" && *k != "callback" {
            s.push_str(k);
            s.push_str(v);
        }
    }
    s.push_str(api_secret);
    let mut hasher = Md5::new();
    hasher.update(s.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Parse a string field that Last.fm returns for numeric values (listeners, playcounts, etc.)
fn parse_count(s: &str) -> u64 {
    // Last.fm may include commas in large numbers (e.g. "1,234,567")
    s.replace(',', "").parse::<u64>().unwrap_or(0)
}

/// Strip basic HTML tags from Last.fm bio/wiki summaries.
/// Last.fm typically includes `<a href="...">text</a>` links and `<br>` elements.
fn strip_html(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => result.push(c),
            _ => {}
        }
    }
    // Last.fm appends " <a href="https://www.last.fm/...">Read more on Last.fm</a>" — trim trailing.
    let trimmed = result.trim();
    trimmed.to_string()
}

/// Last.fm deprecated their artist image API in 2019.
/// All deprecated images resolve to the same blank placeholder (MD5 hash in the URL).
fn is_placeholder_image(url: &str) -> bool {
    url.contains("2a96cbd8b46e442fc41c2b86b821562f")
}

/// Extract the best-quality image URL from a Last.fm image array.
/// Prefers "extralarge" > "large" > "medium" > any non-empty, non-placeholder URL.
fn best_image(images: &[ImageItem]) -> Option<String> {
    let preferred = ["extralarge", "large", "medium", "small"];
    for size in &preferred {
        if let Some(img) = images.iter().find(|i| &i.size == size) {
            if !img.url.is_empty() && !is_placeholder_image(&img.url) {
                return Some(img.url.clone());
            }
        }
    }
    images
        .iter()
        .find(|i| !i.url.is_empty() && !is_placeholder_image(&i.url))
        .map(|i| i.url.clone())
}

/// Check whether a JSON response body is a Last.fm application-level error.
/// Last.fm returns HTTP 200 even for errors like "Artist not found" (error code 6).
fn check_lastfm_error(bytes: &[u8]) -> Result<()> {
    let response: serde_json::Value = serde_json::from_slice(bytes)
        .context("Invalid Last.fm JSON response")?;
    if response.get("error").is_some() {
        let err: LastfmError = serde_json::from_value(response)
            .context("Invalid Last.fm error response")?;
        if err.error != 0 {
            bail!("Last.fm error {}: {}", err.error, err.message);
        }
    }
    Ok(())
}

fn check_scrobble_response(bytes: &[u8]) -> Result<()> {
    check_lastfm_error(bytes)?;
    let response: serde_json::Value = serde_json::from_slice(bytes)?;
    let batch = response.get("scrobbles").context("Missing Last.fm scrobble acknowledgement")?;
    let number = |value: Option<&serde_json::Value>| {
        value.and_then(|value| value.as_u64().or_else(|| value.as_str()?.parse::<u64>().ok()))
    };
    let attributes = batch.get("@attr");
    let accepted = number(attributes.and_then(|value| value.get("accepted")));
    let ignored = number(attributes.and_then(|value| value.get("ignored")));
    let item = batch.get("scrobble").and_then(|value| {
        if let Some(items) = value.as_array() {
            if items.len() == 1 { items.first() } else { None }
        } else { Some(value) }
    });
    let code_value = item.and_then(|value| value.get("ignoredMessage")).and_then(|value| value.get("code"));
    let code = number(code_value);
    // HTTP 200 can still mean an ignored scrobble. Only an explicit accepted
    // single submission permits the durable listening queue to delete its job.
    if accepted != Some(1) || ignored != Some(0) || (code_value.is_some() && code != Some(0)) {
        bail!("Last.fm did not accept this scrobble (ignored code {})", code.map(|code| code.to_string()).unwrap_or_else(|| "unknown".into()));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/// Step 1 of the Last.fm auth flow: request a temporary token.
///
/// Returns the token and the URL the user must visit to approve access.
pub async fn get_token(api_key: &str) -> Result<LastfmAuthToken> {
    let resp = LASTFM_CLIENT
        .get(LASTFM_BASE)
        .query(&[
            ("method", "auth.getToken"),
            ("api_key", api_key),
            ("format", "json"),
        ])
        .send()
        .await.map_err(|error| error.without_url())
        .context("Failed to reach Last.fm")?
        .error_for_status().map_err(|error| error.without_url())
        .context("Last.fm auth.getToken returned error status")?
        .bounded_bytes(MAX_JSON_BYTES)
        .await
        .context("Failed to read Last.fm token response")?;

    check_lastfm_error(&resp)?;

    let parsed: TokenResponse =
        serde_json::from_slice(&resp).context("Failed to parse Last.fm token response")?;

    let auth_url = format!(
        "https://www.last.fm/api/auth/?api_key={}&token={}",
        api_key, parsed.token
    );

    Ok(LastfmAuthToken { token: parsed.token, auth_url })
}

/// Step 3 of the Last.fm auth flow: exchange an authorized token for a session key.
///
/// The user must have approved the request at the `auth_url` from `get_token` first.
pub async fn get_session(api_key: &str, api_secret: &str, token: &str) -> Result<LastfmSession> {
    let mut params = BTreeMap::new();
    params.insert("api_key", api_key);
    params.insert("method", "auth.getSession");
    params.insert("token", token);

    let sig = sign(&params, api_secret);

    let resp = LASTFM_CLIENT
        .post(LASTFM_BASE)
        .form(&[
            ("method", "auth.getSession"),
            ("api_key", api_key),
            ("token", token),
            ("api_sig", &sig),
            ("format", "json"),
        ])
        .send()
        .await.map_err(|error| error.without_url())
        .context("Failed to reach Last.fm")?
        .error_for_status().map_err(|error| error.without_url())
        .context("Last.fm auth.getSession returned error status")?
        .bounded_bytes(MAX_JSON_BYTES)
        .await
        .context("Failed to read Last.fm session response")?;

    check_lastfm_error(&resp)?;

    let parsed: SessionResponse =
        serde_json::from_slice(&resp).context("Failed to parse Last.fm session response")?;

    Ok(LastfmSession {
        username: parsed.session.name,
        session_key: parsed.session.key,
    })
}

/// Fetch basic user info for the authenticated account.
/// Used to display the connected username in Settings.
pub async fn get_user_info(api_key: &str, username: &str) -> Result<LastfmUserInfo> {
    let resp = LASTFM_CLIENT
        .get(LASTFM_BASE)
        .query(&[
            ("method", "user.getInfo"),
            ("user", username),
            ("api_key", api_key),
            ("format", "json"),
        ])
        .send()
        .await.map_err(|error| error.without_url())
        .context("Failed to reach Last.fm user.getInfo")?
        .error_for_status().map_err(|error| error.without_url())
        .context("Last.fm user.getInfo returned error status")?
        .bounded_bytes(MAX_JSON_BYTES)
        .await
        .context("Failed to read Last.fm user info")?;

    check_lastfm_error(&resp)?;

    let parsed: UserInfoResponse =
        serde_json::from_slice(&resp).context("Failed to parse Last.fm user info")?;

    Ok(LastfmUserInfo {
        username: parsed.user.name,
        url: parsed.user.url,
        play_count: parse_count(&parsed.user.play_count),
    })
}

// ---------------------------------------------------------------------------
// Public metadata (no session key required)
// ---------------------------------------------------------------------------

/// Fetch artist metadata: biography, listeners, tags, and similar artists.
pub async fn get_artist_info(api_key: &str, artist: &str) -> Result<LastfmArtistInfo> {
    let resp = LASTFM_CLIENT
        .get(LASTFM_BASE)
        .query(&[
            ("method", "artist.getInfo"),
            ("artist", artist),
            ("api_key", api_key),
            ("autocorrect", "1"),
            ("format", "json"),
        ])
        .send()
        .await.map_err(|error| error.without_url())
        .context("Failed to reach Last.fm artist.getInfo")?
        .error_for_status().map_err(|error| error.without_url())
        .context("Last.fm artist.getInfo returned error status")?
        .bounded_bytes(MAX_JSON_BYTES)
        .await
        .context("Failed to read Last.fm artist info")?;

    check_lastfm_error(&resp)?;

    let parsed: ArtistInfoResponse =
        serde_json::from_slice(&resp).context("Failed to parse Last.fm artist info")?;

    let a = parsed.artist;
    let stats = a.stats.as_ref();

    let similar = a
        .similar
        .map(|s| {
            s.artists
                .into_iter()
                .map(|sa| LastfmSimilarArtist {
                    image_url: best_image(&sa.image),
                    name: sa.name,
                    url: sa.url,
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(LastfmArtistInfo {
        name: a.name,
        url: a.url,
        listeners: stats.map(|s| parse_count(&s.listeners)).unwrap_or(0),
        play_count: stats.map(|s| parse_count(&s.playcount)).unwrap_or(0),
        bio: a.bio.map(|b| strip_html(&b.summary)).unwrap_or_default(),
        tags: a
            .tags
            .map(|t| t.tags.into_iter().map(|tag| tag.name).collect())
            .unwrap_or_default(),
        similar,
    })
}

/// Fetch track metadata: listeners, play count, tags, and wiki summary.
pub async fn get_track_info(api_key: &str, artist: &str, track: &str) -> Result<LastfmTrackInfo> {
    let resp = LASTFM_CLIENT
        .get(LASTFM_BASE)
        .query(&[
            ("method", "track.getInfo"),
            ("artist", artist),
            ("track", track),
            ("api_key", api_key),
            ("autocorrect", "1"),
            ("format", "json"),
        ])
        .send()
        .await.map_err(|error| error.without_url())
        .context("Failed to reach Last.fm track.getInfo")?
        .error_for_status().map_err(|error| error.without_url())
        .context("Last.fm track.getInfo returned error status")?
        .bounded_bytes(MAX_JSON_BYTES)
        .await
        .context("Failed to read Last.fm track info")?;

    check_lastfm_error(&resp)?;

    let parsed: TrackInfoResponse =
        serde_json::from_slice(&resp).context("Failed to parse Last.fm track info")?;

    let t = parsed.track;
    Ok(LastfmTrackInfo {
        name: t.name,
        artist: t.artist.map(|a| a.name).unwrap_or_default(),
        listeners: parse_count(&t.listeners),
        play_count: parse_count(&t.playcount),
        tags: t
            .top_tags
            .map(|tl| tl.tags.into_iter().map(|tag| tag.name).collect())
            .unwrap_or_default(),
        wiki: t.wiki.map(|w| strip_html(&w.summary)).filter(|s| !s.is_empty()),
    })
}

/// Fetch album metadata: tags and wiki summary.
pub async fn get_album_info(api_key: &str, artist: &str, album: &str) -> Result<LastfmAlbumInfo> {
    let resp = LASTFM_CLIENT
        .get(LASTFM_BASE)
        .query(&[
            ("method", "album.getInfo"),
            ("artist", artist),
            ("album", album),
            ("api_key", api_key),
            ("autocorrect", "1"),
            ("format", "json"),
        ])
        .send()
        .await.map_err(|error| error.without_url())
        .context("Failed to reach Last.fm album.getInfo")?
        .error_for_status().map_err(|error| error.without_url())
        .context("Last.fm album.getInfo returned error status")?
        .bounded_bytes(MAX_JSON_BYTES)
        .await
        .context("Failed to read Last.fm album info")?;

    check_lastfm_error(&resp)?;

    let parsed: AlbumInfoResponse =
        serde_json::from_slice(&resp).context("Failed to parse Last.fm album info")?;

    let al = parsed.album;
    Ok(LastfmAlbumInfo {
        name: al.name,
        artist: al.artist,
        tags: al
            .tags
            .map(|t| t.tags.into_iter().map(|tag| tag.name).collect())
            .unwrap_or_default(),
        wiki: al.wiki.map(|w| strip_html(&w.summary)).filter(|s| !s.is_empty()),
    })
}

// ---------------------------------------------------------------------------
// Authenticated write operations (require session key + signing)
// ---------------------------------------------------------------------------

/// Update the "Now Playing" status on Last.fm.
/// Should be called when a track starts playing. Non-fatal — errors are logged.
pub async fn update_now_playing(
    api_key: &str,
    api_secret: &str,
    session_key: &str,
    artist: &str,
    track: &str,
    album: &str,
    album_artist: &str,
    duration_secs: u32,
) -> Result<()> {
    let duration_str = duration_secs.to_string();
    let mut params = BTreeMap::new();
    params.insert("album", album);
    params.insert("albumArtist", album_artist);
    params.insert("api_key", api_key);
    params.insert("artist", artist);
    params.insert("duration", &duration_str);
    params.insert("method", "track.updateNowPlaying");
    params.insert("sk", session_key);
    params.insert("track", track);

    let sig = sign(&params, api_secret);

    let resp = LASTFM_CLIENT
        .post(LASTFM_BASE)
        .form(&[
            ("method", "track.updateNowPlaying"),
            ("artist", artist),
            ("track", track),
            ("album", album),
            ("albumArtist", album_artist),
            ("duration", &duration_str),
            ("api_key", api_key),
            ("api_sig", &sig),
            ("sk", session_key),
            ("format", "json"),
        ])
        .send()
        .await.map_err(|error| error.without_url())
        .context("Failed to reach Last.fm track.updateNowPlaying")?
        .error_for_status().map_err(|error| error.without_url())
        .context("Last.fm track.updateNowPlaying returned error status")?
        .bounded_bytes(MAX_JSON_BYTES)
        .await
        .context("Failed to read Last.fm now-playing response")?;

    check_lastfm_error(&resp)
}

/// Scrobble a track to Last.fm.
///
/// `started_at_unix` is the Unix timestamp (seconds) when the track started playing.
/// Enforces Last.fm scrobble rules:
/// - Track must be longer than 30 seconds
/// - User must have listened for > 50% of duration OR > 4 minutes
pub async fn scrobble(
    api_key: &str,
    api_secret: &str,
    session_key: &str,
    artist: &str,
    track: &str,
    album: &str,
    album_artist: &str,
    duration_secs: u32,
    started_at_unix: u64,
    listened_secs: u64,
) -> Result<()> {
    // Enforce scrobble rules
    if duration_secs < 30 {
        bail!("Track too short to scrobble ({duration_secs}s < 30s)");
    }
    let half_duration = (duration_secs as u64) / 2;
    if listened_secs < half_duration && listened_secs < 240 {
        bail!(
            "Not enough of the track was listened to scrobble ({listened_secs}s listened, need {}s or 240s)",
            half_duration
        );
    }

    let timestamp_str = started_at_unix.to_string();
    let duration_str = duration_secs.to_string();

    let mut params = BTreeMap::new();
    params.insert("album", album);
    params.insert("albumArtist", album_artist);
    params.insert("api_key", api_key);
    params.insert("artist", artist);
    params.insert("duration", &duration_str);
    params.insert("method", "track.scrobble");
    params.insert("sk", session_key);
    params.insert("timestamp", &timestamp_str);
    params.insert("track", track);

    let sig = sign(&params, api_secret);

    let resp = LASTFM_CLIENT
        .post(LASTFM_BASE)
        .form(&[
            ("method", "track.scrobble"),
            ("artist", artist),
            ("track", track),
            ("album", album),
            ("albumArtist", album_artist),
            ("duration", &duration_str),
            ("timestamp", &timestamp_str),
            ("api_key", api_key),
            ("api_sig", &sig),
            ("sk", session_key),
            ("format", "json"),
        ])
        .send()
        .await.map_err(|error| error.without_url())
        .context("Failed to reach Last.fm track.scrobble")?
        .error_for_status().map_err(|error| error.without_url())
        .context("Last.fm track.scrobble returned error status")?
        .bounded_bytes(MAX_JSON_BYTES)
        .await
        .context("Failed to read Last.fm scrobble response")?;

    check_scrobble_response(&resp)
}

/// Love or unlove a track on Last.fm.
///
/// `love = true`  → `track.love`
/// `love = false` → `track.unlove`
pub async fn love_track(
    api_key: &str,
    api_secret: &str,
    session_key: &str,
    artist: &str,
    track: &str,
    love: bool,
) -> Result<()> {
    let method = if love { "track.love" } else { "track.unlove" };

    let mut params = BTreeMap::new();
    params.insert("api_key", api_key);
    params.insert("artist", artist);
    params.insert("method", method);
    params.insert("sk", session_key);
    params.insert("track", track);

    let sig = sign(&params, api_secret);

    let resp = LASTFM_CLIENT
        .post(LASTFM_BASE)
        .form(&[
            ("method", method),
            ("artist", artist),
            ("track", track),
            ("api_key", api_key),
            ("api_sig", &sig),
            ("sk", session_key),
            ("format", "json"),
        ])
        .send()
        .await.map_err(|error| error.without_url())
        .with_context(|| format!("Failed to reach Last.fm {method}"))?
        .error_for_status().map_err(|error| error.without_url())
        .with_context(|| format!("Last.fm {method} returned error status"))?
        .bounded_bytes(MAX_JSON_BYTES)
        .await
        .with_context(|| format!("Failed to read Last.fm {method} response"))?;

    check_lastfm_error(&resp)
}

#[cfg(test)]
mod credential_tests {
    #[test]
    fn auth_result_does_not_expose_the_session_key() {
        let session = super::LastfmSession { username: "listener".into(), session_key: "private-session".into() };
        let json = serde_json::to_value(&session).unwrap();
        assert_eq!(json["username"], "listener");
        assert!(json.get("session_key").is_none());
        assert_eq!(session.session_key, "private-session");
    }
}

#[cfg(test)]
mod response_tests {
    use super::*;

    #[test]
    fn ignored_or_malformed_scrobbles_are_not_successful_acknowledgements() {
        for body in [
            br##"{"scrobbles":{"@attr":{"accepted":"0","ignored":"1"},"scrobble":{"ignoredMessage":{"code":"5","#text":"Daily limit"}}}}"##.as_slice(),
            b"<html>Proxy login</html>".as_slice(),
            b"{}".as_slice(),
            br#"{"scrobbles":{"@attr":{"accepted":"1","ignored":"0"},"scrobble":{"ignoredMessage":{"code":"4"}}}}"#.as_slice(),
            br#"{"scrobbles":{"@attr":{"accepted":"1","ignored":"0"},"scrobble":{"ignoredMessage":{"code":"invalid"}}}}"#.as_slice(),
        ] {
            assert!(check_scrobble_response(body).is_err(), "unaccepted scrobble was acknowledged");
        }
    }

    #[test]
    fn accepted_single_scrobble_counts_allow_string_and_numeric_api_attributes() {
        for body in [
            br##"{"scrobbles":{"@attr":{"accepted":"1","ignored":"0"},"scrobble":{"ignoredMessage":{"code":"0","#text":""}}}}"##.as_slice(),
            br#"{"scrobbles":{"@attr":{"accepted":1,"ignored":0},"scrobble":[{"ignoredMessage":{"code":0}}]}}"#.as_slice(),
        ] {
            assert!(check_scrobble_response(body).is_ok());
        }
        assert!(check_lastfm_error(b"<html>Proxy error</html>").is_err());
        assert!(check_lastfm_error(br#"{"error":9,"message":"Session invalid"}"#).is_err());
        assert!(check_lastfm_error(b"{}").is_ok());
    }
}
