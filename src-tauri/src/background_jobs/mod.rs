//! App-owned background execution. Butler owns claims, recovery and retries;
//! Hibiki owns account fences, deduplication and domain-specific write receipts.
pub(crate) mod client;
mod progress;
mod tasks;
pub(crate) use progress::report;
pub(crate) use tasks::{Browse, Task};

use butler::{monitor::ListFilter, JobState, Queue, QueuePriority, SqliteQueue, Worker};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    path::Path,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, SystemTime},
};
use tauri::Manager;
use tokio::sync::{watch, Notify, Semaphore};

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
const MAX_PENDING: u64 = 1000;
const SCHEDULE_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS hibiki_job_schedules (
    id TEXT PRIMARY KEY, task TEXT NOT NULL, every_ms INTEGER NOT NULL CHECK(every_ms >= 1000), next_run INTEGER NOT NULL
);";

#[derive(Clone, Copy, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Lane {
    Matching,
    Sync,
    Download,
    Refresh,
    Metadata,
    Reporting,
    Analysis,
    Coordination,
    PlaylistSync,
    LinkedSync,
    Favorites,
    Ratings,
    Prefetch,
    Hydration,
}
impl Lane {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Matching => "matching",
            Self::Sync => "sync",
            Self::Download => "download",
            Self::Refresh => "refresh",
            Self::Metadata => "metadata",
            Self::Reporting => "reporting",
            Self::Analysis => "analysis",
            Self::Coordination => "coordination",
            Self::PlaylistSync => "playlist-sync",
            Self::LinkedSync => "linked-sync",
            Self::Favorites => "favorites",
            Self::Ratings => "ratings",
            Self::Prefetch => "prefetch",
            Self::Hydration => "hydration",
        }
    }
    fn limit(self) -> usize {
        if matches!(
            self,
            Self::Reporting
                | Self::Analysis
                | Self::Coordination
                | Self::PlaylistSync
                | Self::LinkedSync
                | Self::Favorites
                | Self::Ratings
                | Self::Prefetch
                | Self::Hydration
        ) {
            1
        } else {
            2
        }
    }
}
const LANES: [Lane; 14] = [
    Lane::Matching,
    Lane::Sync,
    Lane::Download,
    Lane::Refresh,
    Lane::Metadata,
    Lane::Reporting,
    Lane::Analysis,
    Lane::Coordination,
    Lane::PlaylistSync,
    Lane::LinkedSync,
    Lane::Favorites,
    Lane::Ratings,
    Lane::Prefetch,
    Lane::Hydration,
];

pub(crate) struct BackgroundJobs {
    queue: Queue,
    runtime: tokio::runtime::Handle,
    stop: watch::Sender<bool>,
    admission: Mutex<HashMap<String, String>>,
    schedules: Mutex<rusqlite::Connection>,
    changed: Notify,
    progress: Mutex<HashMap<String, progress::Progress>>,
    advisory: Mutex<HashMap<String, std::pin::Pin<Box<dyn Future<Output = ()> + Send>>>>,
    advisory_keys: Mutex<HashSet<String>>,
    terminal_seen: Mutex<HashMap<String, std::time::Instant>>,
    // Non-replayable operations use the same runtime, but their durable receipt
    // stays with the domain journal. They must never enter an at-least-once queue.
    mutations: Arc<Semaphore>,
}

fn queue_error(_: impl std::fmt::Display) -> String {
    "Background queue is unavailable. Try again.".into()
}

