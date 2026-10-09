//! Resume interrupted media bodies without appending a restarted or changed file.
//! Range semantics: https://www.rfc-editor.org/rfc/rfc9110.html#section-14
use futures::StreamExt;
use reqwest::{header, RequestBuilder, StatusCode};

const MAX_RETRIES: usize = 3;
const OVERLAP_BYTES: usize = 64 * 1024;

fn content_range(value: &str) -> Option<(u64, u64, u64)> {
    let (range, total) = value.strip_prefix("bytes ")?.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    let (start, end, total) = (start.parse().ok()?, end.parse().ok()?, total.parse().ok()?);
    if start <= end && end < total {
        Some((start, end, total))
    } else {
        None
    }
}

/// `consume` receives each byte exactly once, including across retries. The
/// caller owns cancellation and the decoder/cache sinks. Errors omit URLs.
pub async fn download(
    make_request: impl Fn() -> RequestBuilder,
    mut set_length: impl FnMut(u64),
    mut consume: impl FnMut(&[u8]),
) -> Result<(), String> {
    let mut offset = 0u64;
    let mut total = None;
    let mut etag: Option<String> = None;
    let mut tail = Vec::<u8>::new();
    let mut retries = 0;
    loop {
        // Compare a bounded overlap as well as validators. Some Plex/podcast
        // servers provide byte ranges without an ETag.
        let resume = offset > 0;
        let from = offset.saturating_sub(tail.len() as u64);
        let expected_overlap = tail.clone();
        let mut request = make_request().header(header::ACCEPT_ENCODING, "identity");
        if resume {
            request = request.header(header::RANGE, format!("bytes={from}-"));
            if let Some(tag) = etag.as_ref().filter(|tag| !tag.starts_with("W/")) {
                request = request.header(header::IF_RANGE, tag);
            }
        }
        let response = match request.send().await {
            Ok(response) => response,
            Err(error) => {
                if retries >= MAX_RETRIES {
                    return Err(format!("media request failed: {}", error.without_url()));
                }
                retries += 1;
                tokio::time::sleep(std::time::Duration::from_millis(100 * retries as u64)).await;
                continue;
            }
        };
        let status = response.status();
        if status.is_server_error() || status == StatusCode::TOO_MANY_REQUESTS {
            if retries >= MAX_RETRIES {
                return Err(format!("media server returned {status}"));
            }
            retries += 1;
            tokio::time::sleep(std::time::Duration::from_millis(100 * retries as u64)).await;
            continue;
        }
        if response
            .headers()
            .get(header::CONTENT_ENCODING)
            .is_some_and(|v| v != "identity")
        {
            return Err("media server returned encoded bytes despite an identity request".into());
        }
        let new_etag = response
            .headers()
            .get(header::ETAG)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let response_length;
        if resume {
            if status != StatusCode::PARTIAL_CONTENT {
                return Err(format!("media server cannot resume this stream ({status})"));
            }
            if etag.is_some() && new_etag != etag {
                return Err("media changed during download".into());
            }
            let (start, end, size) = response
                .headers()
                .get(header::CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                .and_then(content_range)
                .ok_or("invalid media Content-Range")?;
            if start != from || total.is_some_and(|known| known != size) {
                return Err("media range does not match the interrupted file".into());
            }
            total = Some(size);
            set_length(size);
            response_length = Some(end - start + 1);
            if response
                .content_length()
                .is_some_and(|length| Some(length) != response_length)
            {
                return Err("media range length does not match Content-Length".into());
            }
        } else {
            if status != StatusCode::OK {
                return Err(format!("media server returned {status}"));
            }
            etag = new_etag;
            total = response.content_length();
            if let Some(size) = total {
                set_length(size);
            }
            response_length = total;
        }
        let mut stream = response.bytes_stream();
        let mut received = 0u64;
        let mut compared = 0usize;
        let mut interrupted = false;
        while let Some(chunk) = stream.next().await {
            let chunk = match chunk {
                Ok(chunk) => chunk,
                Err(_) => {
                    interrupted = true;
                    break;
                }
            };
            received = received
                .checked_add(chunk.len() as u64)
                .ok_or("media size overflow")?;
            if response_length.is_some_and(|size| received > size) {
                return Err("media response exceeded its declared length".into());
            }
            let overlap = if resume {
                (expected_overlap.len() - compared).min(chunk.len())
            } else {
                0
            };
            if overlap > 0 {
                if chunk[..overlap] != expected_overlap[compared..compared + overlap] {
                    return Err("media bytes changed while resuming".into());
                }
                compared += overlap;
            }
            let fresh = &chunk[overlap..];
            if !fresh.is_empty() {
                offset = offset
                    .checked_add(fresh.len() as u64)
                    .ok_or("media size overflow")?;
                if total.is_some_and(|size| offset > size) {
                    return Err("media exceeded its total length".into());
                }
                consume(fresh);
                if fresh.len() >= OVERLAP_BYTES {
                    tail.clear();
                    tail.extend_from_slice(&fresh[fresh.len() - OVERLAP_BYTES..]);
                } else {
                    tail.extend_from_slice(fresh);
                    if tail.len() > OVERLAP_BYTES {
                        tail.drain(..tail.len() - OVERLAP_BYTES);
                    }
                }
            }
        }
        if !interrupted
            && response_length.is_none_or(|size| received == size)
            && total.is_none_or(|size| offset == size)
        {
            return Ok(());
        }
        if retries >= MAX_RETRIES {
            return Err("media transfer remained incomplete after retries".into());
        }
        retries += 1;
        tokio::time::sleep(std::time::Duration::from_millis(100 * retries as u64)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn read_request(socket: &mut tokio::net::TcpStream) -> String {
        let mut data = Vec::new();
        loop {
            let mut buf = [0; 1024];
            let n = socket.read(&mut buf).await.unwrap();
            assert!(n > 0);
            data.extend_from_slice(&buf[..n]);
            if data.windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
            assert!(data.len() < 16384);
        }
        String::from_utf8(data).unwrap()
    }

    fn header(request: &str, name: &str) -> Option<String> {
        request
            .lines()
            .filter_map(|line| line.split_once(':'))
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.trim().into())
    }

    // Deliberately cut a real TCP body short. The second response can resume,
    // restart, mutate the representation, or lie about its range.
    async fn interrupted(mode: &str) -> (Result<(), String>, Vec<u8>, Vec<u8>) {
        let body: Vec<u8> = (0..100_000).map(|i| (i % 251) as u8).collect();
        let source = body.clone();
        let mode = mode.to_owned();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/track.flac", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let first = read_request(&mut socket).await;
            assert!(header(&first, "Range").is_none());
            let tag_header = if mode == "no-etag" {
                ""
            } else {
                "ETag: \"track-v1\"\r\n"
            };
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: 100000\r\n{tag_header}Connection: close\r\n\r\n").as_bytes()).await.unwrap();
            socket.write_all(&source[..70000]).await.unwrap();
            socket.shutdown().await.unwrap();
            drop(socket);
            let (mut socket, _) = listener.accept().await.unwrap();
            let second = read_request(&mut socket).await;
            assert_eq!(
                header(&second, "If-Range").as_deref(),
                if mode == "no-etag" {
                    None
                } else {
                    Some("\"track-v1\"")
                }
            );
            let range = header(&second, "Range").unwrap();
            let from: usize = range
                .strip_prefix("bytes=")
                .unwrap()
                .trim_end_matches('-')
                .parse()
                .unwrap();
            assert!(from < 70000);
            if mode == "restart" {
                socket
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 100000\r\nConnection: close\r\n\r\n",
                    )
                    .await
                    .unwrap();
                let _ = socket.write_all(&source).await;
                return;
            }
            let start = if mode == "bad-range" { from + 1 } else { from };
            let tag = if mode == "changed-tag" {
                "track-v2"
            } else {
                "track-v1"
            };
            let total = if mode == "changed-size" {
                100001
            } else {
                100000
            };
            let response = format!("HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {}-99999/{}\r\nETag: \"{}\"\r\nConnection: close\r\n\r\n", 100000 - start, start, total, tag);
            socket.write_all(response.as_bytes()).await.unwrap();
            let mut remaining = source[start..].to_vec();
            if mode == "changed-bytes" {
                remaining[0] ^= 1;
            }
            let _ = socket.write_all(&remaining).await;
        });
        let client = reqwest::Client::builder().http1_only().build().unwrap();
        let mut received = Vec::new();
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            download(
                || client.get(&url),
                |_| {},
                |chunk| received.extend_from_slice(chunk),
            ),
        )
        .await
        .unwrap();
        server.await.unwrap();
        (result, received, body)
    }

    #[tokio::test]
    async fn resumes_a_cut_body_with_identical_decoder_and_cache_bytes() {
        for mode in ["resume", "no-etag"] {
            let (result, received, original) = interrupted(mode).await;
            result.unwrap();
            assert_eq!(received, original);
        }
    }

    #[tokio::test]
    async fn never_appends_a_full_restart_response_to_the_partial_file() {
        let (result, received, _) = interrupted("restart").await;
        assert!(result.unwrap_err().contains("cannot resume"));
        assert_eq!(received.len(), 70000);
    }

    #[tokio::test]
    async fn rejects_changed_entities_and_misaligned_ranges() {
        for mode in ["changed-tag", "changed-size", "changed-bytes", "bad-range"] {
            let (result, received, _) = interrupted(mode).await;
            assert!(result.is_err(), "{mode}");
            assert_eq!(received.len(), 70000, "{mode}");
        }
    }

    #[test]
    fn content_range_rejects_invalid_and_overflowing_offsets() {
        assert_eq!(content_range("bytes 5-9/10"), Some((5, 9, 10)));
        for value in [
            "bytes 9-5/10",
            "bytes 0-10/10",
            "bytes 0-1/*",
            "items 0-1/10",
            "bytes 0-18446744073709551616/10",
        ] {
            assert_eq!(content_range(value), None, "{value}");
        }
    }

    #[tokio::test]
    async fn retries_are_bounded_when_the_server_remains_unavailable() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "http://{}/track?private-token=hidden",
            listener.local_addr().unwrap()
        );
        let server = tokio::spawn(async move {
            let mut count = 0;
            for _ in 0..=MAX_RETRIES {
                let (mut socket, _) = listener.accept().await.unwrap();
                read_request(&mut socket).await;
                socket.write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
                count += 1;
            }
            count
        });
        let client = reqwest::Client::new();
        let error = download(
            || client.get(&url),
            |_| {},
            |_| panic!("no successful body"),
        )
        .await
        .unwrap_err();
        assert!(!error.contains("hidden"));
        assert_eq!(server.await.unwrap(), MAX_RETRIES + 1);
    }
}
