//! Public artwork never inherits a server's certificate exception or credentials.

use crate::plex::PlexClient;
use once_cell::sync::Lazy;

pub const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
static PUBLIC: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 10 {
                attempt.error("too many public artwork redirects")
            } else if crate::plex::artwork::public_url(attempt.url()) {
                attempt.follow()
            } else {
                attempt.error("refusing credentials in public artwork redirect")
            }
        }))
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
        return client.artwork_request(value).map(|request| {
            request.header(
                "Accept",
                "image/jpeg, image/png, image/webp, image/gif, image/bmp, image/x-icon",
            )
        });
    }
    if url
        .query_pairs()
        .any(|(key, _)| key.eq_ignore_ascii_case("X-Plex-Token"))
    {
        return None;
    }
    Some(PUBLIC.get(url).header(
        "Accept",
        "image/jpeg, image/png, image/webp, image/gif, image/bmp, image/x-icon",
    ))
}

pub fn scoped_request(
    client: Option<&PlexClient>,
    scope: &str,
    value: &str,
) -> Option<reqwest::RequestBuilder> {
    if !scope_matches(client, scope)
        || (client.is_some_and(|client| client.is_plex_url(value)) && scope.is_empty())
    {
        return None;
    }
    request(client, value)
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
    if !src.is_empty() {
        use sha2::{Digest, Sha256};
        let source = serde_json::to_vec(&[scope, "source", src]).expect("image source tuple");
        return format!("v2_{}.img", hex::encode(Sha256::digest(source)));
    }
    legacy_cache_key(scope, entity_type, entity_id, src, name, artist)
}