impl BackgroundJobs {
    fn enqueue(&self, task: Task, unique: bool, delay: Duration) -> Result<String, String> {
        let key = unique.then(|| task.key()).transpose()?;
        let mut admission = self.admission.lock().map_err(queue_error)?;
        if let Some(key) = &key {
            if let Some(id) = admission.get(key) {
                if self
                    .queue
                    .get(id)
                    .map_err(queue_error)?
                    .is_some_and(|job| !job.state().is_finished())
                {
                    return Ok(id.clone());
                }
            }
        }
        let stats = self.queue.stats().map_err(queue_error)?;
        if stats.pending() + stats.scheduled + stats.processing >= MAX_PENDING {
            return Err("Background queue is busy. This work can be retried shortly.".into());
        }
        // Mutation receipts, session cookies and access tokens are never payloads.
        let envelope = serde_json::to_value(tasks::Work::new(task.clone())).map_err(queue_error)?;
        let id = self
            .queue
            .schedule(
                task.name(),
                task.lane().name(),
                vec![envelope],
                SystemTime::now() + delay,
            )
            .map_err(queue_error)?;
        if let Some(key) = key {
            admission.insert(key, id.clone());
        }
        // Keep only active dedup entries; completed results remain in Butler for
        // their callers, independently of this bounded admission cache.
        if admission.len() > MAX_PENDING as usize {
            admission.retain(|_, id| {
                self.queue
                    .get(id)
                    .ok()
                    .flatten()
                    .is_some_and(|job| !job.state().is_finished())
            });
        }
        Ok(id)
    }
}

/// Disk bookkeeping and all handlers execute on the dedicated runtime. Dropping
/// the IPC receiver does not kill accepted work or its durable checkpoint.
pub(crate) async fn submit(
    app: &tauri::AppHandle,
    task: Task,
    unique: bool,
    delay: Duration,
) -> Result<String, String> {
    let state = app.state::<Arc<BackgroundJobs>>().inner().clone();
    let runtime = state.runtime.clone();
    runtime
        .spawn(async move {
            if *state.stop.borrow() {
                return Err("Hibiki is closing.".into());
            }
            tokio::task::spawn_blocking(move || state.enqueue(task, unique, delay))
                .await
                .map_err(queue_error)?
        })
        .await
        .map_err(queue_error)?
}

pub(crate) fn spawn(app: tauri::AppHandle, task: Task, unique: bool) {
    let state = app.state::<Arc<BackgroundJobs>>().inner().clone();
    state.runtime.spawn(async move {
        if let Err(error) = submit(&app, task.clone(), unique, Duration::ZERO).await {
            tasks::not_admitted(&app, &task);
            tracing::warn!(%error, "Background work could not be queued");
        }
    });
}

/// Best-effort cache work uses the same queue, priorities and Activity reporting
/// without serializing captured transports/credentials. It expires on restart;
/// durable user intentions must use a typed Task and a domain journal instead.
pub(crate) fn advisory(lane: Lane, label: &str, work: impl Future<Output = ()> + Send + 'static) {
    let Some(app) = APP.get() else {
        // Audio unit fixtures have no Tauri application or job service.
        tauri::async_runtime::spawn(work);
        return;
    };
    let state = app.state::<Arc<BackgroundJobs>>().inner().clone();
    let id = uuid::Uuid::new_v4().to_string();
    match state.advisory.lock() {
        Ok(mut jobs) if jobs.len() < MAX_PENDING as usize => {
            jobs.insert(id.clone(), Box::pin(work));
        }
        _ => return,
    }
    let task = Task::Advisory {
        id: id.clone(),
        lane,
        label: label.into(),
    };
    let app = app.clone();
    state.runtime.clone().spawn(async move {
        if let Err(error) = submit(&app, task, false, Duration::ZERO).await {
            if let Ok(mut jobs) = state.advisory.lock() {
                jobs.remove(&id);
            }
            tracing::debug!(%error, "Advisory background work deferred until its next request");
        }
    });
}

struct AdvisoryKey {
    state: std::sync::Weak<BackgroundJobs>,
    key: String,
}
impl Drop for AdvisoryKey {
    fn drop(&mut self) {
        if let Some(state) = self.state.upgrade() {
            if let Ok(mut keys) = state.advisory_keys.lock() { keys.remove(&self.key); }
        }
    }
}

