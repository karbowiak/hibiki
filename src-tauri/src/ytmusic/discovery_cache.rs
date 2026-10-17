//! Parsed catalog pages only: no cookies, request headers or media URLs.
use super::discovery::BrowsePage;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{atomic::{AtomicU64, Ordering}, Arc, Mutex, Weak};

const MAX_STALE_SECONDS: i64 = 7 * 24 * 60 * 60;
const MAX_ENTRY_BYTES: u64 = 2 * 1024 * 1024;
const MAX_CACHE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_ENTRIES: usize = 128;

#[derive(Serialize, Deserialize)]
struct Entry {
    version: u8,
    browse_id: String,
    cached_at: i64,
    fresh_until: i64,
    stale_until: i64,
    page: BrowsePage,
}

/// Application catalog freshness, respecting explicit HTTP cache restrictions.
pub(super) struct Policy {
    pub store: bool,
    fresh_for: i64,
    stale_for: i64,
}

impl Policy {
    pub fn from_headers(headers: &reqwest::header::HeaderMap, fallback: i64, now: i64) -> Self {
        let directives: Vec<_> = headers.get_all(reqwest::header::CACHE_CONTROL).iter()
            .filter_map(|value| value.to_str().ok()).flat_map(|value| value.split(','))
            .map(|value| value.trim().to_ascii_lowercase()).collect();
        let flag = |name: &str| directives.iter().any(|value| value.split('=').next().is_some_and(|value| value.trim() == name));
        let seconds = |name: &str| directives.iter().filter_map(|value| {
            let (key, value) = value.split_once('=')?;
            (key.trim() == name).then(|| value.trim().trim_matches('"').parse::<u64>().ok()).flatten()
        }).min().map(|value| value.min(i64::MAX as u64) as i64);
        let date = |name| headers.get(name).and_then(|value| value.to_str().ok())
            .and_then(|value| chrono::DateTime::parse_from_rfc2822(value).ok()).map(|value| value.timestamp());
        let age = headers.get(reqwest::header::AGE).and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<i64>().ok()).unwrap_or(0).max(0)
            .max(date(reqwest::header::DATE).map(|date| now.saturating_sub(date).max(0)).unwrap_or(0));
        let lifetime = seconds("max-age").or_else(|| date(reqwest::header::EXPIRES)
            .map(|expires| expires.saturating_sub(date(reqwest::header::DATE).unwrap_or(now)).max(0)))
            .unwrap_or(fallback);
        let stale = seconds("stale-while-revalidate").unwrap_or_else(|| if flag("must-revalidate") { 0 } else { MAX_STALE_SECONDS });
        Self { store: !flag("no-store"),
            fresh_for: if flag("no-cache") { 0 } else { lifetime.saturating_sub(age).max(0) },
            stale_for: if flag("no-cache") { 0 } else { lifetime.saturating_add(stale.min(MAX_STALE_SECONDS)).saturating_sub(age).max(0) } }
    }
}

pub(super) struct Saved {
    pub page: BrowsePage,
    pub fresh: bool,
}

#[derive(Default)]
struct Disk {
    epoch: AtomicU64,
    io: Mutex<()>,
}

#[derive(Default)]
pub(super) struct Cache {
    disk: Arc<Disk>,
    requests: Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>,
    retries: Mutex<HashMap<String, i64>>,
}

pub(super) fn key(owner: &str, id: &str, params: Option<&str>, continuation: Option<&str>) -> String {
    let identity = serde_json::to_vec(&("v6", owner, id, params, continuation)).expect("catalog cache identity");
    hex::encode(Sha256::digest(identity))
}

impl Cache {
    pub fn epoch(&self) -> u64 { self.disk.epoch.load(Ordering::SeqCst) }

    /// A failed background refresh must not create a request loop on each read.
    pub fn begin_refresh(&self, key: &str) -> bool {
        let now = super::now();
        let mut retries = self.retries.lock().unwrap_or_else(|error| error.into_inner());
        retries.retain(|_, until| *until > now);
        if retries.contains_key(key) { return false; }
        if retries.len() >= MAX_ENTRIES { return false; }
        retries.insert(key.into(), now + 30);
        true
    }

    /// Coalesce the detail page and queue's simultaneous reads of the same mix.
    pub fn request(&self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut requests = self.requests.lock().unwrap_or_else(|error| error.into_inner());
        requests.retain(|_, value| value.strong_count() > 0);
        if let Some(request) = requests.get(key).and_then(Weak::upgrade) { return request; }
        let request = Arc::new(tokio::sync::Mutex::new(()));
        requests.insert(key.into(), Arc::downgrade(&request));
        request
    }

    pub async fn read(&self, path: PathBuf) -> Option<Saved> {
        tokio::task::spawn_blocking(move || read(&path, super::now())).await.ok().flatten()
    }

