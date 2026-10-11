//! Audio file cache — stores raw audio files (FLAC/MP3/AAC) on disk for
//! instant replay without re-fetching from Plex.
//!
//! Cache key: a digest of the full source URL (server, account and media variant).
//! Temp files: a unique `.part` file per writer (renamed atomically on completion)
//! Index: `index.json` — loaded at startup, flushed on mutations.
//! Eviction: LRU by `last_accessed`, triggered after each write completion.

use std::collections::HashMap;
use std::fs;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tracing::{debug, info, warn};

// The native AAC parser now preserves the full configuration and speaker maps.
// Recompute derived loudness while keeping the encoded media cache intact.
const GAIN_ANALYSIS_VERSION: u8 = 3;
/// Default max cache size: 5 GB.
const DEFAULT_MAX_BYTES: u64 = 5 * 1024 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Cache statistics returned to the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct CacheStats {
    pub total_bytes: u64,
    pub file_count: usize,
    pub max_bytes: u64,
}

/// The audio file cache. Thread-safe: the `Mutex<CacheIndex>` is only locked
/// by the control thread (never the audio callback).
pub struct AudioCache {
    cache_dir: PathBuf,
    index: Mutex<CacheIndex>,
    max_bytes: AtomicU64,
}

/// Active file writer — tees HTTP chunks to disk while streaming.
pub struct CacheWriter {
    temp_path: PathBuf,
    final_path: PathBuf,
    writer: Option<BufWriter<fs::File>>,
    failed: bool,
    bytes_written: u64,
    key: String,
    filename: String,
}

// ---------------------------------------------------------------------------
// Index (persisted as JSON)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CacheEntry {
    filename: String,
    size_bytes: u64,
    last_accessed: u64,
    /// Computed EBU R128 gain in dB (for tracks where Plex lacks loudness data, e.g. Opus).
    /// None = not yet analyzed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    computed_gain_db: Option<f32>,
    #[serde(default)]
    gain_analysis_version: u8,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct CacheIndex {
    entries: HashMap<String, CacheEntry>,
    total_bytes: u64,
}

impl CacheIndex {
    fn load(path: &Path) -> Self {
        match fs::read_to_string(path) {
            Ok(json) => serde_json::from_str(&json).unwrap_or_default(),
            Err(_) => Self::default(),
        }
    }

    fn save(&self, path: &Path) {
        if let Ok(json) = serde_json::to_string_pretty(self) {
            let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
            if fs::write(&temp, json).is_ok() {
                if let Err(error) = fs::rename(&temp, path) {
                    warn!(%error, "failed to persist audio cache index");
                }
            }
            let _ = fs::remove_file(temp);
        }
    }
}

// ---------------------------------------------------------------------------
// AudioCache
// ---------------------------------------------------------------------------

impl AudioCache {
    /// Create or open the cache at the given directory.
    pub fn new(cache_dir: PathBuf, max_bytes: Option<u64>) -> Self {
        let _ = fs::create_dir_all(&cache_dir);
        let index_path = cache_dir.join("index.json");
        let mut index = CacheIndex::load(&index_path);

        // Verify entries still exist on disk — remove orphans
        let before = index.entries.len();
        index.entries.retain(|_key, entry| {
            fs::metadata(cache_dir.join(&entry.filename))
                .map(|metadata| metadata.is_file() && metadata.len() == entry.size_bytes)
                .unwrap_or(false)
        });
        let total = index.entries.values().map(|e| e.size_bytes).sum();
        if index.entries.len() != before || index.total_bytes != total {
            index.total_bytes = total;
            index.save(&index_path);
        }

        let max = max_bytes.unwrap_or(DEFAULT_MAX_BYTES);
        info!(
            dir = %cache_dir.display(),
            entries = index.entries.len(),
            total_mb = index.total_bytes / (1024 * 1024),
            max_mb = max / (1024 * 1024),
            "audio cache loaded"
        );

        Self {
            cache_dir,
            index: Mutex::new(index),
            max_bytes: AtomicU64::new(max),
        }
    }

