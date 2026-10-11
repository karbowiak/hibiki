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

/// One reservation/dispatch clock shared by every endpoint and retry.
static LIMITER: Lazy<RateLimiter> = Lazy::new(RateLimiter::new);

struct Schedule {
    next_slot: tokio::time::Instant,
    last_dispatch: Option<tokio::time::Instant>,
    cooldown_until: Option<tokio::time::Instant>,
}
struct RateLimiter {
    schedule: Mutex<Schedule>,
}
impl RateLimiter {
    fn new() -> Self {
        Self {
            schedule: Mutex::new(Schedule {
                next_slot: tokio::time::Instant::now(),
                last_dispatch: None,
                cooldown_until: None,
            }),
        }
    }
    fn check_cooldown(schedule: &Schedule, now: tokio::time::Instant) -> Result<()> {
        if schedule.cooldown_until.is_some_and(|until| now < until) {
            bail!("iTunes 403 cooldown active — refusing request");
        }
        Ok(())
    }
    async fn wait(&self) -> Result<()> {
        let slot = {
            let mut schedule = self.schedule.lock().unwrap();
            let now = tokio::time::Instant::now();
            Self::check_cooldown(&schedule, now)?;
            let slot = schedule.next_slot.max(now);
            schedule.next_slot = slot + MIN_GAP;
            slot
        };
        tokio::time::sleep_until(slot).await;
        loop {
            let wait_until = {
                let mut schedule = self.schedule.lock().unwrap();
                let now = tokio::time::Instant::now();
                Self::check_cooldown(&schedule, now)?;
                match schedule.last_dispatch.map(|last| last + MIN_GAP) {
                    Some(until) if now < until => Some(until),
                    _ => {
                        schedule.last_dispatch = Some(now);
                        None
                    }
                }
            };
            // No mutex survives a sleep. Cancellation leaves an unused slot;
            // queued callers remain separated, including after runtime stalls.
            match wait_until {
                Some(until) => tokio::time::sleep_until(until).await,
                None => return Ok(()),
            }
        }
    }
    fn enter_cooldown(&self) {
        let mut schedule = self.schedule.lock().unwrap();
        let until = tokio::time::Instant::now() + COOLDOWN_DURATION;
        schedule.cooldown_until = Some(until);
        schedule.next_slot = schedule.next_slot.max(until);
    }
}

/// Log dedup state — (last_log_time, suppressed_count).
static LOG_DEDUP: Lazy<Mutex<(Instant, u32)>> =
    Lazy::new(|| Mutex::new((Instant::now() - Duration::from_secs(60), 0)));

const MIN_GAP: Duration = Duration::from_millis(3000);
const MAX_RETRIES: u32 = 3;
const BASE_BACKOFF: Duration = Duration::from_secs(5);
const COOLDOWN_DURATION: Duration = Duration::from_secs(60);
const LOG_DEDUP_WINDOW: Duration = Duration::from_secs(30);

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
pub async fn itunes_get(url: &str, query: &[(&str, &str)]) -> Result<reqwest::Response> {
    let mut attempt = 0u32;

    loop {
        LIMITER.wait().await?;

        let resp = CLIENT
            .get(url)
            .query(query)
            .send()
            .await
            .map_err(|error| error.without_url())
            .context("iTunes request failed")?;

        let status = resp.status();

        if status.is_success() {
            return Ok(resp);
        }

        // 403 = persistent ban, enter cooldown
        if status == reqwest::StatusCode::FORBIDDEN {
            LIMITER.enter_cooldown();
            tracing::warn!(
                "iTunes returned 403 Forbidden — entering {}s cooldown",
                COOLDOWN_DURATION.as_secs()
            );
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

            let backoff = retry_after.unwrap_or(BASE_BACKOFF * 2u32.pow(attempt - 1));

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    async fn yield_tasks() {
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn concurrent_endpoints_and_retries_reserve_distinct_shared_slots() {
        let limiter = Arc::new(RateLimiter::new());
        let start = tokio::time::Instant::now();
        let (send, mut receive) = tokio::sync::mpsc::unbounded_channel();
        let mut tasks = Vec::new();
        for endpoint in 0..4 {
            let limiter = limiter.clone();
            let send = send.clone();
            tasks.push(tokio::spawn(async move {
                limiter.wait().await.unwrap();
                send.send((endpoint, tokio::time::Instant::now())).unwrap();
            }));
            yield_tasks().await;
        }
        assert_eq!(receive.try_recv().unwrap(), (0, start));
        assert!(receive.try_recv().is_err());
        for endpoint in 1..4 {
            tokio::time::advance(MIN_GAP).await;
            yield_tasks().await;
            assert_eq!(
                receive.try_recv().unwrap(),
                (endpoint, start + MIN_GAP * endpoint)
            );
            assert!(receive.try_recv().is_err());
        }
        for task in tasks {
            task.await.unwrap();
        }
        // A retry shares the same queue; backoff never bypasses admission.
        let retry = tokio::spawn(async move {
            limiter.wait().await.unwrap();
            tokio::time::Instant::now()
        });
        yield_tasks().await;
        assert!(!retry.is_finished());
        tokio::time::advance(MIN_GAP).await;
        assert_eq!(retry.await.unwrap(), start + MIN_GAP * 4);
    }

    #[tokio::test(start_paused = true)]
    async fn delayed_wakeups_cannot_burst_and_cancellation_releases_no_mutex() {
        let limiter = Arc::new(RateLimiter::new());
        limiter.wait().await.unwrap();
        let cancelled = {
            let limiter = limiter.clone();
            tokio::spawn(async move { limiter.wait().await })
        };
        yield_tasks().await;
        cancelled.abort();
        let mut tasks = Vec::new();
        for _ in 0..3 {
            let limiter = limiter.clone();
            tasks.push(tokio::spawn(async move {
                limiter.wait().await.unwrap();
                tokio::time::Instant::now()
            }));
            yield_tasks().await;
        }
        // All reservation deadlines expire together during an executor stall.
        tokio::time::advance(Duration::from_secs(30)).await;
        let mut times = Vec::new();
        for task in tasks {
            times.push(task.await.unwrap());
        }
        times.sort();
        assert!(times.windows(2).all(|pair| pair[1] - pair[0] >= MIN_GAP));
    }

    #[tokio::test(start_paused = true)]
    async fn cooldown_rejects_already_waiting_calls_and_retries_then_recovers() {
        let limiter = Arc::new(RateLimiter::new());
        limiter.wait().await.unwrap();
        let queued = {
            let limiter = limiter.clone();
            tokio::spawn(async move { limiter.wait().await })
        };
        yield_tasks().await;
        limiter.enter_cooldown();
        assert!(limiter.wait().await.is_err());
        tokio::time::advance(MIN_GAP).await;
        assert!(queued.await.unwrap().is_err());
        tokio::time::advance(COOLDOWN_DURATION - MIN_GAP).await;
        limiter.wait().await.unwrap();
    }
}