    pub async fn write(&self, directory: PathBuf, key: String, browse_id: String, page: BrowsePage, policy: Policy, epoch: u64) {
        let disk = self.disk.clone();
        let _ = tokio::task::spawn_blocking(move || {
            let Ok(_guard) = disk.io.lock() else { return; };
            if disk.epoch.load(Ordering::SeqCst) != epoch { return; }
            if policy.store {
                let _ = write(&directory, &key, &browse_id, page, policy, super::now());
            } else { let _ = std::fs::remove_file(directory.join(format!("{key}.json"))); }
        }).await;
    }

    /// Retire pre-mutation writes, invalidate liked-playlist cursors, and patch
    /// only this song's public state in the other saved catalog pages.
    pub async fn song_like_changed(&self, directory: PathBuf, video_id: String, liked: bool, epoch: u64) {
        let disk = self.disk.clone();
        let _ = tokio::task::spawn_blocking(move || {
            let Ok(_guard) = disk.io.lock() else { return; };
            if disk.epoch.load(Ordering::SeqCst) != epoch { return; }
            disk.epoch.fetch_add(1, Ordering::SeqCst);
            let Ok(files) = std::fs::read_dir(&directory) else { return; };
            for file in files.filter_map(Result::ok) {
                let path = file.path();
                if path.extension().and_then(|ext| ext.to_str()) != Some("json") { continue; }
                let Some(mut entry) = read_entry(&path) else { continue; };
                if entry.browse_id == "VLLM" {
                    let _ = std::fs::remove_file(path);
                } else if entry.page.song_like_changed(&video_id, liked) && persist(&path, &entry).is_none() {
                    let _ = std::fs::remove_file(path);
                }
            }
        }).await;
    }

    pub async fn clear(&self, directory: PathBuf) {
        self.disk.epoch.fetch_add(1, Ordering::SeqCst);
        self.retries.lock().unwrap_or_else(|error| error.into_inner()).clear();
        let disk = self.disk.clone();
        let _ = tokio::task::spawn_blocking(move || {
            let Ok(_guard) = disk.io.lock() else { return; };
            let _ = std::fs::remove_dir_all(directory);
        }).await;
    }
}

