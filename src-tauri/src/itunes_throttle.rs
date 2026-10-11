//! Shared rate limiter + retry logic for all iTunes Search API calls.
//!
//! iTunes rate-limits at ~20 req/min per IP. This module enforces a minimum
//! 3s gap between requests (~20/min, matching their limit) and retries on
//! transient errors (429/503) with exponential backoff.
//!
//! 403 triggers a 60-second cooldown — all requests during the cooldown are
//! immediately rejected.

use anyhow::{bail, Context, Result};
use once_cell::sync::Lazy;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Shared HTTP client for all iTunes API calls.
static CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .expect("Failed to build iTunes throttle HTTP client")
});

/// Minimum gap between consecutive iTunes requests.
static LAST_REQUEST: Lazy<Mutex<Instant>> =
    Lazy::new(|| Mutex::new(Instant::now() - Duration::from_secs(5)));

/// Cooldown state after a 403 — (cooldown_start, cooldown_duration).
static COOLDOWN: Lazy<Mutex<Option<(Instant, Duration)>>> =
    Lazy::new(|| Mutex::new(None));

/// Log dedup state — (last_log_time, suppressed_count).
static LOG_DEDUP: Lazy<Mutex<(Instant, u32)>> =
    Lazy::new(|| Mutex::new((Instant::now() - Duration::from_secs(60), 0)));

const MIN_GAP: Duration = Duration::from_millis(3000);
const MAX_RETRIES: u32 = 3;
const BASE_BACKOFF: Duration = Duration::from_secs(5);
const COOLDOWN_DURATION: Duration = Duration::from_secs(60);
const LOG_DEDUP_WINDOW: Duration = Duration::from_secs(30);

/// Wait until at least `MIN_GAP` has elapsed since the last request, then
/// update the timestamp.
async fn throttle() {
    let wait = {
        let mut last = LAST_REQUEST.lock().unwrap();
        let elapsed = last.elapsed();
        let wait = if elapsed < MIN_GAP {
            MIN_GAP - elapsed
        } else {
            Duration::ZERO
        };
        *last = Instant::now() + wait;
        wait
    };
    if !wait.is_zero() {
        tokio::time::sleep(wait).await;
    }
}

/// Check if we're in a 403 cooldown period.
fn in_cooldown() -> bool {
    let guard = COOLDOWN.lock().unwrap();
    if let Some((start, duration)) = *guard {
        start.elapsed() < duration
    } else {
        false
    }
}

/// Enter cooldown after a 403.
fn enter_cooldown() {
    let mut guard = COOLDOWN.lock().unwrap();
    *guard = Some((Instant::now(), COOLDOWN_DURATION));
}

/// Log a throttle warning with deduplication. First warning in each 30s window
/// is emitted immediately; subsequent ones are suppressed and counted.
fn log_throttle_warning(status: reqwest::StatusCode, attempt: u32, backoff: Duration) {
    let mut dedup = LOG_DEDUP.lock().unwrap();
    let (last_log, suppressed) = &mut *dedup;

    if last_log.elapsed() >= LOG_DEDUP_WINDOW {
        let suppressed_msg = if *suppressed > 0 {
            format!(" ({} similar warnings suppressed)", *suppressed)
        } else {
            String::new()
        };
        tracing::warn!(
            "iTunes {} (attempt {}/{}), backing off {:?}{}",
            status,
            attempt,
            MAX_RETRIES,
            backoff,
            suppressed_msg,
        );
        *last_log = Instant::now();
        *suppressed = 0;
    } else {
        *suppressed += 1;
    }
}

/// Single entry point for all iTunes Search API GET requests.
///
/// Applies throttling (3s gap) and retries on 429/503 with exponential
/// backoff. 403 triggers a 60-second cooldown.
pub async fn itunes_get(
    url: &str,
    query: &[(&str, &str)],
) -> Result<reqwest::Response> {
    if in_cooldown() {
        bail!("iTunes 403 cooldown active — refusing request");
    }

    let mut attempt = 0u32;

    loop {
        throttle().await;

        let resp = CLIENT
            .get(url)
            .query(query)
            .send()
            .await.map_err(|error| error.without_url())
            .context("iTunes request failed")?;

        let status = resp.status();

        if status.is_success() {
            return Ok(resp);
        }

        // 403 = persistent ban, enter cooldown
        if status == reqwest::StatusCode::FORBIDDEN {
            enter_cooldown();
            tracing::warn!("iTunes returned 403 Forbidden — entering {}s cooldown", COOLDOWN_DURATION.as_secs());
            bail!("iTunes returned 403 Forbidden — rate limit ban, entering cooldown");
        }

        // 429 or 503 = transient, retry with backoff
        if (status == reqwest::StatusCode::TOO_MANY_REQUESTS
            || status == reqwest::StatusCode::SERVICE_UNAVAILABLE)
            && attempt < MAX_RETRIES
        {
            attempt += 1;

            // Respect Retry-After header if present (seconds)
            let retry_after = resp
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok())
                .map(Duration::from_secs);

            let backoff = retry_after
                .unwrap_or(BASE_BACKOFF * 2u32.pow(attempt - 1));

            log_throttle_warning(status, attempt, backoff);

            tokio::time::sleep(backoff).await;
            continue;
        }

        // Other error status — propagate immediately
        bail!(
            "iTunes returned {} {}",
            status.as_u16(),
            status.canonical_reason().unwrap_or("Unknown")
        );
    }
}
