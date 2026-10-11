//! Audio file cache — stores raw audio files (FLAC/MP3/AAC) on disk for
//! instant replay without re-fetching from Plex.
//!
//! Cache key: a digest of the full source URL (server, account and media variant).
//! Temp files: a unique `.part` file per writer (renamed atomically on completion)
//! Index: `index.json` — loaded at startup, flushed on mutations.
//! Eviction: LRU by `last_accessed`, triggered after each write completion.

use crate::cache_files::{
    directory_id, file_is_current, open_regular_file, open_writable_regular_file, regular_file,
};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tracing::{debug, info, warn};

// Revision ownership and complete-duration validation now protect measurements.
// Recompute older derived gains while keeping the encoded media cache intact.
const GAIN_ANALYSIS_VERSION: u8 = 4;
/// Default max cache size: 5 GB.
const DEFAULT_MAX_BYTES: u64 = 5 * 1024 * 1024 * 1024;
const MAX_INDEX_BYTES: u64 = 16 * 1024 * 1024;
const MAX_KEY_BYTES: usize = 128;
const MAX_CACHE_ENTRIES: usize = 32768;

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

/// Cache, download and loader tasks share the index; the audio callback never
/// locks it or performs filesystem operations.
pub struct AudioCache {
    cache_dir: PathBuf,
    index: Arc<Mutex<CacheIndex>>,
    max_bytes: Arc<AtomicU64>,
    owner: Arc<CacheOwner>,
    available: bool,
    entry_limit: usize,
}

struct CacheOwner {
    generation: AtomicU64,
    directory: PathBuf,
    directory_id: Option<(u64, u64)>,
    // Writers retain ownership even if the cache manager is dropped.
    _lock: Option<fs::File>,
}

impl CacheOwner {
    fn directory_is_current(&self) -> bool {
        let Some(lock) = self._lock.as_ref() else {
            return false;
        };
        if !file_is_current(lock, &self.directory.join(".audio-cache.lock")) {
            return false;
        }
        self.directory_id.is_some() && directory_id(&self.directory) == self.directory_id
    }
}

impl Drop for CacheOwner {
    fn drop(&mut self) {
        // Last-descriptor-close is insufficient on Unix: a concurrent process
        // spawn can temporarily inherit the locked open-file description.
        // This owner is shared with pending writers, so its final Drop is the
        // point at which no cache operation can still need exclusive access.
        if let Some(lock) = self._lock.as_ref() {
            if let Err(error) = lock.unlock() {
                warn!(%error, "failed to release audio cache ownership");
            }
        }
    }
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
    owner: Arc<CacheOwner>,
    generation: u64,
    id: uuid::Uuid,
    index: Arc<Mutex<CacheIndex>>,
    max_bytes: Arc<AtomicU64>,
    declared_size: Arc<AtomicU64>,
    entry_limit: usize,
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
    #[serde(default)]
    revision: String,
}

/// Names an accepted completed download, rather than just its reusable URL key.
#[derive(Clone, PartialEq, Eq)]
pub(super) struct CacheStamp {
    filename: String,
    size_bytes: u64,
    revision: String,
}

impl From<&CacheEntry> for CacheStamp {
    fn from(entry: &CacheEntry) -> Self {
        Self {
            filename: entry.filename.clone(),
            size_bytes: entry.size_bytes,
            revision: entry.revision.clone(),
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct CacheIndex {
    entries: HashMap<String, CacheEntry>,
    total_bytes: u64,
    #[serde(skip)]
    partials: HashMap<uuid::Uuid, u64>,
    #[serde(skip)]
    partial_bytes: u64,
}

impl CacheIndex {
    fn load(path: &Path) -> Self {
        let read = || -> std::io::Result<Self> {
            let metadata = fs::symlink_metadata(path)?;
            if !regular_file(&metadata) || metadata.len() > MAX_INDEX_BYTES {
                return Ok(Self::default());
            }
            let file = open_regular_file(path)?;
            let mut bytes = Vec::new();
            file.take(MAX_INDEX_BYTES + 1).read_to_end(&mut bytes)?;
            if bytes.len() as u64 > MAX_INDEX_BYTES {
                return Ok(Self::default());
            }
            Ok(serde_json::from_slice(&bytes).unwrap_or_default())
        };
        read().unwrap_or_default()
    }

    fn persist(&self, path: &Path) -> Result<(), String> {
        let save = || -> Result<(), String> {
            let json = serde_json::to_vec(self).map_err(|error| error.to_string())?;
            if json.len() as u64 > MAX_INDEX_BYTES {
                return Err("audio cache index is oversized".into());
            }
            let parent = path.parent().ok_or("audio cache has no directory")?;
            let mut temp = tempfile::Builder::new()
                .prefix(".audio-index.")
                .tempfile_in(parent)
                .map_err(|error| error.to_string())?;
            temp.write_all(&json).map_err(|error| error.to_string())?;
            temp.as_file()
                .sync_all()
                .map_err(|error| error.to_string())?;
            temp.persist(path).map_err(|error| error.to_string())?;
            Ok(())
        };
        save()
    }

    fn save(&self, path: &Path) {
        if let Err(error) = self.persist(path) {
            warn!(%error, "failed to persist audio cache index");
        }
    }
}

// ---------------------------------------------------------------------------
// AudioCache
// ---------------------------------------------------------------------------

impl AudioCache {
    /// Create or open the cache at the given directory.
    pub fn new(cache_dir: PathBuf, max_bytes: Option<u64>) -> Self {
        Self::with_limits(cache_dir, max_bytes, MAX_CACHE_ENTRIES)
    }

    fn with_limits(cache_dir: PathBuf, max_bytes: Option<u64>, entry_limit: usize) -> Self {
        let mut directory = fs::DirBuilder::new();
        directory.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            directory.mode(0o700);
        }
        let _ = directory.create(&cache_dir);
        // A redirect at the cache root must not turn Clear into deletion in a
        // different directory. Parent aliases such as macOS /var are resolved.
        let available =
            fs::symlink_metadata(&cache_dir).is_ok_and(|metadata| metadata.file_type().is_dir());
        let cache_dir = if available {
            fs::canonicalize(&cache_dir).unwrap_or(cache_dir)
        } else {
            cache_dir
        };
        let root_lock = available
            .then(|| lock_cache_directory(&cache_dir))
            .transpose();
        let root_lock = match root_lock {
            Ok(lock) => lock,
            Err(error) => {
                warn!(%error, "audio cache disabled: cannot acquire ownership");
                None
            }
        };
        let available = available && root_lock.is_some();
        #[cfg(unix)]
        if available {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&cache_dir, fs::Permissions::from_mode(0o700));
        }
        let index_path = cache_dir.join("index.json");
        let mut index = if available {
            CacheIndex::load(&index_path)
        } else {
            CacheIndex::default()
        };

        // Verify entries still exist on disk — remove orphans
        let before = index.entries.len();
        let mut total = 0_u64;
        index.entries.retain(|key, entry| {
            if !valid_entry(&cache_dir, key, entry) {
                return false;
            }
            if let Some(sum) = total.checked_add(entry.size_bytes) {
                total = sum;
                true
            } else {
                false
            }
        });
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

        let owner = Arc::new(CacheOwner {
            generation: AtomicU64::new(0),
            directory: cache_dir.clone(),
            directory_id: directory_id(&cache_dir),
            _lock: root_lock,
        });
        let cache = Self {
            cache_dir,
            index: Arc::new(Mutex::new(index)),
            max_bytes: Arc::new(AtomicU64::new(max)),
            owner,
            available,
            entry_limit,
        };
        if available {
            cache.remove_crash_orphans();
        }
        // None is the application's temporary default before preferences are
        // restored. Do not discard a user's larger cache before that happens.
        if max_bytes.is_some() {
            cache.evict();
        }
        cache
    }

    fn remove_crash_orphans(&self) {
        if self.check_directory().is_err() {
            return;
        }
        let Ok(idx) = self.index.lock() else {
            return;
        };
        let retained: HashSet<_> = idx
            .entries
            .values()
            .map(|entry| entry.filename.as_str())
            .collect();
        let Ok(entries) = fs::read_dir(&self.cache_dir) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            let owned_index_temp = name.strip_prefix(".audio-index.").is_some_and(|suffix| {
                suffix.len() == 6 && suffix.bytes().all(|b| b.is_ascii_alphanumeric())
            });
            let orphan_media = name.rsplit_once('.').is_some_and(|(key, _)| {
                let digest = key.strip_prefix("s1-").unwrap_or(key);
                matches!(digest.len(), 32 | 64)
                    && digest.bytes().all(|b| b.is_ascii_hexdigit())
                    && valid_filename(key, name)
                    && !retained.contains(name)
            });
            if (owned_partial_filename(name) || owned_index_temp || orphan_media)
                && fs::symlink_metadata(entry.path()).is_ok_and(|metadata| regular_file(&metadata))
            {
                if let Err(error) = fs::remove_file(entry.path()) {
                    warn!(%error, "failed to reclaim crashed audio cache file");
                }
            }
        }
    }

