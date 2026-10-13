//! Exact-identity public enrichment. No credentials, redirects, or name search.
pub mod identity;
use crate::http_response::{BoundedResponseExt, MAX_JSON_BYTES};
use once_cell::sync::Lazy;
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

static CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!(
            "Hibiki/",
            env!("CARGO_PKG_VERSION"),
            " (https://github.com/karbowiak/hibiki)"
        ))
        .build()
        .expect("public metadata client")
});
struct Gate {
    next: tokio::sync::Mutex<Option<tokio::time::Instant>>,
    admission: tokio::sync::Semaphore,
}
impl Gate {
    fn new() -> Self {
        Self {
            next: tokio::sync::Mutex::new(None),
            admission: tokio::sync::Semaphore::new(8),
        }
    }
    async fn wait(&self) {
        let mut next = self.next.lock().await;
        if let Some(deadline) = *next {
            tokio::time::sleep_until(deadline).await;
        }
        *next = Some(tokio::time::Instant::now() + Duration::from_secs(1));
    }
    async fn get(&self, url: &str) -> Result<Option<Value>, String> {
        let _admission = self
            .admission
            .try_acquire()
            .map_err(|_| "Public metadata lookup is busy. Retry later.")?;
        self.wait().await;
        let response = CLIENT
            .get(url)
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .await
            .map_err(|_| "Public metadata request failed. Retry later.")?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            // Honor a server backoff for subsequent requests; never retry inline.
            if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS
                || response.status() == reqwest::StatusCode::SERVICE_UNAVAILABLE
            {
                let seconds = response
                    .headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok())
                    .unwrap_or(60)
                    .clamp(1, 3600);
                let mut next = self.next.lock().await;
                let deadline = tokio::time::Instant::now() + Duration::from_secs(seconds);
                *next = Some(next.map_or(deadline, |old| old.max(deadline)));
            }
            return Err("Public metadata service is unavailable. Retry later.".into());
        }
        response
            .bounded_json(MAX_JSON_BYTES)
            .await
            .map(Some)
            .map_err(|_| "Public metadata response was invalid.".into())
    }
}
static WIKIDATA_GATE: Lazy<Gate> = Lazy::new(Gate::new);
static CAA_GATE: Lazy<Gate> = Lazy::new(Gate::new);
fn mbid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value.to_lowercase())
}
fn qid(value: &str) -> bool {
    value.len() <= 20
        && value.starts_with('Q')
        && value[1..].bytes().all(|b| b.is_ascii_digit())
        && value.as_bytes().get(1).is_some_and(|b| *b != b'0')
}
#[derive(Debug, Serialize)]
pub struct WikidataArtist {
    pub qid: String,
    pub description: Option<String>,
    pub wikipedia_url: Option<String>,
}
fn wikidata_artist(value: &Value, id: &str, artist_mbid: &str) -> Option<WikidataArtist> {
    let entity = value.get("entities")?.get(id)?;
    if entity.get("id")?.as_str()? != id {
        return None;
    }
    // The MusicBrainz relation and reciprocal P434 must agree. A related person
    // or homonymous entity is not evidence for this artist's metadata.
    let verified = entity
        .get("claims")?
        .get("P434")?
        .as_array()?
        .iter()
        .any(|claim| {
            claim
                .pointer("/mainsnak/datavalue/value")
                .and_then(Value::as_str)
                .is_some_and(|id| id.eq_ignore_ascii_case(artist_mbid))
        });
    if !verified {
        return None;
    }
    let description = entity
        .pointer("/descriptions/en/value")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty() && s.chars().count() <= 2000)
        .map(str::to_owned);
    let wikipedia_url = entity
        .pointer("/sitelinks/enwiki/title")
        .and_then(Value::as_str)
        .filter(|s| s.len() <= 512)
        .and_then(|title| {
            let mut url = reqwest::Url::parse("https://en.wikipedia.org/wiki/").ok()?;
            url.path_segments_mut().ok()?.push(&title.replace(' ', "_"));
            Some(url.to_string())
        });
    Some(WikidataArtist {
        qid: id.into(),
        description,
        wikipedia_url,
    })
}
#[tauri::command]
pub async fn wikidata_get_artist(
    qid: String,
    artist_mbid: String,
) -> Result<Option<WikidataArtist>, String> {
    if !crate::public_metadata::qid(&qid) || !mbid(&artist_mbid) {
        return Err("Invalid verified artist identity.".into());
    }
    let Some(value) = WIKIDATA_GATE
        .get(&format!(
            "https://www.wikidata.org/wiki/Special:EntityData/{qid}.json"
        ))
        .await?
    else {
        return Ok(None);
    };
    Ok(wikidata_artist(&value, &qid, &artist_mbid))
}
#[derive(Debug, Serialize)]
pub struct ArchiveCover {
    pub cover_url: String,
}
fn archive_cover(value: &Value) -> Option<ArchiveCover> {
    value.get("images")?.as_array()?.iter().find_map(|image| {
        if image.get("front")?.as_bool()? != true || image.get("approved")?.as_bool()? != true {
            return None;
        }
        let source = image
            .pointer("/thumbnails/1200")
            .or_else(|| image.get("image"))?
            .as_str()?;
        if source.len() > 2048 {
            return None;
        }
        let mut url = reqwest::Url::parse(source).ok()?;
        if !matches!(url.scheme(), "https" | "http")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
            || url.fragment().is_some()
        {
            return None;
        }
        if !matches!(url.host_str()?, "coverartarchive.org" | "archive.org") {
            return None;
        }
        // The documented CAA JSON still contains HTTP image URLs. Upgrade
        // only the two verified public hosts, never arbitrary addresses.
        url.set_scheme("https").ok()?;
        Some(ArchiveCover {
            cover_url: url.to_string(),
        })
    })
}
#[tauri::command]
pub async fn coverartarchive_get_album(
    release_group_mbid: String,
) -> Result<Option<ArchiveCover>, String> {
    if !mbid(&release_group_mbid) {
        return Err("Invalid verified release-group identity.".into());
    }
    let Some(value) = CAA_GATE
        .get(&format!(
            "https://coverartarchive.org/release-group/{release_group_mbid}"
        ))
        .await?
    else {
        return Ok(None);
    };
    Ok(archive_cover(&value))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test(start_paused = true)]
    async fn source_gate_is_bounded_and_cancellation_never_bursts() {
        let gate = std::sync::Arc::new(Gate::new());
        let _held = gate.admission.acquire_many(8).await.unwrap();
        assert!(gate
            .get("http://127.0.0.1:1")
            .await
            .unwrap_err()
            .contains("busy"));
        gate.wait().await;
        let retired = {
            let gate = gate.clone();
            tokio::spawn(async move {
                gate.wait().await;
            })
        };
        tokio::task::yield_now().await;
        retired.abort();
        let first = {
            let gate = gate.clone();
            tokio::spawn(async move {
                gate.wait().await;
                tokio::time::Instant::now()
            })
        };
        let second = {
            let gate = gate.clone();
            tokio::spawn(async move {
                gate.wait().await;
                tokio::time::Instant::now()
            })
        };
        let a = first.await.unwrap();
        let b = second.await.unwrap();
        assert!(b - a >= Duration::from_secs(1));
    }
    #[tokio::test]
    async fn public_transport_is_get_only_identified_and_refuses_redirects() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/exact/Q123", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = vec![];
            let mut buffer = [0; 4096];
            while !bytes.windows(4).any(|p| p == b"\r\n\r\n") {
                let n = stream.read(&mut buffer).unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&buffer[..n]);
            }
            stream.write_all(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/private\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
            String::from_utf8(bytes).unwrap()
        });
        let error = Gate::new().get(&url).await.unwrap_err();
        assert!(!error.contains("127.0.0.1"));
        let request = server.join().unwrap();
        assert!(request.starts_with("GET /exact/Q123 HTTP/1.1"));
        assert!(request.to_lowercase().contains("user-agent: hibiki/"));
        assert!(!request.to_lowercase().contains("authorization:"));
    }
    #[tokio::test]
    async fn transport_bounds_body_and_retains_server_backoff_without_retry() {
        use std::io::{Read, Write};
        for (status, body, extra) in [
            ("200 OK", "{}".to_owned(), ""),
            (
                "200 OK",
                format!("\"{}\"", "x".repeat(MAX_JSON_BYTES + 1)),
                "",
            ),
            ("503 Unavailable", "{}".to_owned(), "Retry-After: 120\r\n"),
        ] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}/exact", listener.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                stream.set_write_timeout(Some(Duration::from_secs(2))).unwrap();
                let mut request = vec![];
                let mut buffer = [0; 4096];
                while !request.windows(4).any(|p| p == b"\r\n\r\n") {
                    let n = stream.read(&mut buffer).unwrap();
                    assert!(n > 0);
                    request.extend_from_slice(&buffer[..n]);
                }
                let header = format!(
                    "HTTP/1.1 {status}\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                stream.write_all(header.as_bytes()).unwrap();
                let _ = stream.write_all(body.as_bytes());
            });
            let gate = Gate::new();
            let result = gate.get(&url).await;
            if status == "200 OK" && extra.is_empty() && result.is_ok() {
                assert_eq!(result.unwrap(), Some(serde_json::json!({})));
            } else {
                assert!(result.is_err());
            }
            if status.starts_with("503") {
                assert!(
                    gate.next.lock().await.unwrap() - tokio::time::Instant::now()
                        > Duration::from_secs(115)
                );
            }
            server.join().unwrap();
        }
    }
    #[test]
    fn reciprocal_artist_identity_and_description_are_required() {
        let id = "12345678-1234-1234-1234-123456789abc";
        let value = serde_json::json!({"entities":{"Q123":{"id":"Q123","descriptions":{"en":{"value":"Japanese singer"}},"claims":{"P434":[{"mainsnak":{"datavalue":{"value":id}}}]},"sitelinks":{"enwiki":{"title":"Artist & musician"}}}}});
        let artist = wikidata_artist(&value, "Q123", id).unwrap();
        assert_eq!(artist.description.as_deref(), Some("Japanese singer"));
        assert!(artist.wikipedia_url.unwrap().contains("Artist_&_musician"));
        assert!(wikidata_artist(&value, "Q123", "22345678-1234-1234-1234-123456789abc").is_none());
        assert!(wikidata_artist(&value, "Q124", id).is_none());
        for bad in ["Q", "Q0", "Q12/../foo", "q12"] {
            assert!(!qid(bad));
        }
    }
    #[test]
    fn only_approved_front_art_from_public_archive_hosts_is_returned() {
        for source in [
            "https://evil.example/image",
            "https://u:p@archive.org/image",
            "https://archive.org:443/image",
        ] {
            let value =
                serde_json::json!({"images":[{"front":true,"approved":true,"image":source}]});
            // Explicit default port is normalized by URL parsing and is safe.
            if source.ends_with(":443/image") {
                assert!(archive_cover(&value).is_some());
            } else {
                assert!(archive_cover(&value).is_none());
            }
        }
        assert_eq!(archive_cover(&serde_json::json!({"images":[{"front":true,"approved":true,"image":"http://coverartarchive.org/release/cover"}]})).unwrap().cover_url,"https://coverartarchive.org/release/cover");
        let value = serde_json::json!({"images":[{"front":false,"approved":true,"image":"https://archive.org/back"},{"front":true,"approved":false,"image":"https://archive.org/unapproved"},{"front":true,"approved":true,"image":"https://archive.org/front","thumbnails":{"1200":"https://archive.org/large"}}]});
        assert_eq!(
            archive_cover(&value).unwrap().cover_url,
            "https://archive.org/large"
        );
    }
}
