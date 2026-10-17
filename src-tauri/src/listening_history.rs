//! Actual native listens, retained locally before remote reporting or webview teardown.
use crate::audio_engine::event::{EngineEvent, TrackEndReason};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PlaybackEnd {
    pub request_id: u64,
    pub playback_id: u64,
    pub rating_key: i64,
    pub position_ms: u64,
    pub duration_ms: u64,
    pub listened_ms: u64,
    pub reason: TrackEndReason,
}
impl PlaybackEnd {
    pub fn from_event(event: &EngineEvent) -> Option<Self> {
        if let EngineEvent::TrackEnded {
            request_id,
            playback_id,
            rating_key,
            position_ms,
            duration_ms,
            listened_ms,
            reason,
        } = event
        {
            Some(Self {
                request_id: *request_id,
                playback_id: *playback_id,
                rating_key: *rating_key,
                position_ms: *position_ms,
                duration_ms: *duration_ms,
                listened_ms: *listened_ms,
                reason: *reason,
            })
        } else {
            None
        }
    }
}
#[derive(Clone, Default, Debug, Serialize, Deserialize)]
pub struct Binding {
    pub plex: Option<String>,
    pub lastfm: Option<String>,
    pub listenbrainz: Option<String>,
}
fn account(service: &str, username: &str, credential: &str) -> Option<String> {
    use sha2::{Digest, Sha256};
    if credential.is_empty() {
        return None;
    }
    // Verified account names survive credential renewal. Empty legacy names
    // remain bound to their exact credential rather than another login.
    let identity = if username.is_empty() {
        credential.to_owned()
    } else {
        username.to_lowercase()
    };
    Some(hex::encode(Sha256::digest(serde_json::to_vec(&[service, &identity]).unwrap())))
}
impl Binding {
    pub fn capture(settings: &crate::plex::PlexSettings, plex: Option<String>) -> Self {
        Self {
            plex,
            lastfm: settings
                .lastfm_enabled
                .then(|| {
                    account(
                        "lastfm",
                        &settings.lastfm_username,
                        &settings.lastfm_session_key,
                    )
                })
                .flatten(),
            listenbrainz: settings
                .listenbrainz_enabled
                .then(|| {
                    account(
                        "listenbrainz",
                        &settings.listenbrainz_username,
                        &settings.listenbrainz_token,
                    )
                })
                .flatten(),
        }
    }
}
#[derive(Clone)]
pub struct Completed {
    pub end: PlaybackEnd,
    pub started_at: u64,
    pub binding: Binding,
    pub labels: Option<TrackLabels>,
}
struct Started {
    started_at: u64,
    binding: Binding,
    labels: Option<TrackLabels>,
}
#[derive(Default)]
struct Journal {
    started: HashMap<u64, Started>,
    completed: HashMap<u64, Completed>,
    completed_order: VecDeque<u64>,
    recent_ends: VecDeque<PlaybackEnd>,
    acknowledged: HashSet<u64>,
}
pub enum HistoryEvent {
    Playback(EngineEvent),
    Started(EngineEvent, Option<TrackLabels>, Binding, u64),
    Barrier(crossbeam_channel::Sender<Result<Vec<PlaybackEnd>, String>>),
}
pub struct NativeHistory {
    pub session: String,
    journal: Mutex<Journal>,
    retention_failed: AtomicBool,
}
impl NativeHistory {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            session: uuid::Uuid::new_v4().to_string(),
            journal: Mutex::new(Journal::default()),
            retention_failed: AtomicBool::new(false),
        })
    }
    pub fn start(
        self: &Arc<Self>,
        app: tauri::AppHandle,
    ) -> std::io::Result<crossbeam_channel::Sender<HistoryEvent>> {
        // Only track boundaries use this reliable channel; high-rate position
        // and visualization events remain on their separate bounded queues.
        let (tx, rx) = crossbeam_channel::unbounded();
        let history = self.clone();
        std::thread::Builder::new()
            .name("listening-history".into())
            .spawn(move || {
                while let Ok(event) = rx.recv() {
                    match event {
                        HistoryEvent::Started(
                            EngineEvent::TrackStarted { playback_id, .. },
                            labels,
                            binding,
                            started_at,
                        ) => {
                            let mut journal = history
                                .journal
                                .lock()
                                .unwrap_or_else(|error| error.into_inner());
                            if !journal.started.contains_key(&playback_id)
                                && !journal.acknowledged.contains(&playback_id)
                            {
                                journal.started.insert(
                                    playback_id,
                                    Started {
                                        started_at,
                                        binding,
                                        labels,
                                    },
                                );
                            }
                        }
                        HistoryEvent::Playback(event) => {
                            history.observe_end(&event);
                            let _ = history.retain_pending(&app);
                        }
                        HistoryEvent::Started(_, _, _, _) => {}
                        HistoryEvent::Barrier(reply) => {
                            let _ = reply.send(history.barrier(|| history.retain_pending(&app)));
                        }
                    }
                }
            })?;
        Ok(tx)
    }
    fn observe_end(&self, event: &EngineEvent) {
        let Some(end) = PlaybackEnd::from_event(event) else {
            return;
        };
        let mut journal = self
            .journal
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if journal.acknowledged.contains(&end.playback_id) {
            return;
        }
        if let Some(start) = journal.started.get(&end.playback_id) {
            let completed = Completed {
                end: end.clone(),
                started_at: start.started_at,
                binding: start.binding.clone(),
                labels: start.labels.clone(),
            };
            if !journal.completed.contains_key(&end.playback_id) {
                journal.completed_order.push_back(end.playback_id);
            }
            journal.completed.insert(end.playback_id, completed);
        }
    }
    fn retain_pending(&self, app: &tauri::AppHandle) -> Result<(), String> {
        self.with_retention_status(|| self.retain_pending_inner(app))
    }
    fn with_retention_status(
        &self,
        retain: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        let result = retain();
        self.retention_failed
            .store(result.is_err(), Ordering::Release);
        result
    }
    fn retain_pending_inner(&self, app: &tauri::AppHandle) -> Result<(), String> {
        use tauri::Manager;
        let records = {
            let journal = self
                .journal
                .lock()
                .map_err(|_| "Listening history unavailable")?;
            journal
                .completed_order
                .iter()
                .filter_map(|id| journal.completed.get(id).cloned())
                .collect::<Vec<_>>()
        };
        let db = app.state::<crate::db::DbState>();
        let mut conn = db.0.lock().map_err(|_| "Listening database unavailable")?;
        for record in records {
            if record.binding.plex.is_some() {
                let labels = record.labels.as_ref().ok_or("Native listen metadata is unavailable; keep Hibiki open to protect this listen")?;
                retain(&mut conn, &self.session, &record, labels)?;
            }
            self.acknowledge(record.end.playback_id);
        }
        Ok(())
    }
    pub fn pending(&self) -> Result<Vec<PlaybackEnd>, String> {
        let journal = self
            .journal
            .lock()
            .map_err(|_| "Listening history unavailable")?;
        Ok(journal
            .completed
            .values()
            .map(|record| record.end.clone())
            .collect())
    }
    fn barrier(
        &self,
        retain: impl FnOnce() -> Result<(), String>,
    ) -> Result<Vec<PlaybackEnd>, String> {
        retain()?;
        self.shutdown_proofs()
    }
    fn shutdown_proofs(&self) -> Result<Vec<PlaybackEnd>, String> {
        let journal = self
            .journal
            .lock()
            .map_err(|_| "Listening history unavailable")?;
        Ok(journal.recent_ends.iter().cloned().collect())
    }
    pub fn acknowledge(&self, id: u64) {
        let mut journal = self
            .journal
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(completed) = journal.completed.remove(&id) {
            journal.recent_ends.push_back(completed.end);
            while journal.recent_ends.len() > 64 {
                journal.recent_ends.pop_front();
            }
        }
        if journal.completed_order.front() == Some(&id) {
            journal.completed_order.pop_front();
        } else {
            journal.completed_order.retain(|pending| *pending != id);
        }
        journal.started.remove(&id);
        journal.acknowledged.insert(id);
    }
}
pub(crate) fn unix_time() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TrackLabels {
    pub artist: String,
    pub track: String,
    pub album: String,
    pub album_artist: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Service {
    PlexTimeline,
    PlexPlayed,
    Lastfm,
    Listenbrainz,
}
#[derive(Clone, Serialize, Deserialize)]
struct Report {
    service: Service,
    binding: String,
    end: PlaybackEnd,
    started_at: u64,
    labels: TrackLabels,
    #[serde(default)]
    ended_at: u64,
    #[serde(default)]
    attempts: u32,
    #[serde(default)]
    first_failed_at: u64,
    #[serde(default)]
    retry_at: u64,
}
impl Report {
    fn matches_binding(&self, current: &Binding) -> bool {
        (match self.service {
            Service::PlexTimeline | Service::PlexPlayed => current.plex.as_deref(),
            Service::Lastfm => current.lastfm.as_deref(),
            Service::Listenbrainz => current.listenbrainz.as_deref(),
        }) == Some(self.binding.as_str())
    }
}
const PREFIX: &str = "listening-outbox-v1/";
fn listened_enough(end: &PlaybackEnd) -> bool {
    end.duration_ms > 0
        && end.listened_ms > 0
        && end.listened_ms >= (end.duration_ms / 2).min(240_000)
}
fn reports(record: &Completed, labels: &TrackLabels) -> Vec<Report> {
    let mut result = Vec::new();
    let mut add = |service, binding: &str| {
        result.push(Report {
            service,
            binding: binding.into(),
            end: record.end.clone(),
            started_at: record.started_at,
            labels: labels.clone(),
            ended_at: unix_time(),
            attempts: 0,
            first_failed_at: 0,
            retry_at: 0,
        })
    };
    if let Some(binding) = &record.binding.plex {
        add(Service::PlexTimeline, binding);
        if listened_enough(&record.end) {
            add(Service::PlexPlayed, binding);
        }
        if record.end.duration_ms > 30_000 && listened_enough(&record.end) {
            if let Some(binding) = &record.binding.lastfm {
                add(Service::Lastfm, binding);
            }
            if let Some(binding) = &record.binding.listenbrainz {
                add(Service::Listenbrainz, binding);
            }
        }
    }
    result
}
fn retain(
    conn: &mut rusqlite::Connection,
    session: &str,
    record: &Completed,
    labels: &TrackLabels,
) -> Result<(), String> {
    if [
        &labels.artist,
        &labels.track,
        &labels.album,
        &labels.album_artist,
    ]
    .iter()
    .any(|value| value.len() > 8192)
    {
        return Err("Listening metadata is too large".into());
    }
    if count_reports(conn)? >= 32_768 {
        return Err("Listening queue is full; keep Hibiki open and retry synchronization".into());
    }
    let transaction = conn
        .transaction()
        .map_err(|_| "Could not retain listening history")?;
    for report in reports(record, labels) {
        let service = serde_json::to_string(&report.service).unwrap();
        let key = format!("{PREFIX}{session}/{}/{service}", record.end.playback_id);
        let value =
            serde_json::to_string(&report).map_err(|_| "Could not encode listening history")?;
        transaction
            .execute(
                "INSERT INTO kv (key,value) VALUES (?1,?2) ON CONFLICT(key) DO NOTHING",
                [&key, &value],
            )
            .map_err(|_| "Could not retain listening history")?;
    }
    transaction
        .commit()
        .map_err(|_| "Could not save listening history".into())
}
#[derive(Default)]
pub struct ReportingState {
    serial: tokio::sync::Mutex<()>,
    owner: Mutex<Option<std::fs::File>>,
}
impl ReportingState {
    fn owns_outbox(&self, directory: &std::path::Path) -> Result<bool, String> {
        if crate::cache_files::directory_id(directory).is_none() {
            return Err("Listening queue directory is unavailable".into());
        }
        let path = directory.join(".listening-outbox.lock");
        let mut owner = self
            .owner
            .lock()
            .map_err(|_| "Listening queue ownership unavailable")?;
        if let Some(file) = owner.as_ref() {
            return crate::cache_files::file_is_current(file, &path)
                .then_some(true)
                .ok_or("Listening queue lock changed; restart Hibiki before syncing".into());
        }
        let file = match std::fs::File::create_new(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                crate::cache_files::open_writable_regular_file(&path)
                    .map_err(|_| "Listening queue lock is linked or unavailable")?
            }
            Err(_) => return Err("Listening queue lock is unavailable".into()),
        };
        if file.try_lock().is_err() {
            return Ok(false);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))
                .map_err(|_| "Cannot protect listening queue lock")?;
        }
        if !crate::cache_files::file_is_current(&file, &path) {
            return Err("Listening queue lock changed".into());
        }
        *owner = Some(file);
        Ok(true)
    }
}
#[derive(Default, Serialize)]
pub struct OutboxStatus {
    pub pending: usize,
}
fn read_reports(conn: &rusqlite::Connection) -> Result<Vec<(String, Report)>, String> {
    let mut query = conn.prepare("SELECT key,value FROM kv WHERE key LIKE 'listening-outbox-v1/%' ORDER BY key LIMIT 32768").map_err(|_| "Listening queue unavailable")?;
    let rows = query
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|_| "Listening queue unavailable")?;
    rows.map(|row| {
        let (key, value) = row.map_err(|_| "Listening queue unavailable")?;
        Ok((
            key,
            serde_json::from_str(&value).map_err(|_| "A retained listen could not be read")?,
        ))
    })
    .collect()
}
fn count_reports(conn: &rusqlite::Connection) -> Result<usize, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM kv WHERE key LIKE 'listening-outbox-v1/%'",
        [],
        |row| row.get::<_, i64>(0),
    )
    .map(|count| count.max(0) as usize)
    .map_err(|_| "Listening queue unavailable".into())
}
fn timeline_session_identifier(job: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("history-{}", hex::encode(Sha256::digest(job.as_bytes())))
}
async fn submit(
    report: &Report,
    settings: &crate::plex::PlexSettings,
    client: Option<&crate::plex::PlexClient>,
    historical_session: Option<&str>,
) -> Result<bool, String> {
    let current = Binding::capture(settings, client.map(|client| client.library_scope.clone()));
    if !report.matches_binding(&current) {
        return Ok(false);
    }
    let labels = &report.labels;
    match report.service {
        Service::PlexTimeline | Service::PlexPlayed => {
            let client = client.ok_or("Original Plex library is not connected")?;
            if matches!(report.service, Service::PlexTimeline) {
                let position = report.end.position_ms.min(i64::MAX as u64) as i64;
                let duration = report.end.duration_ms.min(i64::MAX as u64) as i64;
                let result = if let Some(session) = historical_session {
                    // Older retained rows only know when playback started.
                    let updated = if report.ended_at > 0 {
                        report.ended_at
                    } else {
                        report.started_at
                    };
                    client
                        .report_retained_timeline(
                            report.end.rating_key,
                            position,
                            duration,
                            session,
                            updated.min(unix_time()),
                        )
                        .await
                } else {
                    client
                        .report_timeline(
                            report.end.rating_key,
                            crate::plex::PlaybackState::Stopped,
                            position,
                            duration,
                        )
                        .await
                };
                result.map_err(|_| "Plex progress is retained for retry")?;
            } else {
                client
                    .mark_played(report.end.rating_key)
                    .await
                    .map_err(|_| "Plex played status is retained for retry")?;
            }
        }
        Service::Lastfm => {
            crate::lastfm::scrobble(
                &settings.lastfm_api_key,
                &settings.lastfm_api_secret,
                &settings.lastfm_session_key,
                &labels.artist,
                &labels.track,
                &labels.album,
                &labels.album_artist,
                (report.end.duration_ms / 1000).min(u32::MAX as u64) as u32,
                report.started_at,
                report.end.listened_ms / 1000,
            )
            .await
            .map_err(|_| "Last.fm listen is retained for retry")?;
        }
        Service::Listenbrainz => {
            crate::listenbrainz::submit_listen(
                &settings.listenbrainz_token,
                &labels.artist,
                &labels.track,
                &labels.album,
                report.end.duration_ms,
                report.started_at,
                "",
                &[],
                "",
                "",
            )
            .await
            .map_err(|_| "ListenBrainz listen is retained for retry")?;
        }
    }
    Ok(true)
}
pub async fn drain(app: &tauri::AppHandle) -> Result<OutboxStatus, String> {
    use tauri::Manager;
    let reporting = app.state::<ReportingState>();
    let _serial = reporting.serial.lock().await;
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "Listening queue directory unavailable")?;
    if !reporting.owns_outbox(&directory)? {
        let db = app.state::<crate::db::DbState>();
        let conn = db.0.lock().map_err(|_| "Listening database unavailable")?;
        return Ok(OutboxStatus {
            pending: count_reports(&conn)?,
        });
    }
    let config = app
        .path()
        .app_config_dir()
        .map_err(|_| "Account settings unavailable")?;
    let reports = {
        let db = app.state::<crate::db::DbState>();
        let conn = db.0.lock().map_err(|_| "Listening database unavailable")?;
        read_reports(&conn)?
    };
    for (key, report) in reports {
        if report.retry_at > unix_time() {
            continue;
        }
        let settings =
            crate::plex::load_settings(&config).map_err(|_| "Account settings unavailable")?;
        let client = app
            .state::<crate::commands::PlexState>()
            .0
            .lock()
            .await
            .clone();
        if !reporting.owns_outbox(&directory)? {
            return Err("Listening queue ownership changed".into());
        }
        let primary = app
            .try_state::<crate::audio_engine::bridge::AudioEngineState>()
            .is_some_and(|engine| {
                key.starts_with(&format!("{PREFIX}{}/", engine.0.history.session))
                    && engine.0.primary_timeline_allowed(&report.end)
            });
        let historical_session = (!primary).then(|| timeline_session_identifier(&key));
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(8),
            submit(
                &report,
                &settings,
                client.as_ref(),
                historical_session.as_deref(),
            ),
        )
        .await
        .unwrap_or_else(|_| Err("Listening submission timed out and remains retained".into()));
        if !reporting.owns_outbox(&directory)? {
            return Err("Listening queue ownership changed".into());
        }
        match result {
            Ok(true) => {
                let db = app.state::<crate::db::DbState>();
                let conn = db.0.lock().map_err(|_| "Listening database unavailable")?;
                crate::db::kv::delete(&conn, &key)?;
            }
            Ok(false) => {} // Account/library changed: retain for that identity.
            Err(_) => {
                let mut retry = report;
                retry.attempts = retry.attempts.saturating_add(1);
                if retry.first_failed_at == 0 {
                    retry.first_failed_at = unix_time();
                }
                retry.retry_at = unix_time()
                    .saturating_add((30_u64.saturating_mul(1 << retry.attempts.min(7))).min(3600));
                let db = app.state::<crate::db::DbState>();
                let conn = db.0.lock().map_err(|_| "Listening database unavailable")?;
                crate::db::kv::set(
                    &conn,
                    &key,
                    &serde_json::to_string(&retry)
                        .map_err(|_| "Listening retry could not be saved")?,
                )?;
            }
        }
    }
    let db = app.state::<crate::db::DbState>();
    let conn = db.0.lock().map_err(|_| "Listening database unavailable")?;
    Ok(OutboxStatus {
        pending: count_reports(&conn)?,
    })
}
#[tauri::command]
pub async fn flush_listening_outbox(app: tauri::AppHandle) -> Result<OutboxStatus, String> {
    use tauri::Manager;
    // Remote unavailability never prevents quit: every request is already durable.
    match tokio::time::timeout(std::time::Duration::from_secs(2), drain(&app)).await {
        Ok(result) => result,
        Err(_) => {
            let db = app.state::<crate::db::DbState>();
            let conn = db.0.lock().map_err(|_| "Listening database unavailable")?;
            Ok(OutboxStatus {
                pending: count_reports(&conn)?,
            })
        }
    }
}
pub fn start_worker(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
        loop {
            interval.tick().await;
            let _ = drain(&app).await;
        }
    });
}

