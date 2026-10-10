//! Public artwork never inherits a server's certificate exception or credentials.

use crate::plex::PlexClient;
use once_cell::sync::Lazy;
use std::io::{Read, Write};
use std::path::Path;

pub const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
static PUBLIC: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .expect("public image client")
});

pub fn request(client: Option<&PlexClient>, value: &str) -> Option<reqwest::RequestBuilder> {
    let url = url::Url::parse(value).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    if let Some(client) = client.filter(|client| client.is_plex_url(value)) {
        return Some(client.media_request(value));
    }
    if url
        .query_pairs()
        .any(|(key, _)| key.eq_ignore_ascii_case("X-Plex-Token"))
    {
        return None;
    }
    Some(PUBLIC.get(url))
}

pub async fn fetch(request: reqwest::RequestBuilder) -> Option<Vec<u8>> {
    let mut response = request.send().await.ok()?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|length| length > MAX_IMAGE_BYTES as u64)
    {
        return None;
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if chunk.len() > MAX_IMAGE_BYTES.saturating_sub(bytes.len()) {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.is_empty() {
        None
    } else {
        Some(bytes)
    }
}

pub fn read_cached(path: &Path) -> Option<Vec<u8>> {
    let file = std::fs::File::open(path).ok()?;
    if file.metadata().ok()?.len() > MAX_IMAGE_BYTES as u64 {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(MAX_IMAGE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() <= MAX_IMAGE_BYTES && !bytes.is_empty()).then_some(bytes)
}

pub fn cache(path: &Path, bytes: &[u8]) {
    if bytes.len() > MAX_IMAGE_BYTES {
        return;
    }
    let Some(parent) = path.parent() else {
        return;
    };
    if let Ok(mut temporary) = tempfile::NamedTempFile::new_in(parent) {
        if temporary.write_all(bytes).is_ok() {
            let _ = temporary.persist(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn foreign_artwork_cannot_send_plex_query_tokens_or_embedded_credentials() {
        assert!(request(
            None,
            "https://external.test/image?X-Plex-Token=dummy-secret"
        )
        .is_none());
        assert!(request(None, "https://user:password@external.test/image").is_none());
        assert!(request(None, "file:///tmp/private").is_none());
        assert!(request(None, "https://external.test/image").is_some());
    }
    #[test]
    fn oversized_cached_images_are_rejected_and_cache_replacements_are_complete() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("image");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(MAX_IMAGE_BYTES as u64 + 1).unwrap();
        assert!(read_cached(&path).is_none());
        cache(&path, b"first-image");
        assert_eq!(read_cached(&path).unwrap(), b"first-image");
        cache(&path, b"second-image");
        assert_eq!(read_cached(&path).unwrap(), b"second-image");
    }

    #[tokio::test]
    async fn oversized_image_responses_are_rejected_with_or_without_content_length() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for chunked in [false, true] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let uri = format!("http://{}", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0_u8; 2048];
                let _ = socket.read(&mut request).await;
                if chunked {
                    let _ = socket.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").await;
                    let chunk = vec![0_u8; 1024 * 1024];
                    for _ in 0..9 {
                        if socket.write_all(b"100000\r\n").await.is_err() {
                            break;
                        }
                        if socket.write_all(&chunk).await.is_err() {
                            break;
                        }
                        if socket.write_all(b"\r\n").await.is_err() {
                            break;
                        }
                    }
                    let _ = socket.write_all(b"0\r\n\r\n").await;
                } else {
                    let header = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        MAX_IMAGE_BYTES + 1
                    );
                    let _ = socket.write_all(header.as_bytes()).await;
                }
            });
            assert!(fetch(request(None, &uri).unwrap()).await.is_none());
            server.await.unwrap();
        }
    }
}