    /// Look up a cached file by rating key. Returns the file path if cached.
    /// Updates `last_accessed` on hit.
    pub fn lookup(&self, key: &str) -> Option<PathBuf> {
        let mut idx = self.index.lock().ok()?;
        let entry = idx.entries.get_mut(key)?;
        let path = self.cache_dir.join(&entry.filename);
        if !path.exists() {
            // File disappeared — remove from index
            let size = entry.size_bytes;
            idx.entries.remove(key);
            idx.total_bytes = idx.total_bytes.saturating_sub(size);
            idx.save(&self.index_path());
            return None;
        }
        entry.last_accessed = now_secs();
        // Don't flush index on every hit — debounce by only saving occasionally.
        // The timestamp is in memory; worst case we lose LRU precision on crash.
        Some(path)
    }

    /// Get the computed loudness gain for a cached track (if analyzed).
    pub fn get_computed_gain(&self, key: &str) -> Option<f32> {
        let idx = self.index.lock().ok()?;
        let entry = idx.entries.get(key)?;
        (entry.gain_analysis_version == GAIN_ANALYSIS_VERSION)
            .then_some(entry.computed_gain_db)
            .flatten()
    }

    /// Store a computed loudness gain for a cached track.
    pub fn set_computed_gain(&self, key: &str, gain_db: f32) {
        if let Ok(mut idx) = self.index.lock() {
            if let Some(entry) = idx.entries.get_mut(key) {
                entry.computed_gain_db = Some(gain_db);
                entry.gain_analysis_version = GAIN_ANALYSIS_VERSION;
                idx.save(&self.index_path());
            }
        }
    }

    /// Begin writing a new cache file. Returns a `CacheWriter` that receives
    /// chunks and must be finished (or aborted) when done.
    pub fn begin_write(&self, key: &str, ext: &str) -> Result<CacheWriter, String> {
        if key.is_empty() || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
            return Err("invalid cache key".into());
        }
        let ext = if ext.bytes().all(|b| b.is_ascii_alphanumeric()) && ext.len() <= 16 && !ext.is_empty() { ext } else { "dat" };
        let filename = format!("{}.{}", key, ext);
        let final_path = self.cache_dir.join(&filename);
        let temp_path = self.cache_dir.join(format!("{}.{}.part", filename, uuid::Uuid::new_v4()));

        // If already cached, skip
        if final_path.exists() {
            return Err("already cached".into());
        }

        let file = fs::OpenOptions::new().write(true).create_new(true).open(&temp_path)
            .map_err(|e| format!("cache create: {}", e))?;

        Ok(CacheWriter {
            temp_path,
            final_path,
            writer: Some(BufWriter::with_capacity(256 * 1024, file)),
            failed: false,
            bytes_written: 0,
            key: key.to_string(),
            filename,
        })
    }

    /// Update the maximum cache size and trigger eviction if needed.
    pub fn set_max_bytes(&self, max: u64) {
        self.max_bytes.store(max, Ordering::Relaxed);
        self.evict();
    }

    /// Remove all cached files and reset the index.
    pub fn clear(&self) {
        if let Ok(mut idx) = self.index.lock() {
            for entry in idx.entries.values() {
                let _ = fs::remove_file(self.cache_dir.join(&entry.filename));
            }
            // Also remove any .part files
            if let Ok(dir) = fs::read_dir(&self.cache_dir) {
                for entry in dir.flatten() {
                    if entry.path().extension().map_or(false, |e| e == "part") {
                        let _ = fs::remove_file(entry.path());
                    }
                }
            }
            idx.entries.clear();
            idx.total_bytes = 0;
            idx.save(&self.index_path());
        }
        info!("audio cache cleared");
    }

    /// Get cache statistics.
    pub fn stats(&self) -> CacheStats {
        let idx = self.index.lock().unwrap();
        CacheStats {
            total_bytes: idx.total_bytes,
            file_count: idx.entries.len(),
            max_bytes: self.max_bytes.load(Ordering::Relaxed),
        }
    }

    /// Evict least-recently-accessed entries until under the max size.
    fn evict(&self) {
        if let Ok(mut idx) = self.index.lock() {
            self.evict_with_index(&mut idx);
            idx.save(&self.index_path());
        }
    }

    fn evict_with_index(&self, idx: &mut CacheIndex) {
        let max = self.max_bytes.load(Ordering::Relaxed);
        if max == 0 || idx.total_bytes <= max {
            return;
        }

        // Sort by last_accessed ascending (oldest first)
        let mut entries: Vec<(String, u64, u64)> = idx
            .entries
            .iter()
            .map(|(key, e)| (key.clone(), e.last_accessed, e.size_bytes))
            .collect();
        entries.sort_by_key(|&(_, ts, _)| ts);

        for (key, _, size) in entries {
            if idx.total_bytes <= max {
                break;
            }
            if let Some(entry) = idx.entries.remove(&key) {
                let path = self.cache_dir.join(&entry.filename);
                let _ = fs::remove_file(&path);
                idx.total_bytes = idx.total_bytes.saturating_sub(size);
                debug!(cache_key = key, size, "evicted cached audio file");
            }
        }
    }

    fn index_path(&self) -> PathBuf {
        self.cache_dir.join("index.json")
    }
}