/// Coalesce speculative work before creating a captured future/job. Release the
/// key on completion, cancellation and failed admission, including unpolled work.
pub(crate) fn advisory_once(key: String, lane: Lane, label: &str, work: impl Future<Output = ()> + Send + 'static) {
    let Some(app) = APP.get() else { advisory(lane, label, work); return; };
    let state = app.state::<Arc<BackgroundJobs>>();
    let key = format!("{}:{key}", lane.name());
    if !state.advisory_keys.lock().is_ok_and(|mut keys| keys.insert(key.clone())) { return; }
    let lease = AdvisoryKey { state: Arc::downgrade(state.inner()), key };
    advisory(lane, label, async move { let _lease = lease; work.await; });
}

pub(crate) async fn call(app: &tauri::AppHandle, task: Task) -> Result<serde_json::Value, String> {
    let id = submit(app, task, true, Duration::ZERO).await?;
    let state = app.state::<Arc<BackgroundJobs>>().inner().clone();
    // Butler's wait includes synchronous SQLite reads. Keep those on the
    // dedicated runtime too, including callers admitted through foreground IPC.
    let value = state
        .runtime
        .clone()
        .spawn(async move {
            state
                .queue
                .handle(id)
                .wait_result(Duration::from_secs(1))
                .await
                .map_err(|error| match error {
                    butler::Error::JobFailed { error, .. } => error,
                    other => queue_error(other),
                })
        })
        .await
        .map_err(queue_error)??;
    if let Some(message) = value
        .get("_hibikiDeferred")
        .and_then(serde_json::Value::as_str)
    {
        return Err(message.into());
    }
    Ok(value)
}

/// One-shot non-replayable provider writes. Their existing playlist journal
/// decides whether to verify, retry or ask for review after an interrupted call.
pub(crate) async fn mutation<T: Send + 'static>(
    app: &tauri::AppHandle,
    work: impl Future<Output = Result<T, String>> + Send + 'static,
) -> Result<T, String> {
    let state = app.state::<Arc<BackgroundJobs>>().inner().clone();
    state
        .runtime
        .clone()
        .spawn(async move {
            let _permit = state.mutations.acquire().await.map_err(queue_error)?;
            if *state.stop.borrow() {
                return Err("Hibiki is closing.".into());
            }
            work.await
        })
        .await
        .map_err(queue_error)?
}

fn protect_database(path: &Path) -> Result<(), String> {
    // Separate from plexmusic.db, including WAL and SHM files. Reuse the same
    // private-file protections as the library, without creating its tables here.
    // Call only BEFORE opening SQLite. Closing an unrelated descriptor for its
    // database/SHM file can release SQLite's process-wide POSIX locks. SQLite
    // gives new sidecars the database's private permissions itself.
    for suffix in ["", "-wal", "-shm"] {
        let mut name = path.as_os_str().to_owned();
        name.push(suffix);
        let file = std::path::PathBuf::from(name);
        let exists = match std::fs::symlink_metadata(&file) {
            Ok(_) => true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(queue_error(error)),
        };
        if !exists && suffix.is_empty() {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            options.open(&file).map_err(queue_error)?;
        }
        if exists || suffix.is_empty() {
            let held = crate::cache_files::open_regular_file(&file).map_err(queue_error)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                held.set_permissions(std::fs::Permissions::from_mode(0o600))
                    .map_err(queue_error)?;
            }
        }
    }
    Ok(())
}

fn restore_admission(queue: &Queue) -> Result<HashMap<String, String>, String> {
    let mut admission = HashMap::new();
    // Rebuild the unique keys from durable jobs after a crash/restart. Account
    // and connection revisions are checked again by the handler before any IO.
    for status in [JobState::Pending, JobState::Scheduled, JobState::Processing] {
        let mut filter = ListFilter::new(status);
        filter.limit = 100;
        loop {
            let jobs = queue.list(&filter).map_err(queue_error)?;
            for job in &jobs {
                if tasks::NAMES.contains(&job.record().name.as_str()) {
                    if let Some(task) =
                        job.record().args.first().and_then(|value| {
                            serde_json::from_value::<tasks::Work>(value.clone()).ok()
                        })
                    {
                        admission.insert(task.task.key()?, job.record().id.clone());
                    }
                }
            }
            if jobs.len() < filter.limit {
                break;
            }
            filter.offset += jobs.len();
        }
    }
    Ok(admission)
}

