//! Explicit, read-only integration measurement. Never runs in ordinary CI and
//! never opens the user's database, emits account data, or performs Plex writes.
use super::{freshness, resolver, store, transport};
use crate::plex::{PlexClient, PlexClientConfig, PlexSettings};
use rusqlite::{params, Connection};
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

const SCOPE: &str = "disposable-live-validation";
fn percentiles(mut values: Vec<f64>) -> serde_json::Value {
    values.sort_by(f64::total_cmp);
    if values.is_empty() {
        return serde_json::json!({"samples":0});
    }
    serde_json::json!({"samples":values.len(),"p50Ms":values[values.len()/2],"p95Ms":values[(values.len()-1)*95/100]})
}
struct Reads {
    running: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<Vec<f64>>>,
}
impl Drop for Reads {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Release);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "explicit read-only full Plex census; requires HIBIKI_MATCHING_LIVE_SETTINGS and may take minutes"]
async fn full_live_census_measures_requests_bytes_and_foreground_reads() {
    let path = std::env::var_os("HIBIKI_MATCHING_LIVE_SETTINGS")
        .expect("Set the private settings path explicitly");
    let original = std::fs::read(&path).expect("Private Plex settings are unavailable");
    assert!(original.len() <= 1024 * 1024);
    let settings = serde_json::from_slice::<PlexSettings>(&original)
        .ok()
        .expect("Private Plex settings are invalid");
    assert!(
        settings.section_id > 0
            && !settings.token.is_empty()
            && !settings.machine_identifier.is_empty(),
        "A connected library is required"
    );
    let built = PlexClient::new(PlexClientConfig {
        base_url: settings.base_url.clone(),
        token: settings.token.clone(),
        client_id: format!("hibiki-readonly-validation-{}", uuid::Uuid::new_v4()),
        ..Default::default()
    });
    let client = built
        .ok()
        .expect("The selected Plex endpoint is unavailable");
    let identity = client
        .get_identity()
        .await
        .ok()
        .expect("Plex identity read failed");
    assert!(
        identity.machine_identifier == settings.machine_identifier,
        "The selected server changed"
    );
    let library = client
        .get_section(settings.section_id)
        .await
        .ok()
        .expect("Selected library read failed");
    assert!(library.section_type == "artist", "Select a music library");
    assert!(
        settings.section_uuid.is_empty() || library.uuid.as_deref() == Some(&settings.section_uuid),
        "The selected library changed"
    );
    let modern = transport::modern(&identity.version);
    if let Ok(offset) = std::env::var("HIBIKI_MATCHING_LIVE_OFFSET") {
        let offset = offset.parse::<i64>().expect("Invalid diagnostic offset");
        assert!(offset >= 0);
        let kind = std::env::var("HIBIKI_MATCHING_LIVE_KIND").unwrap_or_else(|_| "album".into());
        let page = transport::page(&client, settings.section_id, &kind, offset, modern).await;
        match page {
            Ok(page) => println!(
                "live_page kind={kind} offset={offset} rows={} total={} bytes={}",
                page.rows.len(),
                page.total,
                page.bytes
            ),
            Err(reason) => panic!("Live page diagnostic: {reason}"),
        }
        return;
    }
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("disposable-index.sqlite");
    let conn = Connection::open(&database).unwrap();
    conn.pragma_update(None, "journal_mode", "WAL").unwrap();
    crate::db::schema::run_migrations(&conn).unwrap();
    store::ensure_scope(&conn, SCOPE).unwrap();
    let running = Arc::new(AtomicBool::new(true));
    let hot = Arc::new(Mutex::new(String::new()));
    let active = running.clone();
    let target = hot.clone();
    let read_path = database.clone();
    let mut reads = Reads {
        running: running.clone(),
        handle: Some(std::thread::spawn(move || {
            let conn =
                Connection::open_with_flags(read_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                    .unwrap();
            conn.busy_timeout(Duration::from_secs(1)).unwrap();
            let mut durations = Vec::new();
            while active.load(Ordering::Acquire) {
                let title = target.lock().unwrap().clone();
                let start = Instant::now();
                let _: i64 = conn.query_row("SELECT count(*) FROM matching_rows WHERE scope=?1 AND kind='track' AND title_key=?2 AND removed=0",
                params![SCOPE,title], |row| row.get(0)).unwrap();
                if durations.len() < 100000 {
                    durations.push(start.elapsed().as_secs_f64() * 1000.0);
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            durations
        })),
    };
    let foreground = Arc::new(Mutex::new((Vec::<f64>::new(), 0usize)));
    let artist_ids = Arc::new(Mutex::new(Vec::<i64>::new()));
    let foreground_task = {
        let active = running.clone();
        let samples = foreground.clone();
        let ids = artist_ids.clone();
        let client = client.clone();
        tokio::spawn(async move {
            let mut cursor = 0;
            while active.load(Ordering::Acquire) {
                let id = ids.lock().unwrap().get(cursor).copied();
                if let Some(id) = id {
                    cursor += 1;
                    let tick = Instant::now();
                    let success =
                        tokio::time::timeout(Duration::from_secs(15), client.get_artist(id))
                            .await
                            .is_ok_and(|result| result.is_ok());
                    let mut samples = samples.lock().unwrap();
                    if success {
                        samples.0.push(tick.elapsed().as_secs_f64() * 1000.0);
                    } else {
                        samples.1 += 1;
                    }
                }
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        })
    };
    let started = Instant::now();
    let mut progress = Instant::now();
    let mut tick = 0;
    let mut sources = Vec::new();
    let mut transactions = Vec::new();
    let mut listing_times = Vec::new();
    let mut completed = std::collections::HashSet::new();
    while completed.len() != 3 {
        assert!(
            started.elapsed() < Duration::from_secs(1800),
            "Live census exceeded its 30-minute bound"
        );
        assert!(
            std::fs::read(&path).ok().as_deref() == Some(original.as_slice()),
            "Settings changed; retire this read-only validation"
        );
        let kind = ["artist", "album", "track"][tick % 3];
        tick += 1;
        if completed.contains(kind) {
            continue;
        }
        let task = store::begin(&conn, SCOPE, kind, 0).unwrap();
        if task.phase == "complete" {
            completed.insert(kind);
            continue;
        }
        if task.phase == "prune" {
            store::prune_fenced(&conn, SCOPE, &task, 0, || {
                freshness::complete_census(&conn, SCOPE, kind, &task.generation)
            })
            .unwrap();
        } else {
            let began = Instant::now();
            let result = tokio::time::timeout(
                Duration::from_secs(30),
                transport::page(&client, settings.section_id, kind, task.offset, modern),
            )
            .await;
            assert!(
                result.as_ref().is_ok_and(|result| result.is_ok()),
                "Live listing failed for {kind}, phase={}, offset={}",
                task.phase,
                task.offset
            );
            let page = result.unwrap().unwrap();
            assert!(
                page.total <= 2000000,
                "Library exceeds this explicit validation's bound"
            );
            listing_times.push(began.elapsed().as_secs_f64() * 1000.0);
            if kind == "artist" && task.phase == "scan" && task.offset == 0 {
                *artist_ids.lock().unwrap() = page.rows.iter().map(|row| row.id).collect();
            }
            if kind == "track" && sources.len() < 16 {
                for row in &page.rows {
                    let source = resolver::Source {
                        id: format!("live-validation:{}", row.id),
                        kind: row.kind.clone(),
                        title: row.title.clone(),
                        artists: row.artists.clone(),
                        identifiers: row.identifiers.clone(),
                        album: row.album.clone(),
                        duration: row.duration,
                        explicit: row.explicit,
                        version: row.version.clone(),
                        date: row.date.clone(),
                        year: row.year,
                        release_type: row.release_type.clone(),
                        catalog: vec![],
                        track_list: vec![],
                    };
                    if resolver::validate(&source).is_ok() {
                        sources.push(source);
                        *hot.lock().unwrap() = row.title_key.clone();
                    }
                    if sources.len() == 16 {
                        break;
                    }
                }
            }
            let began = Instant::now();
            store::publish_fenced(
                &conn,
                SCOPE,
                &task,
                0,
                &page.rows,
                page.total,
                page.bytes,
                || freshness::record_census(&conn, SCOPE, kind, &task.generation, page.server_time),
            )
            .unwrap();
            transactions.push(began.elapsed().as_secs_f64() * 1000.0);
        }
        if progress.elapsed() >= Duration::from_secs(30) {
            let tasks = store::status(&conn, SCOPE).unwrap().tasks;
            println!(
                "live_census_progress {}",
                serde_json::json!({"seconds":started.elapsed().as_secs(),
                "kinds":tasks.iter().map(|task|serde_json::json!({"kind":task.kind,"phase":task.phase,"offset":task.offset,"count":task.count,"total":task.total,"requests":task.requests,"bytes":task.bytes})).collect::<Vec<_>>()})
            );
            progress = Instant::now();
        }
        // Match production's bounded background pace; no per-item detail sweep.
        tokio::time::sleep(Duration::from_millis(125)).await;
    }
    let scan_seconds = started.elapsed().as_secs_f64();
    running.store(false, Ordering::Release);
    foreground_task.abort();
    let read_times = reads.handle.take().unwrap().join().unwrap();
    let (foreground_times, foreground_errors) = foreground.lock().unwrap().clone();
    let status = store::status(&conn, SCOPE).unwrap();
    assert!(status.tasks.iter().all(|task| task.phase == "complete"));
    let mut counts = BTreeMap::new();
    for kind in ["artist", "album", "track"] {
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM matching_rows WHERE scope=?1 AND kind=?2 AND removed=0",
                params![SCOPE, kind],
                |row| row.get(0),
            )
            .unwrap();
        let task = status.tasks.iter().find(|task| task.kind == kind).unwrap();
        assert_eq!(Some(count), task.total);
        counts.insert(kind, count);
    }
    assert_eq!(sources.len(), 16);
    let requests: i64 = status.tasks.iter().map(|task| task.requests).sum();
    let bytes: i64 = status.tasks.iter().map(|task| task.bytes).sum();
    let database_bytes: i64 = conn
        .query_row(
            "SELECT page_count*page_size FROM pragma_page_count(),pragma_page_size()",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let mut lookup_times = Vec::new();
    let mut response_bytes = 0;
    let mut outcomes = BTreeMap::new();
    for pass in 0..100 {
        let tick = Instant::now();
        let tx = conn.unchecked_transaction().unwrap();
        let replies: Vec<_> = sources
            .iter()
            .map(|source| resolver::resolve(&tx, SCOPE, "live-validation", source, false).unwrap())
            .collect();
        tx.commit().unwrap();
        if pass > 0 {
            assert!(replies.iter().all(|reply| reply.cached));
        }
        if pass == 0 {
            for reply in &replies {
                *outcomes.entry(reply.status.clone()).or_insert(0usize) += 1;
            }
        }
        response_bytes = response_bytes.max(serde_json::to_vec(&replies).unwrap().len());
        lookup_times.push(tick.elapsed().as_secs_f64() * 1000.0);
    }
    assert!(
        std::fs::read(&path).ok().as_deref() == Some(original.as_slice()),
        "Selected context changed"
    );
    println!(
        "live_census_summary {}",
        serde_json::json!({"serverVersion":identity.version,"counts":counts,
        "seconds":scan_seconds,"listingCalls":requests,"listingBodyBytes":bytes,"databaseBytes":database_bytes,
        "listing":percentiles(listing_times),"pageTransaction":percentiles(transactions),"foregroundSql":percentiles(read_times),
        "foregroundArtist":percentiles(foreground_times),"foregroundErrors":foreground_errors,"batch16Lookup":percentiles(lookup_times),
        "maxBatchResponseBytes":response_bytes,"outcomes":outcomes,"warmListingCalls":0,
        "scope":"native transport/store and read-only artist requests; no renderer or audible claim"})
    );
    assert_eq!(foreground_errors, 0);
}