// ---------------------------------------------------------------------------
// CacheWriter
// ---------------------------------------------------------------------------

impl CacheWriter {
    /// A failed write must never be published as complete audio.
    pub fn write_chunk(&mut self, data: &[u8]) -> Result<(), String> {
        let result = self.writer.as_mut().ok_or("cache writer closed".to_string())
            .and_then(|w| w.write_all(data).map_err(|e| format!("cache write: {e}")));
        if result.is_err() { self.failed = true; }
        result?;
        self.bytes_written += data.len() as u64;
        Ok(())
    }

    pub fn finish(mut self, cache: &AudioCache) -> Result<(), String> {
        if self.failed { return Err("cache write failed".into()); }
        self.writer.as_mut().ok_or("cache writer closed")?
            .flush().map_err(|e| format!("cache flush: {e}"))?;
        self.writer.take(); // Close before rename (also works on Windows).
        // Serialize rename and indexing with lookup/eviction. Each writer has
        // its own temp file, so it cannot publish another download's bytes.
        let mut idx = cache.index.lock().map_err(|_| "cache index poisoned")?;
        fs::rename(&self.temp_path, &self.final_path)
            .map_err(|e| format!("cache rename: {e}"))?;
        if let Some(old) = idx.entries.remove(&self.key) {
            idx.total_bytes = idx.total_bytes.saturating_sub(old.size_bytes);
        }
        idx.entries.insert(self.key.clone(), CacheEntry {
            filename: self.filename.clone(), size_bytes: self.bytes_written,
            last_accessed: now_secs(), computed_gain_db: None, gain_analysis_version: 0,
        });
        idx.total_bytes += self.bytes_written;
        cache.evict_with_index(&mut idx);
        idx.save(&cache.index_path());
        Ok(())
    }

    pub fn abort(self) { drop(self); }
}

