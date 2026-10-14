//! One shared ListenBrainz budget for favorites, playlists and listen submissions.
use anyhow::{bail, Context, Result};
use once_cell::sync::Lazy;
use reqwest::{header::HeaderMap, Method, Request, RequestBuilder, Response};
use std::time::Duration;
use tokio::{sync::Mutex, time::Instant};

const GAP: Duration = Duration::from_secs(1);
const MAX_WAIT: Duration = Duration::from_secs(60);
pub const COOLDOWN: &str =
    "ListenBrainz is rate limited. Hibiki will wait for its request limit to reset.";
static LIMITER: Lazy<Limiter> = Lazy::new(|| Limiter::new(GAP));

struct Limiter {
    next: Mutex<Instant>,
    gap: Duration,
}
fn seconds(headers: &HeaderMap, name: &str) -> Option<u64> {
    headers.get(name)?.to_str().ok()?.parse().ok()
}
fn retry_after(headers: &HeaderMap) -> Option<u64> {
    let value = headers.get("retry-after")?.to_str().ok()?;
    value.parse().ok().or_else(|| {
        let date = chrono::DateTime::parse_from_rfc2822(value).ok()?;
        Some((date.timestamp() - chrono::Utc::now().timestamp()).max(0) as u64)
    })
}
fn delay(headers: &HeaderMap, limited: bool, gap: Duration) -> Duration {
    let remaining = seconds(headers, "x-ratelimit-remaining");
    let reset = seconds(headers, "x-ratelimit-reset-in");
    let seconds = if limited {
        retry_after(headers)
            .into_iter()
            .chain(reset)
            .max()
            .unwrap_or(60)
    } else if remaining == Some(0) {
        reset.unwrap_or(60)
    } else if let (Some(remaining), Some(reset)) = (remaining, reset) {
        // Spread the remaining budget over the rest of the window.
        reset.div_ceil(remaining.max(1))
    } else {
        0
    };
    gap.max(Duration::from_secs(seconds.min(86400)))
}
fn is_read(request: &Request) -> bool {
    request.method() == Method::GET
        || (request.method() == Method::POST
            && request
                .url()
                .path()
                .ends_with("/get-feedback-for-recordings"))
}
impl Limiter {
    fn new(gap: Duration) -> Self {
        Self {
            next: Mutex::new(Instant::now()),
            gap,
        }
    }
    async fn send(
        &self,
        client: reqwest::Client,
        request: Request,
        current: impl Fn() -> Result<()>,
    ) -> Result<Response> {
        let mut next = self.next.lock().await;
        let read = is_read(&request);
        for attempt in 0..3 {
            let wait = next.saturating_duration_since(Instant::now());
            if wait > MAX_WAIT || (!read && wait > Duration::from_secs(5)) {
                // A mutation must obtain a new preflight rather than carrying
                // an old membership proof through a long service cooldown.
                bail!(COOLDOWN)
            }
            if !wait.is_zero() {
                tokio::time::sleep_until(*next).await
            }
            // Waiting for a rate slot must not admit a retired account's write.
            current()?;
            *next = Instant::now() + self.gap;
            let copy = request
                .try_clone()
                .context("ListenBrainz request cannot be retained")?;
            let response = client
                .execute(copy)
                .await
                .map_err(|error| error.without_url())
                .context("ListenBrainz service unavailable")?;
            let limited = response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS;
            *next = (*next).max(Instant::now() + delay(response.headers(), limited, self.gap));
            if !limited || !read || attempt == 2 {
                return Ok(response);
            }
            // Only explicit rate rejection of a read is replayable. No timeout,
            // failed mutation, create, listen submission or other POST is retried.
        }
        unreachable!()
    }
}
pub async fn send(request: RequestBuilder) -> Result<Response> {
    send_guarded(request, || Ok(())).await
}
pub async fn send_guarded(
    request: RequestBuilder,
    current: impl Fn() -> Result<()>,
) -> Result<Response> {
    let (client, request) = request.build_split();
    let mut request = request.context("Invalid ListenBrainz request")?;
    if request.url().host_str() == Some("api.listenbrainz.org") {
        request.headers_mut().insert(
            reqwest::header::USER_AGENT,
            reqwest::header::HeaderValue::from_static(concat!(
                "Hibiki/",
                env!("CARGO_PKG_VERSION"),
                " (https://github.com/karbowiak/hibiki)"
            )),
        );
        LIMITER.send(client, request, current).await
    } else {
        // Other services and synthetic loopback servers retain their own pacing.
        current()?;
        client
            .execute(request)
            .await
            .map_err(|error| error.without_url())
            .context("Service unavailable")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    async fn server(replies: Vec<&'static str>) -> (String, tokio::task::JoinHandle<Vec<Instant>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/get-feedback", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let mut arrivals = Vec::new();
            for reply in replies {
                let (mut socket, _) = listener.accept().await.unwrap();
                arrivals.push(Instant::now());
                let mut buffer = [0; 4096];
                socket.read(&mut buffer).await.unwrap();
                socket.write_all(reply.as_bytes()).await.unwrap();
            }
            arrivals
        });
        (url, server)
    }
    const OK: &str = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}";
    const RATE: &str = "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 1\r\nX-RateLimit-Reset-In: 1\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}";
    async fn request(limiter: &Limiter, builder: RequestBuilder) -> Response {
        let (client, request) = builder.build_split();
        limiter
            .send(client, request.unwrap(), || Ok(()))
            .await
            .unwrap()
    }
    #[tokio::test]
    async fn read_429_waits_for_reset_and_retries_but_mutations_are_sent_once() {
        let limiter = Limiter::new(GAP);
        let (url, server) = server(vec![RATE, OK]).await;
        assert!(request(&limiter, reqwest::Client::new().get(&url))
            .await
            .status()
            .is_success());
        let arrivals = server.await.unwrap();
        assert!(arrivals[1] - arrivals[0] >= GAP);
        let (url, server) = self::server(vec![RATE]).await;
        let limiter = Limiter::new(GAP);
        assert_eq!(
            request(&limiter, reqwest::Client::new().post(&url))
                .await
                .status()
                .as_u16(),
            429
        );
        assert_eq!(server.await.unwrap().len(), 1);
    }
    #[tokio::test]
    async fn all_readers_share_one_slot_and_exhausted_success_waits_for_reset() {
        let (url, server) = server(vec!["HTTP/1.1 200 OK\r\nX-RateLimit-Remaining: 0\r\nX-RateLimit-Reset-In: 1\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}", OK]).await;
        let limiter = Limiter::new(GAP);
        let client = reqwest::Client::new();
        let _ = tokio::join!(
            request(&limiter, client.get(&url)),
            request(&limiter, client.get(&url))
        );
        let arrivals = server.await.unwrap();
        assert!(arrivals[1] - arrivals[0] >= GAP);
    }
    #[tokio::test]
    async fn retired_owners_and_long_cooldowns_send_nothing() {
        let limiter = Limiter::new(GAP);
        *limiter.next.lock().await = Instant::now() + Duration::from_millis(20);
        let checks = std::sync::atomic::AtomicUsize::new(0);
        let (client, request) = reqwest::Client::new()
            .post("http://127.0.0.1:1/private")
            .build_split();
        let error = limiter
            .send(client, request.unwrap(), || {
                checks.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                bail!("Retired account")
            })
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "Retired account");
        assert_eq!(checks.load(std::sync::atomic::Ordering::SeqCst), 1);
        *limiter.next.lock().await = Instant::now() + Duration::from_secs(120);
        let (client, request) = reqwest::Client::new()
            .get("http://127.0.0.1:1/private")
            .build_split();
        assert_eq!(
            limiter
                .send(client, request.unwrap(), || Ok(()))
                .await
                .unwrap_err()
                .to_string(),
            COOLDOWN
        );
        *limiter.next.lock().await = Instant::now() + Duration::from_secs(6);
        let (client, request) = reqwest::Client::new()
            .post("http://127.0.0.1:1/private")
            .build_split();
        assert_eq!(
            limiter
                .send(client, request.unwrap(), || Ok(()))
                .await
                .unwrap_err()
                .to_string(),
            COOLDOWN
        );
    }
    #[test]
    fn quota_headers_set_pacing_and_only_feedback_lookup_post_is_a_read() {
        let mut headers = HeaderMap::new();
        headers.insert("x-ratelimit-remaining", "3".parse().unwrap());
        headers.insert("x-ratelimit-reset-in", "10".parse().unwrap());
        assert_eq!(delay(&headers, false, GAP), Duration::from_secs(4));
        headers.insert("retry-after", "20".parse().unwrap());
        assert_eq!(delay(&headers, true, GAP), Duration::from_secs(20));
        headers.insert(
            "retry-after",
            "Wed, 21 Oct 2015 07:28:00 GMT".parse().unwrap(),
        );
        assert_eq!(retry_after(&headers), Some(0));
        let client = reqwest::Client::new();
        assert!(is_read(&client.post("https://api.listenbrainz.org/1/feedback/user/listener/get-feedback-for-recordings").build().unwrap()));
        assert!(!is_read(
            &client
                .post("https://api.listenbrainz.org/1/feedback/recording-feedback")
                .build()
                .unwrap()
        ));
        assert!(!is_read(
            &client
                .post("https://api.listenbrainz.org/1/playlist/create")
                .build()
                .unwrap()
        ));
    }
}