pub(crate) fn start(app: &tauri::AppHandle, path: &Path) -> Result<(), String> {
    protect_database(path)?;
    let queue = Queue::new(SqliteQueue::open(path).map_err(queue_error)?);
    let schedules = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(queue_error)?;
    schedules
        .busy_timeout(Duration::from_secs(5))
        .map_err(queue_error)?;
    schedules
        .execute_batch(SCHEDULE_SCHEMA)
        .map_err(queue_error)?;
    let admission = restore_admission(&queue)?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .max_blocking_threads(8)
        .thread_name("hibiki-background")
        .enable_all()
        .build()
        .map_err(queue_error)?;
    let (stop, mut stopping) = watch::channel(false);
    let state = Arc::new(BackgroundJobs {
        queue: queue.clone(),
        runtime: runtime.handle().clone(),
        stop,
        admission: Mutex::new(admission),
        schedules: Mutex::new(schedules),
        changed: Notify::new(),
        progress: Mutex::new(HashMap::new()),
        advisory: Mutex::new(HashMap::new()),
        advisory_keys: Mutex::new(HashSet::new()),
        terminal_seen: Mutex::new(HashMap::new()),
        mutations: Arc::new(Semaphore::new(2)),
    });
    APP.set(app.clone())
        .map_err(|_| "Background runtime already started")?;
    app.manage(state);
    app.manage(Arc::new(client::Client::default()));
    let mut worker = Worker::new(queue)
        .concurrency(8)
        .claimers(2)
        .poll_interval(Duration::from_millis(500))
        .heartbeat_ttl(Duration::from_secs(15))
        .recover_interval(Duration::from_secs(5))
        .checkpoint_interval(Duration::from_secs(1))
        .queues(QueuePriority::weighted([
            ("matching", 3),
            ("sync", 4),
            ("download", 1),
            ("refresh", 2),
            ("metadata", 1),
            ("reporting", 3),
            ("analysis", 1),
            ("coordination", 2),
            ("playlist-sync", 2),
            ("linked-sync", 2),
            ("favorites", 2),
            ("ratings", 4),
            ("prefetch", 3),
            ("hydration", 1),
        ]));
    for lane in LANES {
        worker = worker.queue_limit(lane.name(), lane.limit());
    }
    for name in tasks::NAMES {
        worker = worker.register(tasks::definition(name));
    }
    std::thread::Builder::new()
        .name("hibiki-job-runtime".into())
        .spawn(move || {
            runtime.block_on(worker.run_async(async move {
                let _ = stopping.wait_for(|stop| *stop).await;
            }));
            runtime.shutdown_timeout(Duration::from_secs(2));
        })
        .map_err(queue_error)?;
    start_scheduler(app.clone());
    Ok(())
}

pub(crate) fn stop(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<Arc<BackgroundJobs>>() {
        let _ = state.stop.send(true);
    }
}

/// Recurring work coalesces missed ticks after a restart. A schedule emits at
/// most one active job per key; a slow job never accumulates timer invocations.
pub(crate) async fn every(
    app: &tauri::AppHandle,
    task: Task,
    interval: Duration,
) -> Result<(), String> {
    let state = app.state::<Arc<BackgroundJobs>>().inner().clone();
    let milliseconds = interval.as_millis().clamp(1000, 365 * 24 * 3600 * 1000) as i64;
    let key = task.schedule_key()?;
    let json = serde_json::to_string(&task).map_err(queue_error)?;
    let owned = state.clone();
    state
        .runtime
        .spawn_blocking(move || {
            owned
                .schedules
                .lock()
                .map_err(queue_error)?
                .execute(
                    "INSERT INTO hibiki_job_schedules(id,task,every_ms,next_run) VALUES(?1,?2,?3,0)
             ON CONFLICT(id) DO UPDATE SET next_run=CASE WHEN task<>excluded.task THEN 0 ELSE next_run END,task=excluded.task,every_ms=excluded.every_ms",
                    rusqlite::params![key, json, milliseconds],
                )
                .map_err(queue_error)?;
            Ok::<_, String>(())
        })
        .await
        .map_err(queue_error)??;
    state.changed.notify_one();
    Ok(())
}

