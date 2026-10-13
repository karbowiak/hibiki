//! Bounded metadata bodies. Never buffer a complete remote response before
//! checking its size, and never include a credential-bearing URL in errors.
use anyhow::{bail, Context, Result};
use serde::de::DeserializeOwned;
use std::future::Future;

pub const MAX_JSON_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_TEXT_BYTES: usize = 16 * 1024 * 1024;
// Plex library containers can be much larger than external lookup responses.
pub const MAX_PLEX_BYTES: usize = 64 * 1024 * 1024;

pub(crate) trait BoundedResponseExt {
    fn bounded_bytes(self, limit: usize) -> impl Future<Output = Result<Vec<u8>>> + Send;
    fn bounded_json<T: DeserializeOwned>(
        self,
        limit: usize,
    ) -> impl Future<Output = Result<T>> + Send;
    /// Only Plex read responses tolerate malformed UTF-8 value strings, with
    /// native original-byte provenance. JSON syntax and size limits stay strict.
    fn bounded_plex_json<T: DeserializeOwned>(
        self,
        limit: usize,
    ) -> impl Future<Output = Result<T>> + Send;
    fn bounded_text(self, limit: usize) -> impl Future<Output = Result<String>> + Send;
}

impl BoundedResponseExt for reqwest::Response {
    async fn bounded_bytes(mut self, limit: usize) -> Result<Vec<u8>> {
        if !self.status().is_success() {
            bail!("Metadata request returned HTTP {}", self.status());
        }
        if self
            .content_length()
            .is_some_and(|length| length > limit as u64)
        {
            bail!("Metadata response exceeds the {limit}-byte limit");
        }
        let mut body = Vec::new();
        while let Some(chunk) = self.chunk().await.map_err(|error| error.without_url())? {
            if chunk.len() > limit.saturating_sub(body.len()) {
                bail!("Metadata response exceeds the {limit}-byte limit");
            }
            let needed = body.len() + chunk.len();
            if needed > body.capacity() {
                let capacity = needed.max(body.capacity().saturating_mul(2)).min(limit);
                body.try_reserve_exact(capacity - body.len())
                    .context("Cannot allocate metadata response buffer")?;
            }
            body.extend_from_slice(&chunk);
        }
        Ok(body)
    }

    async fn bounded_json<T: DeserializeOwned>(self, limit: usize) -> Result<T> {
        let body = self.bounded_bytes(limit).await?;
        serde_json::from_slice(&body).context("Failed to parse metadata JSON")
    }

    async fn bounded_plex_json<T: DeserializeOwned>(self, limit: usize) -> Result<T> {
        let body = self.bounded_bytes(limit).await?;
        crate::plex::catalogue::decode_json(&body)
    }