#[derive(Default, Serialize)]
pub struct ListeningStatus {
    pub pending: usize,
    pub unretained: usize,
    pub save_failed: bool,
    pub waiting_for_account: usize,
    pub retrying: usize,
    pub delayed: usize,
    pub delayed_since: Option<u64>,
}
const SCROBBLE_NOTICE_DELAY: u64 = 24 * 60 * 60;
fn classify_reports(reports: &[(String, Report)], current: &Binding, now: u64) -> ListeningStatus {
    let mut status = ListeningStatus {
        pending: reports.len(),
        ..Default::default()
    };
    for (_, report) in reports {
        if !report.matches_binding(current) {
            status.waiting_for_account += 1;
        } else if report.attempts > 0 {
            status.retrying += 1;
            // Only a prolonged failure of an active scrobbling service warrants
            // interruption. Plex history and archived library bindings stay quiet.
            if matches!(report.service, Service::Lastfm | Service::Listenbrainz)
                && report.attempts >= 2
                && report.first_failed_at > 0
                && now.saturating_sub(report.first_failed_at) >= SCROBBLE_NOTICE_DELAY
            {
                status.delayed += 1;
                status.delayed_since = Some(
                    status
                        .delayed_since
                        .map_or(report.first_failed_at, |previous| {
                            previous.min(report.first_failed_at)
                        }),
                );
            }
        }
    }
    status
}
#[tauri::command]
pub async fn listening_history_status(
    app: tauri::AppHandle,
    engine: tauri::State<'_, crate::audio_engine::bridge::AudioEngineState>,
    db: tauri::State<'_, crate::db::DbState>,
) -> Result<ListeningStatus, String> {
    use tauri::Manager;
    let config = app
        .path()
        .app_config_dir()
        .map_err(|_| "Account settings unavailable")?;
    let settings =
        crate::plex::load_settings(&config).map_err(|_| "Account settings unavailable")?;
    let client = app
        .state::<crate::commands::PlexState>()
        .0
        .lock()
        .await
        .clone();
    let current = Binding::capture(
        &settings,
        client.as_ref().map(|client| client.library_scope.clone()),
    );
    let conn = db.0.lock().map_err(|_| "Listening database unavailable")?;
    let mut status = classify_reports(&read_reports(&conn)?, &current, unix_time());
    // Keep the existing total count even if the bounded classification query
    // cannot inspect every retained entry in an oversized legacy queue.
    status.pending = count_reports(&conn)?;
    status.unretained = engine.0.history.pending()?.len();
    status.save_failed =
        status.unretained > 0 && engine.0.history.retention_failed.load(Ordering::Acquire);
    Ok(status)
}
#[tauri::command]
pub async fn retry_listening_history(
    app: tauri::AppHandle,
    engine: tauri::State<'_, crate::audio_engine::bridge::AudioEngineState>,
) -> Result<OutboxStatus, String> {
    use tauri::Manager;
    engine.0.history.retain_pending(&app)?;
    {
        let db = app.state::<crate::db::DbState>();
        let mut conn = db.0.lock().map_err(|_| "Listening database unavailable")?;
        let reports = read_reports(&conn)?;
        let transaction = conn
            .transaction()
            .map_err(|_| "Listening retry unavailable")?;
        for (key, mut report) in reports {
            report.retry_at = 0;
            crate::db::kv::set(
                &transaction,
                &key,
                &serde_json::to_string(&report)
                    .map_err(|_| "Listening retry could not be saved")?,
            )?;
        }
        transaction
            .commit()
            .map_err(|_| "Listening retry could not be saved")?;
    }
    flush_listening_outbox(app).await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ended(id: u64, listened_ms: u64) -> EngineEvent {
        EngineEvent::TrackEnded {
            request_id: 8,
            playback_id: id,
            rating_key: 42,
            position_ms: 170_000,
            duration_ms: 180_000,
            listened_ms,
            reason: TrackEndReason::Stopped,
        }
    }
    fn labels() -> TrackLabels {
        TrackLabels {
            artist: "Artist".into(),
            track: "Track".into(),
            album: "Album".into(),
            album_artist: "Artist".into(),
        }
    }
    fn settings() -> crate::plex::PlexSettings {
        crate::plex::PlexSettings {
            lastfm_enabled: true,
            lastfm_username: "original-lastfm".into(),
            lastfm_session_key: "secret-lastfm".into(),
            listenbrainz_enabled: true,
            listenbrainz_username: "original-listenbrainz".into(),
            listenbrainz_token: "secret-listenbrainz".into(),
            ..Default::default()
        }
    }
    fn completed(id: u64, listened_ms: u64) -> Completed {
        Completed {
            end: PlaybackEnd::from_event(&ended(id, listened_ms)).unwrap(),
            started_at: 1_234,
            binding: Binding::capture(&settings(), Some("original-library".into())),
            labels: Some(labels()),
        }
    }
    #[test]
    fn acknowledged_public_shutdown_proofs_are_bounded_separate_and_arrival_ordered() {
        let history = NativeHistory::new();
        for id in 1..=70 {
            history.journal.lock().unwrap().started.insert(
                id,
                Started {
                    started_at: 1234,
                    binding: Binding::default(),
                    labels: None,
                },
            );
            let mut event = ended(id, 1000);
            if let EngineEvent::TrackEnded { reason, .. } = &mut event {
                *reason = if id == 69 {
                    TrackEndReason::Natural
                } else {
                    TrackEndReason::Stopped
                };
            }
            history.observe_end(&event);
            history.acknowledge(id);
            history.observe_end(&event); // duplicate never resurrects submissions/proofs
            history.acknowledge(id);
        }
        assert!(history.pending().unwrap().is_empty());
        let proofs = history.barrier(|| Ok(())).unwrap();
        assert_eq!(proofs.len(), 64);
        assert_eq!(proofs.first().unwrap().playback_id, 7);
        assert_eq!(proofs.last().unwrap().playback_id, 70);
        assert_eq!(proofs[62].reason, TrackEndReason::Natural);
        assert_eq!(proofs[63].reason, TrackEndReason::Stopped);
        assert!(proofs
            .windows(2)
            .all(|pair| pair[0].playback_id < pair[1].playback_id));
    }

    #[test]
    fn local_retention_failure_cannot_release_recent_shutdown_proofs() {
        let history = NativeHistory::new();
        let record = completed(71, 100_000);
        history.journal.lock().unwrap().started.insert(
            71,
            Started {
                started_at: record.started_at,
                binding: record.binding.clone(),
                labels: record.labels.clone(),
            },
        );
        history.observe_end(&ended(71, 100_000));
        // A newly completed listen awaiting its normal local save is not a failure.
        assert!(!history.retention_failed.load(Ordering::Acquire));
        let db = crate::db::DbState::open_in_memory().unwrap();
        let mut conn = db.0.lock().unwrap();
        conn.execute_batch("CREATE TRIGGER reject_history BEFORE INSERT ON kv BEGIN SELECT RAISE(ABORT,'synthetic retention failure'); END").unwrap();
        assert!(history
            .barrier(|| history.with_retention_status(|| retain(
                &mut conn,
                &history.session,
                &record,
                &labels()
            )))
            .is_err());
        assert_eq!(history.pending().unwrap().len(), 1);
        assert!(history.retention_failed.load(Ordering::Acquire));
        assert!(history.shutdown_proofs().unwrap().is_empty());
        conn.execute_batch("DROP TRIGGER reject_history").unwrap();
        let proofs = history
            .barrier(|| {
                history.with_retention_status(|| {
                    retain(&mut conn, &history.session, &record, &labels())?;
                    history.acknowledge(71);
                    Ok(())
                })
            })
            .unwrap();
        assert!(!history.retention_failed.load(Ordering::Acquire));
        assert_eq!(proofs.len(), 1);
        assert_eq!(proofs[0].playback_id, 71);
        assert!(history.pending().unwrap().is_empty());
    }

    #[test]
    fn native_journal_deduplicates_outgoing_and_shutdown_ends_by_playback_identity() {
        let history = NativeHistory::new();
        {
            let mut journal = history.journal.lock().unwrap();
            for id in [1, 2] {
                journal.started.insert(
                    id,
                    Started {
                        started_at: 1234,
                        binding: completed(id, 100_000).binding,
                        labels: Some(labels()),
                    },
                );
            }
        }
        history.observe_end(&ended(1, 100_000));
        history.observe_end(&ended(1, 100_000));
        history.observe_end(&ended(2, 5000));
        let mut listens = history.pending().unwrap();
        listens.sort_by_key(|event| event.playback_id);
        assert_eq!(listens.len(), 2);
        assert_eq!(listens[0].listened_ms, 100_000);
        assert_eq!(
            listens[1].listened_ms, 5000,
            "seek position cannot establish eligibility"
        );
        history.acknowledge(1);
        history.observe_end(&ended(1, 100_000));
        assert_eq!(history.pending().unwrap().len(), 1);
    }
    #[test]
    fn durable_retention_is_idempotent_and_keeps_credentials_out_of_sqlite() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.sqlite");
        let db = crate::db::DbState::open(&path).unwrap();
        {
            let mut conn = db.0.lock().unwrap();
            retain(&mut conn, "session", &completed(1, 100_000), &labels()).unwrap();
            retain(&mut conn, "session", &completed(1, 100_000), &labels()).unwrap();
            assert_eq!(count_reports(&conn).unwrap(), 4);
            let rows = read_reports(&conn).unwrap();
            let json =
                serde_json::to_string(&rows.iter().map(|(_, report)| report).collect::<Vec<_>>())
                    .unwrap();
            assert!(!json.contains("secret-lastfm") && !json.contains("secret-listenbrainz"));
        }
        drop(db);
        let reopened = crate::db::DbState::open(&path).unwrap();
        assert_eq!(count_reports(&reopened.0.lock().unwrap()).unwrap(), 4);
    }
    #[test]
    fn eligibility_uses_heard_frames_and_retention_failure_preserves_native_proof() {
        let record = completed(1, 5000);
        assert_eq!(
            reports(&record, &labels()).len(),
            1,
            "long seek position earns only final timeline, not played/scrobbles"
        );
        let history = NativeHistory::new();
        history.journal.lock().unwrap().started.insert(
            1,
            Started {
                started_at: 1234,
                binding: record.binding,
                labels: Some(labels()),
            },
        );
        history.observe_end(&ended(1, 100_000));
        let mut unavailable = rusqlite::Connection::open_in_memory().unwrap();
        let record = history.journal.lock().unwrap().completed[&1].clone();
        assert!(retain(&mut unavailable, "session", &record, &labels()).is_err());
        assert_eq!(history.pending().unwrap().len(), 1);
    }
    #[tokio::test]
    async fn timeline_reports_share_one_device_and_isolate_retained_playback_sessions() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let first = timeline_session_identifier("retained-job-a");
        let second = timeline_session_identifier("retained-job-b");
        assert_eq!(first, timeline_session_identifier("retained-job-a"));
        assert_ne!(first, second);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let expected = [
            None,
            Some(first.clone()),
            Some(first.clone()),
            Some(second.clone()),
            None,
            None,
            Some(first.clone()),
        ];
        let server = tokio::spawn(async move {
            for (index, session) in expected.into_iter().enumerate() {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                while !bytes.ends_with(b"\r\n\r\n") {
                    let mut chunk = [0_u8; 4096];
                    let size = socket.read(&mut chunk).await.unwrap();
                    assert!(size > 0 && bytes.len() + size <= 16_384);
                    bytes.extend_from_slice(&chunk[..size]);
                }
                let request = String::from_utf8(bytes).unwrap();
                let headers = request.to_lowercase();
                let target = request
                    .lines()
                    .next()
                    .unwrap()
                    .split_whitespace()
                    .collect::<Vec<_>>();
                assert_eq!(target[0], "POST");
                let url = reqwest::Url::parse(&format!("http://fixture{}", target[1])).unwrap();
                let query = url
                    .query_pairs()
                    .collect::<std::collections::HashMap<_, _>>();
                assert_eq!(url.path(), "/:/timeline");
                assert_eq!(query["clientIdentifier"], "primary-client");
                assert_eq!(query["hasMDE"], "1");
                assert!(headers.contains("\r\nx-plex-client-identifier: primary-client\r\n"));
                assert!(headers.contains("x-plex-token: dummy-native-token"));
                if let Some(session) = session {
                    assert!(
                        headers.contains(&format!("\r\nx-plex-session-identifier: {session}\r\n"))
                    );
                    assert_eq!(query["state"], "stopped");
                    assert_eq!(query["offline"], "1");
                    assert_eq!(
                        query["updated"],
                        if index == 6 { "1234" } else { "1700000001" }
                    );
                } else {
                    assert!(!headers.contains("x-plex-session-identifier:"));
                    assert!(!query.contains_key("offline"));
                }
                socket
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    .await
                    .unwrap();
            }
        });
        let config = crate::plex::PlexClientConfig {
            base_url: base,
            token: "dummy-native-token".into(),
            client_id: "primary-client".into(),
            ..Default::default()
        };
        let mut client = crate::plex::PlexClient::new(config.clone()).unwrap();
        client.library_scope = "original-library".into();
        let mut report = reports(&completed(1, 100_000), &labels()).remove(0);
        report.ended_at = 1_700_000_001;
        client
            .report_timeline(42, crate::plex::PlaybackState::Playing, 9000, 180000)
            .await
            .unwrap();
        for session in [&first, &first, &second] {
            assert!(submit(&report, &settings(), Some(&client), Some(session))
                .await
                .unwrap());
        }
        assert!(submit(&report, &settings(), Some(&client), None)
            .await
            .unwrap());
        // Recreating the HTTP client (reconnect/restart) retains installation identity.
        let replacement = crate::plex::PlexClient::new(config).unwrap();
        replacement
            .report_timeline(43, crate::plex::PlaybackState::Playing, 0, 180000)
            .await
            .unwrap();
        let mut legacy = serde_json::to_value(&report).unwrap();
        legacy.as_object_mut().unwrap().remove("ended_at");
        let legacy: Report = serde_json::from_value(legacy).unwrap();
        assert_eq!(legacy.ended_at, 0);
        assert!(submit(&legacy, &settings(), Some(&client), Some(&first))
            .await
            .unwrap());
        server.await.unwrap();
    }

    #[test]
    fn only_one_replay_worker_owns_a_queue_and_secondary_can_acquire_after_exit() {
        let directory = tempfile::tempdir().unwrap();
        let first = ReportingState::default();
        let second = ReportingState::default();
        assert!(first.owns_outbox(directory.path()).unwrap());
        assert!(!second.owns_outbox(directory.path()).unwrap());
        drop(first);
        assert!(second.owns_outbox(directory.path()).unwrap());
        #[cfg(unix)]
        {
            std::fs::remove_file(directory.path().join(".listening-outbox.lock")).unwrap();
            let replacement = ReportingState::default();
            assert!(replacement.owns_outbox(directory.path()).unwrap());
            assert!(second.owns_outbox(directory.path()).is_err());
        }
    }

    #[test]
    fn status_distinguishes_ordinary_delivery_repeated_failures_and_inactive_bindings() {
        let current = Binding::capture(&settings(), Some("original-library".into()));
        let mut queued: Vec<_> = reports(&completed(1, 100_000), &labels())
            .into_iter()
            .enumerate()
            .map(|(i, report)| (i.to_string(), report))
            .collect();
        let now = unix_time();
        let initial = classify_reports(&queued, &current, now);
        assert_eq!(initial.pending, 4);
        assert_eq!(initial.waiting_for_account, 0);
        assert_eq!(initial.retrying, 0);
        assert_eq!(initial.delayed, 0);
        queued[0].1.attempts = 1;
        queued[1].1.attempts = 2;
        queued[2].1.attempts = 3;
        queued[1].1.first_failed_at = now - SCROBBLE_NOTICE_DELAY;
        queued[2].1.first_failed_at = now - SCROBBLE_NOTICE_DELAY;
        assert_eq!(
            classify_reports(&queued, &current, now).delayed,
            1,
            "Plex delivery does not masquerade as scrobbling failure"
        );
        assert_eq!(
            classify_reports(&queued, &current, now - 1).delayed,
            0,
            "even repeated failures stay quiet for a full day"
        );
        let mut changed = settings();
        changed.lastfm_username = "replacement".into();
        changed.listenbrainz_enabled = false;
        let inactive = Binding::capture(&changed, Some("original-library".into()));
        let status = classify_reports(&queued, &inactive, now);
        assert_eq!(status.pending, 4);
        assert_eq!(status.waiting_for_account, 2);
        assert_eq!(status.retrying, 2);
        assert_eq!(
            status.delayed, 0,
            "only a long-running failure for the active service warrants attention"
        );
        let disconnected = classify_reports(&queued, &Binding::default(), now);
        assert_eq!(disconnected.waiting_for_account, 4);
        assert_eq!(
            disconnected.delayed, 0,
            "inactive bindings do not masquerade as network failures"
        );
        let serialized = serde_json::to_value(&status).unwrap();
        assert_eq!(serialized.as_object().unwrap().len(), 7);
        assert!(serialized
            .as_object()
            .unwrap()
            .values()
            .all(|value| value.is_number() || value.is_boolean() || value.is_null()));
    }

    #[tokio::test]
    async fn queued_external_listens_never_replay_to_a_changed_or_disabled_account() {
        let mut changed = settings();
        changed.lastfm_username = "replacement".into();
        changed.listenbrainz_username = "replacement".into();
        for report in reports(&completed(1, 100_000), &labels())
            .into_iter()
            .filter(|report| matches!(report.service, Service::Lastfm | Service::Listenbrainz))
        {
            assert!(!submit(&report, &changed, None, None).await.unwrap());
            let mut disabled = settings();
            disabled.lastfm_enabled = false;
            disabled.listenbrainz_enabled = false;
            assert!(!submit(&report, &disabled, None, None).await.unwrap());
        }
        let mut renewed = settings();
        renewed.lastfm_session_key = "renewed-secret".into();
        assert_eq!(
            Binding::capture(&settings(), None).lastfm,
            Binding::capture(&renewed, None).lastfm,
            "verified account binding survives credential renewal"
        );
    }
}
