//! YTM freshness and mutation policy over the shared native metadata cache.
use super::discovery::BrowsePage;
#[cfg(test)]
use crate::metadata_cache::Write;
use crate::metadata_cache::{CACHE, RETENTION};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
const MAX_STALE_SECONDS: i64 = RETENTION;
pub(super) use crate::metadata_cache::HttpPolicy as Policy;
impl Policy {
    pub fn for_page(mut self, id: &str, page: &BrowsePage, now: i64) -> Self {
        if self.adaptive && (id.starts_with("MPRE") || id == "hibiki_song_metadata") {
            use chrono::Datelike;
            let current_year = chrono::DateTime::from_timestamp(now, 0)
                .map(|date| date.year())
                .unwrap_or(0);
            let years: Vec<_> = page.items.iter().filter_map(|item| item.year).collect();
            self.fresh_for =
                if !years.is_empty() && years.iter().all(|year| *year < current_year - 1) {
                    30 * 24 * 3600
                } else {
                    24 * 3600
                };
            self.stale_for = self.fresh_for + MAX_STALE_SECONDS;
        }
        self
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
pub(super) struct Cache {
    disk: Arc<Disk>,
    requests: moka::sync::Cache<String, Arc<tokio::sync::Mutex<()>>>,
    retries: moka::sync::Cache<String, (u32, i64)>,
}
impl Default for Cache {
    fn default() -> Self {
        Self {
            disk: Arc::new(Disk::default()),
            requests: moka::sync::Cache::builder()
                .max_capacity(2048)
                .time_to_idle(std::time::Duration::from_secs(300))
                .build(),
            retries: moka::sync::Cache::builder()
                .max_capacity(2048)
                .time_to_idle(std::time::Duration::from_secs(1800))
                .build(),
        }
    }
}
pub(super) fn key(
    owner: &str,
    id: &str,
    params: Option<&str>,
    continuation: Option<&str>,
) -> String {
    let identity = serde_json::to_vec(&("v7", owner, id, params, continuation))
        .expect("catalog cache identity");
    hex::encode(Sha256::digest(identity))
}
impl Cache {
    pub fn epoch(&self) -> u64 {
        self.disk.epoch.load(Ordering::SeqCst)
    }
    pub fn begin_refresh(&self, key: &str) -> bool {
        // Admission is serialized by the per-key request guard.
        if self
            .retries
            .get(key)
            .is_some_and(|(_, until)| until > super::now())
        {
            return false;
        }
        let attempts = self.retries.get(key).map_or(0, |(attempts, _)| attempts);
        self.retries
            .insert(key.into(), (attempts, super::now() + 120));
        true
    }
    pub fn finish_refresh(&self, key: &str, success: bool) {
        if success {
            self.retries.invalidate(key);
            return;
        }
        let attempts = self
            .retries
            .get(key)
            .map_or(1, |(attempts, _)| (attempts + 1).min(6));
        let jitter = key
            .bytes()
            .fold(0u64, |sum, byte| sum.wrapping_add(byte as u64))
            % 11;
        self.retries.insert(
            key.into(),
            (attempts, super::now() + (5i64 << attempts) + jitter as i64),
        );
    }
    pub fn request(&self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.requests
            .get_with(key.into(), || Arc::new(tokio::sync::Mutex::new(())))
    }
    pub async fn read(&self, path: PathBuf) -> Option<Saved> {
        tokio::task::spawn_blocking(move || {
            let entry = CACHE.read(path.parent()?, "ytmusic", path.file_stem()?.to_str()?)?;
            Some(Saved {
                fresh: entry.fresh(super::now()),
                page: serde_json::from_value(entry.payload.clone()).ok()?,
            })
        })
        .await
        .ok()
        .flatten()
    }
    #[cfg(test)]
    pub async fn write(
        &self,
        directory: PathBuf,
        key: String,
        browse_id: String,
        page: BrowsePage,
        policy: Policy,
        epoch: u64,
    ) {
        let disk = self.disk.clone();
        let _ = tokio::task::spawn_blocking(move || {
            let Ok(_guard) = disk.io.lock() else {
                return;
            };
            if disk.epoch.load(Ordering::SeqCst) != epoch {
                return;
            }
            let Ok(version) = CACHE.epoch(&directory, "ytmusic") else {
                return;
            };
            let Ok(payload) = serde_json::to_value(page) else {
                return;
            };
            let _ = CACHE.write(
                &directory,
                "ytmusic",
                &key,
                version,
                Write {
                    payload,
                    tag: browse_id,
                    fresh_for: policy.fresh_for,
                    retain_for: policy.stale_for,
                    store: policy.store,
                },
            );
        })
        .await;
    }
    pub async fn song_like_changed(
        &self,
        directory: PathBuf,
        video_id: String,
        liked: bool,
        epoch: u64,
    ) {
        let disk = self.disk.clone();
        let _ = tokio::task::spawn_blocking(move || {
            let Ok(_guard) = disk.io.lock() else {
                return;
            };
            if disk.epoch.load(Ordering::SeqCst) != epoch {
                return;
            }
            disk.epoch.fetch_add(1, Ordering::SeqCst);
            let _ = CACHE.edit(&directory, "ytmusic", |_, tag, value| {
                if tag == "VLLM" {
                    *value = serde_json::Value::Null;
                    return true;
                }
                let Ok(mut page) = serde_json::from_value::<BrowsePage>(value.clone()) else {
                    return false;
                };
                if page.song_like_changed(&video_id, liked) {
                    *value = serde_json::to_value(page).unwrap_or_default();
                    true
                } else {
                    false
                }
            });
        })
        .await;
    }
    pub async fn playlist_changed(&self, directory: PathBuf, playlist_id: String) {
        self.disk.epoch.fetch_add(1, Ordering::SeqCst);
        let disk = self.disk.clone();
        let _ = tokio::task::spawn_blocking(move || {
            let Ok(_guard) = disk.io.lock() else {
                return;
            };
            let _ = CACHE.edit(&directory, "ytmusic", |_, tag, value| {
                if tag == playlist_id || tag == "FEmusic_liked_playlists" {
                    *value = serde_json::Value::Null;
                    true
                } else {
                    false
                }
            });
        })
        .await;
    }
    pub async fn clear(&self, directory: PathBuf) {
        self.disk.epoch.fetch_add(1, Ordering::SeqCst);
        self.retries.invalidate_all();
        let disk = self.disk.clone();
        let _ = tokio::task::spawn_blocking(move || {
            let Ok(_guard) = disk.io.lock() else {
                return;
            };
            let _ = CACHE.clear(&directory, "ytmusic");
        })
        .await;
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn page() -> BrowsePage {
        serde_json::from_value(
            serde_json::json!({"title":"My Mix 1","items":[],"hubs":[],"continuation":"next-page"}),
        )
        .unwrap()
    }
    fn policy() -> Policy {
        Policy::from_headers(&reqwest::header::HeaderMap::new(), 900, 1000)
    }
    #[tokio::test]
    async fn shared_storage_survives_reopening_and_disconnect_retires_old_writes() {
        let directory = tempfile::tempdir().unwrap();
        let cache = Cache::default();
        let epoch = cache.epoch();
        cache
            .write(
                directory.path().into(),
                "page".into(),
                "MPREalbum".into(),
                page(),
                policy(),
                epoch,
            )
            .await;
        let reopened = Cache::default();
        assert!(
            reopened
                .read(directory.path().join("page.json"))
                .await
                .unwrap()
                .fresh
        );
        assert!(Arc::ptr_eq(&cache.request("key"), &cache.request("key")));
        cache.clear(directory.path().into()).await;
        cache
            .write(
                directory.path().into(),
                "page".into(),
                "MPREalbum".into(),
                page(),
                policy(),
                epoch,
            )
            .await;
        assert!(cache
            .read(directory.path().join("page.json"))
            .await
            .is_none());
    }
    #[test]
    fn provider_cache_lifetimes_override_defaults_and_preserve_restrictions() {
        use reqwest::header::*;
        let mut headers = HeaderMap::new();
        headers.insert(
            CACHE_CONTROL,
            HeaderValue::from_static("private, max-age=120, stale-while-revalidate=600"),
        );
        headers.insert(AGE, HeaderValue::from_static("30"));
        let policy = Policy::from_headers(&headers, 900, 1000);
        assert_eq!((policy.fresh_for, policy.stale_for), (90, 690));
        headers.insert(
            CACHE_CONTROL,
            HeaderValue::from_static("max-age=60, must-revalidate"),
        );
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
        let page: BrowsePage = serde_json::from_value(serde_json::json!({"title":"Album","items":[
            {"id":"abcdefghijk","kind":"song","title":"Song","artist":"Artist","description":"","liked":false},
            {"id":"lmnopqrstuv","kind":"song","title":"Other","artist":"Artist","description":"","liked":false}
        ],"hubs":[]})).unwrap();
        let epoch = cache.epoch();
        cache
            .write(
                directory.path().into(),
                "album".into(),
                "MPREalbum".into(),
                page.clone(),
                policy(),
                epoch,
            )
            .await;
        cache
            .write(
                directory.path().into(),
                "liked".into(),
                "VLLM".into(),
                page.clone(),
                policy(),
                epoch,
            )
            .await;
        cache
            .song_like_changed(directory.path().into(), "abcdefghijk".into(), true, epoch)
            .await;
        assert!(cache
            .read(directory.path().join("liked.json"))
            .await
            .is_none());
        let saved = cache
            .read(directory.path().join("album.json"))
            .await
            .unwrap();
        assert_eq!(saved.page.items[0].liked, Some(true));
        assert_eq!(saved.page.items[1].liked, Some(false));
        cache
            .write(
                directory.path().into(),
                "old-result".into(),
                "VLLM".into(),
                page,
                policy(),
                epoch,
            )
            .await;
        assert!(cache
            .read(directory.path().join("old-result.json"))
            .await
            .is_none());
    }
    #[test]
    fn expires_and_date_are_used_when_max_age_is_absent() {
        use reqwest::header::*;
        let mut headers = HeaderMap::new();
        headers.insert(
            DATE,
            HeaderValue::from_static("Sat, 17 Oct 2026 12:00:00 GMT"),
        );
        headers.insert(
            EXPIRES,
            HeaderValue::from_static("Sat, 17 Oct 2026 12:10:00 GMT"),
        );
        let now = chrono::DateTime::parse_from_rfc2822("Sat, 17 Oct 2026 12:01:00 GMT")
            .unwrap()
            .timestamp();
        assert_eq!(Policy::from_headers(&headers, 900, now).fresh_for, 540);
    }
}