fn start_scheduler(app: tauri::AppHandle) {
    let state = app.state::<Arc<BackgroundJobs>>().inner().clone();
    let mut stop = state.stop.subscribe();
    state.runtime.clone().spawn(async move {
        loop {
            let owner = state.clone();
            let app = app.clone();
            let result = tokio::task::spawn_blocking(move || scheduler_tick(&owner, Some(&app))).await;
            if !matches!(result, Ok(Ok(()))) { tracing::warn!("Background schedules will be retried on the next tick"); }
            tokio::select! { _ = stop.wait_for(|stop| *stop) => break, _ = state.changed.notified() => {}, _ = tokio::time::sleep(Duration::from_secs(5)) => {} }
        }
    });
}

fn scheduler_tick(state: &BackgroundJobs, app: Option<&tauri::AppHandle>) -> Result<(), String> {
    if *state.stop.borrow() {
        return Ok(());
    }
    let now = chrono::Utc::now().timestamp_millis();
    let due = {
        let db = state.schedules.lock().map_err(queue_error)?;
        let mut query = db.prepare("SELECT id,task,every_ms FROM hibiki_job_schedules WHERE next_run <= ?1 ORDER BY next_run LIMIT 32").map_err(queue_error)?;
        let rows = query
            .query_map([now], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .map_err(queue_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(queue_error)?
    };
    for (key, json, interval) in due {
        let task = match serde_json::from_str::<Task>(&json) {
            Ok(task) => task,
            Err(_) => {
                // A future/removed task version must not stall every schedule.
                // Keep it for a compatible runtime, but take it off the hot path.
                state
                    .schedules
                    .lock()
                    .map_err(queue_error)?
                    .execute(
                        "UPDATE hibiki_job_schedules SET next_run=?2 WHERE id=?1 AND task=?3",
                        rusqlite::params![key, now.saturating_add(interval.max(3600_000)), json],
                    )
                    .map_err(queue_error)?;
                tracing::warn!(schedule = %key, "Unrecognized background schedule deferred");
                continue;
            }
        };
        let ready = app.is_none_or(|app| state.runtime.block_on(async {
            tokio::time::timeout(Duration::from_secs(2), tasks::ready(app, &task)).await
                // If discovery fails, let the real job expose the failure.
                .map(|result| result.unwrap_or(true)).unwrap_or(false)
        }));
        if ready { state.enqueue(task, true, Duration::ZERO)?; }
        // Due work advances after durable admission; idle discoveries advance
        // without creating a job. A crash coalesces with an existing active key.
        // Handlers must tolerate repetition if a job finished before that crash.
        state
            .schedules
            .lock()
            .map_err(queue_error)?
            .execute(
                "UPDATE hibiki_job_schedules SET next_run=?2 WHERE id=?1 AND task=?3",
                rusqlite::params![key, now.saturating_add(interval), json],
            )
            .map_err(queue_error)?;
    }
    // Keep a bounded recent history, including failures for diagnostics. Leave
    // results at least an hour for any caller waiting on a completed read.
    for status in [JobState::Done, JobState::Dead, JobState::Cancelled] {
        let mut filter = ListFilter::new(status);
        filter.offset = 200;
        filter.limit = 100;
        for job in state.queue.list(&filter).map_err(queue_error)? {
            // Butler has no finished-at timestamp. Start this conservative
            // retention clock after observing a terminal job, not at admission:
            // a long task's new result must remain available to its waiters.
            let old = state.terminal_seen.lock().map_err(queue_error)?
                .entry(job.record().id.clone()).or_insert_with(std::time::Instant::now).elapsed() >= Duration::from_secs(3600);
            if old {
                state.queue.discard(&job.record().id).map_err(queue_error)?;
                state.terminal_seen.lock().map_err(queue_error)?.remove(&job.record().id);
            }
        }
    }
    Ok(())
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct QueueStatus {
    pub pending: u64,
    pub running: u64,
    pub scheduled: u64,
    pub failed: u64,
    pub jobs: Vec<QueueJob>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueJob {
    id: String,
    label: String,
    queue: String,
    state: String,
    activity_id: Option<String>,
    progress: Option<progress::Progress>,
}
#[tauri::command]
pub async fn background_queue_status(app: tauri::AppHandle) -> Result<QueueStatus, String> {
    let state = app.state::<Arc<BackgroundJobs>>().inner().clone();
    state
        .runtime
        .clone()
        .spawn_blocking(move || {
            let queue = &state.queue;
            let stats = queue.stats().map_err(queue_error)?;
            let active = state.progress.lock().map_err(queue_error)?.clone();
            let mut jobs = Vec::new();
            for status in [JobState::Processing, JobState::Pending, JobState::Scheduled] {
                let mut filter = ListFilter::new(status);
                filter.limit = 32;
                for job in queue.list(&filter).map_err(queue_error)? {
                    let record = job.record();
                    let Some(work) = record.args.first().and_then(|value| {
                        serde_json::from_value::<tasks::Work>(value.clone()).ok()
                    }) else {
                        continue;
                    };
                    let progress = active.get(&work.id).cloned().or_else(|| {
                        record
                            .progress
                            .as_ref()
                            .and_then(|value| serde_json::from_value(value.clone()).ok())
                    }).filter(|progress: &progress::Progress| !progress.stage.is_empty()).or_else(|| match &work.task {
                        Task::Client { request } => request.initial_progress(),
                        _ => None,
                    });
                    jobs.push(QueueJob {
                        id: record.id.clone(),
                        label: work.task.label().into(),
                        queue: record.queue.clone(),
                        state: status.as_str().into(),
                        activity_id: work.task.activity_id(),
                        progress,
                    });
                }
            }
            Ok(QueueStatus {
                pending: stats.pending(),
                running: stats.processing,
                scheduled: stats.scheduled,
                failed: stats.dead,
                jobs,
            })
        })
        .await
        .map_err(queue_error)?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(queue: Queue, runtime: &tokio::runtime::Runtime) -> BackgroundJobs {
        let (stop, _) = watch::channel(false);
        let schedules = rusqlite::Connection::open_in_memory().unwrap();
        schedules.execute_batch(SCHEDULE_SCHEMA).unwrap();
        BackgroundJobs {
            admission: Mutex::new(restore_admission(&queue).unwrap()),
            queue,
            runtime: runtime.handle().clone(),
            stop,
            schedules: Mutex::new(schedules),
            changed: Notify::new(),
            progress: Mutex::new(HashMap::new()),
            advisory: Mutex::new(HashMap::new()),
            advisory_keys: Mutex::new(HashSet::new()),
            terminal_seen: Mutex::new(HashMap::new()),
            mutations: Arc::new(Semaphore::new(2)),
        }
    }

    #[test]
    fn unpolled_advisory_cancellation_releases_its_admission_key() {
        let runtime = tokio::runtime::Builder::new_current_thread().build().unwrap();
        let jobs = Arc::new(state(Queue::new(butler::MemoryQueue::default()), &runtime));
        let key = "metadata:touch".to_owned();
        jobs.advisory_keys.lock().unwrap().insert(key.clone());
        let lease = AdvisoryKey { state: Arc::downgrade(&jobs), key: key.clone() };
        let work = async move { let _lease = lease; std::future::pending::<()>().await; };
        assert!(jobs.advisory_keys.lock().unwrap().contains(&key));
        drop(work);
        assert!(jobs.advisory_keys.lock().unwrap().insert(key));
    }

    #[test]
    fn terminal_history_waits_an_hour_after_observation_before_reclaiming_results() {
        let runtime = tokio::runtime::Builder::new_current_thread().build().unwrap();
        let jobs = state(Queue::new(butler::MemoryQueue::default()), &runtime);
        for _ in 0..201 {
            let id = jobs.enqueue(Task::ListeningOutbox, false, Duration::ZERO).unwrap();
            jobs.queue.cancel(&id).unwrap();
        }
        scheduler_tick(&jobs, None).unwrap();
        assert_eq!(jobs.queue.stats().unwrap().cancelled, 201);
        assert_eq!(jobs.terminal_seen.lock().unwrap().len(), 1);
        for seen in jobs.terminal_seen.lock().unwrap().values_mut() {
            *seen = std::time::Instant::now() - Duration::from_secs(3601);
        }
        scheduler_tick(&jobs, None).unwrap();
        assert_eq!(jobs.queue.stats().unwrap().cancelled, 200);
        assert!(jobs.terminal_seen.lock().unwrap().is_empty());
    }

    #[test]
    fn an_unrecognized_schedule_does_not_starve_valid_schedules() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let jobs = state(Queue::new(butler::MemoryQueue::default()), &runtime);
        {
            let db = jobs.schedules.lock().unwrap();
            for (id, payload) in [
                ("unknown", "{\"type\":\"futureVersion\"}".to_owned()),
                (
                    "valid",
                    serde_json::to_string(&Task::ListeningOutbox).unwrap(),
                ),
            ] {
                db.execute("INSERT INTO hibiki_job_schedules(id,task,every_ms,next_run) VALUES(?1,?2,1000,0)", rusqlite::params![id, payload]).unwrap();
            }
        }
        scheduler_tick(&jobs, None).unwrap();
        assert_eq!(jobs.queue.stats().unwrap().pending(), 1);
        let deferred: i64 = jobs
            .schedules
            .lock()
            .unwrap()
            .query_row(
                "SELECT next_run FROM hibiki_job_schedules WHERE id='unknown'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(deferred > chrono::Utc::now().timestamp_millis() + 3500_000);
        // Further ticks don't repeatedly inspect or enqueue the unknown version.
        scheduler_tick(&jobs, None).unwrap();
        assert_eq!(jobs.queue.stats().unwrap().pending(), 1);
    }

    #[test]
    fn unique_jobs_survive_restart_and_delayed_admission_uses_the_same_key() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("jobs.sqlite3");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let id = {
            let jobs = state(Queue::new(SqliteQueue::open(&path).unwrap()), &runtime);
            let id = jobs
                .enqueue(Task::ListeningOutbox, true, Duration::from_secs(60))
                .unwrap();
            assert_eq!(
                jobs.enqueue(Task::ListeningOutbox, true, Duration::ZERO)
                    .unwrap(),
                id
            );
            assert_eq!(jobs.queue.stats().unwrap().scheduled, 1);
            id
        };
        let jobs = state(Queue::new(SqliteQueue::open(&path).unwrap()), &runtime);
        assert_eq!(
            jobs.enqueue(Task::ListeningOutbox, true, Duration::ZERO)
                .unwrap(),
            id
        );
        assert_eq!(jobs.queue.stats().unwrap().scheduled, 1);
        let conn = rusqlite::Connection::open(&path).unwrap();
        assert_eq!(
            conn.query_row::<i64, _, _>(
                "SELECT count(*) FROM sqlite_master WHERE name='tracks'",
                [],
                |row| row.get(0)
            )
            .unwrap(),
            0
        );
    }

    #[test]
    fn a_cancelled_job_does_not_absorb_new_work() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let jobs = state(Queue::new(butler::MemoryQueue::default()), &runtime);
        let old = jobs
            .enqueue(Task::ListeningOutbox, true, Duration::ZERO)
            .unwrap();
        assert!(jobs.queue.cancel(&old).unwrap());
        let new = jobs
            .enqueue(Task::ListeningOutbox, true, Duration::ZERO)
            .unwrap();
        assert_ne!(old, new);
        assert_eq!(jobs.queue.stats().unwrap().pending(), 1);
    }

    #[test]
    fn job_identity_includes_the_owner_connection_and_work_type() {
        let make = |scope: &str, revision| Task::PlexDownloads {
            context: crate::commands::PlexRequestContext {
                cache_scope: scope.into(),
                connection_revision: revision,
            },
        };
        assert_ne!(make("one", 1).key().unwrap(), make("two", 1).key().unwrap());
        assert_ne!(make("one", 1).key().unwrap(), make("one", 2).key().unwrap());
        assert_ne!(
            make("one", 1).key().unwrap(),
            Task::PlexMatchingIndex {
                context: crate::commands::PlexRequestContext {
                    cache_scope: "one".into(),
                    connection_revision: 1,
                }
            }
            .key()
            .unwrap()
        );
    }

    #[test]
    fn provider_audio_jobs_use_live_handlers_and_retire_with_their_owner() {
        let download = Task::YoutubeDownloads { scope: "ytmusic-owner".into(), generation: 1 };
        assert_eq!(download.name(), "hibiki.youtube-downloads.v2");
        assert_eq!(download.lane().name(), "download");
        assert!(tasks::NAMES.contains(&download.name()));
        assert_ne!(download.name(), "hibiki.youtube-downloads.v1", "The experimental v1 handler deliberately discards work");
        assert_ne!(download.key().unwrap(), Task::YoutubeDownloads { scope: "ytmusic-owner".into(), generation: 2 }.key().unwrap());
        let work = tasks::Work::new(download);
        let restored: tasks::Work = serde_json::from_value(serde_json::to_value(&work).unwrap()).unwrap();
        assert_eq!(restored.id, work.id);
        assert_eq!(restored.task.activity_id().as_deref(), Some("downloads:ytmusic"));
        let probe = |account: &str, generation| Task::YoutubeAudioProbe { video_id: "abcdefghijk".into(), account: account.into(), generation };
        assert_eq!(probe("one", 1).lane().name(), "matching");
        assert!(tasks::NAMES.contains(&probe("one", 1).name()));
        assert_ne!(probe("one", 1).key().unwrap(), probe("two", 1).key().unwrap());
        assert_ne!(probe("one", 1).key().unwrap(), probe("one", 2).key().unwrap());
    }

    #[test]
    fn reconciliation_domains_have_independent_single_writer_queues() {
        let mut lanes = std::collections::HashSet::new();
        for (domain, activity) in [
            ("mixed", "mixed:one"),
            ("linked", "linked:one"),
            ("favorites", "favorites"),
            ("ratings", "ytmusic-ratings"),
        ] {
            let task = Task::Client {
                request: client::Request {
                    owner: "owner".into(),
                    domain: domain.into(),
                    method: "sync".into(),
                    args: serde_json::json!(["one"]),
                },
            };
            assert_eq!(task.lane().limit(), 1);
            assert!(lanes.insert(task.lane().name()));
            assert_eq!(task.activity_id().as_deref(), Some(activity));
        }
    }

    #[test]
    fn advisory_envelope_preserves_both_identities() {
        let work = tasks::Work::new(Task::Advisory {
            id: "closure-id".into(),
            lane: Lane::Refresh,
            label: "Refresh".into(),
        });
        let value = serde_json::to_value(&work).unwrap();
        assert_eq!(value["workId"], work.id);
        assert_eq!(value["id"], "closure-id");
        let restored: tasks::Work = serde_json::from_value(value).unwrap();
        assert_eq!(restored.id, work.id);
        assert!(matches!(restored.task, Task::Advisory { id, .. } if id == "closure-id"));
        // Already persisted experimental payloads can retire without retrying.
        let restored: tasks::Work = serde_json::from_value(serde_json::json!({
            "type": "advisory", "id": "old-closure", "lane": "refresh", "label": "Refresh"
        }))
        .unwrap();
        assert!(matches!(restored.task, Task::Advisory { id, .. } if id == "old-closure"));
    }
}
