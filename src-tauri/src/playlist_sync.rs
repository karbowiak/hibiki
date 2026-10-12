//! Explicit ListenBrainz playlist copies. Credentials stay native; there is no background sync.
use crate::http_response::{BoundedResponseExt, MAX_JSON_BYTES};
use anyhow::{bail, Context, Result};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;
use tauri::Manager;

const BASE: &str = "https://api.listenbrainz.org/1/";
const MAX_ITEMS: usize = 1000;
static CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        // Never forward the token to a redirected host.
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!(
            "Hibiki/",
            env!("CARGO_PKG_VERSION"),
            " (https://github.com/karbowiak/hibiki)"
        ))
        .build()
        .expect("Playlist HTTP client")
});

#[derive(Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct PlaylistAccount {
    service: String,
    user: String,
    revision: String,
}
struct Credentials {
    account: PlaylistAccount,
    token: String,
}
fn credentials(config: &Path) -> Result<Credentials> {
    let settings = crate::plex::load_settings(config).context("Account settings unavailable")?;
    if settings.listenbrainz_token.is_empty() || settings.listenbrainz_username.is_empty() {
        bail!("Connect ListenBrainz before using playlists");
    }
    Ok(Credentials {
        account: PlaylistAccount {
            service: "listenbrainz".into(),
            user: settings.listenbrainz_username,
            revision: settings.listenbrainz_auth_revision.to_string(),
        },
        token: settings.listenbrainz_token,
    })
}
fn owned(config: &Path, expected: &PlaylistAccount) -> Result<Credentials> {
    let current = credentials(config)?;
    if &current.account != expected {
        bail!("ListenBrainz account changed. Preview again.");
    }
    Ok(current)
}
fn config(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|_| "Account settings unavailable".into())
}
fn canonical_mbid(value: &str) -> Result<String> {
    let id = uuid::Uuid::parse_str(value).context("Invalid recording identifier")?;
    if value.len() != 36 {
        bail!("Invalid recording identifier");
    }
    Ok(id.to_string())
}
fn create_payload(title: &str, mbids: &[String]) -> Result<Value> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > 500 || mbids.len() > MAX_ITEMS {
        bail!("Invalid or oversized playlist");
    }
    let tracks = mbids
        .iter()
        .map(|value| {
            canonical_mbid(value).map(
                |mbid| json!({"identifier": [format!("https://musicbrainz.org/recording/{mbid}")]}),
            )
        })
        .collect::<Result<Vec<_>>>()?;
    // Required by the actual server validator. Copies are private by default;
    // no collaborators/created_for or user supplied external identifiers are forwarded.
    Ok(
        json!({"playlist": {"title": title, "extension": {"https://musicbrainz.org/doc/jspf#playlist": {"public": false}}, "track": tracks}}),
    )
}
fn endpoint(base: &str, segments: &[&str]) -> Result<reqwest::Url> {
    let mut url = reqwest::Url::parse(base)?;
    url.path_segments_mut()
        .map_err(|_| anyhow::anyhow!("Invalid playlist API endpoint"))?
        .pop_if_empty()
        .extend(segments);
    Ok(url)
}
async fn response(request: reqwest::RequestBuilder) -> Result<Value> {
    let response = request
        .send()
        .await
        .map_err(|error| error.without_url())
        .context("Playlist service unavailable")?;
    if !response.status().is_success() {
        bail!(
            "Playlist service rejected the request (HTTP {})",
            response.status().as_u16()
        );
    }
    response
        .bounded_json(MAX_JSON_BYTES)
        .await
        .context("Invalid playlist service response")
}
async fn read_from(client: &reqwest::Client, base: &str, token: &str, id: &str) -> Result<Value> {
    let id = canonical_mbid(id)?;
    let value = response(
        client
            .get(endpoint(base, &["playlist", &id])?)
            .header("Authorization", format!("Token {token}")),
    )
    .await?;
    let playlist = value
        .get("playlist")
        .and_then(Value::as_object)
        .context("Invalid playlist response")?;
    if let Some(tracks) = playlist.get("track") {
        let tracks = tracks.as_array().context("Invalid playlist tracks")?;
        if tracks.len() > MAX_ITEMS {
            bail!("Playlist exceeds the supported track limit");
        }
    }
    Ok(value)
}
async fn create_from(
    client: &reqwest::Client,
    base: &str,
    token: &str,
    title: &str,
    mbids: &[String],
) -> Result<String> {
    let payload = create_payload(title, mbids)?;
    let value = response(
        client
            .post(endpoint(base, &["playlist", "create"])?)
            .header("Authorization", format!("Token {token}"))
            .json(&payload),
    )
    .await?;
    if value.get("status").and_then(Value::as_str) != Some("ok") {
        bail!("Playlist creation was not acknowledged");
    }
    canonical_mbid(
        value
            .get("playlist_mbid")
            .and_then(Value::as_str)
            .context("Playlist creation did not return an identifier")?,
    )
}
#[tauri::command]
pub async fn playlist_sync_listenbrainz_account(
    app: tauri::AppHandle,
) -> Result<PlaylistAccount, String> {
    credentials(&config(&app)?)
        .map(|value| value.account)
        .map_err(|_| "Connect ListenBrainz before using playlists".into())
}
#[tauri::command]
pub async fn playlist_sync_listenbrainz_list(
    app: tauri::AppHandle,
    expected: PlaylistAccount,
    offset: u32,
    count: u32,
) -> Result<Value, String> {
    if count == 0 || count > 100 || offset > 100_000 {
        return Err("Invalid playlist page".into());
    }
    let path = config(&app)?;
    let current = owned(&path, &expected)
        .map_err(|_| "ListenBrainz account changed. Preview again.".to_string())?;
    let url = endpoint(BASE, &["user", &current.account.user, "playlists"])
        .map_err(|_| "Invalid playlist request".to_string())?;
    let value = response(
        CLIENT
            .get(url)
            .header("Authorization", format!("Token {}", current.token))
            .query(&[("offset", offset), ("count", count)]),
    )
    .await
    .map_err(|_| "Could not load ListenBrainz playlists".to_string())?;
    owned(&path, &expected)
        .map_err(|_| "ListenBrainz account changed. Preview again.".to_string())?;
    let items = value
        .get("playlists")
        .and_then(Value::as_array)
        .ok_or("Invalid playlist list response")?;
    if items.len() > count as usize {
        return Err("Invalid playlist list response".into());
    }
    Ok(value)
}
#[tauri::command]
pub async fn playlist_sync_listenbrainz_read(
    app: tauri::AppHandle,
    expected: PlaylistAccount,
    id: String,
) -> Result<Value, String> {
    let path = config(&app)?;
    let current = owned(&path, &expected)
        .map_err(|_| "ListenBrainz account changed. Preview again.".to_string())?;
    let value = read_from(&CLIENT, BASE, &current.token, &id)
        .await
        .map_err(|_| "Could not load this ListenBrainz playlist".to_string())?;
    owned(&path, &expected)
        .map_err(|_| "ListenBrainz account changed. Preview again.".to_string())?;
    Ok(value)
}
#[derive(Serialize)]
pub struct CreatedPlaylist {
    id: String,
}
#[tauri::command]
pub async fn playlist_sync_listenbrainz_create(
    app: tauri::AppHandle,
    expected: PlaylistAccount,
    title: String,
    mbids: Vec<String>,
) -> Result<CreatedPlaylist, String> {
    // Validate before admission. The request uses the captured token, never a later login's token.
    create_payload(&title, &mbids).map_err(|_| {
        "Each occurrence requires a valid recording MBID and playlist title".to_string()
    })?;
    let path = config(&app)?;
    let current = owned(&path, &expected)
        .map_err(|_| "ListenBrainz account changed. Preview again.".to_string())?;
    let id = create_from(&CLIENT, BASE, &current.token, &title, &mbids)
        .await
        .map_err(|_| {
            "Playlist outcome needs checking. Review ListenBrainz before retrying.".to_string()
        })?;
    // A completed admitted operation is returned with its old-account identity.
    // The caller durably retains the receipt even if that view/account has retired.
    Ok(CreatedPlaylist { id })
}