    /// Look up a cached file by rating key. Returns the file path if cached.
    /// Updates `last_accessed` on hit.
    pub fn lookup(&self, key: &str) -> Option<PathBuf> {
        self.lookup_file(key).map(|(path, _, _)| path)
    }

    /// Open under the cache lock so Clear/eviction cannot race playback startup.
    #[cfg(test)]
    pub fn open(&self, key: &str) -> Option<fs::File> {
        self.lookup_file(key).map(|(_, file, _)| file)
    }

    pub(super) fn open_with_stamp(&self, key: &str) -> Option<(fs::File, CacheStamp)> {
        self.lookup_file(key).map(|(_, file, stamp)| (file, stamp))
    }

    /// A late decoder failure must never remove a newer completed download.
    pub(super) fn discard(&self, key: &str, stamp: &CacheStamp) -> bool {
        if self.check_directory().is_err() {
            return false;
        }
        let Ok(mut idx) = self.index.lock() else {
            return false;
        };
        let Some(entry) = idx.entries.get(key) else {
            return false;
        };
        if CacheStamp::from(entry) != *stamp {
            return false;
        }
        let entry = idx.entries.remove(key).unwrap();
        idx.total_bytes = idx.total_bytes.saturating_sub(entry.size_bytes);
        if valid_filename(key, &entry.filename) {
            let _ = fs::remove_file(self.cache_dir.join(entry.filename));
        }
        idx.save(&self.index_path());
        true
    }

    fn lookup_file(&self, key: &str) -> Option<(PathBuf, fs::File, CacheStamp)> {
        if !self.available || !self.owner.directory_is_current() {
            return None;
        }
        let mut idx = self.index.lock().ok()?;
        let entry = idx.entries.get_mut(key)?;
        let path = self.cache_dir.join(&entry.filename);
        let file = valid_filename(key, &entry.filename)
            .then(|| open_regular_file(&path).ok())
            .flatten()
            .filter(|file| {
                file.metadata().is_ok_and(|metadata| {
                    entry.size_bytes > 0 && metadata.len() == entry.size_bytes
                })
            });
        let Some(file) = file else {
            // Missing, truncated or replaced files must fall back to downloading.
            let size = entry.size_bytes;
            idx.entries.remove(key);
            idx.total_bytes = idx.total_bytes.saturating_sub(size);
            idx.save(&self.index_path());
            return None;
        };
        entry.last_accessed = now_secs();
        // Don't flush index on every hit — debounce by only saving occasionally.
        // The timestamp is in memory; worst case we lose LRU precision on crash.
        Some((path, file, CacheStamp::from(&*entry)))
    }

    /// Get the computed loudness gain for a cached track (if analyzed).
    pub fn get_computed_gain(&self, key: &str) -> Option<f32> {
        if !self.available || !self.owner.directory_is_current() {
            return None;
        }
        let idx = self.index.lock().ok()?;
        let entry = idx.entries.get(key)?;
        (entry.gain_analysis_version == GAIN_ANALYSIS_VERSION)
            .then_some(entry.computed_gain_db)
            .flatten()
    }

    pub(super) fn stamp_is_current(&self, key: &str, stamp: &CacheStamp) -> bool {
        self.available
            && self.owner.directory_is_current()
            && self
                .index
                .lock()
                .ok()
                .and_then(|idx| idx.entries.get(key).map(CacheStamp::from))
                .as_ref()
                == Some(stamp)
    }

    pub(super) fn set_computed_gain_for_stamp(
        &self,
        key: &str,
        stamp: &CacheStamp,
        gain_db: f32,
    ) -> bool {
        if !gain_db.is_finite() || !self.available || !self.owner.directory_is_current() {
            return false;
        }
        let Ok(mut idx) = self.index.lock() else {
            return false;
        };
        let Some(entry) = idx.entries.get_mut(key) else {
            return false;
        };
        if CacheStamp::from(&*entry) != *stamp {
            return false;
        }
        entry.computed_gain_db = Some(gain_db);
        entry.gain_analysis_version = GAIN_ANALYSIS_VERSION;
        idx.save(&self.index_path());
        true
    }

    /// Test fixture helper; production measurements require an exact file stamp.
    #[cfg(test)]
    pub fn set_computed_gain(&self, key: &str, gain_db: f32) {
        if !gain_db.is_finite() || !self.available || !self.owner.directory_is_current() {
            return;
        }
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
        if !self.available || !self.owner.directory_is_current() {
            return Err("audio cache directory is unavailable or redirected".into());
        }
        if !valid_key(key) {
            return Err("invalid cache key".into());
        }
        let ext = if valid_extension(ext) { ext } else { "dat" };
        let filename = format!("{}.{}", key, ext);
        let final_path = self.cache_dir.join(&filename);
        let id = uuid::Uuid::new_v4();
        let temp_path = self.cache_dir.join(format!("{}.{}.part", filename, id));

        // Serialize writer admission with Clear. Unindexed or invalid bytes are
        // replaced only after a complete fresh download, never reused as audio.
        let mut idx = self.index.lock().map_err(|_| "cache index poisoned")?;
        if idx
            .entries
            .get(key)
            .is_some_and(|entry| valid_entry(&self.cache_dir, key, entry))
        {
            return Err("already cached".into());
        }

        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options
            .open(&temp_path)
            .map_err(|e| format!("cache create: {}", e))?;

        idx.partials.insert(id, 0);

        Ok(CacheWriter {
            temp_path,
            final_path,
            writer: Some(BufWriter::with_capacity(256 * 1024, file)),
            failed: false,
            bytes_written: 0,
            key: key.to_string(),
            filename,
            owner: self.owner.clone(),
            generation: self.owner.generation.load(Ordering::Acquire),
            id,
            index: self.index.clone(),
            max_bytes: self.max_bytes.clone(),
            declared_size: Arc::new(AtomicU64::new(0)),
            entry_limit: self.entry_limit,
        })
    }

