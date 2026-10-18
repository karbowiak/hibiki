//! One process-wide budget for authenticated API calls and extractor admission.
//! Learn a useful pace from normal traffic; never send probe-only requests.
use reqwest::header::{HeaderMap, RETRY_AFTER};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;
use tokio::sync::{Semaphore, SemaphorePermit};
use tokio::time::Instant;

const GAP: Duration = Duration::from_millis(200);
const MIN_GAP_MS: u64 = 50;
const MAX_GAP_MS: u64 = 10000;
const HEALTHY_WINDOW: Duration = Duration::from_secs(30);
const MAX_WAIT: Duration = Duration::from_secs(8);
pub(super) const COOLDOWN: &str =
    "YouTube Music is rate limited. Hibiki will retry after the cooldown.";
const BUSY: &str = "YouTube Music request queue is busy. Try again shortly.";
pub(super) static REQUESTS: LazyLock<Limiter> = LazyLock::new(Limiter::new);

struct Budget {
    next: Instant,
    blocked_until: Instant,
    strikes: u32,
    successes: u32,
    gap_ms: u64,
    last_growth: Instant,
    last_saved: Instant,
    path: Option<PathBuf>,
}
#[derive(Serialize, Deserialize)]
struct Saved {
    version: u8,
    gap_ms: u64,
    strikes: u32,
    cooldown_until_ms: i64,
    saved_at_ms: i64,
}
pub(super) struct Limiter {
    budget: Mutex<Budget>,
    active: Semaphore,
    queued: Semaphore,
}
impl Limiter {
    fn new() -> Self {
        Self {
            budget: Mutex::new(Budget {
                next: Instant::now(),
                blocked_until: Instant::now(),
                strikes: 0,
                successes: 0,
                gap_ms: GAP.as_millis() as u64,
                last_growth: Instant::now(),
                last_saved: Instant::now(),
                path: None,
            }),
            active: Semaphore::new(2),
            queued: Semaphore::new(24),
        }
    }
    pub(super) fn restore(&self, path: PathBuf) {
        let mut budget = self.budget.lock().unwrap_or_else(|error| error.into_inner());
        if budget.path.is_some() { return; }
        let saved = std::fs::metadata(&path).ok().filter(|metadata| metadata.len() <= 1024)
            .and_then(|_| std::fs::read(&path).ok()).and_then(|bytes| serde_json::from_slice::<Saved>(&bytes).ok());
        if let Some(saved) = saved.filter(|saved| saved.version == 1) {
            let wall = chrono::Utc::now().timestamp_millis();
            // Discard a very old learned pace, but retain any active server cooldown.
            if (0..=30 * 86400000_i64).contains(&wall.saturating_sub(saved.saved_at_ms)) {
                budget.gap_ms = saved.gap_ms.clamp(MIN_GAP_MS, MAX_GAP_MS);
                budget.strikes = saved.strikes.min(10);
            }
            let remaining = Duration::from_millis(saved.cooldown_until_ms.saturating_sub(wall).max(0) as u64);
            budget.blocked_until = Instant::now().checked_add(remaining).unwrap_or(Instant::now());
        }
        budget.path = Some(path);
    }
    pub(super) fn interval_seconds(&self) -> String {
        let budget = self.budget.lock().unwrap_or_else(|error| error.into_inner());
        format!("{:.3}", budget.gap_ms as f64 / 1000.0)
    }
    fn persist(budget: &mut Budget) {
        let Some(path) = &budget.path else { return; };
        let wall = chrono::Utc::now().timestamp_millis();
        let remaining = budget.blocked_until.saturating_duration_since(Instant::now()).as_millis().min(i64::MAX as u128) as i64;
        let saved = Saved { version: 1, gap_ms: budget.gap_ms, strikes: budget.strikes,
            cooldown_until_ms: wall.saturating_add(remaining), saved_at_ms: wall };
        // Small, infrequent, serialized atomic snapshots contain timing only.
        // A crash or truncated file safely falls back to the initial pace.
        if let (Some(parent), Ok(bytes)) = (path.parent(), serde_json::to_vec(&saved)) {
            let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
            let _ = std::fs::create_dir_all(parent).and_then(|_| std::fs::write(&temporary, bytes))
                .and_then(|_| std::fs::rename(&temporary, path));
        }
        budget.last_saved = Instant::now();
    }
    /// Do not reserve future slots: cancellation consumes no future budget.
    /// Recheck cooldown and account ownership after every asynchronous wait.
    pub(super) async fn admit(
        &self,
        current: impl Fn() -> bool,
    ) -> Result<SemaphorePermit<'_>, &'static str> {
        let _queued = self.queued.try_acquire().map_err(|_| BUSY)?;
        tokio::time::timeout(MAX_WAIT, async {
            let permit = self.active.acquire().await.map_err(|_| BUSY)?;
            loop {
                if !current() {
                    return Err("YouTube Music session changed.");
                }
                let wait = {
                    let mut budget = self
                        .budget
                        .lock()
                        .unwrap_or_else(|error| error.into_inner());
                    let now = Instant::now();
                    if budget.blocked_until > now {
                        return Err(COOLDOWN);
                    }
                    if budget.next > now {
                        Some(budget.next)
                    } else {
                        budget.next = now + Duration::from_millis(budget.gap_ms);
                        None
                    }
                };
                if let Some(deadline) = wait {
                    tokio::time::sleep_until(deadline).await;
                } else {
                    return Ok(permit);
                }
            }
        })
        .await
        .map_err(|_| BUSY)?
    }
    pub(super) fn throttle(&self, retry: Option<Duration>) {
        let mut budget = self
            .budget
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let now = Instant::now();
        let already_blocked = budget.blocked_until > now;
        let fallback = Duration::from_secs(30 * (1_u64 << budget.strikes.min(5)))
            .min(Duration::from_secs(900));
        let delay = if already_blocked { retry.unwrap_or_default() } else { fallback.max(retry.unwrap_or_default()) };
        let until = now
            .checked_add(delay)
            .unwrap_or(now + Duration::from_secs(86400));
        budget.blocked_until = budget.blocked_until.max(until);
        // Several in-flight responses can belong to the same throttle episode.
        if !already_blocked {
            budget.strikes = budget.strikes.saturating_add(1);
            budget.gap_ms = (budget.gap_ms * 2).min(MAX_GAP_MS);
        }
        budget.successes = 0;
        budget.last_growth = now;
        Self::persist(&mut budget);
        // Static timing only: never log credentials, account IDs or request URLs.
        tracing::warn!(
            cooldown_seconds = budget.blocked_until.saturating_duration_since(now).as_secs(),
            interval_ms = budget.gap_ms,
            "YouTube Music requests paused after throttling"
        );
    }
    pub(super) fn success(&self) {
        let mut budget = self
            .budget
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if budget.blocked_until > Instant::now() { return; }
        budget.successes = budget.successes.saturating_add(1);
        // Add speed slowly after sustained healthy traffic; halve it on 429.
        if budget.successes >= 50 && budget.last_growth.elapsed() >= HEALTHY_WINDOW {
            budget.gap_ms = (budget.gap_ms * 9 / 10).max(MIN_GAP_MS);
            budget.strikes = budget.strikes.saturating_sub(1);
            budget.successes = 0;
            budget.last_growth = Instant::now();
            Self::persist(&mut budget);
        } else if budget.last_saved.elapsed() >= HEALTHY_WINDOW {
            Self::persist(&mut budget);
        }
    }
}