impl Drop for CacheWriter {
    fn drop(&mut self) {
        self.writer.take();
        let _ = fs::remove_file(&self.temp_path);
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Legacy URL keys retained only for cache format regression fixtures.
#[cfg(test)]
pub fn cache_key(url: &str) -> String {
    use md5::{Digest, Md5};
    format!("{:x}", Md5::digest(url.as_bytes()))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Extract the file extension from a URL path.
/// e.g. `http://host/library/parts/123/456/file.flac?token=x` → `"flac"`
pub fn extract_extension(url: &str) -> String {
    // Strip query string
    let path = url.split('?').next().unwrap_or(url);
    // Get the last path component's extension
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("dat")
        .to_string()
}

#[cfg(test)]
mod tests {
    #[test]
    fn legacy_analysis_is_recomputed_without_discarding_the_cached_audio_file() {
        let dir = tempfile::tempdir().unwrap();
        let cache = AudioCache::new(dir.path().into(), None);
        let key = cache_key("https://test.invalid/legacy.wav");
        let mut writer = cache.begin_write(&key, "wav").unwrap();
        writer.write_chunk(b"cached audio stays intact").unwrap();
        writer.finish(&cache).unwrap();
        cache.set_computed_gain(&key, -5.0);
        let index_path = dir.path().join("index.json");
        let mut saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&index_path).unwrap()).unwrap();
        saved["entries"][&key]
            .as_object_mut()
            .unwrap()
            .remove("gain_analysis_version");
        std::fs::write(&index_path, serde_json::to_vec(&saved).unwrap()).unwrap();
        let restored = AudioCache::new(dir.path().into(), None);
        assert_eq!(restored.get_computed_gain(&key), None);
        let file = restored.lookup(&key).unwrap();
        assert_eq!(std::fs::read(file).unwrap(), b"cached audio stays intact");
        restored.set_computed_gain(&key, -6.0);
        assert_eq!(restored.get_computed_gain(&key), Some(-6.0));
    }

    #[test]
    fn analysis_from_previous_decoders_is_recomputed_but_encoded_bytes_remain() {
        for version in 1..GAIN_ANALYSIS_VERSION {
            let dir = tempfile::tempdir().unwrap();
            let cache = AudioCache::new(dir.path().into(), None);
            let key = cache_key("https://test.invalid/opus.ogg");
            let mut writer = cache.begin_write(&key, "ogg").unwrap();
            writer.write_chunk(b"encoded source is preserved").unwrap();
            writer.finish(&cache).unwrap();
            cache.set_computed_gain(&key, 6.0);
            let path = dir.path().join("index.json");
            let mut saved: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            saved["entries"][&key]["gain_analysis_version"] = serde_json::json!(version);
            std::fs::write(path, serde_json::to_vec(&saved).unwrap()).unwrap();
            let restored = AudioCache::new(dir.path().into(), None);
            assert_eq!(restored.get_computed_gain(&key), None);
            assert_eq!(std::fs::read(restored.lookup(&key).unwrap()).unwrap(), b"encoded source is preserved");
        }
    }

    use super::*;
    use std::fs;

    #[test]
    fn extract_ext_from_url() {
        assert_eq!(
            extract_extension("http://host/library/parts/123/456/file.flac?X-Plex-Token=abc"),
            "flac"
        );
        assert_eq!(
            extract_extension("http://host/music/track.mp3"),
            "mp3"
        );
        assert_eq!(extract_extension("http://host/noext"), "dat");
    }

    #[test]
    fn cache_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let cache = AudioCache::new(dir.path().to_path_buf(), Some(100 * 1024 * 1024));

        // Miss
        assert!(cache.lookup("42").is_none());

        // Write
        let mut writer = cache.begin_write("42", "flac").unwrap();
        writer.write_chunk(&[1, 2, 3, 4, 5]).unwrap();
        writer.finish(&cache).unwrap();

        // Hit
        let path = cache.lookup("42").unwrap();
        assert!(path.exists());
        assert_eq!(fs::read(&path).unwrap(), vec![1, 2, 3, 4, 5]);

        // Stats
        let stats = cache.stats();
        assert_eq!(stats.file_count, 1);
        assert_eq!(stats.total_bytes, 5);

        // Clear
        cache.clear();
        assert!(cache.lookup("42").is_none());
        assert_eq!(cache.stats().file_count, 0);
    }

