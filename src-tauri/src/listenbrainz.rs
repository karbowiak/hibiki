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
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("Hibiki/", env!("CARGO_PKG_VERSION"), " (https://github.com/karbowiak/hibiki)"))
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

#[derive(Deserialize)]
struct SubmissionResponse {
    status: String,
}

async fn acknowledge_submission(response: reqwest::Response) -> Result<()> {
    let response: SubmissionResponse = response.bounded_json(MAX_JSON_BYTES).await
        .context("Invalid ListenBrainz submission acknowledgement")?;
    if response.status != "ok" {
        bail!("ListenBrainz did not accept this submission");
    }
    Ok(())
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
    let request = LB_CLIENT
        .get(format!("{}/validate-token", LB_BASE))
        .query(&[("token", token)]);
    let resp: ValidateTokenResponse = crate::listenbrainz_transport::send(request)
        .await
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
        "submission_client": "Hibiki",
        "submission_client_version": env!("CARGO_PKG_VERSION"),
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

    let request = LB_CLIENT
        .post(format!("{}/submit-listens", LB_BASE))
        .header("Authorization", format!("Token {}", token))
        .json(&payload);
    let response = crate::listenbrainz_transport::send(request)
        .await
        .context("Failed to reach ListenBrainz submit-listens (now playing)")?
        .error_for_status().map_err(|error| error.without_url())
        .context("ListenBrainz submit-listens (now playing) returned error status")?;

    acknowledge_submission(response).await
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

    let request = LB_CLIENT
        .post(format!("{}/submit-listens", LB_BASE))
        .header("Authorization", format!("Token {}", token))
        .json(&payload);
    let response = crate::listenbrainz_transport::send(request)
        .await
        .context("Failed to reach ListenBrainz submit-listens")?
        .error_for_status().map_err(|error| error.without_url())
        .context("ListenBrainz submit-listens returned error status")?;

    acknowledge_submission(response).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn response(body: &[u8]) -> reqwest::Response {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let body = body.to_vec();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0; 2048];
            let read = stream.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..read]).to_lowercase();
            assert!(request.contains("user-agent: hibiki/") && request.contains("https://github.com/karbowiak/hibiki"));
            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes()).await.unwrap();
            stream.write_all(&body).await.unwrap();
        });
        LB_CLIENT.get(format!("http://{address}/")).send().await.unwrap()
    }

    #[tokio::test]
    async fn only_explicit_success_acknowledges_a_submission() {
        for body in [b"<html>Proxy login</html>".as_slice(), b"{}", br#"{"status":"error"}"#, br#"{"status":true}"#] {
            assert!(acknowledge_submission(response(body).await).await.is_err());
        }
        acknowledge_submission(response(br#"{"status":"ok"}"#).await).await.unwrap();
        // Playing-now responses may include an MSID without changing status.
        acknowledge_submission(response(br#"{"status":"ok","recording_msid":"recording"}"#).await).await.unwrap();
    }
}