    /// Update the maximum cache size and trigger eviction if needed.
    pub fn set_max_bytes(&self, max: u64) -> Result<CacheStats, String> {
        self.check_directory()?;
        let mut idx = self
            .index
            .lock()
            .map_err(|_| "audio cache index unavailable")?;
        let previous = self.max_bytes.swap(max, Ordering::AcqRel);
        if max != 0 && idx.partial_bytes > max {
            self.owner.generation.fetch_add(1, Ordering::AcqRel);
            if let Err(error) = self.remove_partials(&mut idx) {
                self.max_bytes.store(previous, Ordering::Release);
                return Err(error);
            }
        }
        let result = make_room(&self.cache_dir, &mut idx, max, 0, 0, self.entry_limit);
        let saved = idx.persist(&self.index_path());
        if let Err(error) = result.and(saved) {
            self.max_bytes.store(previous, Ordering::Release);
            return Err(error);
        }
        Ok(self.stats_with_index(&idx))
    }

    fn check_directory(&self) -> Result<(), String> {
        if !self.available || !self.owner.directory_is_current() {
            Err("Audio cache directory is unavailable or has moved. Restart Hibiki after checking storage permissions.".into())
        } else {
            Ok(())
        }
    }

    fn remove_partials(&self, idx: &mut CacheIndex) -> Result<(), String> {
        let directory = fs::read_dir(&self.cache_dir)
            .map_err(|error| format!("Cannot read audio cache: {error}"))?;
        let mut failure = None;
        for entry in directory {
            match entry {
                Ok(entry)
                    if entry
                        .file_name()
                        .to_str()
                        .is_some_and(owned_partial_filename) =>
                {
                    if let Err(error) = fs::remove_file(entry.path()) {
                        if error.kind() != std::io::ErrorKind::NotFound {
                            failure = Some(format!("Could not remove incomplete audio: {error}"));
                        }
                    }
                }
                Err(error) => {
                    failure = Some(format!("Cannot read audio cache: {error}"));
                }
                _ => {}
            }
        }
        if let Some(error) = failure {
            return Err(error);
        }
        idx.partials.clear();
        idx.partial_bytes = 0;
        Ok(())
    }

    /// Retire downloads and return an acknowledged snapshot after deletion.
    pub fn clear(&self) -> Result<CacheStats, String> {
        self.check_directory()?;
        let mut idx = self
            .index
            .lock()
            .map_err(|_| "audio cache index unavailable")?;
        self.owner.generation.fetch_add(1, Ordering::AcqRel);
        let mut failure = self.remove_partials(&mut idx).err();
        idx.entries.retain(|key, entry| {
            if !valid_filename(key, &entry.filename) {
                return false;
            }
            match fs::remove_file(self.cache_dir.join(&entry.filename)) {
                Ok(()) => false,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
                Err(error) => {
                    failure = Some(format!("Could not remove cached audio: {error}"));
                    true
                }
            }
        });
        idx.total_bytes = idx
            .entries
            .values()
            .fold(0_u64, |total, entry| total.saturating_add(entry.size_bytes));
        if let Err(error) = idx.persist(&self.index_path()) {
            failure = Some(error);
        }
        if let Some(error) = failure {
            return Err(error);
        }
        info!("audio cache cleared");
        Ok(self.stats_with_index(&idx))
    }

    fn stats_with_index(&self, idx: &CacheIndex) -> CacheStats {
        CacheStats {
            total_bytes: idx.total_bytes.saturating_add(idx.partial_bytes),
            file_count: idx.entries.len(),
            max_bytes: self.max_bytes.load(Ordering::Acquire),
        }
    }

    /// Get cache statistics.
    pub fn stats(&self) -> CacheStats {
        let idx = self.index.lock().unwrap_or_else(|error| error.into_inner());
        self.stats_with_index(&idx)
    }

    /// Evict least-recently-accessed entries until under the max size.
    fn evict(&self) {
        if !self.available || !self.owner.directory_is_current() {
            return;
        }
        if let Ok(mut idx) = self.index.lock() {
            self.evict_with_index(&mut idx);
            idx.save(&self.index_path());
        }
    }

    fn evict_with_index(&self, idx: &mut CacheIndex) {
        let max = self.max_bytes.load(Ordering::Relaxed);
        let _ = make_room(&self.cache_dir, idx, max, 0, 0, self.entry_limit);
    }

    fn index_path(&self) -> PathBuf {
        self.cache_dir.join("index.json")
    }
}

// ---------------------------------------------------------------------------
// CacheWriter
// ---------------------------------------------------------------------------

impl CacheWriter {
    /// Set by the HTTP header callback before delivering body chunks. Zero
    /// means unknown; resumed bodies report the original representation size.
    pub fn declared_size(&self) -> Arc<AtomicU64> {
        self.declared_size.clone()
    }

    fn reject(&mut self, idx: &mut CacheIndex, reason: &str) -> Result<(), String> {
        self.failed = true;
        self.writer.take();
        if self.owner.directory_is_current() {
            let _ = fs::remove_file(&self.temp_path);
        }
        if let Some(bytes) = idx.partials.remove(&self.id) {
            idx.partial_bytes = idx.partial_bytes.saturating_sub(bytes);
        }
        Err(reason.into())
    }

    /// A failed write must never be published as complete audio.
    pub fn write_chunk(&mut self, data: &[u8]) -> Result<(), String> {
        let index = self.index.clone();
        let mut idx = index.lock().map_err(|_| "cache index poisoned")?;
        if self.failed {
            return Err("cache writer failed".into());
        }
        if self.generation != self.owner.generation.load(Ordering::Acquire)
            || !self.owner.directory_is_current()
        {
            return self.reject(&mut idx, "cache writer retired by Clear or storage change");
        }
        let Some(total) = self.bytes_written.checked_add(data.len() as u64) else {
            return self.reject(&mut idx, "cache size overflow");
        };
        let max = self.max_bytes.load(Ordering::Acquire);
        if max != 0 && (total > max || self.declared_size.load(Ordering::Acquire) > max) {
            return self.reject(&mut idx, "audio exceeds the cache limit");
        }
        let before = idx.entries.len();
        let room = make_room(
            &self.owner.directory,
            &mut idx,
            max,
            data.len() as u64,
            0,
            self.entry_limit,
        );
        if idx.entries.len() != before {
            idx.save(&self.owner.directory.join("index.json"));
        }
        if let Err(error) = room {
            return self.reject(&mut idx, &error);
        }
        idx.partial_bytes = idx
            .partial_bytes
            .checked_add(data.len() as u64)
            .ok_or("cache size overflow")?;
        idx.partials.insert(self.id, total);
        let result = self
            .writer
            .as_mut()
            .ok_or("cache writer closed".to_string())
            .and_then(|w| w.write_all(data).map_err(|e| format!("cache write: {e}")));
        if result.is_err() {
            return self.reject(&mut idx, "cache write failed");
        }
        result?;
        self.bytes_written = total;
        Ok(())
    }

