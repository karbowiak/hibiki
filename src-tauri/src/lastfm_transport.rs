//! One conservative budget for Last.fm reads, loves, auth and scrobbles.
use crate::http_response::{BoundedResponseExt, MAX_JSON_BYTES};
use anyhow::{bail, Context, Result};
use once_cell::sync::Lazy;
use reqwest::{header::HeaderMap, Request, RequestBuilder};
use std::time::Duration;
use tokio::{sync::Mutex, time::Instant};

const GAP: Duration = Duration::from_secs(1);
pub const COOLDOWN: &str =
    "Last.fm is rate limited. Hibiki will wait for its request limit to reset.";
static LIMITER: Lazy<Limiter> = Lazy::new(|| Limiter::new(GAP));

struct Limiter {
    next: Mutex<Instant>,
    gap: Duration,
}
fn retry_after(headers: &HeaderMap) -> Duration {
    let seconds = headers
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| {
            v.parse::<u64>().ok().or_else(|| {
                let date = chrono::DateTime::parse_from_rfc2822(v).ok()?;
                Some((date.timestamp() - chrono::Utc::now().timestamp()).max(0) as u64)
            })
        })
        .unwrap_or(60);
    Duration::from_secs(seconds)
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
    ) -> Result<Vec<u8>> {
        let mut next = self.next.lock().await;
        let wait = next.saturating_duration_since(Instant::now());
        if wait > Duration::from_secs(60)
            || (request.method() != reqwest::Method::GET && wait > Duration::from_secs(5))
        {
            // An old mutation preflight must not survive a long cooldown.
            bail!(COOLDOWN)
        }
        if !wait.is_zero() {
            tokio::time::sleep_until(*next).await;
        }
        current()?;
        *next = Instant::now() + self.gap;
        let response = client
            .execute(request)
            .await
            .map_err(|e| e.without_url())
            .context("Last.fm service unavailable")?;
        let cooldown = retry_after(response.headers()).max(self.gap);
        if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
            *next = Instant::now()
                .checked_add(cooldown)
                .unwrap_or_else(|| Instant::now() + Duration::from_secs(86400));
            bail!(COOLDOWN)
        }
        if !response.status().is_success() {
            bail!(
                "Last.fm rejected the request (HTTP {})",
                response.status().as_u16()
            )
        }
        let bytes = response
            .bounded_bytes(MAX_JSON_BYTES)
            .await
            .context("Invalid Last.fm response")?;
        // Last.fm also signals rate limiting inside an HTTP 200 response.
        let value: serde_json::Value =
            serde_json::from_slice(&bytes).context("Invalid Last.fm JSON response")?;
        if value["error"].as_u64() == Some(29) || value["error"].as_str() == Some("29") {
            *next = Instant::now()
                .checked_add(cooldown)
                .unwrap_or_else(|| Instant::now() + Duration::from_secs(86400));
            bail!(COOLDOWN)
        }
        // Requests are sent once. In particular, a lost love/scrobble reply
        // cannot cause a hidden replay here.
        Ok(bytes.to_vec())
    }
}
pub async fn send(request: RequestBuilder) -> Result<Vec<u8>> {
    send_guarded(request, || Ok(())).await
}
pub async fn send_guarded(
    request: RequestBuilder,
    current: impl Fn() -> Result<()>,
) -> Result<Vec<u8>> {
    let (client, request) = request.build_split();
    let mut request = request.context("Invalid Last.fm request")?;
    if request.url().host_str() == Some("ws.audioscrobbler.com") {
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
        // Isolated loopback fixtures use the same checks without global delays.
        Limiter::new(Duration::ZERO)
            .send(client, request, current)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    const OK: &str = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}";
    async fn server(replies: Vec<&'static str>) -> (String, tokio::task::JoinHandle<Vec<Instant>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
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
        (url, task)
    }
    async fn request(limiter: &Limiter, builder: RequestBuilder) -> Result<Vec<u8>> {
        let (client, request) = builder.build_split();
        limiter.send(client, request.unwrap(), || Ok(())).await
    }
    #[tokio::test]
    async fn concurrent_reads_and_writes_share_the_same_budget() {
        let limiter = Limiter::new(Duration::from_millis(30));
        let (url, task) = server(vec![OK, OK, OK]).await;
        let client = reqwest::Client::new();
        let (a, b, c) = tokio::join!(
            request(&limiter, client.get(&url)),
            request(&limiter, client.post(&url)),
            request(&limiter, client.get(&url))
        );
        assert!(a.is_ok() && b.is_ok() && c.is_ok());
        let arrivals = task.await.unwrap();
        assert!(arrivals
            .windows(2)
            .all(|pair| pair[1] - pair[0] >= limiter.gap));
    }
    #[tokio::test]
    async fn http_and_application_rate_limits_apply_cooldown_without_replaying() {
        for reply in [
            "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 120\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
            "HTTP/1.1 200 OK\r\nContent-Length: 12\r\nConnection: close\r\n\r\n{\"error\":29}",
        ] {
            let limiter = Limiter::new(GAP);
            let (url, task) = server(vec![reply]).await;
            assert_eq!(request(&limiter, reqwest::Client::new().post(&url)).await.unwrap_err().to_string(), COOLDOWN);
            assert_eq!(task.await.unwrap().len(), 1);
            assert!(limiter.next.lock().await.saturating_duration_since(Instant::now()) > Duration::from_secs(59));
            assert_eq!(request(&limiter, reqwest::Client::new().post(&url)).await.unwrap_err().to_string(), COOLDOWN);
        }
    }
    #[tokio::test]
    async fn owner_is_checked_after_waiting_and_transport_errors_hide_credentials() {
        let limiter = Limiter::new(Duration::from_millis(20));
        *limiter.next.lock().await = Instant::now() + limiter.gap;
        let started = Instant::now();
        let (client, req) = reqwest::Client::new()
            .post("http://127.0.0.1:1/?api_key=private")
            .build_split();
        assert_eq!(
            limiter
                .send(client, req.unwrap(), || {
                    assert!(started.elapsed() >= Duration::from_millis(20));
                    bail!("Retired account")
                })
                .await
                .unwrap_err()
                .to_string(),
            "Retired account"
        );
        let error = request(
            &limiter,
            reqwest::Client::new().get("http://127.0.0.1:1/?api_key=private"),
        )
        .await
        .unwrap_err();
        assert!(!format!("{error:#}").contains("private"));
    }
    #[test]
    fn cooldown_honors_seconds_dates_and_falls_back_without_headers() {
        let mut headers = HeaderMap::new();
        assert_eq!(retry_after(&headers), Duration::from_secs(60));
        headers.insert("retry-after", "120".parse().unwrap());
        assert_eq!(retry_after(&headers), Duration::from_secs(120));
        headers.insert(
            "retry-after",
            "Wed, 21 Oct 2015 07:28:00 GMT".parse().unwrap(),
        );
        assert_eq!(retry_after(&headers), Duration::ZERO);
    }
}
