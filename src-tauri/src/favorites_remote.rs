//! Favorite feedback is account-fenced; credentials and signatures remain native.
use crate::http_response::{BoundedResponseExt, MAX_JSON_BYTES};
use anyhow::{bail, Context, Result};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use tauri::Manager;
static CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!(
            "Hibiki/",
            env!("CARGO_PKG_VERSION"),
            " (https://github.com/karbowiak/hibiki)"
        ))
        .build()
        .expect("Favorite HTTP client")
});
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct FavoriteAccount {
    pub service: String,
    pub user: String,
    pub revision: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FavoriteRecording {
    pub key: String,
    pub title: String,
    pub artist: String,
    #[serde(default)]
    pub album: String,
    #[serde(default)]
    pub duration_ms: Option<i64>,
    /// Original service love/feedback time in Unix milliseconds, when available.
    #[serde(default)]
    pub liked_at: Option<i64>,
    #[serde(default)]
    pub recording_mbid: Option<String>,
    #[serde(default)]
    pub recording_msid: Option<String>,
    #[serde(default)]
    pub local_track_id: Option<String>,
}
#[derive(Serialize)]
pub struct FavoritePage {
    pub rows: Vec<FavoriteRecording>,
    pub total: usize,
    pub offset: usize,
}
struct Credentials {
    account: FavoriteAccount,
    key: String,
    secret: String,
    session: String,
}
fn credentials(app: &tauri::AppHandle, service: &str) -> Result<Credentials> {
    let path = app.path().app_config_dir()?;
    let settings = crate::plex::load_settings(&path)?;
    let value = match service {
        "lastfm" => Credentials {
            account: FavoriteAccount {
                service: service.into(),
                user: settings.lastfm_username,
                revision: settings.lastfm_auth_revision.to_string(),
            },
            key: settings.lastfm_api_key,
            secret: settings.lastfm_api_secret,
            session: settings.lastfm_session_key,
        },
        "listenbrainz" => Credentials {
            account: FavoriteAccount {
                service: service.into(),
                user: settings.listenbrainz_username,
                revision: settings.listenbrainz_auth_revision.to_string(),
            },
            key: String::new(),
            secret: String::new(),
            session: settings.listenbrainz_token,
        },
        _ => bail!("Unknown favorite service"),
    };
    if value.account.user.is_empty()
        || value.session.is_empty()
        || (service == "lastfm" && (value.key.is_empty() || value.secret.is_empty()))
    {
        bail!("Connect this service before syncing likes")
    }
    Ok(value)
}
fn owned(app: &tauri::AppHandle, expected: &FavoriteAccount) -> Result<Credentials> {
    let value = credentials(app, &expected.service)?;
    if value.account != *expected {
        bail!("Favorite account changed")
    };
    Ok(value)
}
async fn response(request: reqwest::RequestBuilder) -> Result<Value> {
    response_guarded(request, || Ok(())).await
}
async fn response_guarded(
    request: reqwest::RequestBuilder,
    current: impl Fn() -> Result<()>,
) -> Result<Value> {
    let host = request
        .try_clone()
        .context("Favorite request cannot be retained")?
        .build()
        .map_err(|error| error.without_url())?
        .url()
        .host_str()
        .map(str::to_owned);
    if host.as_deref() == Some("ws.audioscrobbler.com") {
        let bytes = crate::lastfm::transport::send_guarded(request, current).await?;
        let value: Value = serde_json::from_slice(&bytes).context("Invalid favorite service response")?;
        if value.get("error").is_some() {
            bail!("Favorite service reported an error")
        }
        return Ok(value);
    }
    let response = crate::listenbrainz_transport::send_guarded(request, current).await?;
    if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        if response.url().host_str() == Some("api.listenbrainz.org") {
            bail!(crate::listenbrainz_transport::COOLDOWN)
        }
        bail!("Favorite service is rate limited. Please try syncing later.")
    }
    if !response.status().is_success() {
        bail!(
            "Favorite service rejected the request (HTTP {})",
            response.status().as_u16()
        )
    }
    let value: Value = response
        .bounded_json(MAX_JSON_BYTES)
        .await
        .context("Invalid favorite service response")?;
    if value.get("error").is_some() {
        bail!("Favorite service reported an error")
    };
    Ok(value)
}
fn number(value: Option<&Value>) -> Result<usize> {
    value
        .and_then(|v| v.as_u64().or_else(|| v.as_str()?.parse().ok()))
        .and_then(|n| usize::try_from(n).ok())
        .context("Invalid favorite page count")
}
fn text(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or("")
        .chars()
        .take(1000)
        .collect()
}
fn uuid(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|v| v.len() == 36)
        .and_then(|v| uuid::Uuid::parse_str(v).ok())
        .map(|v| v.to_string())
}
fn label_key(artist: &str, title: &str) -> String {
    format!(
        "lastfm:{}",
        json!([artist.trim().to_lowercase(), title.trim().to_lowercase()])
    )
}
fn liked_at(value: Option<&Value>) -> Option<i64> {
    let seconds = value.and_then(|v| v.as_i64().or_else(|| v.as_str()?.parse().ok()))?;
    let millis = seconds.checked_mul(1000)?;
    // Unknown or malformed dates must not prevent importing an otherwise valid love.
    (millis > 0 && millis <= 8_640_000_000_000_000).then_some(millis)
}
fn parse_page(service: &str, value: &Value, offset: usize) -> Result<FavoritePage> {
    let (rows, total, actual) = if service == "listenbrainz" {
        (
            value
                .get("feedback")
                .and_then(Value::as_array)
                .context("Missing feedback page")?
                .clone(),
            number(value.get("total_count"))?,
            number(value.get("offset"))?,
        )
    } else {
        let list = value.get("lovedtracks").context("Missing loved tracks")?;
        let attr = list
            .get("@attr")
            .context("Missing loved track pagination")?;
        let total = number(attr.get("total"))?;
        let rows = match list.get("track") {
            Some(Value::Array(rows)) => rows.clone(),
            Some(raw @ Value::Object(_)) => vec![raw.clone()],
            None if total == 0 => vec![],
            _ => bail!("Invalid loved track list"),
        };
        let page = number(attr.get("page"))?;
        if page != offset / 100 + 1 {
            bail!("Favorite page offset changed")
        };
        (rows, total, offset)
    };
    if actual != offset
        || rows.len() > if service == "listenbrainz" { 1000 } else { 100 }
        || total > 100000
        || offset + rows.len() > total
        || (rows.is_empty() && offset < total)
    {
        bail!("Incomplete or changed favorite page")
    }
    let rows = rows
        .iter()
        .map(|row| {
            if service == "listenbrainz" {
                if row.get("score").and_then(Value::as_i64) != Some(1) {
                    bail!("Unexpected feedback score")
                }
                let mbid = uuid(row.get("recording_mbid"));
                let msid = uuid(row.get("recording_msid"));
                let id = mbid
                    .as_ref()
                    .or(msid.as_ref())
                    .context("Favorite recording ID missing")?;
                let metadata = row.get("track_metadata");
                Ok(FavoriteRecording {
                    key: format!("{}:{}", if mbid.is_some() { "mbid" } else { "msid" }, id),
                    title: text(metadata.and_then(|m| m.get("track_name"))),
                    artist: text(metadata.and_then(|m| m.get("artist_name"))),
                    album: text(metadata.and_then(|m| m.get("release_name"))),
                    duration_ms: None,
                    liked_at: liked_at(row.get("created")),
                    recording_mbid: mbid,
                    recording_msid: msid,
                    local_track_id: None,
                })
            } else {
                let title = text(row.get("name"));
                let artist = text(row.get("artist").and_then(|v| v.get("name")));
                if title.is_empty() || artist.is_empty() {
                    bail!("Favorite labels missing")
                }
                // Last.fm's track MBID is not treated as proof of a recording identity.
                Ok(FavoriteRecording {
                    key: label_key(&artist, &title),
                    title,
                    artist,
                    album: String::new(),
                    duration_ms: None,
                    liked_at: liked_at(row.get("date").and_then(|date| date.get("uts"))),
                    recording_mbid: None,
                    recording_msid: None,
                    local_track_id: None,
                })
            }
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(FavoritePage {
        rows,
        total,
        offset,
    })
}
const LB_BASE: &str = "https://api.listenbrainz.org/1/feedback/";
const LF_BASE: &str = "https://ws.audioscrobbler.com/2.0/";
fn lb_url(base: &str, user: &str, suffix: &str) -> Result<reqwest::Url> {
    let mut url = reqwest::Url::parse(base)?;
    url.path_segments_mut()
        .map_err(|_| anyhow::anyhow!("Invalid feedback endpoint"))?
        .pop_if_empty()
        .extend(["user", user, suffix]);
    Ok(url)
}
async fn peek_at(
    creds: &Credentials,
    record: &FavoriteRecording,
    lb: &str,
    lf: &str,
) -> Result<bool> {
    if creds.account.service == "listenbrainz" {
        let (field, id) = if let Some(id) = &record.recording_mbid {
            ("recording_mbids", id)
        } else {
            (
                "recording_msids",
                record
                    .recording_msid
                    .as_ref()
                    .context("Resolve this recording before syncing")?,
            )
        };
        uuid::Uuid::parse_str(id)?;
        let value = response(
            CLIENT
                .post(lb_url(
                    lb,
                    &creds.account.user,
                    "get-feedback-for-recordings",
                )?)
                .header("Authorization", format!("Token {}", creds.session))
                .json(&json!({field:[id]})),
        )
        .await?;
        let values = value
            .get("feedback")
            .and_then(Value::as_array)
            .context("Missing feedback proof")?;
        if values.len() != 1 {
            bail!("Ambiguous feedback proof")
        }
        let row = &values[0];
        let returned = if field == "recording_mbids" {
            uuid(row.get("recording_mbid"))
        } else {
            uuid(row.get("recording_msid"))
        };
        if returned.as_deref() != Some(id.as_str()) {
            bail!("Recording feedback proof changed")
        }
        let score = row
            .get("score")
            .and_then(Value::as_i64)
            .filter(|s| [-1, 0, 1].contains(s))
            .context("Invalid feedback proof")?;
        Ok(score == 1)
    } else {
        let value = response(CLIENT.get(lf).query(&[
            ("method", "track.getInfo"),
            ("api_key", &creds.key),
            ("username", &creds.account.user),
            ("artist", &record.artist),
            ("track", &record.title),
            ("autocorrect", "0"),
            ("format", "json"),
        ]))
        .await?;
        let track = value.get("track").context("Missing love proof")?;
        let title = text(track.get("name"));
        let artist = text(track.get("artist").and_then(|row| row.get("name")));
        if label_key(&artist, &title) != label_key(&record.artist, &record.title) {
            bail!("Favorite recording labels changed")
        }
        let score = number(track.get("userloved"))?;
        if score > 1 {
            bail!("Invalid love proof")
        };
        Ok(score == 1)
    }
}
async fn peek(creds: &Credentials, record: &FavoriteRecording) -> Result<bool> {
    peek_at(creds, record, LB_BASE, LF_BASE).await
}
async fn write_at(
    creds: &Credentials,
    record: &FavoriteRecording,
    liked: bool,
    lb: &str,
    lf: &str,
    current: impl Fn() -> Result<()>,
) -> Result<()> {
    if creds.account.service == "listenbrainz" {
        let mut payload = json!({"score":if liked {1}else{0}});
        if let Some(id) = &record.recording_mbid {
            uuid::Uuid::parse_str(id)?;
            payload["recording_mbid"] = json!(id)
        } else {
            let id = record
                .recording_msid
                .as_ref()
                .context("Resolve this recording before syncing")?;
            uuid::Uuid::parse_str(id)?;
            payload["recording_msid"] = json!(id)
        };
        let value = response_guarded(
            CLIENT
                .post(reqwest::Url::parse(lb)?.join("recording-feedback")?)
                .header("Authorization", format!("Token {}", creds.session))
                .json(&payload),
            current,
        )
        .await?;
        if value.get("status").and_then(Value::as_str) != Some("ok") {
            bail!("Feedback was not acknowledged")
        }
    } else {
        if record.title.is_empty() || record.artist.is_empty() {
            bail!("Resolve this recording before syncing")
        }
        let method = if liked { "track.love" } else { "track.unlove" };
        let mut params = BTreeMap::new();
        params.insert("method", method);
        params.insert("api_key", creds.key.as_str());
        params.insert("artist", record.artist.as_str());
        params.insert("track", record.title.as_str());
        params.insert("sk", creds.session.as_str());
        let sig = crate::lastfm::sign(&params, &creds.secret);
        params.insert("api_sig", &sig);
        params.insert("format", "json");
        let value = response_guarded(CLIENT.post(lf).form(&params), current).await?;
        if !value.is_object() {
            bail!("Love change was not acknowledged")
        }
    }
    Ok(())
}
#[tauri::command]
pub async fn favorites_remote_account(
    service: String,
    app: tauri::AppHandle,
) -> Result<FavoriteAccount, String> {
    credentials(&app, &service)
        .map(|c| c.account)
        .map_err(|_| "Connect this service before syncing likes".into())
}
#[tauri::command]
pub async fn favorites_remote_page(
    expected: FavoriteAccount,
    offset: usize,
    app: tauri::AppHandle,
) -> Result<FavoritePage, String> {
    let work = async {
        if offset > 100000 || offset % 100 != 0 {
            bail!("Invalid favorite page")
        };
        let creds = owned(&app, &expected)?;
        let value = if expected.service == "listenbrainz" {
            response(
                CLIENT
                    .get(lb_url(LB_BASE, &expected.user, "get-feedback")?)
                    .header("Authorization", format!("Token {}", creds.session))
                    .query(&[
                        ("score", "1"),
                        ("metadata", "true"),
                        ("count", "1000"),
                        ("offset", &offset.to_string()),
                    ]),
            )
            .await?
        } else {
            response(CLIENT.get(LF_BASE).query(&[
                ("method", "user.getLovedTracks"),
                ("api_key", &creds.key),
                ("user", &expected.user),
                ("limit", "100"),
                ("page", &(offset / 100 + 1).to_string()),
                ("format", "json"),
            ]))
            .await?
        };
        owned(&app, &expected)?;
        parse_page(&expected.service, &value, offset)
    };
    work.await.map_err(|e: anyhow::Error| e.to_string())
}
#[tauri::command]
pub async fn favorites_remote_peek(
    expected: FavoriteAccount,
    record: FavoriteRecording,
    app: tauri::AppHandle,
) -> Result<bool, String> {
    let work = async {
        let creds = owned(&app, &expected)?;
        let value = peek(&creds, &record).await?;
        owned(&app, &expected)?;
        Ok(value)
    };
    work.await.map_err(|e: anyhow::Error| e.to_string())
}
#[tauri::command]
pub async fn favorites_remote_set(
    expected: FavoriteAccount,
    record: FavoriteRecording,
    liked: bool,
    before: bool,
    app: tauri::AppHandle,
) -> Result<bool, String> {
    let work = async {
        if record.title.len() > 1000 || record.artist.len() > 1000 {
            bail!("Invalid favorite labels")
        }
        let creds = owned(&app, &expected)?;
        let actual = peek(&creds, &record).await?;
        if actual == liked {
            return Ok(actual);
        };
        if actual != before {
            bail!("Favorite changed before saving")
        };
        owned(&app, &expected)?;
        write_at(&creds, &record, liked, LB_BASE, LF_BASE, || {
            owned(&app, &expected).map(|_| ())
        })
        .await?;
        owned(&app, &expected)?;
        let after = peek(&creds, &record).await?;
        owned(&app, &expected)?;
        if after != liked {
            bail!("Favorite change needs read-only recovery")
        };
        Ok(after)
    };
    work.await.map_err(|e: anyhow::Error| e.to_string())
}
#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    #[test]
    fn feedback_and_loved_pages_keep_recording_identity_and_validate_completeness() {
        let id = "11111111-1111-4111-8111-111111111111";
        let value = json!({"feedback":[{"score":1,"recording_msid":id,"track_metadata":{"track_name":"Song","artist_name":"Artist"}}],"total_count":1,"offset":0});
        let page = parse_page("listenbrainz", &value, 0).unwrap();
        assert_eq!(page.rows[0].recording_msid.as_deref(), Some(id));
        assert!(page.rows[0].recording_mbid.is_none());
        assert!(parse_page("listenbrainz", &value, 100).is_err());
        let lastfm = json!({"lovedtracks":{"track":[{"name":"Song","mbid":id,"artist":{"name":"Artist"}}],"@attr":{"page":"1","total":"1"}}});
        let page = parse_page("lastfm", &lastfm, 0).unwrap();
        assert!(page.rows[0].recording_mbid.is_none());
        assert!(parse_page(
            "lastfm",
            &json!({"lovedtracks":{"track":[],"@attr":{"page":"1","total":"2"}}}),
            0
        )
        .is_err());
    }
    #[test]
    fn love_dates_are_preserved_in_milliseconds_with_optional_legacy_values() {
        let id = "11111111-1111-4111-8111-111111111111";
        let lb = json!({"feedback":[{"score":1,"recording_mbid":id,"created":1600000000}],"total_count":1,"offset":0});
        let lf = json!({"lovedtracks":{"track":[{"name":"Song","artist":{"name":"Artist"},"date":{"uts":"1500000000"}}],"@attr":{"page":"1","total":"1"}}});
        assert_eq!(
            parse_page("listenbrainz", &lb, 0).unwrap().rows[0].liked_at,
            Some(1600000000000)
        );
        let page = parse_page("lastfm", &lf, 0).unwrap();
        assert_eq!(page.rows[0].liked_at, Some(1500000000000));
        assert_eq!(
            serde_json::to_value(&page.rows[0]).unwrap()["likedAt"],
            1500000000000_i64
        );
        for raw in [
            json!(null),
            json!(0),
            json!(-1),
            json!("invalid"),
            json!({}),
            json!(1.5),
            json!(i64::MAX),
        ] {
            assert_eq!(liked_at(Some(&raw)), None);
        }
        assert_eq!(liked_at(None), None);
        let legacy = json!({"key":"old","title":"Song","artist":"Artist"});
        assert!(serde_json::from_value::<FavoriteRecording>(legacy)
            .unwrap()
            .liked_at
            .is_none());
    }
    #[test]
    fn listenbrainz_accepts_bounded_thousand_record_pages() {
        let rows: Vec<_> = (1..=1000).map(|id| json!({"score":1,"recording_mbid":format!("00000000-0000-4000-8000-{id:012}"),"created":1600000000})).collect();
        let mut value = json!({"feedback":rows,"total_count":1001,"offset":0});
        assert_eq!(
            parse_page("listenbrainz", &value, 0).unwrap().rows.len(),
            1000
        );
        value["feedback"]
            .as_array_mut()
            .unwrap()
            .push(json!({"score":1,"recording_mbid":"11111111-1111-4111-8111-111111111111"}));
        assert!(parse_page("listenbrainz", &value, 0).is_err());
    }
    pub(crate) fn loopback(
        replies: Vec<(u16, Value)>,
    ) -> (String, std::thread::JoinHandle<Vec<String>>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/", listener.local_addr().unwrap());
        let thread = std::thread::spawn(move || {
            listener.set_nonblocking(true).unwrap();
            let mut requests = Vec::new();
            for (status, body) in replies {
                let start = std::time::Instant::now();
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(start.elapsed().as_secs() < 5);
                            std::thread::sleep(std::time::Duration::from_millis(2))
                        }
                        Err(e) => panic!("{e}"),
                    }
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(3)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut buffer = [0; 2048];
                loop {
                    let n = stream.read(&mut buffer).unwrap();
                    if n == 0 {
                        break;
                    };
                    bytes.extend_from_slice(&buffer[..n]);
                    if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                line.strip_prefix("content-length:")?
                                    .trim()
                                    .parse::<usize>()
                                    .ok()
                            })
                            .unwrap_or(0);
                        if bytes.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                requests.push(String::from_utf8(bytes).unwrap());
                let encoded = body.to_string();
                write!(stream,"HTTP/1.1 {status} Reply\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{encoded}",encoded.len()).unwrap();
            }
            requests
        });
        (base, thread)
    }
    fn fixture(service: &str) -> (Credentials, FavoriteRecording) {
        (
            Credentials {
                account: FavoriteAccount {
                    service: service.into(),
                    user: "listener".into(),
                    revision: "lease".into(),
                },
                key: "key".into(),
                secret: "secret".into(),
                session: "session".into(),
            },
            FavoriteRecording {
                key: "record".into(),
                title: "Song".into(),
                artist: "Artist".into(),
                album: String::new(),
                duration_ms: None,
                liked_at: None,
                recording_mbid: Some("11111111-1111-4111-8111-111111111111".into()),
                recording_msid: None,
                local_track_id: None,
            },
        )
    }
    #[tokio::test]
    async fn feedback_transport_keeps_ids_and_uses_zero_for_unlike() {
        let (creds, record) = fixture("listenbrainz");
        let (base, thread) = loopback(vec![
            (
                200,
                json!({"feedback":[{"recording_mbid":record.recording_mbid,"score":1}]}),
            ),
            (200, json!({"status":"ok"})),
            (
                200,
                json!({"feedback":[{"recording_mbid":record.recording_mbid,"score":0}]}),
            ),
        ]);
        assert!(peek_at(&creds, &record, &base, &base).await.unwrap());
        write_at(&creds, &record, false, &base, &base, || Ok(()))
            .await
            .unwrap();
        assert!(!peek_at(&creds, &record, &base, &base).await.unwrap());
        let requests = thread.join().unwrap();
        assert!(requests[0].starts_with("POST /user/listener/get-feedback-for-recordings"));
        assert!(requests[0].to_lowercase().contains("user-agent: hibiki/"));
        assert!(requests[0]
            .to_lowercase()
            .contains("authorization: token session"));
        let payload: Value =
            serde_json::from_str(requests[1].split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(payload["score"], 0);
        assert_eq!(payload["recording_mbid"], record.recording_mbid.unwrap());
        assert!(payload.get("recording_msid").is_none());
    }
    #[tokio::test]
    async fn lastfm_transport_verifies_labels_and_signs_the_exact_love() {
        let (creds, record) = fixture("lastfm");
        let (base, thread) = loopback(vec![
            (
                200,
                json!({"track":{"name":"Song","artist":{"name":"Artist"},"userloved":"0"}}),
            ),
            (200, json!({})),
            (
                200,
                json!({"track":{"name":"Song","artist":{"name":"Artist"},"userloved":"1"}}),
            ),
        ]);
        assert!(!peek_at(&creds, &record, &base, &base).await.unwrap());
        write_at(&creds, &record, true, &base, &base, || Ok(()))
            .await
            .unwrap();
        assert!(peek_at(&creds, &record, &base, &base).await.unwrap());
        let requests = thread.join().unwrap();
        assert!(requests[0].contains("autocorrect=0"));
        let params: BTreeMap<_, _> =
            url::form_urlencoded::parse(requests[1].split("\r\n\r\n").nth(1).unwrap().as_bytes())
                .into_owned()
                .collect();
        use md5::{Digest, Md5};
        assert_eq!(params["method"], "track.love");
        assert_eq!(params["artist"], "Artist");
        assert_eq!(params["track"], "Song");
        assert_eq!(
            params["api_sig"],
            format!(
                "{:x}",
                Md5::digest("api_keykeyartistArtistmethodtrack.lovesksessiontrackSongsecret")
            )
        );
        let (base, thread) = loopback(vec![(
            200,
            json!({"track":{"name":"Other version","artist":{"name":"Artist"},"userloved":"0"}}),
        )]);
        assert!(peek_at(&creds, &record, &base, &base).await.is_err());
        assert_eq!(thread.join().unwrap().len(), 1);
    }
    #[tokio::test]
    async fn rejected_feedback_is_not_retried_or_reported_as_saved() {
        let (creds, record) = fixture("listenbrainz");
        for (status, body) in [
            (500, json!({})),
            (302, json!({})),
            (200, json!({"status":"failed"})),
        ] {
            let (base, thread) = loopback(vec![(status, body)]);
            assert!(write_at(&creds, &record, true, &base, &base, || Ok(()))
                .await
                .is_err());
            assert_eq!(thread.join().unwrap().len(), 1);
        }
        let (base, thread) = loopback(vec![(
            200,
            json!({"feedback":[{"recording_mbid":"22222222-2222-4222-8222-222222222222","score":1}]}),
        )]);
        assert!(peek_at(&creds, &record, &base, &base).await.is_err());
        thread.join().unwrap();
        assert_eq!(
            parse_page(
                "lastfm",
                &json!({"lovedtracks":{"@attr":{"page":"1","total":"0"}}}),
                0
            )
            .unwrap()
            .total,
            0
        );
    }
}
