//! ListenBrainz playlist copies and one-step linked updates. Credentials stay native.
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
#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ListenBrainzListing { Created, Createdfor, Collaborator }
impl ListenBrainzListing {
    fn suffix(self) -> Option<&'static str> {match self {Self::Created=>None,Self::Createdfor=>Some("createdfor"),Self::Collaborator=>Some("collaborator")}}
}
async fn list_from(client:&reqwest::Client, base:&str, token:&str, username:&str, source:ListenBrainzListing, offset:u32,count:u32)->Result<Value> {
    if count==0 || count>100 || offset>100_000 {bail!("Invalid playlist page")}
    let mut segments=vec!["user",username,"playlists"];
    if let Some(suffix)=source.suffix(){segments.push(suffix)}
    let mut value=response(client.get(endpoint(base,&segments)?).header("Authorization",format!("Token {token}")).query(&[("offset",offset),("count",count)])).await?;
    let items=value.get("playlists").and_then(Value::as_array).context("Invalid playlist list response")?;
    if items.len()>count as usize || value.get("offset").and_then(Value::as_u64)!=Some(offset as u64)
        || value.get("playlist_count").and_then(Value::as_u64).is_none() {bail!("Invalid playlist list response")}
    // These documented user-list endpoints return summaries without recordings.
    // Do not silently turn browsing all lists into a bulk track download.
    for item in items {
        let playlist=item.get("playlist").and_then(Value::as_object).context("Invalid playlist summary")?;
        if playlist.get("track").is_some_and(|tracks| tracks.as_array().is_none_or(|t|!t.is_empty())) {bail!("Playlist list unexpectedly contains recordings")}
        let id=playlist.get("identifier").and_then(Value::as_str).context("Playlist summary identity missing")?.trim_start_matches("https://listenbrainz.org/playlist/");
        canonical_mbid(id)?;
    }
    value["listing_source"]=serde_json::to_value(source)?;
    Ok(value)
}
#[tauri::command]
pub async fn playlist_sync_listenbrainz_list(
    app: tauri::AppHandle, expected: PlaylistAccount, offset:u32,count:u32,
    source:Option<ListenBrainzListing>,
)->Result<Value,String> {
    let path=config(&app)?;
    let current=owned(&path,&expected).map_err(|_|"ListenBrainz account changed. Preview again.".to_string())?;
    let value=list_from(&CLIENT,BASE,&current.token,&current.account.user,source.unwrap_or(ListenBrainzListing::Created),offset,count).await
        .map_err(|_|"Could not load ListenBrainz playlist summaries".to_string())?;
    owned(&path,&expected).map_err(|_|"ListenBrainz account changed. Preview again.".to_string())?;
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

#[derive(Clone, Deserialize)]
pub struct ListenBrainzExpected {
    pub title: String,
    pub mbids: Vec<String>,
}
#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ListenBrainzOperation {
    Append {
        #[serde(rename = "trackId")]
        track_id: String,
    },
    Move {
        from: usize,
        to: usize,
    },
    Delete {
        index: usize,
    },
}
fn recording_ids(value: &Value, id: &str) -> Result<Vec<String>> {
    let playlist = value.get("playlist").context("Invalid playlist response")?;
    let returned = playlist
        .get("identifier")
        .and_then(Value::as_str)
        .context("Missing playlist identity")?
        .trim_start_matches("https://listenbrainz.org/playlist/");
    if canonical_mbid(returned)? != canonical_mbid(id)? {
        bail!("Playlist response identity changed")
    }
    let tracks = playlist
        .get("track")
        .and_then(Value::as_array)
        .context("Missing playlist recordings")?;
    if tracks.len() > MAX_ITEMS {
        bail!("Playlist exceeds supported size")
    }
    tracks
        .iter()
        .map(|track| {
            let identifiers = track
                .get("identifier")
                .and_then(Value::as_array)
                .context("Invalid recording identity")?;
            if identifiers.len() > 20 {
                bail!("Too many recording identifiers")
            }
            let mut ids = std::collections::HashSet::new();
            for identifier in identifiers.iter().filter_map(Value::as_str) {
                if let Some(id) = identifier
                    .strip_prefix("https://musicbrainz.org/recording/")
                    .or_else(|| identifier.strip_prefix("http://musicbrainz.org/recording/"))
                {
                    ids.insert(canonical_mbid(id)?);
                }
            }
            if ids.len() != 1 {
                bail!("Ambiguous recording identity")
            };
            Ok(ids.into_iter().next().unwrap())
        })
        .collect()
}
fn mutation_payload(
    expected: &ListenBrainzExpected,
    operation: &ListenBrainzOperation,
) -> Result<(&'static str, Value, Vec<String>)> {
    if expected.title.is_empty() || expected.title.len() > 2000 || expected.mbids.len() > MAX_ITEMS
    {
        bail!("Invalid playlist update")
    }
    let mut after: Vec<_> = expected
        .mbids
        .iter()
        .map(|id| canonical_mbid(id))
        .collect::<Result<_>>()?;
    let (verb, payload) = match operation {
        ListenBrainzOperation::Append { track_id } => {
            let id = canonical_mbid(track_id)?;
            if after.len() >= MAX_ITEMS {
                bail!("Playlist item limit reached")
            };
            after.push(id.clone());
            (
                "add",
                json!({"playlist":{"track":[{"identifier":[format!("https://musicbrainz.org/recording/{id}")]}]}}),
            )
        }
        ListenBrainzOperation::Move { from, to } => {
            if *from >= after.len() || *to >= *from {
                bail!("Invalid occurrence move")
            };
            let id = after.remove(*from);
            after.insert(*to, id.clone());
            ("move", json!({"mbid":id,"from":from,"to":to,"count":1}))
        }
        ListenBrainzOperation::Delete { index } => {
            if *index >= after.len() {
                bail!("Invalid occurrence delete")
            };
            after.remove(*index);
            ("delete", json!({"index":index,"count":1}))
        }
    };
    Ok((verb, payload, after))
}
async fn sync_read(client: &reqwest::Client, base: &str, token: &str, id: &str) -> Result<Value> {
    response(
        client
            .get(endpoint(base, &["playlist", id])?)
            .query(&[("fetch_metadata", "false")])
            .header("Authorization", format!("Token {token}")),
    )
    .await
}
async fn mutate_from(
    client: &reqwest::Client,
    base: &str,
    token: &str,
    id: &str,
    expected: &ListenBrainzExpected,
    operation: &ListenBrainzOperation,
    current: impl Fn() -> Result<()>,
) -> Result<Value> {
    let id = canonical_mbid(id)?;
    let (verb, payload, after) = mutation_payload(expected, operation)?;
    current()?;
    let before = sync_read(client, base, token, &id).await?;
    if recording_ids(&before, &id)? != expected.mbids
        || before.pointer("/playlist/title").and_then(Value::as_str)
            != Some(expected.title.as_str())
    {
        bail!("Playlist changed before update")
    }
    current()?;
    let ack = response(
        client
            .post(endpoint(base, &["playlist", &id, "item", verb])?)
            .header("Authorization", format!("Token {token}"))
            .json(&payload),
    )
    .await?;
    if ack.get("status").and_then(Value::as_str) != Some("ok") {
        bail!("Playlist update was not acknowledged")
    }
    current()?;
    let result = sync_read(client, base, token, &id).await?;
    current()?;
    if recording_ids(&result, &id)? != after
        || result.pointer("/playlist/title").and_then(Value::as_str)
            != Some(expected.title.as_str())
    {
        bail!("Playlist update outcome requires reconciliation")
    }
    Ok(result)
}
async fn require_owned_destination(
    client:&reqwest::Client,base:&str,token:&str,id:&str,account:&PlaylistAccount,current:impl Fn()->Result<()>,
)->Result<()> {
    let id=canonical_mbid(id)?;
    current()?;
    let authenticated=response(client.get(endpoint(base,&["validate-token"])?).header("Authorization",format!("Token {token}"))).await?;
    if authenticated["valid"]!=true || authenticated["user_name"].as_str()!=Some(account.user.as_str()) {bail!("Authenticated ListenBrainz account changed")}
    current()?;
    let value=sync_read(client,base,token,&id).await?;
    recording_ids(&value,&id)?;
    let playlist=value.get("playlist").context("Playlist ownership missing")?;
    let generated=playlist.get("extension").and_then(|e|e.get("https://musicbrainz.org/doc/jspf#playlist"))
        .and_then(|e|e.get("created_for")).is_some_and(|v|!v.is_null());
    if playlist.get("creator").and_then(Value::as_str)!=Some(account.user.as_str()) || generated {
        bail!("Generated and collaborator playlists are read-only sync sources")
    }
    current()?;
    Ok(())
}
static SYNC_MUTATION_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
#[tauri::command]
pub async fn playlist_sync_listenbrainz_mutate(
    app: tauri::AppHandle,
    expected: PlaylistAccount,
    id: String,
    before: ListenBrainzExpected,
    operation: ListenBrainzOperation,
) -> Result<Value, String> {
    mutation_payload(&before, &operation)
        .map_err(|_| "Invalid ordered playlist update".to_string())?;
    let path = config(&app)?;
    let _guard = SYNC_MUTATION_LOCK.lock().await;
    let credentials = owned(&path, &expected)
        .map_err(|_| "ListenBrainz account changed. Review again.".to_string())?;
    require_owned_destination(&CLIENT,BASE,&credentials.token,&id,&expected,||owned(&path,&expected).map(|_|())).await
        .map_err(|_|"ListenBrainz destination ownership could not be confirmed. Only your own playlists can be updated.".to_string())?;
    mutate_from(
        &CLIENT,
        BASE,
        &credentials.token,
        &id,
        &before,
        &operation,
        || owned(&path, &expected).map(|_| ()),
    )
    .await
    .map_err(|_| "Playlist update needs reconciliation before any further write.".to_string())
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
    fn jspf_ids(ids: &[&str]) -> Value {
        json!({"playlist":{"identifier":format!("https://listenbrainz.org/playlist/{A}"),"title":"Ordered","track":ids.iter().map(|id|json!({"identifier":[format!("https://musicbrainz.org/recording/{id}")]})).collect::<Vec<_>>()}})
    }
    fn sequence_server(replies: Vec<Value>) -> (String, std::thread::JoinHandle<Vec<String>>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/proxy/1/", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for reply in replies {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(3)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut chunk = [0; 2048];
                loop {
                    let size = stream.read(&mut chunk).unwrap();
                    if size == 0 {
                        break;
                    };
                    bytes.extend_from_slice(&chunk[..size]);
                    if let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                        let header = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                        let length = header
                            .lines()
                            .find_map(|line| {
                                line.strip_prefix("content-length:")
                                    .and_then(|length| length.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if bytes.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                requests.push(String::from_utf8(bytes).unwrap());
                let body = reply.to_string();
                write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
            }
            requests
        });
        (base, handle)
    }
    #[tokio::test]
    async fn linked_verbs_preflight_preserve_duplicate_order_and_use_one_authenticated_post() {
        let b = "22222222-2222-4222-8222-222222222222";
        for (operation, after, verb, payload) in [
            (
                ListenBrainzOperation::Append { track_id: A.into() },
                vec![A, b, A, A],
                "add",
                json!({"playlist":{"track":[{"identifier":[format!("https://musicbrainz.org/recording/{A}")]}]}}),
            ),
            (
                ListenBrainzOperation::Move { from: 2, to: 1 },
                vec![A, A, b],
                "move",
                json!({"mbid":A,"from":2,"to":1,"count":1}),
            ),
            (
                ListenBrainzOperation::Delete { index: 1 },
                vec![A, A],
                "delete",
                json!({"index":1,"count":1}),
            ),
        ] {
            let before = ListenBrainzExpected {
                title: "Ordered".into(),
                mbids: vec![A.into(), b.into(), A.into()],
            };
            let (base, server) = sequence_server(vec![
                jspf_ids(&[A, b, A]),
                json!({"status":"ok"}),
                jspf_ids(&after),
            ]);
            let result = mutate_from(
                &CLIENT,
                &base,
                "offline-token",
                A,
                &before,
                &operation,
                || Ok(()),
            )
            .await
            .unwrap();
            assert_eq!(recording_ids(&result, A).unwrap(), after);
            let requests = server.join().unwrap();
            assert_eq!(requests.len(), 3);
            assert!(requests[0]
                .starts_with(&format!("GET /proxy/1/playlist/{A}?fetch_metadata=false ")));
            assert!(requests[1].starts_with(&format!("POST /proxy/1/playlist/{A}/item/{verb} ")));
            assert_eq!(
                serde_json::from_str::<Value>(requests[1].split("\r\n\r\n").nth(1).unwrap())
                    .unwrap(),
                payload
            );
            assert!(requests.iter().all(|request| request
                .to_lowercase()
                .contains("authorization: token offline-token")));
        }
    }
    #[tokio::test]
    async fn changed_preflight_or_retired_lease_sends_no_playlist_mutation() {
        let operation = ListenBrainzOperation::Delete { index: 0 };
        let expected = ListenBrainzExpected {
            title: "Ordered".into(),
            mbids: vec![A.into(), A.into()],
        };
        let (base, server) = sequence_server(vec![jspf_ids(&[A])]);
        assert!(mutate_from(
            &CLIENT,
            &base,
            "offline-token",
            A,
            &expected,
            &operation,
            || Ok(())
        )
        .await
        .is_err());
        assert_eq!(server.join().unwrap().len(), 1);
        let (base, server) = sequence_server(vec![jspf_ids(&[A, A])]);
        let calls = std::cell::Cell::new(0);
        assert!(mutate_from(
            &CLIENT,
            &base,
            "offline-token",
            A,
            &expected,
            &operation,
            || {
                calls.set(calls.get() + 1);
                if calls.get() > 1 {
                    bail!("Retired lease")
                };
                Ok(())
            }
        )
        .await
        .is_err());
        assert_eq!(server.join().unwrap().len(), 1);
    }
    #[test]
    fn invalid_occurrence_operations_and_ambiguous_recordings_are_rejected() {
        let expected = ListenBrainzExpected {
            title: "Ordered".into(),
            mbids: vec![A.into()],
        };
        assert!(
            mutation_payload(&expected, &ListenBrainzOperation::Move { from: 0, to: 0 }).is_err()
        );
        assert!(mutation_payload(&expected, &ListenBrainzOperation::Delete { index: 1 }).is_err());
        assert!(mutation_payload(
            &expected,
            &ListenBrainzOperation::Append {
                track_id: "invalid".into()
            }
        )
        .is_err());
        let mut value = jspf_ids(&[A]);
        value["playlist"]["track"][0]["identifier"] = json!([
            format!("https://musicbrainz.org/recording/{A}"),
            "https://musicbrainz.org/recording/22222222-2222-4222-8222-222222222222"
        ]);
        assert!(recording_ids(&value, A).is_err());
    }
}

#[cfg(test)]
mod live_smoke;

#[cfg(test)]
mod listing_tests {
    use super::*;
    use tokio::io::{AsyncReadExt,AsyncWriteExt};
    #[tokio::test]
    async fn all_official_user_listing_feeds_are_bounded_metadata_only_pages() {
        for source in [ListenBrainzListing::Created,ListenBrainzListing::Createdfor,ListenBrainzListing::Collaborator] {
            let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base=format!("http://{}/1/",listener.local_addr().unwrap());
            let server=tokio::spawn(async move {
                let (mut stream,_)=listener.accept().await.unwrap();let mut bytes=Vec::new();let mut buffer=[0;4096];
                while !bytes.windows(4).any(|w|w==b"\r\n\r\n") {let n=stream.read(&mut buffer).await.unwrap();assert!(n>0);bytes.extend_from_slice(&buffer[..n]);assert!(bytes.len()<65536);}
                let text=String::from_utf8(bytes).unwrap();let target=text.lines().next().unwrap().split_whitespace().nth(1).unwrap();
                let url=url::Url::parse(&format!("http://fixture{target}")).unwrap();
                let wanted=format!("/1/user/fixture%2Fname/playlists{}",source.suffix().map(|s|format!("/{s}")).unwrap_or_default());assert_eq!(url.path(),wanted);
                let query=url.query_pairs().into_owned().collect::<std::collections::BTreeMap<_,_>>();assert_eq!(query.len(),2);assert_eq!(query["offset"],"100");assert_eq!(query["count"],"2");assert!(text.to_lowercase().contains("authorization: token fixture-token"));
                let body=json!({"playlists":[{"playlist":{"identifier":"https://listenbrainz.org/playlist/11111111-1111-4111-8111-111111111111","title":"Weekly fixture","creator":"fixture-bot","track":[]}}],"playlist_count":101,"offset":100,"count":2}).to_string();
                stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
            });
            let value=list_from(&CLIENT,&base,"fixture-token","fixture/name",source,100,2).await.unwrap();assert_eq!(value["playlists"].as_array().unwrap().len(),1);assert_eq!(value["listing_source"],serde_json::to_value(source).unwrap());server.await.unwrap();
        }
    }
    #[tokio::test]
    async fn listing_rejects_recordings_oversized_pages_and_wrong_offsets() {
        for case in 0..3 {
            let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let base=format!("http://{}/1/",listener.local_addr().unwrap());
            let server=tokio::spawn(async move {
                let (mut stream,_)=listener.accept().await.unwrap();let mut buffer=[0;4096];let _=stream.read(&mut buffer).await.unwrap();
                let item=json!({"playlist":{"identifier":"11111111-1111-4111-8111-111111111111","track":if case==0 {json!([{"identifier":[]}])}else{json!([])}}});
                let body=json!({"playlists":if case==1 {vec![item.clone(),item]}else{vec![item]},"playlist_count":2,"offset":if case==2{1}else{0},"count":1}).to_string();
                stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
            });
            assert!(list_from(&CLIENT,&base,"fixture-token","fixture",ListenBrainzListing::Createdfor,0,1).await.is_err());server.await.unwrap();
        }
    }
}

#[cfg(test)]
mod readonly_listing_smoke {
    use super::*;
    #[tokio::test]
    #[ignore="Explicit bounded read-only account verification; never ordinary CI"]
    async fn live_readonly_visible_listing_feeds() -> Result<()> {
        if std::env::var("HIBIKI_READONLY_LB_LIST_VERIFY").ok().as_deref()!=Some("1") {bail!("Explicit read-only listing approval required")}
        let path=std::path::PathBuf::from(std::env::var("HIBIKI_READONLY_LB_LIST_CONFIG").context("Explicit private config path required")?);
        let current=credentials(&path)?;
        let auth=response(CLIENT.get(endpoint(BASE,&["validate-token"])?).header("Authorization",format!("Token {}",current.token))).await?;
        if auth["valid"]!=true || auth["user_name"].as_str()!=Some(current.account.user.as_str()){bail!("Read-only authenticated account mismatch")}
        let mut proof=vec![];
        for source in [ListenBrainzListing::Created,ListenBrainzListing::Createdfor,ListenBrainzListing::Collaborator] {
            let mut offset=0;let mut pages=0;let mut total=None;let mut seen=std::collections::BTreeSet::new();
            loop {
                let lease=owned(&path,&current.account)?;if lease.token!=current.token {bail!("Read-only credential revision changed")}
                let page=list_from(&CLIENT,BASE,&current.token,&current.account.user,source,offset,100).await?;
                let count=page["playlist_count"].as_u64().context("Invalid page total")?;
                if total.is_some_and(|old|old!=count){bail!("Read-only list changed while paging")};total=Some(count);
                let items=page["playlists"].as_array().unwrap();
                if items.is_empty() && (offset as u64)<count {bail!("Incomplete visible feed")}
                for item in items {let id=item["playlist"]["identifier"].as_str().unwrap();if !seen.insert(id.to_owned()){bail!("Repeated visible page")}}
                offset+=items.len() as u32;pages+=1;
                let complete=(offset as u64)>=count;
                if complete || pages>=20 {proof.push(json!({"source":source,"summaries":offset,"reportedTotal":count,"pages":pages,"complete":complete}));break}
            }
            owned(&path,&current.account)?;
        }
        let artifact=std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join(".tmp/lb-visible-feeds-proof.json");
        std::fs::write(artifact,serde_json::to_vec_pretty(&proof)?)?;
        println!("Read-only visible feed proof: {}",serde_json::to_string(&proof)?);
        Ok(())
    }
}

#[cfg(test)]
mod destination_ownership_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize,Ordering};
    use tokio::io::{AsyncReadExt,AsyncWriteExt};
    #[tokio::test]
    async fn authenticated_owned_destination_required_before_any_mutation() {
        let id="11111111-1111-4111-8111-111111111111";
        let recording="22222222-2222-4222-8222-222222222222";
        for case in 0..5 {
            let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let base=format!("http://{}/1/",listener.local_addr().unwrap());
            let (stop,mut stopped)=tokio::sync::oneshot::channel();
            let server=tokio::spawn(async move {
                let mut mutations=0;let mut changed=false;let mut reads=0;
                loop {
                    let (mut stream,_)=tokio::select!{_= &mut stopped=>break,accepted=listener.accept()=>accepted.unwrap()};
                    let mut bytes=Vec::new();let mut buffer=[0;4096];while !bytes.windows(4).any(|w|w==b"\r\n\r\n"){let n=stream.read(&mut buffer).await.unwrap();assert!(n>0);bytes.extend_from_slice(&buffer[..n]);assert!(bytes.len()<65536)}
                    let request=String::from_utf8(bytes).unwrap();let line=request.lines().next().unwrap();let auth=line.contains("validate-token");let writing=line.starts_with("POST ");
                    let value=if auth {json!({"valid":true,"user_name":if case==4{"other"}else{"fixture-user"}})}else if writing {mutations+=1;changed=true;json!({"status":"ok"})}else {
                        reads+=1;json!({"playlist":{"identifier":format!("https://listenbrainz.org/playlist/{id}"),"title":"Fixture","creator":if case==0||case==3{"fixture-user"}else if case==1{"weekly-bot"}else{"friend"},"extension":{"https://musicbrainz.org/doc/jspf#playlist":{"created_for":if case==1{json!("fixture-user")}else{json!(null)}}},"track":if changed {vec![json!({"identifier":[format!("https://musicbrainz.org/recording/{recording}")]})]}else{vec![]}}})
                    };
                    let body=value.to_string();stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
                } (mutations,reads)
            });
            let account=PlaylistAccount{service:"listenbrainz".into(),user:"fixture-user".into(),revision:"fixture".into()};let checks=AtomicUsize::new(0);
            let guard=|| {let n=checks.fetch_add(1,Ordering::SeqCst);if case==3&&n>=2{bail!("retired")};Ok(())};
            let permission=require_owned_destination(&CLIENT,&base,"fixture-token",id,&account,guard).await;
            if permission.is_ok(){mutate_from(&CLIENT,&base,"fixture-token",id,&ListenBrainzExpected{title:"Fixture".into(),mbids:vec![]},&ListenBrainzOperation::Append{track_id:recording.into()},||Ok(())).await.unwrap();}
            let _=stop.send(());let (mutations,reads)=server.await.unwrap();assert_eq!(mutations,usize::from(case==0));assert_eq!(permission.is_ok(),case==0);if case==0{assert_eq!(reads,3);}
        }
    }
}