    async fn bounded_text(self, limit: usize) -> Result<String> {
        // Match reqwest's charset and BOM handling for existing RSS/lyrics feeds.
        let content_type = self
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<mime::Mime>().ok());
        let charset = content_type
            .as_ref()
            .and_then(|mime| mime.get_param("charset").map(|value| value.as_str()))
            .unwrap_or("utf-8");
        let encoding =
            encoding_rs::Encoding::for_label(charset.as_bytes()).unwrap_or(encoding_rs::UTF_8);
        let body = self.bounded_bytes(limit).await?;
        Ok(encoding.decode(&body).0.into_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn response(headers: &str, body: &[u8]) -> reqwest::Response {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let bytes = format!("HTTP/1.1 {headers}\r\nConnection: close\r\n\r\n").into_bytes();
        let body = body.to_vec();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0; 2048];
            stream.read(&mut request).await.unwrap();
            stream.write_all(&bytes).await.unwrap();
            let _ = stream.write_all(&body).await;
        });
        reqwest::Client::new()
            .get(format!("http://{address}/?token=dummy-private-token"))
            .send()
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn limits_apply_to_declared_and_chunked_bodies_including_the_exact_boundary() {
        let declared = response("200 OK\r\nContent-Length: 1024", b"not read").await;
        assert!(declared
            .bounded_bytes(16)
            .await
            .unwrap_err()
            .to_string()
            .contains("exceeds"));
        let bytes = response(
            "200 OK\r\nTransfer-Encoding: chunked",
            b"8\r\n12345678\r\n8\r\nabcdefgh\r\n0\r\n\r\n",
        )
        .await
        .bounded_bytes(16)
        .await
        .unwrap();
        assert_eq!(bytes, b"12345678abcdefgh");
        let bytes = response(
            "200 OK\r\nTransfer-Encoding: chunked",
            b"7\r\n1234567\r\n8\r\nabcdefgh\r\n0\r\n\r\n",
        )
        .await
        .bounded_bytes(15)
        .await
        .unwrap();
        assert_eq!(bytes.len(), 15);
        assert!(bytes.capacity() <= 15);
        let too_large = response(
            "200 OK\r\nTransfer-Encoding: chunked",
            b"8\r\n12345678\r\n9\r\nabcdefghi\r\n0\r\n\r\n",
        )
        .await
        .bounded_bytes(16)
        .await
        .unwrap_err();
        assert!(too_large.to_string().contains("exceeds"));
    }

    #[tokio::test]
    async fn status_body_and_json_errors_never_expose_request_credentials() {
        for (headers, body) in [
            (
                "503 Service Unavailable\r\nContent-Length: 2",
                b"{}".as_slice(),
            ),
            ("200 OK\r\nContent-Length: 99", b"truncated".as_slice()),
            ("200 OK\r\nContent-Length: 1", b"{".as_slice()),
        ] {
            let error = response(headers, body)
                .await
                .bounded_json::<serde_json::Value>(128)
                .await
                .unwrap_err();
            let shown = format!("{error:#}");
            assert!(!shown.contains("dummy-private-token"));
            assert!(!shown.contains("127.0.0.1"));
        }
        let json = response("200 OK\r\nContent-Length: 7", br#"{"a":1}"#)
            .await
            .bounded_json::<serde_json::Value>(7)
            .await
            .unwrap();
        assert_eq!(json["a"], 1);
    }

    #[tokio::test]
    async fn plex_value_text_recovery_preserves_strict_generic_json_and_body_bounds() {
        let body = b"{\"title\":\"caf\xe9\"}";
        let headers = format!("200 OK\r\nContent-Length: {}", body.len());
        let json = response(&headers, body)
            .await
            .bounded_plex_json::<serde_json::Value>(body.len())
            .await
            .unwrap();
        assert_eq!(json["title"], "caf\u{fffd}");
        assert_eq!(
            json["_hibikiInvalidUtf8"]["fields"][0]["replacements"][0]["bytesHex"],
            "e9"
        );
        assert!(response(&headers, body)
            .await
            .bounded_json::<serde_json::Value>(body.len())
            .await
            .is_err());
        assert!(response(&headers, body)
            .await
            .bounded_plex_json::<serde_json::Value>(body.len() - 1)
            .await
            .unwrap_err()
            .to_string()
            .contains("exceeds"));
        let chunked = b"8\r\n{\"title\"\r\n8\r\n:\"caf\xe9\"}\r\n0\r\n\r\n";
        assert!(response("200 OK\r\nTransfer-Encoding: chunked", chunked)
            .await
            .bounded_plex_json::<serde_json::Value>(15)
            .await
            .unwrap_err()
            .to_string()
            .contains("exceeds"));
        let json = response("200 OK\r\nTransfer-Encoding: chunked", chunked)
            .await
            .bounded_plex_json::<serde_json::Value>(16)
            .await
            .unwrap();
        assert_eq!(json["title"], "caf\u{fffd}");
    }

    #[tokio::test]
    async fn bounded_text_preserves_charset_and_bom_decoding() {
        let text = response(
            "200 OK\r\nContent-Type: text/xml; charset=\"iso-8859-1\"\r\nContent-Length: 4",
            b"caf\xe9",
        )
        .await
        .bounded_text(4)
        .await
        .unwrap();
        assert_eq!(text, "caf\u{e9}");
        let text = response(
            "200 OK\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Length: 5",
            b"\xef\xbb\xbf\xc3\xa9",
        )
        .await
        .bounded_text(5)
        .await
        .unwrap();
        assert_eq!(text, "\u{e9}");
    }
}
