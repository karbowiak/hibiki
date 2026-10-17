//! Resume interrupted media bodies without appending a restarted or changed file.
//! Range semantics: https://www.rfc-editor.org/rfc/rfc9110.html#section-14
use futures::StreamExt;
use reqwest::{header, RequestBuilder, StatusCode};

const MAX_RETRIES: usize = 3;
const OVERLAP_BYTES: usize = 64 * 1024;
// Release the Plex fetch lock between bounded requests. A new play/preload must
// not wait behind an entire album-sized file or all of another job's retries.
const PLEX_RANGE_BYTES: u64 = 4 * 1024 * 1024;

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
/// Plex callers share their originating connection's lock. Bounded ranges keep
/// transfers exclusive while allowing active playback/preload/downloads to take
/// turns. Public media retains ordinary streaming and open-ended range retries.
pub async fn download(
    make_request: impl Fn() -> RequestBuilder,
    mut set_length: impl FnMut(u64),
    mut consume: impl FnMut(&[u8]) -> Result<(), String>,
    plex_fetch_lock: Option<&tokio::sync::Mutex<()>>,
) -> Result<(), String> {
    let mut offset = 0u64;
    let mut total = None;
    let mut etag: Option<String> = None;
    let mut tail = Vec::<u8>::new();
    let mut retries = 0;
    loop {
        let guard = match plex_fetch_lock {
            Some(lock) => Some(lock.lock().await),
            None => None,
        };
        let attempt_offset = offset;
        // Compare a bounded overlap as well as validators. Some Plex/podcast
        // servers provide byte ranges without an ETag.
        let resume = offset > 0;
        let from = offset.saturating_sub(tail.len() as u64);
        let expected_overlap = tail.clone();
        let mut request = make_request().header(header::ACCEPT_ENCODING, "identity");
        if resume || plex_fetch_lock.is_some() {
            let range = if plex_fetch_lock.is_some() {
                let end = from.saturating_add(PLEX_RANGE_BYTES - 1);
                format!("bytes={from}-{end}")
            } else {
                format!("bytes={from}-")
            };
            request = request.header(header::RANGE, range);
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
                drop(guard);
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
            drop(response);
            drop(guard);
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
        if resume || status == StatusCode::PARTIAL_CONTENT && plex_fetch_lock.is_some() {
            if status != StatusCode::PARTIAL_CONTENT {
                return Err(format!("media server cannot resume this stream ({status})"));
            }
            if resume && etag.is_some() && new_etag != etag {
                return Err("media changed during download".into());
            }
            if !resume {
                etag = new_etag;
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
            if plex_fetch_lock.is_some() && end - start + 1 > PLEX_RANGE_BYTES {
                return Err("media response exceeded its requested range".into());
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
        let mut interruption = None;
        while let Some(chunk) = stream.next().await {
            let chunk = match chunk {
                Ok(chunk) => chunk,
                Err(error) => {
                    interruption = Some(if error.is_timeout() {
                        "media body read timed out".to_owned()
                    } else {
                        error.without_url().to_string()
                    });
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
                consume(fresh)?;
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
        // The body is consumed/dropped before another job can use Plex. Never
        // hold this lock during retry backoff or between successful ranges.
        drop(stream);
        drop(guard);
        if interruption.is_none() && response_length.is_none_or(|size| received == size) {
            if total.is_none_or(|size| offset == size) {
                return Ok(());
            }
            if status == StatusCode::PARTIAL_CONTENT && offset > attempt_offset {
                // A complete range is healthy progress, not an interrupted
                // transfer. Retry budgets apply to consecutive failed bodies.
                retries = 0;
                tokio::task::yield_now().await;
                continue;
            }
        }
        if retries >= MAX_RETRIES {
            let expected = total.map_or_else(|| "unknown".into(), |size| size.to_string());
            let reason = interruption
                .as_deref()
                .unwrap_or("response ended before its declared length");
            return Err(format!(
                "media transfer remained incomplete after retries ({offset}/{expected} bytes): {reason}"
            ));
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
                |chunk| {
                    received.extend_from_slice(chunk);
                    Ok(())
                },
                None,
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
            None,
        )
        .await
        .unwrap_err();
        assert!(!error.contains("hidden"));
        assert_eq!(server.await.unwrap(), MAX_RETRIES + 1);
    }

    #[tokio::test]
    async fn plex_jobs_share_the_fetch_lock_and_take_turns_between_ranges() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let source: Arc<Vec<u8>> = Arc::new((0..600_000).map(|i| (i % 251) as u8).collect());
        let body = source.clone();
        let active = Arc::new(AtomicUsize::new(0));
        let max_active = Arc::new(AtomicUsize::new(0));
        let max_seen = max_active.clone();
        let server = tokio::spawn(async move {
            let mut handlers = Vec::new();
            let mut order = Vec::new();
            // Each file takes four server-capped ranges, including overlaps.
            for _ in 0..8 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let request = read_request(&mut socket).await;
                order.push(request.lines().next().unwrap().to_string());
                let range = header(&request, "Range").unwrap();
                let (start, end) = range
                    .strip_prefix("bytes=")
                    .unwrap()
                    .split_once('-')
                    .unwrap();
                let start: usize = start.parse().unwrap();
                let end: usize = end.parse().unwrap();
                assert_eq!(end - start + 1, PLEX_RANGE_BYTES as usize);
                let end = (start + 200_000).min(body.len());
                let body = body.clone();
                let active = active.clone();
                let max_seen = max_seen.clone();
                handlers.push(tokio::spawn(async move {
                    let count = active.fetch_add(1, Ordering::SeqCst) + 1;
                    max_seen.fetch_max(count, Ordering::SeqCst);
                    // A second unguarded request would arrive during this wait.
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                    socket.write_all(format!("HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {}-{}/{}\r\nConnection: close\r\n\r\n", end-start, start, end-1, body.len()).as_bytes()).await.unwrap();
                    socket.write_all(&body[start..end-1]).await.unwrap();
                    active.fetch_sub(1, Ordering::SeqCst);
                    socket.write_all(&body[end-1..end]).await.unwrap();
                }));
            }
            for handler in handlers {
                handler.await.unwrap();
            }
            order
        });
        let client = reqwest::Client::builder()
            .http1_only()
            .pool_max_idle_per_host(0)
            .build()
            .unwrap();
        let lock = tokio::sync::Mutex::new(());
        let mut a = Vec::new();
        let mut b = Vec::new();
        let (a_result, b_result) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            tokio::join!(
                download(
                    || client.get(format!("{base}/active")),
                    |_| {},
                    |chunk| {
                        a.extend_from_slice(chunk);
                        Ok(())
                    },
                    Some(&lock)
                ),
                download(
                    || client.get(format!("{base}/preload")),
                    |_| {},
                    |chunk| {
                        b.extend_from_slice(chunk);
                        Ok(())
                    },
                    Some(&lock)
                ),
            )
        })
        .await
        .unwrap();
        a_result.unwrap();
        b_result.unwrap();
        let order = server.await.unwrap();
        assert_ne!(
            order[0], order[1],
            "preload gets a turn before the active file is complete"
        );
        assert_eq!(max_active.load(Ordering::SeqCst), 1);
        assert_eq!(&a, source.as_ref());
        assert_eq!(&b, source.as_ref());
    }

    #[tokio::test]
    async fn healthy_ranges_restore_the_retry_budget_and_failed_ranges_retain_exact_bytes() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/track", listener.local_addr().unwrap());
        let original: Vec<u8> = (0..1_200_000).map(|i| (i % 251) as u8).collect();
        let body = original.clone();
        let server = tokio::spawn(async move {
            let mut attempts = 0;
            let mut failures = 0;
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let request = read_request(&mut socket).await;
                let range = header(&request, "Range").unwrap();
                let (from, _) = range
                    .strip_prefix("bytes=")
                    .unwrap()
                    .split_once('-')
                    .unwrap();
                let from: usize = from.parse().unwrap();
                let end = (from + 200_000).min(body.len());
                let cut = attempts % 2 == 0 && end - from > 120_000;
                attempts += 1;
                socket.write_all(format!("HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {}-{}/{}\r\nETag: \"same\"\r\nConnection: close\r\n\r\n", end-from, from, end-1, body.len()).as_bytes()).await.unwrap();
                if cut {
                    failures += 1;
                    socket.write_all(&body[from..from + 120_000]).await.unwrap();
                } else {
                    socket.write_all(&body[from..end]).await.unwrap();
                }
                if !cut && end == body.len() {
                    return failures;
                }
            }
        });
        let client = reqwest::Client::new();
        let lock = tokio::sync::Mutex::new(());
        let mut received = Vec::new();
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            download(
                || client.get(&url),
                |_| {},
                |chunk| {
                    received.extend_from_slice(chunk);
                    Ok(())
                },
                Some(&lock),
            ),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(server.await.unwrap() > MAX_RETRIES);
        assert_eq!(received, original);
    }

    #[tokio::test]
    async fn a_permanently_cut_body_fails_with_progress_and_without_credentials() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "http://{}/track?X-Plex-Token=secret",
            listener.local_addr().unwrap()
        );
        let body: Vec<u8> = (0..160_000).map(|i| (i % 251) as u8).collect();
        let server = tokio::spawn(async move {
            for attempt in 0..=MAX_RETRIES {
                let (mut socket, _) = listener.accept().await.unwrap();
                let request = read_request(&mut socket).await;
                let from = if attempt == 0 {
                    0
                } else {
                    let range = header(&request, "Range").unwrap();
                    range
                        .strip_prefix("bytes=")
                        .unwrap()
                        .split_once('-')
                        .unwrap()
                        .0
                        .parse()
                        .unwrap()
                };
                socket.write_all(format!("HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {}-159999/160000\r\nConnection: close\r\n\r\n", 160_000-from, from).as_bytes()).await.unwrap();
                socket.write_all(&body[from..80_000]).await.unwrap();
            }
        });
        let client = reqwest::Client::new();
        let lock = tokio::sync::Mutex::new(());
        let error = download(|| client.get(&url), |_| {}, |_| Ok(()), Some(&lock))
            .await
            .unwrap_err();
        server.await.unwrap();
        assert!(error.contains("80000/160000 bytes"), "{error}");
        assert!(
            !error.contains("secret") && !error.contains("http://"),
            "{error}"
        );
        assert!(lock.try_lock().is_ok());
    }

    #[tokio::test]
    async fn cancelling_a_queued_fetch_does_not_send_a_request_or_hold_the_lock() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/obsolete", listener.local_addr().unwrap());
        let client = reqwest::Client::new();
        let lock = tokio::sync::Mutex::new(());
        let guard = lock.lock().await;
        let result = tokio::time::timeout(
            std::time::Duration::from_millis(20),
            download(
                || client.get(&url),
                |_| {},
                |_| panic!("obsolete fetch"),
                Some(&lock),
            ),
        )
        .await;
        assert!(result.is_err());
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), listener.accept())
                .await
                .is_err()
        );
        drop(guard);
        assert!(lock.try_lock().is_ok());
    }
}