pub mod recordings;

#[cfg(test)]
mod weekly_metadata_probe {
    use super::*;
    fn minimal(value:&Value,depth:usize)->Value {
        if depth==0{return Value::Null}
        match value {
            Value::Object(map)=>Value::Object(map.iter().take(24).filter(|(k,_)|!matches!(k.to_lowercase().as_str(),"token"|"authorization"|"password"|"api_key")).map(|(k,v)|(k.clone(),minimal(v,depth-1))).collect()),
            Value::Array(a)=>Value::Array(a.iter().take(8).map(|v|minimal(v,depth-1)).collect()),
            Value::String(s)=>Value::String(s.chars().take(500).collect()),
            other=>other.clone(),
        }
    }
    #[tokio::test]
    #[ignore="Explicit read-only weekly summary probe; never ordinary CI"]
    async fn live_readonly_weekly_metadata() -> Result<()> {
        if std::env::var("HIBIKI_READONLY_WEEKLY_VERIFY").ok().as_deref()!=Some("1"){bail!("Explicit read-only probe required")}
        let path=std::path::PathBuf::from(std::env::var("HIBIKI_READONLY_LB_LIST_CONFIG")?);
        let week=std::env::var("HIBIKI_WEEKLY_PROBE_WEEK")?;
        let account=credentials(&path)?;
        let value=list_from(&CLIENT,BASE,&account.token,&account.account.user,ListenBrainzListing::Createdfor,0,100).await?;
        owned(&path,&account.account)?;
        let selected=value["playlists"].as_array().unwrap().iter().filter(|row|row["playlist"]["title"].as_str().is_some_and(|s|s.contains(&week)&&(s.starts_with("Weekly Exploration")||s.starts_with("Weekly Jams")))).take(4).collect::<Vec<_>>();
        let mut proof=Vec::new();let mut detail_reads=0;
        for row in selected {
            let mut playlist=row["playlist"].clone();
            if !playlist.get("date").is_some_and(Value::is_string) {
                owned(&path,&account.account)?;
                let id=canonical_mbid(playlist["identifier"].as_str().context("Missing weekly identity")?.trim_start_matches("https://listenbrainz.org/playlist/"))?;
                playlist=sync_read(&CLIENT,BASE,&account.token,&id).await?["playlist"].clone();detail_reads+=1;
                owned(&path,&account.account)?;
            }
            let mut fields=serde_json::Map::new();
            for key in ["identifier","title","creator","date","created","created_at","updated","last_modified","extension"] {
                if let Some(value)=playlist.get(key){fields.insert(key.into(),minimal(value,5));}
            }
            proof.push(Value::Object(fields));
        }
        owned(&path,&account.account)?;
        let artifact=std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join(".tmp/lb-weekly-metadata-proof.json");
        use std::io::Write;let mut file=tempfile::NamedTempFile::new_in(artifact.parent().unwrap())?;file.write_all(&serde_json::to_vec_pretty(&proof)?)?;file.as_file().sync_all()?;std::fs::rename(file.into_temp_path(),&artifact)?;
        println!("Read-only weekly metadata retained: {} selected summaries, {} detail reads; no writes.",proof.len(),detail_reads);Ok(())
    }
}

pub mod candidates;
/// Explicit selected-song discovery; no recording-identity promotion or writes.
#[tauri::command]
pub async fn playlist_sync_candidates(context:crate::commands::PlexRequestContext,section_id:i64,source:candidates::CandidateSource,state:tauri::State<'_,crate::commands::PlexState>)->Result<candidates::Discovery,String>{
    let client={let guard=state.0.lock().await;state.checked_client(&context,&guard)?.clone()};
    let result=tokio::time::timeout(std::time::Duration::from_secs(30),candidates::discover(&client,section_id,&source,||state.is_current(context.connection_revision))).await
        .map_err(|_|"Scoped candidate discovery timed out. Review or retry this song.".to_string())?
        .map_err(|_|"Could not confirm scoped candidates for this library connection.".to_string())?;
    let guard=state.0.lock().await;state.checked_client(&context,&guard)?;Ok(result)
}