fn read_entry(path: &Path) -> Option<Entry> {
    let file = std::fs::File::open(path).ok()?;
    if file.metadata().ok()?.len() > MAX_ENTRY_BYTES { return None; }
    let mut bytes = Vec::new();
    file.take(MAX_ENTRY_BYTES + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > MAX_ENTRY_BYTES { return None; }
    serde_json::from_slice(&bytes).ok()
}

fn read(path: &Path, now: i64) -> Option<Saved> {
    let entry = read_entry(path)?;
    (entry.version == 2 && entry.cached_at <= now && now < entry.stale_until)
        .then_some(Saved { page: entry.page, fresh: now < entry.fresh_until })
}

fn persist(path: &Path, entry: &Entry) -> Option<()> {
    let bytes = serde_json::to_vec(entry).ok()?;
    if bytes.len() as u64 > MAX_ENTRY_BYTES { return None; }
    let directory = path.parent()?;
    std::fs::create_dir_all(directory).ok()?;
    let mut file = tempfile::NamedTempFile::new_in(directory).ok()?;
    file.write_all(&bytes).ok()?;
    file.persist(path).ok()?;
    Some(())
}

fn write(directory: &Path, key: &str, browse_id: &str, page: BrowsePage, policy: Policy, now: i64) -> Option<()> {
    persist(&directory.join(format!("{key}.json")), &Entry { version: 2, browse_id: browse_id.into(), cached_at: now,
        fresh_until: now.saturating_add(policy.fresh_for), stale_until: now.saturating_add(policy.stale_for), page })?;
    trim(directory, MAX_ENTRIES, MAX_CACHE_BYTES);
    Some(())
}

fn trim(directory: &Path, max_entries: usize, max_bytes: u64) {
    let Ok(files) = std::fs::read_dir(directory) else { return; };
    let mut entries: Vec<_> = files.filter_map(Result::ok).filter_map(|file| {
        let path = file.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") { return None; }
        let metadata = file.metadata().ok()?;
        Some((path, metadata.len(), metadata.modified().ok()?))
    }).collect();
    entries.sort_by_key(|(_, _, modified)| std::cmp::Reverse(*modified));
    let mut size = 0_u64;
    for (index, (path, bytes, _)) in entries.into_iter().enumerate() {
        size = size.saturating_add(bytes);
        if index >= max_entries || size > max_bytes { let _ = std::fs::remove_file(path); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn page() -> BrowsePage {
        serde_json::from_value(serde_json::json!({"title":"My Mix 1","items":[],"hubs":[],"continuation":"next-page"})).unwrap()
    }
    fn policy() -> Policy { Policy::from_headers(&reqwest::header::HeaderMap::new(), 900, 1000) }
    #[test]
    fn catalog_pages_survive_reopening_then_become_stale_before_expiring() {
        let directory = tempfile::tempdir().unwrap();
        let key = key("connection", "VLRDmix", None, None);
        let path = directory.path().join(format!("{key}.json"));
        write(directory.path(), &key, "VLRDmix", page(), policy(), 1000).unwrap();
        let saved = read(&path, 1001).unwrap();
        assert!(saved.fresh);
        assert_eq!(serde_json::to_value(saved.page).unwrap()["continuation"], "next-page");
        assert!(read(&path, 999).is_none());
        assert!(!read(&path, 1900).unwrap().fresh);
        assert!(read(&path, 1900 + MAX_STALE_SECONDS).is_none());
        std::fs::write(&path, b"incomplete JSON").unwrap();
        assert!(read(&path, 1001).is_none());
    }
    #[test]
    fn keys_separate_connections_filters_and_pages_and_storage_is_bounded() {
        let first = key("one", "VLRDmix", None, None);
        for other in [key("two", "VLRDmix", None, None), key("one", "VLRDmix", Some("filter"), None),
            key("one", "VLRDmix", None, Some("next-page"))] { assert_ne!(first, other); }
        let directory = tempfile::tempdir().unwrap();
        for index in 0..4 { write(directory.path(), &index.to_string(), "VLRDmix", page(), policy(), 1000).unwrap(); }
        trim(directory.path(), 2, u64::MAX);
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 2);
        trim(directory.path(), 2, 1);
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }
    #[tokio::test]
    async fn disconnect_clears_saved_pages_and_parallel_readers_share_a_request() {
        let cache = Cache::default();
        let first = cache.request("same-page");
        assert!(Arc::ptr_eq(&first, &cache.request("same-page")));
        assert!(!Arc::ptr_eq(&first, &cache.request("another-page")));
        let directory = tempfile::tempdir().unwrap();
        let epoch = cache.epoch();
        cache.write(directory.path().to_owned(), "page".into(), "VLRDmix".into(), page(), policy(), epoch).await;
        assert!(cache.read(directory.path().join("page.json")).await.is_some());
        cache.clear(directory.path().to_owned()).await;
        cache.write(directory.path().to_owned(), "page".into(), "VLRDmix".into(), page(), policy(), epoch).await;
        assert!(cache.read(directory.path().join("page.json")).await.is_none());
    }
    #[test]
    fn provider_cache_lifetimes_override_defaults_and_preserve_restrictions() {
        use reqwest::header::*;
        let mut headers = HeaderMap::new();
        headers.insert(CACHE_CONTROL, HeaderValue::from_static("private, max-age=120, stale-while-revalidate=600"));
        headers.insert(AGE, HeaderValue::from_static("30"));
        let policy = Policy::from_headers(&headers, 900, 1000);
        assert_eq!((policy.fresh_for, policy.stale_for), (90, 690));
        headers.insert(CACHE_CONTROL, HeaderValue::from_static("max-age=60, must-revalidate"));
        let policy = Policy::from_headers(&headers, 900, 1000);
        assert_eq!((policy.fresh_for, policy.stale_for), (30, 30));
        headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-cache"));
        let policy = Policy::from_headers(&headers, 900, 1000);
        assert_eq!((policy.fresh_for, policy.stale_for), (0, 0));
        headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
        assert!(!Policy::from_headers(&headers, 900, 1000).store);
    }
    #[tokio::test]
    async fn a_like_patches_saved_songs_invalidates_liked_cursors_and_retires_old_writes() {
        let cache = Cache::default();
        let directory = tempfile::tempdir().unwrap();
        let now = super::super::now();
        let page: BrowsePage = serde_json::from_value(serde_json::json!({"title":"Album","items":[
            {"id":"abcdefghijk","kind":"song","title":"Song","artist":"Artist","description":"","liked":false},
            {"id":"lmnopqrstuv","kind":"song","title":"Other","artist":"Artist","description":"","liked":false}
        ],"hubs":[]})).unwrap();
        write(directory.path(), "album", "MPREalbum", page.clone(), policy(), now).unwrap();
        for key in ["liked-head", "liked-next"] {
            write(directory.path(), key, "VLLM", page.clone(), policy(), now).unwrap();
        }
        let epoch = cache.epoch();
        cache.song_like_changed(directory.path().to_owned(), "abcdefghijk".into(), true, epoch).await;
        assert!(!directory.path().join("liked-head.json").exists());
        assert!(!directory.path().join("liked-next.json").exists());
        let saved = read(&directory.path().join("album.json"), now).unwrap();
        assert_eq!(saved.page.items[0].liked, Some(true));
        assert_eq!(saved.page.items[1].liked, Some(false));
        cache.write(directory.path().to_owned(), "old-result".into(), "VLLM".into(), page, policy(), epoch).await;
        assert!(!directory.path().join("old-result.json").exists());
    }
    #[test]
    fn expires_and_date_are_used_when_max_age_is_absent() {
        use reqwest::header::*;
        let mut headers = HeaderMap::new();
        headers.insert(DATE, HeaderValue::from_static("Sat, 17 Oct 2026 12:00:00 GMT"));
        headers.insert(EXPIRES, HeaderValue::from_static("Sat, 17 Oct 2026 12:10:00 GMT"));
        let now = chrono::DateTime::parse_from_rfc2822("Sat, 17 Oct 2026 12:01:00 GMT").unwrap().timestamp();
        assert_eq!(Policy::from_headers(&headers, 900, now).fresh_for, 540);
    }
}