#[cfg(test)]
mod tests {
    use super::*;
    const A: &str = "12345678-1234-1234-1234-123456789abc";
    const B: &str = "22345678-1234-1234-1234-123456789abc";
    #[test]
    fn private_payload_preserves_duplicate_occurrences_and_order() {
        let payload = create_payload("Copy", &[A.into(), B.into(), A.into()]).unwrap();
        assert_eq!(
            payload["playlist"]["extension"]["https://musicbrainz.org/doc/jspf#playlist"]["public"],
            false
        );
        let tracks = payload["playlist"]["track"].as_array().unwrap();
        assert_eq!(tracks.len(), 3);
        assert_eq!(tracks[0], tracks[2]);
        assert_ne!(tracks[0], tracks[1]);
        assert!(create_payload("Copy", &["../../../private".into()]).is_err());
        assert!(create_payload("Copy", &vec![A.into(); MAX_ITEMS + 1]).is_err());
    }
    #[test]
    fn changed_or_reconnected_account_is_rejected_without_using_new_token() {
        let dir = tempfile::tempdir().unwrap();
        crate::plex::update_settings(dir.path(), |settings| {
            settings.listenbrainz_username = "listener".into();
            settings.listenbrainz_token = "synthetic-token".into();
            settings.listenbrainz_auth_revision = 1;
            Ok(())
        })
        .unwrap();
        let expected = credentials(dir.path()).unwrap().account;
        crate::plex::update_settings(dir.path(), |settings| {
            settings.listenbrainz_auth_revision = 2;
            Ok(())
        })
        .unwrap();
        assert!(owned(dir.path(), &expected).is_err());
        crate::plex::update_settings(dir.path(), |settings| {
            settings.listenbrainz_username = "other".into();
            Ok(())
        })
        .unwrap();
        assert!(owned(dir.path(), &expected).is_err());
    }
    fn server(reply: String) -> (String, std::thread::JoinHandle<String>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut chunk = [0_u8; 4096];
            loop {
                let count = stream.read(&mut chunk).unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&chunk[..count]);
                if let Some(header_end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..header_end]);
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|value| value.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if bytes.len() >= header_end + 4 + length {
                        break;
                    }
                }
                assert!(bytes.len() < 100_000);
            }
            stream.write_all(reply.as_bytes()).unwrap();
            String::from_utf8(bytes).unwrap()
        });
        (format!("http://{address}/proxy/1/"), handle)
    }
    #[tokio::test]
    async fn loopback_create_preserves_private_payload_duplicates_path_and_native_authorization() {
        let body = format!(r#"{{"status":"ok","playlist_mbid":"{A}"}}"#);
        let (base, server) = server(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body));
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let id = create_from(
            &client,
            &base,
            "synthetic-token",
            "Copy",
            &[A.into(), B.into(), A.into()],
        )
        .await
        .unwrap();
        assert_eq!(id, A);
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /proxy/1/playlist/create HTTP/1.1"));
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: token synthetic-token"));
        let payload: Value =
            serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(
            payload,
            create_payload("Copy", &[A.into(), B.into(), A.into()]).unwrap()
        );
    }
    #[tokio::test]
    async fn redirects_and_unacknowledged_creates_are_never_treated_as_success() {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let (base, server) = server("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/private?token=secret\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into());
        let error = create_from(&client, &base, "synthetic-token", "Copy", &[])
            .await
            .unwrap_err()
            .to_string();
        assert!(!error.contains("secret"));
        assert!(error.contains("302"));
        server.join().unwrap();
        let body = r#"{"status":"ok"}"#;
        let (base, server) = self::server(format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        ));
        assert!(create_from(&client, &base, "synthetic-token", "Copy", &[])
            .await
            .is_err());
        server.join().unwrap();
    }
}
