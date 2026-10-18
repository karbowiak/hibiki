//! Shared native metadata storage. Provider modules own SWR; this module owns
//! persistence, retention, memory eviction, and single-flight initialization.
use moka::{future::Cache as AsyncCache, sync::Cache};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    future::Future,
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex},
    time::{Duration, Instant},
};

/// Application catalog freshness, respecting explicit HTTP cache restrictions.
pub(crate) struct HttpPolicy {
    pub store: bool,
    pub fresh_for: i64,
    pub stale_for: i64,
    pub adaptive: bool,
}

impl HttpPolicy {
    pub fn from_headers(headers: &reqwest::header::HeaderMap, fallback: i64, now: i64) -> Self {
        let directives: Vec<_> = headers
            .get_all(reqwest::header::CACHE_CONTROL)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .flat_map(|value| value.split(','))
            .map(|value| value.trim().to_ascii_lowercase())
            .collect();
        let flag = |name: &str| {
            directives.iter().any(|value| {
                value
                    .split('=')
                    .next()
                    .is_some_and(|value| value.trim() == name)
            })
        };
        let seconds = |name: &str| {
            directives
                .iter()
                .filter_map(|value| {
                    let (key, value) = value.split_once('=')?;
                    (key.trim() == name)
                        .then(|| value.trim().trim_matches('"').parse::<u64>().ok())
                        .flatten()
                })
                .min()
                .map(|value| value.min(i64::MAX as u64) as i64)
        };
        let date = |name| {
            headers
                .get(name)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| chrono::DateTime::parse_from_rfc2822(value).ok())
                .map(|value| value.timestamp())
        };
        let age = headers
            .get(reqwest::header::AGE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or(0)
            .max(0)
            .max(
                date(reqwest::header::DATE)
                    .map(|date| now.saturating_sub(date).max(0))
                    .unwrap_or(0),
            );
        let lifetime = seconds("max-age")
            .or_else(|| {
                date(reqwest::header::EXPIRES).map(|expires| {
                    expires
                        .saturating_sub(date(reqwest::header::DATE).unwrap_or(now))
                        .max(0)
                })
            })
            .unwrap_or(fallback);
        let stale = seconds("stale-while-revalidate").unwrap_or_else(|| {
            if flag("must-revalidate") {
                0
            } else {
                MAX_STALE_SECONDS
            }
        });
        Self {
            store: !flag("no-store"),
            adaptive: !flag("no-store")
                && !flag("no-cache")
                && !flag("must-revalidate")
                && seconds("max-age").is_none()
                && date(reqwest::header::EXPIRES).is_none(),
            fresh_for: if flag("no-cache") {
                0
            } else {
                lifetime.saturating_sub(age).max(0)
            },
            stale_for: if flag("no-cache") {
                0
            } else {
                lifetime
                    .saturating_add(stale.min(MAX_STALE_SECONDS))
                    .saturating_sub(age)
                    .max(0)
            },
        }
    }
}

const MAX_STALE_SECONDS: i64 = RETENTION;