pub(super) fn retry_after(headers: &HeaderMap) -> Option<Duration> {
    let value = headers.get(RETRY_AFTER)?.to_str().ok()?.trim();
    let seconds = value.parse().ok().or_else(|| {
        let date = chrono::DateTime::parse_from_rfc2822(value).ok()?;
        let reference = headers
            .get(reqwest::header::DATE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| chrono::DateTime::parse_from_rfc2822(value).ok())
            .map(|date| date.timestamp())
            .unwrap_or_else(super::now);
        Some(date.timestamp().saturating_sub(reference).max(0) as u64)
    })?;
    Some(Duration::from_secs(seconds))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };

    #[tokio::test(start_paused = true)]
    async fn concurrent_callers_are_spaced_and_cancelled_waits_reserve_nothing() {
        let limiter = Limiter::new();
        drop(limiter.admit(|| true).await.unwrap());
        {
            let wait = limiter.admit(|| true);
            tokio::pin!(wait);
            assert!(tokio::time::timeout(Duration::from_millis(100), &mut wait)
                .await
                .is_err());
        }
        let start = Instant::now();
        let (a, b) = tokio::join!(
            async {
                let _permit = limiter.admit(|| true).await.unwrap();
                Instant::now()
            },
            async {
                let _permit = limiter.admit(|| true).await.unwrap();
                Instant::now()
            }
        );
        // join! may poll either contender first. The limiter guarantees
        // spacing, not the identity of the caller admitted first.
        let (first,second) = if a <= b { (a,b) } else { (b,a) };
        assert!(first >= start + GAP - Duration::from_millis(100));
        assert!(second >= first + GAP);
    }
    #[tokio::test(start_paused = true)]
    async fn a_new_cooldown_retires_waiting_admission_and_grows_on_repeated_limits() {
        let limiter = Arc::new(Limiter::new());
        drop(limiter.admit(|| true).await.unwrap());
        let other = limiter.clone();
        let pending = tokio::spawn(async move { other.admit(|| true).await.map(drop) });
        tokio::task::yield_now().await;
        limiter.throttle(Some(Duration::from_secs(120)));
        tokio::time::advance(GAP).await;
        assert_eq!(pending.await.unwrap().unwrap_err(), COOLDOWN);
        assert_eq!(limiter.admit(|| true).await.unwrap_err(), COOLDOWN);
        tokio::time::advance(Duration::from_secs(120)).await;
        limiter.throttle(None);
        let budget = limiter.budget.lock().unwrap();
        assert_eq!(budget.strikes, 2);
        assert_eq!(
            budget.blocked_until - Instant::now(),
            Duration::from_secs(60)
        );
    }
    #[tokio::test(start_paused = true)]
    async fn an_account_retired_while_queued_cannot_send() {
        let limiter = Arc::new(Limiter::new());
        drop(limiter.admit(|| true).await.unwrap());
        let current = Arc::new(AtomicBool::new(true));
        let owner = current.clone();
        let pending = tokio::spawn(async move {
            limiter
                .admit(|| owner.load(Ordering::SeqCst))
                .await
                .map(drop)
        });
        tokio::task::yield_now().await;
        current.store(false, Ordering::SeqCst);
        tokio::time::advance(GAP).await;
        assert_eq!(
            pending.await.unwrap().unwrap_err(),
            "YouTube Music session changed."
        );
    }
    #[test]
    fn retry_after_accepts_seconds_and_dates_without_shortening_server_delays() {
        let mut headers = HeaderMap::new();
        headers.insert(RETRY_AFTER, "172800".parse().unwrap());
        assert_eq!(retry_after(&headers), Some(Duration::from_secs(172800)));
        headers.insert(
            reqwest::header::DATE,
            "Sun, 18 Oct 2026 12:00:00 GMT".parse().unwrap(),
        );
        headers.insert(
            RETRY_AFTER,
            "Sun, 18 Oct 2026 12:02:00 GMT".parse().unwrap(),
        );
        assert_eq!(retry_after(&headers), Some(Duration::from_secs(120)));
        headers.insert(RETRY_AFTER, "invalid".parse().unwrap());
        assert_eq!(retry_after(&headers), None);
    }
    #[tokio::test(start_paused = true)]
    async fn healthy_traffic_recovers_gradually_and_duplicate_429s_back_off_once() {
        let limiter = Limiter::new();
        limiter.throttle(None);
        limiter.throttle(None);
        assert_eq!(limiter.budget.lock().unwrap().gap_ms, 400);
        assert_eq!(limiter.budget.lock().unwrap().strikes, 1);
        tokio::time::advance(Duration::from_secs(30)).await;
        for _ in 0..50 { limiter.success(); }
        assert_eq!(limiter.budget.lock().unwrap().gap_ms, 360);
        for _ in 0..100 { limiter.success(); }
        assert_eq!(limiter.budget.lock().unwrap().gap_ms, 360);
        tokio::time::advance(HEALTHY_WINDOW).await;
        limiter.success();
        assert_eq!(limiter.budget.lock().unwrap().gap_ms, 324);
    }
    #[test]
    fn a_restart_restores_pace_and_does_not_clear_server_cooldown() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("pace.json");
        let limiter = Limiter::new();
        limiter.restore(path.clone());
        limiter.throttle(Some(Duration::from_secs(120)));
        let restarted = Limiter::new();
        restarted.restore(path.clone());
        let budget = restarted.budget.lock().unwrap();
        assert_eq!(budget.gap_ms, 400);
        assert_eq!(budget.strikes, 1);
        assert!(budget.blocked_until.saturating_duration_since(Instant::now()) > Duration::from_secs(118));
        drop(budget);
        std::fs::write(&path, "incomplete").unwrap();
        let corrupt = Limiter::new();
        corrupt.restore(path);
        assert_eq!(corrupt.budget.lock().unwrap().gap_ms, 200);
    }
}