    pub fn finish(mut self, cache: &AudioCache) -> Result<(), String> {
        if self.failed {
            return Err("cache write failed".into());
        }
        if !Arc::ptr_eq(&self.owner, &cache.owner) {
            return Err("cache writer belongs to another cache".into());
        }
        if !self.owner.directory_is_current() {
            return Err("cache directory was moved or redirected".into());
        }
        let mut idx = cache.index.lock().map_err(|_| "cache index poisoned")?;
        if self.generation != self.owner.generation.load(Ordering::Acquire) {
            return Err("cache writer retired by Clear".into());
        }
        if self.bytes_written == 0 {
            return Err("cannot cache empty audio".into());
        }
        self.writer
            .as_mut()
            .ok_or("cache writer closed")?
            .flush()
            .map_err(|e| format!("cache flush: {e}"))?;
        // Close before rename (also works on Windows). Serialize publication
        // with lookup/eviction; every writer owns its own temporary file.
        self.writer.take();
        let metadata = fs::symlink_metadata(&self.temp_path)
            .map_err(|error| format!("cache metadata: {error}"))?;
        if !regular_file(&metadata) || metadata.len() != self.bytes_written {
            return Err("cache temporary file was replaced or truncated".into());
        }
        let before = idx.entries.len();
        let incoming = usize::from(!idx.entries.contains_key(&self.key));
        let room = make_room(
            &cache.cache_dir,
            &mut idx,
            self.max_bytes.load(Ordering::Acquire),
            0,
            incoming,
            self.entry_limit,
        );
        if idx.entries.len() != before {
            idx.save(&cache.index_path());
        }
        room?;
        let old_size = idx
            .entries
            .get(&self.key)
            .map_or(0, |entry| entry.size_bytes);
        let total = idx
            .total_bytes
            .saturating_sub(old_size)
            .checked_add(self.bytes_written)
            .ok_or("cache size overflow")?;
        fs::rename(&self.temp_path, &self.final_path).map_err(|e| format!("cache rename: {e}"))?;
        if let Some(bytes) = idx.partials.remove(&self.id) {
            idx.partial_bytes = idx.partial_bytes.saturating_sub(bytes);
        }
        if let Some(old) = idx.entries.remove(&self.key) {
            idx.total_bytes = idx.total_bytes.saturating_sub(old.size_bytes);
        }
        idx.entries.insert(
            self.key.clone(),
            CacheEntry {
                filename: self.filename.clone(),
                size_bytes: self.bytes_written,
                last_accessed: now_secs(),
                computed_gain_db: None,
                gain_analysis_version: 0,
                revision: self.id.to_string(),
            },
        );
        idx.total_bytes = total;
        cache.evict_with_index(&mut idx);
        idx.save(&cache.index_path());
        Ok(())
    }

    pub fn abort(self) {
        drop(self);
    }
}

