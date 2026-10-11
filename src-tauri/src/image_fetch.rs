//! Public artwork never inherits a server's certificate exception or credentials.

use crate::plex::PlexClient;
use once_cell::sync::Lazy;

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

/// Digest-only filenames cannot contain entity IDs, paths or credentials.
pub fn cache_key(
    scope: &str,
    entity_type: &str,
    entity_id: &str,
    src: &str,
    name: &str,
    artist: &str,
) -> String {
    use sha2::{Digest, Sha256};
    let tuple = serde_json::to_vec(&[scope, entity_type, entity_id, src, name, artist])
        .expect("string tuple");
    format!("v2_{:x}.img", Sha256::digest(tuple))
}

pub fn scope_matches(client: Option<&PlexClient>, requested: &str) -> bool {
    requested.is_empty()
        || client.is_some_and(|client| {
            !client.library_scope.is_empty() && client.library_scope == requested
        })
}

pub async fn fetch(request: reqwest::RequestBuilder) -> Option<Vec<u8>> {
    // Artwork must not inherit the audio client's long streaming deadline.
    let mut response = request
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .ok()?;
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn artwork_cache_separates_accounts_and_metadata_names_and_cannot_escape_its_directory() {
        let key = cache_key(
            "account-a",
            "artist",
            "../../private",
            "https://plex.test/image",
            "Name",
            "Artist",
        );
        assert!(!key.contains('/') && !key.contains("private"));
        assert_ne!(
            key,
            cache_key(
                "account-b",
                "artist",
                "../../private",
                "https://plex.test/image",
                "Name",
                "Artist"
            )
        );
        assert_ne!(
            cache_key("", "artist", "1", "", "First", ""),
            cache_key("", "artist", "1", "", "Second", "")
        );
        assert_ne!(
            key,
            cache_key(
                "account-a",
                "album",
                "../../private",
                "https://plex.test/image",
                "Name",
                "Artist"
            )
        );
    }

    #[test]
    fn old_scoped_image_urls_are_rejected_before_cache_access_or_credentials() {
        let mut client = PlexClient::new(crate::plex::PlexClientConfig {
            base_url: "https://plex.test".into(),
            ..Default::default()
        })
        .unwrap();
        client.library_scope = "current-library".into();
        assert!(scope_matches(Some(&client), "current-library"));
        assert!(!scope_matches(Some(&client), "old-library"));
        assert!(!scope_matches(None, "current-library"));
        assert!(scope_matches(None, ""));
    }

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