    #[test]
    fn lru_eviction() {
        let dir = tempfile::tempdir().unwrap();
        let cache = AudioCache::new(dir.path().to_path_buf(), Some(10)); // 10 bytes max

        // Write 3 files: 5 bytes each = 15 total, exceeds 10
        // Manually set last_accessed to ensure deterministic ordering
        for (i, key) in ["1", "2", "3"].iter().enumerate() {
            let mut w = cache.begin_write(*key, "dat").unwrap();
            w.write_chunk(&[0; 5]).unwrap();
            w.finish(&cache).unwrap();
            // Set increasing timestamps manually for deterministic LRU order
            if let Ok(mut idx) = cache.index.lock() {
                if let Some(entry) = idx.entries.get_mut(*key) {
                    entry.last_accessed = 1000 + i as u64;
                }
            }
        }

        let stats = cache.stats();
        // Should have evicted oldest entries to stay under 10 bytes
        assert!(stats.total_bytes <= 10, "total {} > 10", stats.total_bytes);
        // Key 3 (most recent) should still be cached
        assert!(cache.lookup("3").is_some());
    }

    #[test]
    fn same_track_id_on_different_servers_accounts_or_variants_has_distinct_cache_keys() {
        let urls = [
            "https://server-a/library/parts/42/file.flac?X-Plex-Token=account-a",
            "https://server-b/library/parts/42/file.flac?X-Plex-Token=account-a",
            "https://server-a/library/parts/42/file.flac?X-Plex-Token=account-b",
            "https://server-a/library/parts/42/file.mp3?X-Plex-Token=account-a",
        ];
        let keys: std::collections::HashSet<_> = urls.iter().map(|url| cache_key(url)).collect();
        assert_eq!(keys.len(), urls.len());
        let dir = tempfile::tempdir().unwrap();
        let cache = AudioCache::new(dir.path().into(), None);
        let mut writer = cache.begin_write(&cache_key(urls[0]), "flac").unwrap();
        writer.write_chunk(b"server-a audio").unwrap();
        writer.finish(&cache).unwrap();
        assert!(cache.lookup(&cache_key(urls[0])).is_some());
        for url in &urls[1..] { assert!(cache.lookup(&cache_key(url)).is_none()); }
    }

    #[test]
    fn overlapping_writers_never_publish_another_downloads_partial_file() {
        let dir = tempfile::tempdir().unwrap();
        let cache = AudioCache::new(dir.path().into(), None);
        let mut first = cache.begin_write("42", "flac").unwrap();
        first.write_chunk(b"first complete audio").unwrap();
        let mut second = cache.begin_write("42", "flac").unwrap();
        second.write_chunk(b"second").unwrap();
        first.finish(&cache).unwrap();
        assert_eq!(fs::read(cache.lookup("42").unwrap()).unwrap(), b"first complete audio");
        second.write_chunk(b" complete audio").unwrap();
        second.finish(&cache).unwrap();
        assert_eq!(fs::read(cache.lookup("42").unwrap()).unwrap(), b"second complete audio");
        assert_eq!(cache.stats().total_bytes, b"second complete audio".len() as u64);
        assert_eq!(cache.stats().file_count, 1);
    }

    #[test]
    fn failed_or_abandoned_writes_are_not_cached() {
        let dir = tempfile::tempdir().unwrap();
        let cache = AudioCache::new(dir.path().into(), None);
        let mut writer = cache.begin_write("42", "flac").unwrap();
        let temp = writer.temp_path.clone();
        writer.writer.take();
        assert!(writer.write_chunk(b"bytes").is_err());
        assert!(writer.finish(&cache).is_err());
        assert!(!temp.exists());
        assert!(cache.lookup("42").is_none());
        assert_eq!(cache.stats().total_bytes, 0);
    }

    #[test]
    fn incomplete_cached_files_are_rejected_after_restart() {
        let dir = tempfile::tempdir().unwrap();
        let cache = AudioCache::new(dir.path().into(), None);
        let mut writer = cache.begin_write("42", "flac").unwrap();
        writer.write_chunk(b"complete audio").unwrap();
        writer.finish(&cache).unwrap();
        fs::write(cache.lookup("42").unwrap(), b"bad").unwrap();
        let reopened = AudioCache::new(dir.path().into(), None);
        assert!(reopened.lookup("42").is_none());
        assert_eq!(reopened.stats().total_bytes, 0);
    }
}
