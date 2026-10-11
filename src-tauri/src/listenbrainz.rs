#![allow(dead_code)]
//! ListenBrainz API integration — scrobbling (submit listens) and now-playing updates.
//!
//! Authentication uses a simple user token (no OAuth). Users copy it from their
//! ListenBrainz profile page at https://listenbrainz.org/settings/.

use crate::http_response::{BoundedResponseExt, MAX_JSON_BYTES};
use anyhow::{bail, Context, Result};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};

const LB_BASE: &str = "https://api.listenbrainz.org/1";

static LB_CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .user_agent("Plexify/1.0 (https://github.com/plexify)")
        .build()
        .expect("Failed to build ListenBrainz HTTP client")
});

// ---------------------------------------------------------------------------
// Private response models
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct ValidateTokenResponse {
    valid: bool,
    #[serde(default)]
    user_name: Option<String>,
}

// ---------------------------------------------------------------------------
// Public return types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Clone)]
pub struct ListenBrainzTokenResult {
    pub valid: bool,
    pub username: String,
}

// ---------------------------------------------------------------------------
// Public API functions
// ---------------------------------------------------------------------------

/// Validate a ListenBrainz user token and return the associated username.
pub async fn validate_token(token: &str) -> Result<ListenBrainzTokenResult> {
    let resp: ValidateTokenResponse = LB_CLIENT
        .get(format!("{}/validate-token", LB_BASE))
        .query(&[("token", token)])
        .send()
        .await.map_err(|error| error.without_url())
        .context("Failed to reach ListenBrainz validate-token")?
        .error_for_status().map_err(|error| error.without_url())
        .context("ListenBrainz validate-token returned error status")?
        .bounded_json(MAX_JSON_BYTES)
        .await
        .context("Failed to parse ListenBrainz validate-token response")?;

    if !resp.valid {
        bail!("Invalid ListenBrainz token");
    }

    Ok(ListenBrainzTokenResult {
        valid: true,
        username: resp.user_name.unwrap_or_default(),
    })
}

/// Build the `additional_info` JSON object, including any MBIDs when available.
fn build_additional_info(
    duration_ms: u64,
    recording_mbid: &str,
    artist_mbids: &[String],
    release_mbid: &str,
    release_group_mbid: &str,
) -> serde_json::Value {
    let mut info = serde_json::json!({
        "duration_ms": duration_ms,
        "submission_client": "Plexify",
    });
    let obj = info.as_object_mut().unwrap();
    if !recording_mbid.is_empty() {
        obj.insert("recording_mbid".into(), serde_json::json!(recording_mbid));
    }
    if !artist_mbids.is_empty() {
        obj.insert("artist_mbids".into(), serde_json::json!(artist_mbids));
    }
    if !release_mbid.is_empty() {
        obj.insert("release_mbid".into(), serde_json::json!(release_mbid));
    }
    if !release_group_mbid.is_empty() {
        obj.insert("release_group_mbid".into(), serde_json::json!(release_group_mbid));
    }
    info
}

/// Submit a "playing now" update to ListenBrainz.
pub async fn submit_now_playing(
    token: &str,
    artist: &str,
    track: &str,
    album: &str,
    duration_ms: u64,
    recording_mbid: &str,
    artist_mbids: &[String],
    release_mbid: &str,
    release_group_mbid: &str,
) -> Result<()> {
    let additional_info = build_additional_info(
        duration_ms, recording_mbid, artist_mbids, release_mbid, release_group_mbid,
    );

    let payload = serde_json::json!({
        "listen_type": "playing_now",
        "payload": [{
            "track_metadata": {
                "artist_name": artist,
                "track_name": track,
                "release_name": album,
                "additional_info": additional_info,
            }
        }]
    });

    LB_CLIENT
        .post(format!("{}/submit-listens", LB_BASE))
        .header("Authorization", format!("Token {}", token))
        .json(&payload)
        .send()
        .await.map_err(|error| error.without_url())
        .context("Failed to reach ListenBrainz submit-listens (now playing)")?
        .error_for_status().map_err(|error| error.without_url())
        .context("ListenBrainz submit-listens (now playing) returned error status")?;

    Ok(())
}

/// Submit a completed listen to ListenBrainz.
///
/// `listened_at` is a Unix timestamp (seconds) when the track started playing.
pub async fn submit_listen(
    token: &str,
    artist: &str,
    track: &str,
    album: &str,
    duration_ms: u64,
    listened_at: u64,
    recording_mbid: &str,
    artist_mbids: &[String],
    release_mbid: &str,
    release_group_mbid: &str,
) -> Result<()> {
    let additional_info = build_additional_info(
        duration_ms, recording_mbid, artist_mbids, release_mbid, release_group_mbid,
    );

    let payload = serde_json::json!({
        "listen_type": "single",
        "payload": [{
            "listened_at": listened_at,
            "track_metadata": {
                "artist_name": artist,
                "track_name": track,
                "release_name": album,
                "additional_info": additional_info,
            }
        }]
    });

    LB_CLIENT
        .post(format!("{}/submit-listens", LB_BASE))
        .header("Authorization", format!("Token {}", token))
        .json(&payload)
        .send()
        .await.map_err(|error| error.without_url())
        .context("Failed to reach ListenBrainz submit-listens")?
        .error_for_status().map_err(|error| error.without_url())
        .context("ListenBrainz submit-listens returned error status")?;

    Ok(())
}