impl Drop for CacheWriter {
    fn drop(&mut self) {
        self.writer.take();
        if self.owner.directory_is_current() {
            let _ = fs::remove_file(&self.temp_path);
        }
        if let Ok(mut idx) = self.index.lock() {
            if let Some(bytes) = idx.partials.remove(&self.id) {
                idx.partial_bytes = idx.partial_bytes.saturating_sub(bytes);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn make_room(
    directory: &Path,
    idx: &mut CacheIndex,
    max: u64,
    extra_bytes: u64,
    extra_entries: usize,
    entry_limit: usize,
) -> Result<(), String> {
    let pending = idx
        .partial_bytes
        .checked_add(extra_bytes)
        .ok_or("cache size overflow")?;
    if max != 0 && pending > max {
        return Err("cache budget is occupied by active downloads".into());
    }
    let fits = |idx: &CacheIndex| {
        (max == 0 || idx.total_bytes <= max - pending)
            && idx.entries.len().saturating_add(extra_entries) <= entry_limit
    };
    if fits(idx) {
        return Ok(());
    }
    let mut entries: Vec<_> = idx
        .entries
        .iter()
        .map(|(key, entry)| (key.clone(), entry.last_accessed))
        .collect();
    entries.sort_by(|a, b| a.1.cmp(&b.1).then(a.0.cmp(&b.0)));
    for (key, _) in entries {
        if fits(idx) {
            break;
        }
        let entry = &idx.entries[&key];
        if valid_filename(&key, &entry.filename) {
            if let Err(error) = fs::remove_file(directory.join(&entry.filename)) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    return Err(format!("cannot evict cached audio: {error}"));
                }
            }
        }
        let removed = idx.entries.remove(&key).unwrap();
        idx.total_bytes = idx.total_bytes.saturating_sub(removed.size_bytes);
        debug!(cache_key = key, "evicted cached audio file");
    }
    if fits(idx) {
        Ok(())
    } else {
        Err("audio cache has no capacity".into())
    }
}

fn valid_key(key: &str) -> bool {
    if key.is_empty()
        || key.len() > MAX_KEY_BYTES
        || !key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return false;
    }
    // These are device names on Windows even with an extension. The index is
    // reserved on every platform and can never be a media cache entry.
    let upper = key.to_ascii_uppercase();
    !matches!(upper.as_str(), "INDEX" | "CON" | "PRN" | "AUX" | "NUL")
        && !(upper.len() == 4
            && (upper.starts_with("COM") || upper.starts_with("LPT"))
            && matches!(upper.as_bytes()[3], b'1'..=b'9'))
}

fn valid_extension(extension: &str) -> bool {
    !extension.is_empty()
        && extension.len() <= 16
        && extension.bytes().all(|b| b.is_ascii_alphanumeric())
}

fn valid_filename(key: &str, filename: &str) -> bool {
    valid_key(key)
        && filename
            .rsplit_once('.')
            .is_some_and(|(prefix, extension)| prefix == key && valid_extension(extension))
}

fn lock_cache_directory(directory: &Path) -> Result<fs::File, String> {
    let identity = directory_id(directory).ok_or("audio cache directory is unavailable")?;
    let path = directory.join(".audio-cache.lock");
    let lock = match fs::File::create_new(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            open_writable_regular_file(&path).map_err(|error| error.to_string())?
        }
        Err(error) => return Err(error.to_string()),
    };
    if !regular_file(&lock.metadata().map_err(|error| error.to_string())?) {
        return Err("audio cache lock is not a private file".into());
    }
    lock.try_lock()
        .map_err(|error| format!("audio cache is owned by another process: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        lock.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
    }
    if directory_id(directory) != Some(identity) || !file_is_current(&lock, &path) {
        return Err("audio cache directory changed".into());
    }
    Ok(lock)
}

fn owned_partial_filename(filename: &str) -> bool {
    let Some((media, id)) = filename
        .strip_suffix(".part")
        .and_then(|value| value.rsplit_once('.'))
    else {
        return false;
    };
    let Some((key, _)) = media.rsplit_once('.') else {
        return false;
    };
    valid_filename(key, media) && uuid::Uuid::parse_str(id).is_ok()
}

fn valid_entry(directory: &Path, key: &str, entry: &CacheEntry) -> bool {
    valid_filename(key, &entry.filename)
        && (entry.revision.is_empty() || uuid::Uuid::parse_str(&entry.revision).is_ok())
        && entry.size_bytes > 0
        && open_regular_file(&directory.join(&entry.filename)).is_ok_and(|file| {
            file.metadata()
                .is_ok_and(|metadata| metadata.len() == entry.size_bytes)
        })
}

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
    fn cache_child(directory: &Path, mode: &str) {
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "audio_engine::cache::tests::cache_lock_child",
                "--ignored",
            ])
            .env("HIBIKI_AUDIO_CACHE_TEST_DIR", directory)
            .env("HIBIKI_AUDIO_CACHE_TEST_MODE", mode)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
    }

    #[test]
    fn another_process_cannot_mutate_the_active_audio_cache_or_delete_its_writer() {
        let dir = tempfile::tempdir().unwrap();
        let cache = AudioCache::new(dir.path().into(), None);
        let mut writer = cache.begin_write("42", "flac").unwrap();
        writer.write_chunk(b"active partial").unwrap();
        writer.writer.as_mut().unwrap().flush().unwrap();
        let partial = writer.temp_path.clone();
        cache_child(dir.path(), "busy");
        assert_eq!(fs::read(partial).unwrap(), b"active partial");
        writer.finish(&cache).unwrap();
        assert_eq!(
            fs::read(cache.lookup("42").unwrap()).unwrap(),
            b"active partial"
        );
    }

    #[test]
    fn pending_writer_holds_exclusive_ownership_after_manager_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let cache = AudioCache::new(dir.path().into(), None);
        let writer = cache.begin_write("42", "flac").unwrap();
        drop(cache);
        let blocked = AudioCache::new(dir.path().into(), None);
        assert!(blocked.clear().is_err());
        drop(writer);
        drop(blocked);
        let fresh = AudioCache::new(dir.path().into(), None);
        assert!(fresh.begin_write("42", "flac").is_ok());
    }

    #[test]
    fn final_cache_owner_releases_lock_even_with_a_surviving_duplicate_descriptor() {
        let dir = tempfile::tempdir().unwrap();
        let cache = AudioCache::new(dir.path().into(), None);
        let mut writer = cache.begin_write("42", "flac").unwrap();
        writer.write_chunk(b"retained encoded source").unwrap();
        writer.finish(&cache).unwrap();
        // A process spawn can transiently inherit this open-file description
        // before exec closes its descriptor. Model that without forking tests.
        let inherited = cache.owner._lock.as_ref().unwrap().try_clone().unwrap();
        drop(cache);
        let restored = AudioCache::new(dir.path().into(), None);
        assert!(
            restored.available,
            "the final owner must release its lock explicitly"
        );
        assert_eq!(
            fs::read(restored.lookup("42").unwrap()).unwrap(),
            b"retained encoded source"
        );
        drop(inherited);
        let competing = AudioCache::new(dir.path().into(), None);
        assert!(
            !competing.available,
            "replacement owner retains exclusivity"
        );
        assert!(restored.begin_write("43", "flac").is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn replacing_the_lock_file_retires_the_old_cache_and_its_writer() {
        let dir = tempfile::tempdir().unwrap();
        let old = AudioCache::new(dir.path().into(), None);
        let mut writer = old.begin_write("42", "flac").unwrap();
        writer.write_chunk(b"old partial").unwrap();
        fs::remove_file(dir.path().join(".audio-cache.lock")).unwrap();
        let replacement = AudioCache::new(dir.path().into(), None);
        assert!(old.clear().is_err());
        assert!(writer.write_chunk(b"obsolete").is_err());
        let mut fresh = replacement.begin_write("42", "flac").unwrap();
        fresh.write_chunk(b"fresh audio").unwrap();
        fresh.finish(&replacement).unwrap();
        assert_eq!(
            fs::read(replacement.lookup("42").unwrap()).unwrap(),
            b"fresh audio"
        );
    }

    #[cfg(unix)]
    #[test]
    fn linked_lock_files_cannot_touch_another_files_data_or_permissions() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        for hard_link in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let outside = dir.path().join("outside");
            fs::write(&outside, b"private non-cache data").unwrap();
            fs::set_permissions(&outside, fs::Permissions::from_mode(0o640)).unwrap();
            let root = dir.path().join("cache");
            fs::create_dir(&root).unwrap();
            let lock = root.join(".audio-cache.lock");
            if hard_link {
                fs::hard_link(&outside, &lock).unwrap();
            } else {
                symlink(&outside, &lock).unwrap();
            }
            let cache = AudioCache::new(root, Some(1));
            assert!(cache.clear().is_err());
            assert!(cache.begin_write("42", "wav").is_err());
            assert_eq!(fs::read(&outside).unwrap(), b"private non-cache data");
            assert_eq!(
                fs::metadata(outside).unwrap().permissions().mode() & 0o777,
                0o640
            );
        }
    }

    #[test]
    fn startup_reclaims_crash_orphans_without_removing_unknown_files() {
        let dir = tempfile::tempdir().unwrap();
        cache_child(dir.path(), "crash");
        let cache = AudioCache::new(dir.path().into(), None);
        assert_eq!(cache.stats().total_bytes, 0);
        let names: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(!names.iter().any(|name| name.ends_with(".part")
            || name == ".audio-index.ABC123"
            || name.ends_with(".flac")));
        assert_eq!(
            fs::read(dir.path().join("favorite.wav")).unwrap(),
            b"unknown file"
        );
        assert!(cache.begin_write("42", "flac").is_ok());
    }

    #[test]
    #[ignore = "Invoked only by isolated cross-process cache regressions"]
    fn cache_lock_child() {
        let dir = PathBuf::from(std::env::var_os("HIBIKI_AUDIO_CACHE_TEST_DIR").unwrap());
        let cache = AudioCache::new(dir.clone(), Some(1));
        if std::env::var("HIBIKI_AUDIO_CACHE_TEST_MODE").unwrap() == "busy" {
            assert!(cache.clear().is_err());
            assert!(cache.set_max_bytes(1).is_err());
            assert!(cache.begin_write("replacement", "wav").is_err());
        } else {
            cache.set_max_bytes(1024).unwrap();
            let mut writer = cache.begin_write("42", "wav").unwrap();
            writer.write_chunk(b"crashed partial").unwrap();
            fs::write(
                dir.join(format!("{}.flac", "a".repeat(32))),
                b"unindexed completed file",
            )
            .unwrap();
            fs::write(dir.join(".audio-index.ABC123"), b"crashed index").unwrap();
            fs::write(dir.join("favorite.wav"), b"unknown file").unwrap();
            std::mem::forget(writer);
            std::process::exit(0); // Simulate loss of process without writer Drop.
        }
    }

    #[test]
    fn a_late_corrupt_file_report_cannot_discard_a_newer_download_with_the_same_key() {
        let directory = tempfile::tempdir().unwrap();
        let cache = AudioCache::new(directory.path().into(), None);
        let mut old = cache.begin_write("42", "flac").unwrap();
        let mut newer = cache.begin_write("42", "flac").unwrap();
        old.write_chunk(b"old audio").unwrap();
        old.finish(&cache).unwrap();
        let (_, stale_stamp) = cache.open_with_stamp("42").unwrap();
        newer.write_chunk(b"new audio").unwrap();
        newer.finish(&cache).unwrap();
        assert!(!cache.discard("42", &stale_stamp));
        assert_eq!(fs::read(cache.lookup("42").unwrap()).unwrap(), b"new audio");
        let (_, current_stamp) = cache.open_with_stamp("42").unwrap();
        assert!(cache.discard("42", &current_stamp));
        assert!(cache.lookup("42").is_none());
        assert_eq!(cache.stats().total_bytes, 0);
    }
    #[test]
    fn clear_reports_deletion_failures_and_preserves_unexpected_directories() {
        let directory = tempfile::tempdir().unwrap();
        let cache = AudioCache::new(directory.path().into(), None);
        let mut writer = cache.begin_write("42", "flac").unwrap();
        writer.write_chunk(b"cached audio").unwrap();
        writer.finish(&cache).unwrap();
        let path = cache.lookup("42").unwrap();
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        fs::write(path.join("preserved.txt"), b"unrelated content").unwrap();
        assert!(cache.clear().is_err());
        assert_eq!(cache.stats().file_count, 1);
        assert_eq!(
            fs::read(path.join("preserved.txt")).unwrap(),
            b"unrelated content"
        );
        let persisted = CacheIndex::load(&directory.path().join("index.json"));
        assert_eq!(persisted.entries.len(), 1);
    }
    #[cfg(unix)]
    #[test]
    fn startup_default_does_not_evict_a_larger_cache_before_preferences_are_restored() {
        use std::os::unix::fs::MetadataExt;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("42.flac");
        let file = fs::File::create(&path).unwrap();
        file.set_len(DEFAULT_MAX_BYTES + 1).unwrap();
        assert!(
            file.metadata().unwrap().blocks() * 512 < 1024 * 1024,
            "fixture must remain sparse"
        );
        drop(file);
        write_index(directory.path(), "42", "42.flac", DEFAULT_MAX_BYTES + 1);
        let cache = AudioCache::new(directory.path().into(), None);
        assert!(cache.lookup("42").is_some());
        assert_eq!(cache.stats().total_bytes, DEFAULT_MAX_BYTES + 1);
        cache.set_max_bytes(DEFAULT_MAX_BYTES + 2).unwrap();
        assert!(cache.lookup("42").is_some());
    }
    #[test]
    fn a_declared_oversized_download_keeps_useful_cached_audio() {
        let directory = tempfile::tempdir().unwrap();
        let cache = AudioCache::new(directory.path().into(), Some(10));
        let mut old = cache.begin_write("old", "flac").unwrap();
        old.write_chunk(&[1; 8]).unwrap();
        old.finish(&cache).unwrap();
        let mut oversized = cache.begin_write("large", "flac").unwrap();
        oversized.declared_size().store(20, Ordering::Release);
        assert!(oversized.write_chunk(&[0; 1]).is_err());
        assert_eq!(fs::read(cache.lookup("old").unwrap()).unwrap(), [1; 8]);
        assert_eq!(cache.stats().total_bytes, 8);
    }

    #[test]
    fn unlimited_bytes_still_bound_index_growth_and_keep_recent_tracks() {
        let directory = tempfile::tempdir().unwrap();
        let cache = AudioCache::with_limits(directory.path().into(), Some(0), 2);
        for (timestamp, key) in ["old", "middle", "recent"].into_iter().enumerate() {
            let mut writer = cache.begin_write(key, "flac").unwrap();
            writer.write_chunk(&[1; 20]).unwrap();
            writer.finish(&cache).unwrap();
            cache
                .index
                .lock()
                .unwrap()
                .entries
                .get_mut(key)
                .unwrap()
                .last_accessed = timestamp as u64;
        }
        assert!(cache.lookup("old").is_none());
        assert!(cache.lookup("middle").is_some() && cache.lookup("recent").is_some());
        assert_eq!(cache.stats().total_bytes, 40);
        assert_eq!(cache.stats().max_bytes, 0);
        assert_eq!(cache.stats().file_count, 2);
        let persisted = CacheIndex::load(&directory.path().join("index.json"));
        assert_eq!(persisted.entries.len(), 2);
        assert_eq!(persisted.partial_bytes, 0);
    }

    #[test]
    fn clearing_while_downloads_overlap_cannot_subtract_a_new_writers_reservation() {
        let directory = tempfile::tempdir().unwrap();
        let cache = AudioCache::new(directory.path().into(), Some(10));
        let mut old = cache.begin_write("old", "flac").unwrap();
        old.write_chunk(&[0; 6]).unwrap();
        cache.clear().unwrap();
        let mut fresh = cache.begin_write("fresh", "flac").unwrap();
        fresh.write_chunk(&[1; 6]).unwrap();
        drop(old);
        let mut next = cache.begin_write("next", "flac").unwrap();
        assert!(next.write_chunk(&[2; 6]).is_err());
        drop(next);
        fresh.finish(&cache).unwrap();
        assert_eq!(cache.stats().total_bytes, 6);
    }
    #[test]
    fn a_download_larger_than_the_cache_limit_is_rejected_before_publication() {
        let directory = tempfile::tempdir().unwrap();
        let cache = AudioCache::new(directory.path().into(), Some(10));
        let mut writer = cache.begin_write("42", "flac").unwrap();
        assert!(writer.write_chunk(&[0; 11]).is_err());
        assert!(writer.finish(&cache).is_err());
        assert_eq!(cache.stats().total_bytes, 0);
        assert_eq!(
            fs::read_dir(directory.path())
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "part"))
                .count(),
            0
        );
    }

    #[test]
    fn simultaneous_downloads_share_the_limit_and_aborting_releases_capacity() {
        let directory = tempfile::tempdir().unwrap();
        let cache = AudioCache::new(directory.path().into(), Some(10));
        let mut first = cache.begin_write("first", "flac").unwrap();
        first.write_chunk(&[1; 6]).unwrap();
        let mut second = cache.begin_write("second", "flac").unwrap();
        assert!(second.write_chunk(&[2; 6]).is_err());
        drop(second);
        drop(first);
        let mut fresh = cache.begin_write("fresh", "flac").unwrap();
        fresh.write_chunk(&[3; 10]).unwrap();
        fresh.finish(&cache).unwrap();
        assert_eq!(cache.stats().total_bytes, 10);
        assert_eq!(cache.stats().file_count, 1);
    }

    #[test]
    fn lowering_the_limit_retires_an_oversized_pending_download() {
        let directory = tempfile::tempdir().unwrap();
        let cache = AudioCache::new(directory.path().into(), Some(20));
        let mut pending = cache.begin_write("42", "flac").unwrap();
        pending.write_chunk(&[0; 16]).unwrap();
        cache.set_max_bytes(5).unwrap();
        assert!(pending.finish(&cache).is_err());
        let mut fresh = cache.begin_write("new", "flac").unwrap();
        fresh.write_chunk(&[1; 5]).unwrap();
        fresh.finish(&cache).unwrap();
        assert_eq!(cache.stats().total_bytes, 5);
    }

    #[test]
    fn downloading_new_audio_evicts_old_entries_before_the_partial_file_grows() {
        let directory = tempfile::tempdir().unwrap();
        let cache = AudioCache::new(directory.path().into(), Some(10));
        let mut old = cache.begin_write("old", "flac").unwrap();
        old.write_chunk(&[0; 8]).unwrap();
        old.finish(&cache).unwrap();
        let mut next = cache.begin_write("next", "flac").unwrap();
        next.write_chunk(&[1; 7]).unwrap();
        assert!(cache.lookup("old").is_none());
        next.finish(&cache).unwrap();
        assert_eq!(cache.stats().total_bytes, 7);
    }
    #[test]
    fn replacing_the_cache_directory_cannot_reuse_the_previous_owners_entries() {
        let directory = tempfile::tempdir().unwrap();
        let cache_dir = directory.path().join("cache");
        let cache = AudioCache::new(cache_dir.clone(), None);
        let mut writer = cache.begin_write("42", "flac").unwrap();
        writer.write_chunk(b"cached source").unwrap();
        writer.finish(&cache).unwrap();
        fs::rename(&cache_dir, directory.path().join("original-cache")).unwrap();
        fs::create_dir(&cache_dir).unwrap();
        fs::write(cache_dir.join("42.flac"), b"private data!").unwrap();
        let hit = cache.open("42");
        assert!(cache.clear().is_err());
        assert!(hit.is_none());
        assert_eq!(
            fs::read(cache_dir.join("42.flac")).unwrap(),
            b"private data!"
        );
        assert!(cache.begin_write("new", "flac").is_err());
    }

    #[test]
    fn hard_linked_media_cannot_import_another_files_contents() {
        let directory = tempfile::tempdir().unwrap();
        let cache_dir = directory.path().join("cache");
        fs::create_dir(&cache_dir).unwrap();
        let preserved = directory.path().join("preserved.flac");
        fs::write(&preserved, b"another file").unwrap();
        fs::hard_link(&preserved, cache_dir.join("42.flac")).unwrap();
        write_index(&cache_dir, "42", "42.flac", 12);
        let cache = AudioCache::new(cache_dir, None);
        assert!(cache.open("42").is_none());
        cache.clear().unwrap();
        assert_eq!(fs::read(preserved).unwrap(), b"another file");
    }
    #[cfg(unix)]
    #[test]
    fn redirecting_the_cache_root_retires_file_access_and_preserves_cleanup_targets() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let cache_dir = directory.path().join("cache");
        let cache = AudioCache::new(cache_dir.clone(), None);
        let mut writer = cache.begin_write("42", "flac").unwrap();
        writer.write_chunk(b"cached source").unwrap();
        writer.finish(&cache).unwrap();
        let mut pending = cache.begin_write("pending", "flac").unwrap();
        pending.write_chunk(b"pending audio").unwrap();
        let outside = directory.path().join("preserved");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("42.flac"), b"private data!").unwrap();
        let protected_partial = outside.join(pending.temp_path.file_name().unwrap());
        fs::write(&protected_partial, b"unrelated backup data").unwrap();
        fs::rename(&cache_dir, directory.path().join("original-cache")).unwrap();
        symlink(&outside, &cache_dir).unwrap();
        let hit = cache.open("42");
        assert!(cache.clear().is_err());
        let continued = pending.write_chunk(b"late bytes");
        let finalized = pending.finish(&cache);
        assert_eq!(fs::read(outside.join("42.flac")).unwrap(), b"private data!");
        assert_eq!(
            fs::read(protected_partial).unwrap(),
            b"unrelated backup data"
        );
        assert!(hit.is_none() && continued.is_err() && finalized.is_err());
        assert!(cache.begin_write("new", "flac").is_err());
    }
    #[test]
    fn an_open_playback_file_survives_clear_and_a_new_cache_writer() {
        let directory = tempfile::tempdir().unwrap();
        let cache = AudioCache::new(directory.path().into(), None);
        let mut writer = cache.begin_write("42", "flac").unwrap();
        writer.write_chunk(b"currently playing audio").unwrap();
        writer.finish(&cache).unwrap();
        let mut playing = cache.open("42").unwrap();
        cache.clear().unwrap();
        assert!(cache.open("42").is_none());
        let mut bytes = Vec::new();
        playing.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"currently playing audio");
        drop(playing);
        let mut fresh = cache.begin_write("42", "flac").unwrap();
        fresh.write_chunk(b"new audio").unwrap();
        fresh.finish(&cache).unwrap();
        assert_eq!(fs::read(cache.lookup("42").unwrap()).unwrap(), b"new audio");
    }

    #[test]
    fn index_reads_are_bounded_and_bad_names_cannot_become_writer_paths() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("42.flac"), b"orphan audio").unwrap();
        write_index(directory.path(), "42", "42.flac", 12);
        let mut oversized = fs::OpenOptions::new()
            .append(true)
            .open(directory.path().join("index.json"))
            .unwrap();
        let padding = [b' '; 4096];
        for _ in 0..=MAX_INDEX_BYTES / 4096 {
            oversized.write_all(&padding).unwrap();
        }
        drop(oversized);
        let cache = AudioCache::new(directory.path().into(), None);
        assert!(cache.lookup("42").is_none());
        assert_eq!(
            fs::read(directory.path().join("42.flac")).unwrap(),
            b"orphan audio"
        );
        for key in [
            "",
            "../42",
            "42/x",
            "42\\x",
            "index",
            "NUL",
            "con",
            "COM1",
            "Lpt9",
            "key:stream",
        ] {
            assert!(
                cache.begin_write(key, "flac").is_err(),
                "accepted key {key}"
            );
        }
        assert!(cache
            .begin_write(&"x".repeat(MAX_KEY_BYTES + 1), "flac")
            .is_err());
        let mut legitimate = cache.begin_write("s1-source", "../../outside").unwrap();
        legitimate.write_chunk(b"safe extension fallback").unwrap();
        legitimate.finish(&cache).unwrap();
        assert!(cache
            .lookup("s1-source")
            .unwrap()
            .ends_with("s1-source.dat"));
    }

    #[cfg(unix)]
    #[test]
    fn old_cache_files_become_private_and_replaced_links_cannot_be_read_or_chmodded() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let directory = tempfile::tempdir().unwrap();
        let cache_dir = directory.path().join("cache");
        fs::create_dir(&cache_dir).unwrap();
        let media = cache_dir.join("42.flac");
        fs::write(&media, b"cached audio").unwrap();
        write_index(&cache_dir, "42", "42.flac", 12);
        for path in [&media, &cache_dir.join("index.json")] {
            fs::set_permissions(path, fs::Permissions::from_mode(0o644)).unwrap();
        }
        let cache = AudioCache::new(cache_dir.clone(), None);
        assert!(cache.open("42").is_some());
        for path in [&media, &cache_dir.join("index.json")] {
            assert_eq!(fs::metadata(path).unwrap().permissions().mode() & 0o077, 0);
        }
        let outside = directory.path().join("outside.flac");
        fs::write(&outside, b"other source").unwrap();
        fs::set_permissions(&outside, fs::Permissions::from_mode(0o644)).unwrap();
        fs::remove_file(&media).unwrap();
        symlink(&outside, &media).unwrap();
        assert!(cache.open("42").is_none());
        assert_eq!(fs::read(&outside).unwrap(), b"other source");
        assert_eq!(
            fs::metadata(&outside).unwrap().permissions().mode() & 0o777,
            0o644
        );
        fs::remove_file(&media).unwrap();
        fs::hard_link(&outside, &media).unwrap();
        write_index(&cache_dir, "42", "42.flac", 12);
        let reopened = AudioCache::new(cache_dir, None);
        assert!(reopened.open("42").is_none());
        assert_eq!(
            fs::metadata(&outside).unwrap().permissions().mode() & 0o777,
            0o644
        );
    }
    fn write_index(directory: &Path, key: &str, filename: &str, size: u64) {
        let mut index = CacheIndex::default();
        index.entries.insert(
            key.into(),
            CacheEntry {
                filename: filename.into(),
                size_bytes: size,
                last_accessed: 1,
                computed_gain_db: None,
                gain_analysis_version: 0,
                revision: String::new(),
            },
        );
        index.total_bytes = size;
        fs::write(
            directory.join("index.json"),
            serde_json::to_vec(&index).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn damaged_index_cannot_read_or_delete_neighbouring_files() {
        for absolute in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let cache_dir = directory.path().join("cache");
            fs::create_dir(&cache_dir).unwrap();
            let preserved = directory.path().join("preserved.bin");
            fs::write(&preserved, b"user data outside cache").unwrap();
            let filename = if absolute {
                preserved.to_str().unwrap().to_owned()
            } else {
                "../preserved.bin".into()
            };
            write_index(&cache_dir, "42", &filename, 23);
            let cache = AudioCache::new(cache_dir, None);
            let invalid_hit = cache.lookup("42");
            cache.clear().unwrap();
            assert_eq!(fs::read(&preserved).unwrap(), b"user data outside cache");
            assert!(invalid_hit.is_none());
            assert_eq!(cache.stats().file_count, 0);
        }
    }

    #[test]
    fn index_entries_cannot_reassign_another_sources_file() {
        let directory = tempfile::tempdir().unwrap();
        let preserved = directory.path().join("other.flac");
        fs::write(&preserved, b"another source").unwrap();
        write_index(directory.path(), "42", "other.flac", 14);
        let cache = AudioCache::new(directory.path().into(), None);
        let invalid_hit = cache.lookup("42");
        cache.clear().unwrap();
        assert_eq!(fs::read(preserved).unwrap(), b"another source");
        assert!(invalid_hit.is_none());
    }

    #[test]
    fn clearing_cache_retires_existing_writers_but_accepts_new_downloads() {
        let directory = tempfile::tempdir().unwrap();
        let cache = AudioCache::new(directory.path().into(), None);
        let unrelated = directory.path().join("unrelated.part");
        fs::write(&unrelated, b"preserved unrelated file").unwrap();
        let mut obsolete = cache.begin_write("42", "flac").unwrap();
        obsolete.write_chunk(b"first chunk").unwrap();
        cache.clear().unwrap();
        assert!(obsolete.write_chunk(b"late chunk").is_err());
        assert!(obsolete.finish(&cache).is_err());
        assert_eq!(fs::read(unrelated).unwrap(), b"preserved unrelated file");
        assert_eq!(cache.stats().file_count, 0);
        let mut fresh = cache.begin_write("42", "flac").unwrap();
        fresh.write_chunk(b"fresh audio").unwrap();
        fresh.finish(&cache).unwrap();
        assert_eq!(
            fs::read(cache.lookup("42").unwrap()).unwrap(),
            b"fresh audio"
        );
    }

    #[test]
    fn a_writer_cannot_be_published_into_a_different_cache() {
        let first_dir = tempfile::tempdir().unwrap();
        let second_dir = tempfile::tempdir().unwrap();
        let first = AudioCache::new(first_dir.path().into(), None);
        let second = AudioCache::new(second_dir.path().into(), None);
        let mut writer = first.begin_write("42", "flac").unwrap();
        writer.write_chunk(b"owned audio").unwrap();
        assert!(writer.finish(&second).is_err());
        assert!(first.lookup("42").is_none() && second.lookup("42").is_none());
        assert!(!first_dir.path().join("42.flac").exists());
    }

    #[test]
    fn rejected_orphaned_bytes_do_not_block_a_fresh_download() {
        let directory = tempfile::tempdir().unwrap();
        let cache = AudioCache::new(directory.path().into(), None);
        let mut writer = cache.begin_write("42", "flac").unwrap();
        writer.write_chunk(b"complete audio").unwrap();
        writer.finish(&cache).unwrap();
        fs::write(cache.lookup("42").unwrap(), b"bad").unwrap();
        assert!(cache.lookup("42").is_none());
        drop(cache);
        let reopened = AudioCache::new(directory.path().into(), None);
        let mut fresh = reopened.begin_write("42", "flac").unwrap();
        fresh.write_chunk(b"fresh complete audio").unwrap();
        fresh.finish(&reopened).unwrap();
        assert_eq!(
            fs::read(reopened.lookup("42").unwrap()).unwrap(),
            b"fresh complete audio"
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_audio_and_index_files_are_rejected_without_touching_targets() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let cache_dir = directory.path().join("cache");
        fs::create_dir(&cache_dir).unwrap();
        let preserved = directory.path().join("preserved.flac");
        fs::write(&preserved, b"private source").unwrap();
        symlink(&preserved, cache_dir.join("42.flac")).unwrap();
        write_index(&cache_dir, "42", "42.flac", 14);
        let cache = AudioCache::new(cache_dir.clone(), None);
        assert!(cache.lookup("42").is_none());
        cache.clear().unwrap();
        assert_eq!(fs::read(preserved).unwrap(), b"private source");
        let outside_index = directory.path().join("outside.json");
        fs::write(&outside_index, b"{\"entries\":{},\"total_bytes\":123}").unwrap();
        fs::remove_file(cache_dir.join("index.json")).unwrap();
        symlink(&outside_index, cache_dir.join("index.json")).unwrap();
        let cache = AudioCache::new(cache_dir, None);
        assert_eq!(cache.stats().total_bytes, 0);
        assert_eq!(
            fs::read(outside_index).unwrap(),
            b"{\"entries\":{},\"total_bytes\":123}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn new_cache_media_and_index_files_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let cache = AudioCache::new(directory.path().join("cache"), None);
        let mut writer = cache.begin_write("42", "flac").unwrap();
        assert_eq!(
            fs::metadata(&writer.temp_path)
                .unwrap()
                .permissions()
                .mode()
                & 0o077,
            0
        );
        writer.write_chunk(b"private audio").unwrap();
        writer.finish(&cache).unwrap();
        for path in [cache.lookup("42").unwrap(), cache.index_path()] {
            assert_eq!(fs::metadata(path).unwrap().permissions().mode() & 0o077, 0);
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_cache_directory_cannot_read_or_clear_the_target_directory() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let outside = directory.path().join("preserved");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("42.flac"), b"preserved source").unwrap();
        write_index(&outside, "42", "42.flac", 16);
        let index = fs::read(outside.join("index.json")).unwrap();
        let cache_path = directory.path().join("cache");
        symlink(&outside, &cache_path).unwrap();
        let cache = AudioCache::new(cache_path, None);
        let hit = cache.lookup("42");
        assert!(cache.clear().is_err());
        assert_eq!(
            fs::read(outside.join("42.flac")).unwrap(),
            b"preserved source"
        );
        assert_eq!(fs::read(outside.join("index.json")).unwrap(), index);
        assert!(hit.is_none());
        assert!(cache.begin_write("new", "flac").is_err());
    }
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
        drop(cache);
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
            let mut saved: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            saved["entries"][&key]["gain_analysis_version"] = serde_json::json!(version);
            std::fs::write(path, serde_json::to_vec(&saved).unwrap()).unwrap();
            drop(cache);
            let restored = AudioCache::new(dir.path().into(), None);
            assert_eq!(restored.get_computed_gain(&key), None);
            assert_eq!(
                std::fs::read(restored.lookup(&key).unwrap()).unwrap(),
                b"encoded source is preserved"
            );
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
        assert_eq!(extract_extension("http://host/music/track.mp3"), "mp3");
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
        cache.clear().unwrap();
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
        for url in &urls[1..] {
            assert!(cache.lookup(&cache_key(url)).is_none());
        }
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
        assert_eq!(
            fs::read(cache.lookup("42").unwrap()).unwrap(),
            b"first complete audio"
        );
        second.write_chunk(b" complete audio").unwrap();
        second.finish(&cache).unwrap();
        assert_eq!(
            fs::read(cache.lookup("42").unwrap()).unwrap(),
            b"second complete audio"
        );
        assert_eq!(
            cache.stats().total_bytes,
            b"second complete audio".len() as u64
        );
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
