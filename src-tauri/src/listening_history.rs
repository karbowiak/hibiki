//! Actual native listens, retained locally before remote reporting or webview teardown.
use crate::audio_engine::event::{EngineEvent, TrackEndReason};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

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
    Some(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&[service, &identity]).unwrap())
    ))
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
}
impl NativeHistory {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            session: uuid::Uuid::new_v4().to_string(),
            journal: Mutex::new(Journal::default()),
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
                            let _ = reply
                                .send(history.retain_pending(&app).and_then(|_| history.pending()));
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
            journal.completed.insert(end.playback_id, completed);
        }
    }
    fn retain_pending(&self, app: &tauri::AppHandle) -> Result<(), String> {
        use tauri::Manager;
        let records = {
            let journal = self
                .journal
                .lock()
                .map_err(|_| "Listening history unavailable")?;
            journal.completed.values().cloned().collect::<Vec<_>>()
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
    pub fn acknowledge(&self, id: u64) {
        let mut journal = self
            .journal
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        journal.completed.remove(&id);
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
    attempts: u32,
    #[serde(default)]
    retry_at: u64,
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
            attempts: 0,
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
fn timeline_client_identifier(primary: &str, job: &str, current_shutdown: bool) -> String {
    use sha2::{Digest, Sha256};
    if current_shutdown {
        primary.to_owned()
    } else {
        format!("{primary}-history-{:x}", Sha256::digest(job.as_bytes()))
    }
}
async fn submit(
    report: &Report,
    settings: &crate::plex::PlexSettings,
    client: Option<&crate::plex::PlexClient>,
    timeline_client: Option<&str>,
) -> Result<bool, String> {
    let current = Binding::capture(settings, client.map(|client| client.library_scope.clone()));
    let labels = &report.labels;
    match report.service {
        Service::PlexTimeline | Service::PlexPlayed => {
            if current.plex.as_deref() != Some(&report.binding) {
                return Ok(false);
            }
            let client = client.ok_or("Original Plex library is not connected")?;
            if matches!(report.service, Service::PlexTimeline) {
                client
                    .report_timeline(
                        report.end.rating_key,
                        crate::plex::PlaybackState::Stopped,
                        report.end.position_ms.min(i64::MAX as u64) as i64,
                        report.end.duration_ms.min(i64::MAX as u64) as i64,
                        Some(timeline_client.unwrap_or(&client.client_id)),
                    )
                    .await
                    .map_err(|_| "Plex progress is retained for retry")?;
            } else {
                client
                    .mark_played(report.end.rating_key)
                    .await
                    .map_err(|_| "Plex played status is retained for retry")?;
            }
        }
        Service::Lastfm => {
            if current.lastfm.as_deref() != Some(&report.binding) {
                return Ok(false);
            }
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
            if current.listenbrainz.as_deref() != Some(&report.binding) {
                return Ok(false);
            }
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
        let timeline_client = client
            .as_ref()
            .map(|client| timeline_client_identifier(&client.client_id, &key, primary));
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(8),
            submit(
                &report,
                &settings,
                client.as_ref(),
                timeline_client.as_deref(),
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

#[derive(Serialize)]
pub struct ListeningStatus {
    pub pending: usize,
    pub unretained: usize,
}
#[tauri::command]
pub fn listening_history_status(
    engine: tauri::State<'_, crate::audio_engine::bridge::AudioEngineState>,
    db: tauri::State<'_, crate::db::DbState>,
) -> Result<ListeningStatus, String> {
    let unretained = engine.0.history.pending()?.len();
    let conn = db.0.lock().map_err(|_| "Listening database unavailable")?;
    Ok(ListeningStatus {
        pending: count_reports(&conn)?,
        unretained,
    })
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
    async fn historical_progress_uses_a_separate_actual_header_and_shutdown_uses_primary() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let historical = timeline_client_identifier("primary-client", "retained-job", false);
        assert_ne!(historical, "primary-client");
        assert_eq!(
            timeline_client_identifier("primary-client", "retained-job", true),
            "primary-client"
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let expected = historical.clone();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = [0_u8; 4096];
            let size = socket.read(&mut bytes).await.unwrap();
            let request = String::from_utf8_lossy(&bytes[..size]).to_lowercase();
            assert!(request.contains(&format!("x-plex-client-identifier: {}", expected)));
            assert!(request.contains(&format!("clientidentifier={}", expected)));
            assert!(request.contains("x-plex-token: dummy-native-token"));
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await
                .unwrap();
        });
        let client = crate::plex::PlexClient::new(crate::plex::PlexClientConfig {
            base_url: base,
            token: "dummy-native-token".into(),
            client_id: "primary-client".into(),
            ..Default::default()
        })
        .unwrap();
        client
            .report_timeline(
                42,
                crate::plex::PlaybackState::Stopped,
                9000,
                180000,
                Some(&historical),
            )
            .await
            .unwrap();
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