const MAX_ENTRY: usize = 2 * 1024 * 1024;
const MAX_OWNER_ENTRIES: i64 = 2000;
const MAX_OWNER_BYTES: i64 = 32 * 1024 * 1024;
const MAX_BYTES: i64 = 128 * 1024 * 1024;
pub const RETENTION: i64 = 90 * 24 * 3600;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Entry {
    pub payload: Value,
    pub cached_at: i64,
    pub fresh_until: i64,
    pub retain_until: i64,
}
impl Entry {
    pub fn fresh(&self, now: i64) -> bool {
        self.cached_at <= now && now < self.fresh_until
    }
}
pub struct Write {
    pub payload: Value,
    pub tag: String,
    pub fresh_for: i64,
    pub retain_for: i64,
    pub store: bool,
}
struct FreshExpiry;
impl moka::Expiry<String, Arc<Entry>> for FreshExpiry {
    fn expire_after_create(&self, _: &String, value: &Arc<Entry>, _: Instant) -> Option<Duration> {
        Some(Duration::from_secs(
            value.fresh_until.saturating_sub(now()).max(0) as u64,
        ))
    }
    fn expire_after_update(
        &self,
        key: &String,
        value: &Arc<Entry>,
        at: Instant,
        _: Option<Duration>,
    ) -> Option<Duration> {
        self.expire_after_create(key, value, at)
    }
}
#[derive(Clone)]
pub struct Store {
    connections: Cache<PathBuf, Arc<Mutex<Connection>>>,
    retained: Cache<String, Arc<Entry>>,
    fresh: AsyncCache<String, Arc<Entry>>,
}
impl Default for Store {
    fn default() -> Self {
        Self {
            connections: Cache::builder()
                .max_capacity(8)
                .time_to_idle(Duration::from_secs(1800))
                .build(),
            retained: Cache::builder()
                .max_capacity(16 * 1024 * 1024)
                .weigher(|_: &String, value: &Arc<Entry>| {
                    serde_json::to_vec(&value.payload)
                        .map_or(MAX_ENTRY as u32, |bytes| bytes.len() as u32)
                })
                .time_to_idle(Duration::from_secs(600))
                .build(),
            fresh: AsyncCache::builder()
                .max_capacity(16 * 1024 * 1024)
                .weigher(|_: &String, value: &Arc<Entry>| {
                    serde_json::to_vec(&value.payload)
                        .map_or(MAX_ENTRY as u32, |bytes| bytes.len() as u32)
                })
                .expire_after(FreshExpiry)
                .build(),
        }
    }
}
pub static CACHE: LazyLock<Store> = LazyLock::new(Store::default);
pub fn now() -> i64 {
    chrono::Utc::now().timestamp()
}
fn identity(root: &Path, owner: &str, key: &str) -> String {
    format!("{}\0{owner}\0{key}", root.display())
}
impl Store {
    fn connection(&self, root: &Path) -> Result<Arc<Mutex<Connection>>, String> {
        self.connections.try_get_with(root.to_owned(), || {
            std::fs::create_dir_all(root).map_err(|_| "Cannot create metadata cache")?;
            let conn = Connection::open(root.join("metadata.sqlite")).map_err(|_| "Cannot open metadata cache")?;
            conn.busy_timeout(Duration::from_secs(2)).map_err(|_| "Cannot configure metadata cache")?;
            conn.execute_batch("PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS owners(owner TEXT PRIMARY KEY, epoch INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS entries(owner TEXT NOT NULL, cache_key TEXT NOT NULL, tag TEXT NOT NULL,
                    schema INTEGER NOT NULL, payload TEXT NOT NULL, bytes INTEGER NOT NULL, cached_at INTEGER NOT NULL,
                    fresh_until INTEGER NOT NULL, retain_until INTEGER NOT NULL, accessed_at INTEGER NOT NULL,
                    PRIMARY KEY(owner,cache_key));
                CREATE INDEX IF NOT EXISTS metadata_access ON entries(accessed_at);")
                .map_err(|_| "Cannot initialize metadata cache")?;
            Ok::<_, String>(Arc::new(Mutex::new(conn)))
        }).map_err(|error| (*error).clone())
    }
    pub fn epoch(&self, root: &Path, owner: &str) -> Result<u64, String> {
        let conn = self.connection(root)?;
        let conn = conn.lock().map_err(|_| "Metadata cache unavailable")?;
        conn.execute("INSERT OR IGNORE INTO owners(owner) VALUES(?1)", [owner])
            .map_err(|_| "Cannot open metadata owner")?;
        conn.query_row("SELECT epoch FROM owners WHERE owner=?1", [owner], |row| {
            row.get::<_, i64>(0).map(|value| value as u64)
        })
        .map_err(|_| "Cannot read metadata version".into())
    }
    pub fn read(&self, root: &Path, owner: &str, key: &str) -> Option<Arc<Entry>> {
        self.read_at(root, owner, key, now())
    }
    fn read_at(&self, root: &Path, owner: &str, key: &str, at: i64) -> Option<Arc<Entry>> {
        let id = identity(root, owner, key);
        if let Some(entry) = self
            .retained
            .get(&id)
            .filter(|entry| entry.cached_at <= at && entry.retain_until > at)
        {
            return Some(entry);
        }
        let conn = self.connection(root).ok()?;
        let conn = conn.lock().ok()?;
        let row: Option<(i64, String, i64, i64, i64)> = conn.query_row(
            "SELECT schema,payload,cached_at,fresh_until,retain_until FROM entries WHERE owner=?1 AND cache_key=?2",
            params![owner,key], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?))).optional().ok()?;
        let (schema, payload, cached_at, fresh_until, retain_until) = row?;
        let payload = serde_json::from_str(&payload)
            .ok()
            .filter(|_: &Value| schema == 1 && cached_at <= at && retain_until > at);
        let Some(payload) = payload else {
            let _ = conn.execute(
                "DELETE FROM entries WHERE owner=?1 AND cache_key=?2",
                params![owner, key],
            );
            return None;
        };
        let entry = Arc::new(Entry {
            payload,
            cached_at,
            fresh_until,
            retain_until,
        });
        let _ = conn.execute(
            "UPDATE entries SET accessed_at=?3 WHERE owner=?1 AND cache_key=?2",
            params![owner, key, now()],
        );
        self.retained.insert(id, entry.clone());
        Some(entry)
    }
    pub(crate) fn write(
        &self,
        root: &Path,
        owner: &str,
        key: &str,
        epoch: u64,
        value: Write,
    ) -> Result<Arc<Entry>, String> {
        crate::db::offline::check_payload(&value.payload, 0)?;
        let payload =
            serde_json::to_string(&value.payload).map_err(|_| "Cannot encode metadata")?;
        if payload.len() > MAX_ENTRY {
            return Err("Metadata page exceeds cache limit".into());
        }
        let conn = self.connection(root)?;
        let mut conn = conn.lock().map_err(|_| "Metadata cache unavailable")?;
        let tx = conn
            .transaction()
            .map_err(|_| "Cannot begin metadata write")?;
        let current: u64 = tx
            .query_row("SELECT epoch FROM owners WHERE owner=?1", [owner], |row| {
                row.get::<_, i64>(0).map(|value| value as u64)
            })
            .map_err(|_| "Metadata owner unavailable")?;
        if current != epoch {
            return Err("Metadata request was superseded".into());
        }
        let at = now();
        let entry = Arc::new(Entry {
            payload: value.payload,
            cached_at: at,
            fresh_until: at.saturating_add(if value.store {
                value.fresh_for.max(0)
            } else {
                0
            }),
            retain_until: at.saturating_add(value.retain_for.clamp(0, RETENTION)),
        });
        if value.store && entry.retain_until > at {
            tx.execute("INSERT INTO entries VALUES(?1,?2,?3,1,?4,?5,?6,?7,?8,?6)
                ON CONFLICT(owner,cache_key) DO UPDATE SET tag=excluded.tag,schema=1,payload=excluded.payload,bytes=excluded.bytes,
                cached_at=excluded.cached_at,fresh_until=excluded.fresh_until,retain_until=excluded.retain_until,accessed_at=excluded.accessed_at",
                params![owner,key,value.tag,payload,payload.len() as i64,at,entry.fresh_until,entry.retain_until]).map_err(|_| "Cannot persist metadata")?;
            tx.execute(
                "DELETE FROM entries WHERE retain_until<=?1 OR cached_at>?1",
                [at],
            )
            .map_err(|_| "Cannot expire metadata")?;
            // At most one new page was added; evict the least recently used
            // pages until both owner and global limits hold.
            loop {
                let (count, bytes): (i64, i64) = tx
                    .query_row(
                        "SELECT COUNT(*),COALESCE(SUM(bytes),0) FROM entries WHERE owner=?1",
                        [owner],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .map_err(|_| "Cannot size metadata")?;
                if count <= MAX_OWNER_ENTRIES && bytes <= MAX_OWNER_BYTES {
                    break;
                }
                tx.execute("DELETE FROM entries WHERE (owner,cache_key) IN (SELECT owner,cache_key FROM entries WHERE owner=?1 ORDER BY accessed_at,cache_key LIMIT 1)", [owner]).map_err(|_| "Cannot bound metadata")?;
            }
            loop {
                let (bytes, count): (i64, i64) = tx
                    .query_row(
                        "SELECT COALESCE(SUM(bytes),0),COUNT(*) FROM entries",
                        [],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .map_err(|_| "Cannot size metadata")?;
                if bytes <= MAX_BYTES && count <= 8000 {
                    break;
                }
                tx.execute("DELETE FROM entries WHERE (owner,cache_key) IN (SELECT owner,cache_key FROM entries ORDER BY accessed_at,owner,cache_key LIMIT 1)", []).map_err(|_| "Cannot bound metadata")?;
            }
        } else {
            tx.execute(
                "DELETE FROM entries WHERE owner=?1 AND cache_key=?2",
                params![owner, key],
            )
            .map_err(|_| "Cannot discard restricted metadata")?;
        }
        tx.commit().map_err(|_| "Cannot commit metadata")?;
        if value.store {
            self.retained
                .insert(identity(root, owner, key), entry.clone());
        } else {
            self.retained.invalidate(&identity(root, owner, key));
        }
        Ok(entry)
    }
    /// Moka runs one initializer per versioned key and shares its result with
    /// concurrent callers. Invalidation changes the version before a new fetch.
    pub async fn fetch<F>(
        &self,
        root: PathBuf,
        owner: String,
        key: String,
        epoch: u64,
        fetch: F,
    ) -> Result<Arc<Entry>, String>
    where
        F: Future<Output = Result<Write, String>>,
    {
        let id = format!("{}\0{epoch}", identity(&root, &owner, &key));
        self.fresh
            .try_get_with(id, async {
                let value = fetch.await?;
                let uncached = Arc::new(Entry {
                    payload: value.payload.clone(),
                    cached_at: now(),
                    fresh_until: 0,
                    retain_until: 0,
                });
                // Persistence is bounded but uses a blocking SQLite connection.
                let store = self.clone();
                let saved = tokio::task::spawn_blocking(move || {
                    store.write(&root, &owner, &key, epoch, value)
                })
                .await
                .map_err(|_| "Metadata writer stopped".to_owned())?;
                match saved {
                    Err(error) if error == "Metadata request was superseded" => Err(error),
                    Err(_) => Ok(uncached), // Optional caching must not hide a valid provider response.
                    Ok(entry) => Ok(entry),
                }
            })
            .await
            .map_err(|error| (*error).clone())
    }
    pub async fn forget_fresh(&self, root: &Path, owner: &str, key: &str, epoch: u64) {
        self.fresh
            .invalidate(&format!("{}\0{epoch}", identity(root, owner, key)))
            .await;
    }
    /// A provider selects affected keys and may repair retained payloads. None
    /// removes a confirmed obsolete reference; Some retains a stale snapshot.
    pub fn edit(
        &self,
        root: &Path,
        owner: &str,
        mut edit: impl FnMut(&str, &str, &mut Value) -> bool,
    ) -> Result<(), String> {
        let conn = self.connection(root)?;
        let mut conn = conn.lock().map_err(|_| "Metadata cache unavailable")?;
        let tx = conn
            .transaction()
            .map_err(|_| "Cannot invalidate metadata")?;
        tx.execute("INSERT INTO owners(owner,epoch) VALUES(?1,1) ON CONFLICT(owner) DO UPDATE SET epoch=epoch+1", [owner]).map_err(|_| "Cannot version metadata")?;
        let rows = {
            let mut query = tx
                .prepare("SELECT cache_key,tag,payload FROM entries WHERE owner=?1")
                .map_err(|_| "Cannot read metadata")?;
            let rows = query
                .query_map([owner], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(|_| "Cannot read metadata")?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| "Cannot read metadata")?;
            rows
        };
        for (key, tag, payload) in rows {
            let Ok(mut value) = serde_json::from_str::<Value>(&payload) else {
                tx.execute(
                    "DELETE FROM entries WHERE owner=?1 AND cache_key=?2",
                    params![owner, key],
                )
                .map_err(|_| "Cannot discard corrupt metadata")?;
                continue;
            };
            if edit(&key, &tag, &mut value) {
                if value.is_null() {
                    tx.execute(
                        "DELETE FROM entries WHERE owner=?1 AND cache_key=?2",
                        params![owner, key],
                    )
                    .map_err(|_| "Cannot remove metadata")?;
                } else {
                    let payload =
                        serde_json::to_string(&value).map_err(|_| "Cannot repair metadata")?;
                    tx.execute("UPDATE entries SET payload=?3,bytes=?4,fresh_until=0 WHERE owner=?1 AND cache_key=?2", params![owner,key,payload,payload.len() as i64]).map_err(|_| "Cannot expire metadata")?;
                }
            }
        }
        tx.commit()
            .map_err(|_| "Cannot commit metadata invalidation")?;
        self.retained.invalidate_all();
        // Versioned flight keys prevent older completions being read/persisted.
        self.fresh.invalidate_all();
        Ok(())
    }
    pub fn clear(&self, root: &Path, owner: &str) -> Result<(), String> {
        self.edit(root, owner, |_, _, value| {
            *value = Value::Null;
            true
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    fn value(title: &str) -> Write {
        Write {
            payload: serde_json::json!({"title":title}),
            tag: "album".into(),
            fresh_for: 60,
            retain_for: RETENTION,
            store: true,
        }
    }
    #[test]
    fn restart_preserves_age_expiry_retains_stale_and_corrupt_rows_recover() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::default();
        let epoch = store.epoch(directory.path(), "plex-one").unwrap();
        let saved = store
            .write(directory.path(), "plex-one", "album", epoch, value("Saved"))
            .unwrap();
        drop(store);
        let reopened = Store::default();
        let at = saved.cached_at;
        assert!(reopened
            .read_at(directory.path(), "plex-one", "album", at + 1)
            .unwrap()
            .fresh(at + 1));
        assert!(!reopened
            .read_at(directory.path(), "plex-one", "album", at + 61)
            .unwrap()
            .fresh(at + 61));
        assert!(reopened
            .read_at(directory.path(), "plex-one", "album", at + RETENTION)
            .is_none());
        reopened
            .write(directory.path(), "plex-one", "album", epoch, value("Again"))
            .unwrap();
        reopened.retained.invalidate_all();
        let conn = reopened.connection(directory.path()).unwrap();
        conn.lock()
            .unwrap()
            .execute("UPDATE entries SET payload='broken'", [])
            .unwrap();
        assert!(reopened
            .read(directory.path(), "plex-one", "album")
            .is_none());
        assert!(reopened
            .write(
                directory.path(),
                "plex-one",
                "album",
                epoch,
                value("Recovered")
            )
            .is_ok());
    }
    #[tokio::test]
    async fn concurrent_misses_coalesce_and_invalidation_retires_a_delayed_refresh() {
        let directory = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::default());
        let epoch = store.epoch(directory.path(), "ytmusic-one").unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let tasks = (0..20)
            .map(|_| {
                let store = store.clone();
                let root = directory.path().to_owned();
                let calls = calls.clone();
                tokio::spawn(async move {
                    store
                        .fetch(root, "ytmusic-one".into(), "album".into(), epoch, async {
                            calls.fetch_add(1, Ordering::SeqCst);
                            tokio::time::sleep(Duration::from_millis(10)).await;
                            Ok(value("One response"))
                        })
                        .await
                        .unwrap()
                })
            })
            .collect::<Vec<_>>();
        for task in tasks {
            assert_eq!(task.await.unwrap().payload["title"], "One response");
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        store
            .edit(directory.path(), "ytmusic-one", |_, _, _| true)
            .unwrap();
        let epoch = store.epoch(directory.path(), "ytmusic-one").unwrap();
        let (started, waiting) = tokio::sync::oneshot::channel();
        let (release, ready) = tokio::sync::oneshot::channel();
        let old = {
            let store = store.clone();
            let root = directory.path().to_owned();
            tokio::spawn(async move {
                store
                    .fetch(root, "ytmusic-one".into(), "album".into(), epoch, async {
                        started.send(()).unwrap();
                        ready.await.unwrap();
                        Ok(value("Old"))
                    })
                    .await
            })
        };
        waiting.await.unwrap();
        store
            .edit(directory.path(), "ytmusic-one", |_, _, _| true)
            .unwrap();
        release.send(()).unwrap();
        assert!(old.await.unwrap().is_err());
        let retained = store
            .read(directory.path(), "ytmusic-one", "album")
            .unwrap();
        assert_eq!(retained.payload["title"], "One response");
        assert!(!retained.fresh(now()));
        let epoch = store.epoch(directory.path(), "ytmusic-one").unwrap();
        let failed = store
            .fetch(
                directory.path().into(),
                "ytmusic-one".into(),
                "album".into(),
                epoch,
                async { Err("Transient provider failure".into()) },
            )
            .await;
        assert!(failed.is_err());
        assert_eq!(
            store
                .read(directory.path(), "ytmusic-one", "album")
                .unwrap()
                .payload["title"],
            "One response"
        );
    }
    #[test]
    fn shared_store_isolates_owners_and_rejects_credentials_and_restricted_responses() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::default();
        for owner in ["plex-one", "ytmusic-one", "ytmusic-two"] {
            let epoch = store.epoch(directory.path(), owner).unwrap();
            store
                .write(directory.path(), owner, "same", epoch, value(owner))
                .unwrap();
        }
        store.clear(directory.path(), "ytmusic-one").unwrap();
        assert!(store
            .read(directory.path(), "ytmusic-one", "same")
            .is_none());
        assert_eq!(
            store
                .read(directory.path(), "plex-one", "same")
                .unwrap()
                .payload["title"],
            "plex-one"
        );
        assert_eq!(
            store
                .read(directory.path(), "ytmusic-two", "same")
                .unwrap()
                .payload["title"],
            "ytmusic-two"
        );
        let epoch = store.epoch(directory.path(), "plex-one").unwrap();
        let mut forbidden = value("secret");
        forbidden.payload = serde_json::json!({"accessToken":"secret"});
        assert!(store
            .write(directory.path(), "plex-one", "bad", epoch, forbidden)
            .is_err());
        let mut restricted = value("restricted");
        restricted.store = false;
        store
            .write(directory.path(), "plex-one", "same", epoch, restricted)
            .unwrap();
        assert!(store.read(directory.path(), "plex-one", "same").is_none());
    }
    #[test]
    fn owner_entry_count_is_bounded_and_cache_read_timings_are_measured() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::default();
        let epoch = store.epoch(directory.path(), "plex-one").unwrap();
        let started = Instant::now();
        for index in 0..2001 {
            store
                .write(
                    directory.path(),
                    "plex-one",
                    &index.to_string(),
                    epoch,
                    value("Album"),
                )
                .unwrap();
        }
        let writes = started.elapsed();
        let count: i64 = store
            .connection(directory.path())
            .unwrap()
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM entries", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 2000);
        let reopened = Store::default();
        let started = Instant::now();
        assert!(reopened
            .read(directory.path(), "plex-one", "2000")
            .is_some());
        let disk = started.elapsed();
        let started = Instant::now();
        for _ in 0..1000 {
            assert!(reopened
                .read(directory.path(), "plex-one", "2000")
                .is_some());
        }
        eprintln!("metadata cache: 2001 bounded writes {writes:?}, reopened read {disk:?}, 1000 memory reads {:?}",started.elapsed());
    }
}