pub fn legacy_cache_key(
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
    format!("v2_{}.img", hex::encode(Sha256::digest(tuple)))
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
    let declared = match response.headers().get(reqwest::header::CONTENT_TYPE) {
        Some(value) => Some(value.to_str().ok()?.to_owned()),
        None => None,
    };
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if chunk.len() > MAX_IMAGE_BYTES.saturating_sub(bytes.len()) {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    crate::image_content::validate(bytes, declared).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn artwork_rejects_html_error_pages_even_when_http_status_is_success() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let uri = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0_u8; 2048];
            socket.read(&mut buffer).await.unwrap();
            let body = b"<html><body>Sign in</body></html>";
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes()).await.unwrap();
            socket.write_all(body).await.unwrap();
        });
        assert!(fetch(request(None, &uri).unwrap()).await.is_none());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn artwork_checks_http_mime_against_pixels_and_accepts_untyped_cdn_images() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for declared in [
            Some("image/png"),
            Some("application/octet-stream"),
            None,
            Some("text/html"),
            Some("image/jpeg"),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let uri = format!("http://{}", listener.local_addr().unwrap());
            let png = crate::image_content::test_png();
            let expected = png.clone();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buffer = [0_u8; 2048];
                socket.read(&mut buffer).await.unwrap();
                let mime = declared
                    .map(|value| format!("Content-Type: {value}\r\n"))
                    .unwrap_or_default();
                socket.write_all(format!("HTTP/1.1 200 OK\r\n{mime}Content-Length: {}\r\nConnection: close\r\n\r\n", png.len()).as_bytes()).await.unwrap();
                socket.write_all(&png).await.unwrap();
            });
            let bytes = fetch(request(None, &uri).unwrap()).await;
            if matches!(declared, Some("text/html")) {
                assert!(bytes.is_none());
            } else {
                assert_eq!(bytes, Some(expected));
            }
            server.await.unwrap();
        }
    }

    #[test]
    fn artwork_cannot_turn_metadata_urls_into_authenticated_api_calls() {
        let client = PlexClient::new(crate::plex::PlexClientConfig {
            base_url: "https://plex.test".into(),
            token: "dummy-private-token".into(),
            ..Default::default()
        })
        .unwrap();
        for path in [
            "/:/scrobble?key=1",
            "/:/unscrobble?key=1",
            "/library/sections/1/refresh",
            "/library/metadata/1",
            "/library/metadata/1/theme",
        ] {
            assert!(
                request(Some(&client), &format!("https://plex.test{path}")).is_none(),
                "artwork must reject {path} before building a privileged request"
            );
        }
    }

    #[test]
    fn authenticated_artwork_requires_the_current_library_scope() {
        let mut client = PlexClient::new(crate::plex::PlexClientConfig {
            base_url: "https://plex.test/plex".into(),
            token: "dummy-private-token".into(),
            ..Default::default()
        })
        .unwrap();
        client.library_scope = "current-library".into();
        let uri =
            "https://plex.test/plex/library/metadata/42/thumb?X-Plex-Token=old-token&width=600";
        assert!(scoped_request(Some(&client), "", uri).is_none());
        assert!(scoped_request(Some(&client), "old-library", uri).is_none());
        let request = scoped_request(Some(&client), "current-library", uri)
            .unwrap()
            .build()
            .unwrap();
        assert_eq!(request.url().query(), Some("width=600"));
        assert!(request.headers()["X-Plex-Token"].is_sensitive());
        assert_eq!(request.headers()["X-Plex-Token"], "dummy-private-token");
        let public = scoped_request(Some(&client), "", "https://cdn.test/cover.jpg")
            .unwrap()
            .build()
            .unwrap();
        assert!(!public.headers().contains_key("X-Plex-Token"));
    }

    #[test]
    fn nested_transcode_credentials_are_replaced_only_for_trusted_artwork() {
        let mut client = PlexClient::new(crate::plex::PlexClientConfig {
            base_url: "https://plex.test/plex".into(),
            token: "current-token".into(),
            ..Default::default()
        })
        .unwrap();
        client.library_scope = "library".into();
        for source in ["/library/metadata/42/thumb?X-Plex-Token=old-token&signature=a%20b%2Bc", "https://plex.test/plex/library/metadata/42/thumb?x-plex-token=old-token&signature=a%20b%2Bc"] {
            let mut uri = url::Url::parse("https://plex.test/plex/photo/:/transcode?width=600&signature=a%20b%2Bc").unwrap();
            uri.query_pairs_mut().append_pair("url", source);
            let request = scoped_request(Some(&client), "library", uri.as_str()).unwrap().build().unwrap();
            let nested = request.url().query_pairs().find(|(key, _)| key == "url").unwrap().1;
            assert!(!nested.contains("old-token"));
            assert!(nested.contains("X-Plex-Token=current-token"));
            assert!(nested.contains("signature=a%20b%2Bc"));
            assert!(request.url().query().unwrap().starts_with("width=600&signature=a%20b%2Bc&url="));
        }
        for source in [
            "https://foreign.test/cover.jpg?X-Plex-Token=old-token",
            "https://plex.test/plex/:/scrobble?key=1&X-Plex-Token=old-token",
            "/:/scrobble?key=1&X-Plex-Token=old-token",
        ] {
            let mut uri = url::Url::parse("https://plex.test/plex/photo/:/transcode").unwrap();
            uri.query_pairs_mut().append_pair("url", source);
            assert!(scoped_request(Some(&client), "library", uri.as_str()).is_none());
        }
    }

    #[tokio::test]
    async fn authenticated_redirects_remain_inside_artwork_routes() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for (redirect, allowed) in [
            ("/library/metadata/2/art/123", true),
            ("/:/scrobble?key=1", false),
            (
                "/library/metadata/2/thumb?X-Plex-Token=another-token",
                false,
            ),
            ("https://foreign.invalid/library/metadata/2/thumb", false),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = [0_u8; 4096];
                let size = socket.read(&mut bytes).await.unwrap();
                assert!(String::from_utf8_lossy(&bytes[..size])
                    .to_ascii_lowercase()
                    .contains("x-plex-token: dummy-private-token"));
                socket.write_all(format!("HTTP/1.1 302 Found\r\nLocation: {redirect}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
                drop(socket);
                let second =
                    tokio::time::timeout(std::time::Duration::from_millis(250), listener.accept())
                        .await;
                if let Ok(Ok((mut socket, _))) = second {
                    let size = socket.read(&mut bytes).await.unwrap();
                    assert!(String::from_utf8_lossy(&bytes[..size])
                        .to_ascii_lowercase()
                        .contains("x-plex-token: dummy-private-token"));
                    let artwork = crate::image_content::test_png();
                    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", artwork.len()).as_bytes()).await.unwrap();
                    socket.write_all(&artwork).await.unwrap();
                    true
                } else {
                    false
                }
            });
            let client = PlexClient::new(crate::plex::PlexClientConfig {
                base_url: base.clone(),
                token: "dummy-private-token".into(),
                ..Default::default()
            })
            .unwrap();
            let result =
                fetch(request(Some(&client), &format!("{base}/library/metadata/1/thumb")).unwrap())
                    .await;
            assert_eq!(result.is_some(), allowed, "redirect {redirect}");
            assert_eq!(
                server.await.unwrap(),
                allowed,
                "must not send the rejected hop"
            );
        }
    }

    #[tokio::test]
    async fn public_redirects_cannot_introduce_query_credentials() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let uri = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = [0_u8; 4096];
            let size = socket.read(&mut bytes).await.unwrap();
            assert!(!String::from_utf8_lossy(&bytes[..size])
                .to_ascii_lowercase()
                .contains("x-plex-token"));
            socket.write_all(b"HTTP/1.1 302 Found\r\nLocation: /cover?x-plex-token=secret\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
            drop(socket);
            assert!(
                tokio::time::timeout(std::time::Duration::from_millis(250), listener.accept())
                    .await
                    .is_err()
            );
        });
        assert!(fetch(request(None, &uri).unwrap()).await.is_none());
        server.await.unwrap();
    }
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
        assert_eq!(
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
