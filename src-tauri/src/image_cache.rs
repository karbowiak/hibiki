//! Artwork disk cache. Runtime reads, writes, and management operations run on
//! blocking workers. A request keeps its generation through fetch.

use crate::cache_files::{
    directory_id, open_regular_file, open_writable_regular_file, regular_file,
};
use crate::image_fetch::MAX_IMAGE_BYTES;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

pub const MAX_CACHE_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_CACHE_FILES: usize = 4096;

pub struct ImageCacheState(pub Arc<ImageCache>);

#[derive(Clone)]
pub struct Ticket {
    owner: Arc<()>,
    generation: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CacheInfo {
    pub files: usize,
    pub bytes: u64,
    pub max_bytes: u64,
    pub max_files: usize,
}

struct Root {
    directory: PathBuf,
    identity: (u64, u64),
    // Held for the lifetime of this manager. Other processes keep fetching
    // artwork, but cannot independently evict or clear this directory.
    _lock: fs::File,
}

struct PendingImage {
    file: Option<tempfile::NamedTempFile>,
    path: PathBuf,
    root: Arc<Root>,
}

impl PendingImage {
    fn new(root: Arc<Root>) -> Result<Self, String> {
        let prefix = format!(".imgcache.{}.", uuid::Uuid::new_v4());
        let file = tempfile::Builder::new()
            .prefix(&prefix)
            .suffix(".tmp")
            // Cleanup belongs to the original root, not its reusable pathname.
            .disable_cleanup(true)
            .tempfile_in(&root.directory)
            .map_err(|e| e.to_string())?;
        Ok(Self {
            path: file.path().to_owned(),
            file: Some(file),
            root,
        })
    }

    fn persist(mut self, path: &Path) -> Result<(), String> {
        self.file
            .take()
            .expect("pending image writer")
            .persist(path)
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

impl Drop for PendingImage {
    fn drop(&mut self) {
        // Close the file before unlinking, including on platforms that disallow
        // deletion of an open writer. A moved root leaves an owned crash orphan.
        drop(self.file.take());
        if directory_id(&self.root.directory) == Some(self.root.identity) {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[derive(Default)]
struct Index {
    loaded: bool,
    entries: HashMap<String, Entry>,
    bytes: u64,
}

struct Entry {
    bytes: u64,
    accessed: SystemTime,
}

pub struct ImageCache {
    root: Mutex<Result<Arc<Root>, String>>,
    configured_directory: Option<PathBuf>,
    index: Mutex<Index>,
    owner: Arc<()>,
    generation: AtomicU64,
    max_bytes: u64,
    max_files: usize,
}

impl ImageCache {
    pub fn new(directory: PathBuf) -> Self {
        Self::with_limits(directory, MAX_CACHE_BYTES, MAX_CACHE_FILES)
    }

    pub fn unavailable(error: String) -> Self {
        Self::from_root(Err(error), None, MAX_CACHE_BYTES, MAX_CACHE_FILES)
    }

    fn with_limits(directory: PathBuf, max_bytes: u64, max_files: usize) -> Self {
        Self::from_root(
            open_root(directory.clone()),
            Some(directory),
            max_bytes,
            max_files,
        )
    }

    fn from_root(
        root: Result<Root, String>,
        configured_directory: Option<PathBuf>,
        max_bytes: u64,
        max_files: usize,
    ) -> Self {
        Self {
            root: Mutex::new(root.map(Arc::new)),
            configured_directory,
            index: Mutex::new(Index::default()),
            owner: Arc::new(()),
            generation: AtomicU64::new(0),
            max_bytes,
            max_files,
        }
    }

    pub fn ticket(&self) -> Ticket {
        Ticket {
            owner: self.owner.clone(),
            generation: self.generation.load(Ordering::Acquire),
        }
    }

    fn accepts(&self, ticket: &Ticket) -> bool {
        Arc::ptr_eq(&self.owner, &ticket.owner)
            && ticket.generation == self.generation.load(Ordering::Acquire)
    }

    fn root(&self) -> Result<Arc<Root>, String> {
        let mut root = self.root.lock().map_err(|e| e.to_string())?;
        // A second instance can enable its cache when the first instance exits.
        // Once a directory is accepted, its identity remains pinned below.
        if root.is_err() {
            if let Some(path) = &self.configured_directory {
                *root = open_root(path.clone()).map(Arc::new);
            }
        }
        let root = root.as_ref().map_err(Clone::clone)?.clone();
        if directory_id(&root.directory) != Some(root.identity) {
            return Err("Artwork cache directory was moved or redirected".into());
        }
        Ok(root)
    }

    fn load(&self, index: &mut Index) -> Result<(), String> {
        if index.loaded {
            return Ok(());
        }
        let root = self.root()?;
        index.entries.clear();
        index.bytes = 0;
        for entry in fs::read_dir(&root.directory).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if owned_temporary(&name) {
                remove_owned_file(&entry.path())?;
                continue;
            }
            if !owned_image(&name) {
                continue;
            }
            let file = match open_regular_file(&entry.path()) {
                Ok(file) => file,
                Err(_) => {
                    remove_owned_file(&entry.path())?;
                    continue;
                }
            };
            let metadata = file.metadata().map_err(|e| e.to_string())?;
            drop(file);
            if metadata.len() == 0 || metadata.len() > MAX_IMAGE_BYTES as u64 {
                remove_owned_file(&entry.path())?;
                continue;
            }
            index.bytes += metadata.len();
            index.entries.insert(
                name,
                Entry {
                    bytes: metadata.len(),
                    accessed: metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                },
            );
            self.make_room(index, 0, 0, None)?;
        }
        index.loaded = true;
        Ok(())
    }

    fn make_room(
        &self,
        index: &mut Index,
        extra_bytes: u64,
        extra_files: usize,
        protected: Option<&str>,
    ) -> Result<(), String> {
        let root = self.root()?;
        while index.bytes.saturating_add(extra_bytes) > self.max_bytes
            || index.entries.len().saturating_add(extra_files) > self.max_files
        {
            let oldest = index
                .entries
                .iter()
                .filter(|(key, _)| Some(key.as_str()) != protected)
                .min_by_key(|(_, entry)| entry.accessed)
                .map(|(key, _)| key.clone())
                .ok_or("Artwork does not fit the available cache budget")?;
            remove_owned_file(&root.directory.join(&oldest))?;
            if let Some(entry) = index.entries.remove(&oldest) {
                index.bytes -= entry.bytes;
            }
        }
        Ok(())
    }

    pub fn read(&self, ticket: &Ticket, key: &str) -> Option<Vec<u8>> {
        if !owned_image(key) || !self.accepts(ticket) {
            return None;
        }
        let mut index = self.index.lock().ok()?;
        let root = self.root().ok()?;
        self.load(&mut index).ok()?;
        if !self.accepts(ticket) {
            return None;
        }
        let entry = index.entries.get_mut(key)?;
        let path = root.directory.join(key);
        let file = open_writable_regular_file(&path)
            .or_else(|_| open_regular_file(&path))
            .ok()?;
        if file.metadata().ok()?.len() != entry.bytes {
            return None;
        }
        let mut bytes = Vec::new();
        (&file)
            .take(MAX_IMAGE_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES || bytes.len() as u64 != entry.bytes {
            return None;
        }
        entry.accessed = SystemTime::now();
        let _ = file.set_modified(entry.accessed);
        Some(bytes)
    }

    pub fn store(&self, ticket: &Ticket, key: &str, bytes: &[u8]) -> Result<(), String> {
        self.store_with_before_publish(ticket, key, bytes, |_| {})
    }

    fn store_with_before_publish(
        &self,
        ticket: &Ticket,
        key: &str,
        bytes: &[u8],
        before_publish: impl FnOnce(&Path),
    ) -> Result<(), String> {
        if !owned_image(key)
            || bytes.is_empty()
            || bytes.len() > MAX_IMAGE_BYTES
            || bytes.len() as u64 > self.max_bytes
            || self.max_files == 0
        {
            return Err("Invalid artwork cache entry".into());
        }
        let mut index = self.index.lock().map_err(|e| e.to_string())?;
        let root = self.root()?;
        if !self.accepts(ticket) {
            return Err("Artwork request was retired".into());
        }
        self.load(&mut index)?;
        if index
            .entries
            .get(key)
            .is_some_and(|entry| entry.bytes.saturating_add(bytes.len() as u64) > self.max_bytes)
        {
            return Err("Artwork replacement does not fit the available cache budget".into());
        }
        let extra_files = usize::from(!index.entries.contains_key(key));
        // Reserve temporary-file bytes too, keeping disk use bounded during
        // atomic replacement of an existing complete image.
        self.make_room(&mut index, bytes.len() as u64, extra_files, Some(key))?;
        let mut temporary = PendingImage::new(root.clone())?;
        temporary
            .file
            .as_mut()
            .expect("pending image writer")
            .write_all(bytes)
            .map_err(|e| e.to_string())?;
        before_publish(&temporary.path);
        self.root()?;
        if !self.accepts(ticket) {
            return Err("Artwork request was retired".into());
        }
        temporary.persist(&root.directory.join(key))?;
        if let Some(old) = index.entries.insert(
            key.to_owned(),
            Entry {
                bytes: bytes.len() as u64,
                accessed: SystemTime::now(),
            },
        ) {
            index.bytes -= old.bytes;
        }
        index.bytes += bytes.len() as u64;
        Ok(())
    }

    fn info(&self, index: &Index) -> CacheInfo {
        CacheInfo {
            files: index.entries.len(),
            bytes: index.bytes,
            max_bytes: self.max_bytes,
            max_files: self.max_files,
        }
    }

    pub fn stats(&self) -> Result<CacheInfo, String> {
        let mut index = self.index.lock().map_err(|e| e.to_string())?;
        self.root()?;
        // Settings should also reflect manually removed/damaged cache files.
        index.loaded = false;
        self.load(&mut index)?;
        Ok(self.info(&index))
    }

    pub fn clear(&self) -> Result<CacheInfo, String> {
        self.generation.fetch_add(1, Ordering::AcqRel);
        let mut index = self.index.lock().map_err(|e| e.to_string())?;
        let root = self.root()?;
        let mut failure = None;
        for entry in fs::read_dir(&root.directory).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name();
            if name
                .to_str()
                .is_some_and(|name| owned_image(name) || owned_temporary(name))
            {
                if let Err(error) = remove_owned_file(&entry.path()) {
                    failure = Some(error);
                }
            }
        }
        for kind in ["pleximg", "metaimg"] {
            if let Err(error) = clear_legacy(&root.directory, kind) {
                failure = Some(error);
            }
        }
        index.loaded = false;
        let rescan = self.load(&mut index);
        if let Some(error) = failure {
            return Err(error);
        }
        rescan?;
        Ok(self.info(&index))
    }
}

fn open_root(directory: PathBuf) -> Result<Root, String> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&directory).map_err(|e| e.to_string())?;
    let identity = directory_id(&directory).ok_or("Artwork cache is not a private directory")?;
    let directory = fs::canonicalize(directory).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    let path = directory.join(".imgcache.lock");
    // create_new never follows a pre-existing link or truncates an old file.
    let lock = match fs::File::create_new(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            open_writable_regular_file(&path).map_err(|e| e.to_string())?
        }
        Err(error) => return Err(error.to_string()),
    };
    if !regular_file(&lock.metadata().map_err(|e| e.to_string())?) {
        return Err("Artwork cache lock is not a private file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        lock.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    lock.try_lock()
        .map_err(|error| format!("Cannot lock the artwork cache: {error}"))?;
    if directory_id(&directory) != Some(identity) {
        return Err("Artwork cache directory changed".into());
    }
    Ok(Root {
        directory,
        identity,
        _lock: lock,
    })
}

fn owned_image(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".img") else {
        return false;
    };
    if let Some(digest) = stem.strip_prefix("v2_") {
        return digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_hexdigit());
    }
    // Earlier versions used type + entity ID + an eight-digit URL digest.
    let Some((identity, digest)) = stem.rsplit_once('_') else {
        return false;
    };
    let Some((kind, id)) = identity.split_once('_') else {
        return false;
    };
    matches!(kind, "artist" | "album" | "track" | "playlist" | "ext")
        && !id.is_empty()
        && id.len() <= 256
        && !id.contains(['/', '\\', ':'])
        && (digest == "fallback"
            || (digest.len() == 8 && digest.bytes().all(|b| b.is_ascii_hexdigit())))
}

fn clear_legacy(current: &Path, kind: &str) -> Result<(), String> {
    let path = current
        .parent()
        .ok_or("Artwork cache has no parent directory")?
        .join(kind);
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
        Ok(_) => {}
    }
    let root = open_root(path)?;
    for entry in fs::read_dir(&root.directory).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let Some(stem) = name.to_str().and_then(|name| name.strip_suffix(".img")) else {
            continue;
        };
        let owned = if kind == "metaimg" {
            stem.len() == 32 && stem.bytes().all(|b| b.is_ascii_hexdigit())
        } else {
            ["library_", "playlists_", "photo_"]
                .iter()
                .any(|prefix| stem.starts_with(prefix))
                && stem.len() <= 512
                && stem
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
        };
        if owned {
            if directory_id(&root.directory) != Some(root.identity) {
                return Err("Old artwork cache directory changed".into());
            }
            remove_owned_file(&entry.path())?;
        }
    }
    Ok(())
}

fn owned_temporary(name: &str) -> bool {
    let Some(stem) = name
        .strip_prefix(".imgcache.")
        .and_then(|name| name.strip_suffix(".tmp"))
    else {
        return false;
    };
    let Some((id, random)) = stem.split_once('.') else {
        return false;
    };
    uuid::Uuid::parse_str(id).is_ok()
        && random.len() == 6
        && random.bytes().all(|b| b.is_ascii_alphanumeric())
}

fn remove_owned_file(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        // Never recurse into a directory occupying a supposed image filename.
        Ok(metadata) if metadata.file_type().is_dir() => {
            Err("Artwork cache entry was replaced by a directory".into())
        }
        Ok(_) => fs::remove_file(path).map_err(|e| e.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

pub async fn read(cache: Arc<ImageCache>, ticket: Ticket, key: String) -> Option<Vec<u8>> {
    tokio::task::spawn_blocking(move || cache.read(&ticket, &key))
        .await
        .ok()
        .flatten()
}

pub async fn store(cache: Arc<ImageCache>, ticket: Ticket, key: String, bytes: Vec<u8>) -> Vec<u8> {
    // A failed disk write must not hide successfully fetched artwork.
    tokio::task::spawn_blocking(move || {
        let _ = cache.store(&ticket, &key, &bytes);
        bytes
    })
    .await
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(id: u64) -> String {
        format!("v2_{id:064x}.img")
    }

    #[test]
    fn byte_and_file_budgets_evict_least_recently_used_artwork() {
        let directory = tempfile::tempdir().unwrap();
        let cache = ImageCache::with_limits(directory.path().join("images"), 12, 2);
        let ticket = cache.ticket();
        cache.store(&ticket, &key(1), b"aaaa").unwrap();
        cache.store(&ticket, &key(2), b"bbbb").unwrap();
        assert_eq!(cache.read(&ticket, &key(1)).unwrap(), b"aaaa");
        cache.store(&ticket, &key(3), b"cccc").unwrap();
        assert!(cache.read(&ticket, &key(2)).is_none());
        assert_eq!(cache.stats().unwrap().files, 2);
        assert_eq!(cache.stats().unwrap().bytes, 8);
        assert!(cache.store(&ticket, &key(4), &[0; 13]).is_err());
        assert_eq!(cache.read(&ticket, &key(1)).unwrap(), b"aaaa");
    }

    #[test]
    fn existing_cache_is_bounded_on_first_use_and_keeps_recent_images() {
        let directory = tempfile::tempdir().unwrap();
        for id in 1..=3 {
            let path = directory.path().join(key(id));
            fs::write(&path, [id as u8; 4]).unwrap();
            fs::File::options()
                .read(true)
                .write(true)
                .open(path)
                .unwrap()
                .set_modified(SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(id))
                .unwrap();
        }
        fs::write(directory.path().join("user-notes.txt"), b"keep me").unwrap();
        let cache = ImageCache::with_limits(directory.path().into(), 8, 2);
        assert_eq!(cache.stats().unwrap().bytes, 8);
        assert!(!directory.path().join(key(1)).exists());
        assert_eq!(cache.read(&cache.ticket(), &key(3)).unwrap(), [3; 4]);
        cache.clear().unwrap();
        assert_eq!(
            fs::read(directory.path().join("user-notes.txt")).unwrap(),
            b"keep me"
        );
    }

    #[test]
    fn clear_retires_old_tickets_and_a_ticket_cannot_write_another_cache() {
        let directory = tempfile::tempdir().unwrap();
        let cache = ImageCache::new(directory.path().join("first"));
        let second = ImageCache::new(directory.path().join("second"));
        let old = cache.ticket();
        cache.store(&old, &key(1), b"first image").unwrap();
        assert_eq!(cache.clear().unwrap().files, 0);
        assert!(cache.store(&old, &key(1), b"late image").is_err());
        assert!(cache.read(&old, &key(1)).is_none());
        assert!(second
            .store(&cache.ticket(), &key(1), b"wrong owner")
            .is_err());
        cache
            .store(&cache.ticket(), &key(1), b"current image")
            .unwrap();
        assert_eq!(cache.stats().unwrap().files, 1);
    }

    #[test]
    fn replacements_are_atomic_and_invalid_or_oversized_files_are_not_served() {
        let directory = tempfile::tempdir().unwrap();
        let cache = ImageCache::new(directory.path().into());
        let ticket = cache.ticket();
        cache.store(&ticket, &key(1), b"first image").unwrap();
        cache
            .store(&ticket, &key(1), b"complete second image")
            .unwrap();
        assert_eq!(
            cache.read(&ticket, &key(1)).unwrap(),
            b"complete second image"
        );
        assert!(cache.store(&ticket, "../../outside.img", b"image").is_err());
        assert!(cache.store(&ticket, &key(2), &[]).is_err());
        assert!(cache
            .store(&ticket, &key(2), &vec![0; MAX_IMAGE_BYTES + 1])
            .is_err());
        let file = fs::File::options()
            .write(true)
            .open(directory.path().join(key(1)))
            .unwrap();
        file.set_len(MAX_IMAGE_BYTES as u64 + 1).unwrap();
        assert!(cache.read(&ticket, &key(1)).is_none());
        assert_eq!(cache.stats().unwrap().files, 0);
    }

    #[test]
    fn another_manager_cannot_independently_clear_or_evict_the_cache() {
        let directory = tempfile::tempdir().unwrap();
        let first = ImageCache::new(directory.path().into());
        first.store(&first.ticket(), &key(1), b"owned").unwrap();
        let second = ImageCache::new(directory.path().into());
        assert!(second.stats().is_err());
        assert!(second.clear().is_err());
        assert!(second
            .store(&second.ticket(), &key(1), b"replacement")
            .is_err());
        assert_eq!(first.read(&first.ticket(), &key(1)).unwrap(), b"owned");
        drop(first);
        assert_eq!(second.read(&second.ticket(), &key(1)).unwrap(), b"owned");
        drop(second);
        let third = ImageCache::new(directory.path().into());
        assert_eq!(third.read(&third.ticket(), &key(1)).unwrap(), b"owned");
    }

    #[test]
    fn another_process_cannot_clear_or_replace_a_locked_artwork_cache() {
        let directory = tempfile::tempdir().unwrap();
        let cache = ImageCache::new(directory.path().into());
        cache.store(&cache.ticket(), &key(1), b"owned").unwrap();
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "image_cache::tests::lock_child_process",
                "--ignored",
            ])
            .env("HIBIKI_IMAGE_CACHE_LOCK_TEST_DIR", directory.path())
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stdout)
        );
        assert_eq!(cache.read(&cache.ticket(), &key(1)).unwrap(), b"owned");
    }

    #[test]
    #[ignore = "Invoked only by the isolated cross-process lock regression"]
    fn lock_child_process() {
        let directory = PathBuf::from(
            std::env::var_os("HIBIKI_IMAGE_CACHE_LOCK_TEST_DIR").expect("parent test directory"),
        );
        let cache = ImageCache::new(directory);
        assert!(cache.stats().is_err());
        assert!(cache.clear().is_err());
        assert!(cache
            .store(&cache.ticket(), &key(1), b"replacement")
            .is_err());
    }

    #[test]
    fn crashed_owned_temporary_files_are_cleaned_and_unknown_files_are_preserved() {
        let directory = tempfile::tempdir().unwrap();
        let owned = directory
            .path()
            .join(format!(".imgcache.{}.ABC123.tmp", uuid::Uuid::new_v4()));
        fs::write(&owned, b"partial").unwrap();
        fs::write(directory.path().join(".imgcache.user.tmp"), b"keep").unwrap();
        let cache = ImageCache::new(directory.path().into());
        assert_eq!(cache.stats().unwrap().files, 0);
        assert!(!owned.exists());
        cache.clear().unwrap();
        assert_eq!(
            fs::read(directory.path().join(".imgcache.user.tmp")).unwrap(),
            b"keep"
        );
    }

    #[test]
    fn clear_removes_old_image_cache_formats_without_recursing_or_deleting_unknown_files() {
        let directory = tempfile::tempdir().unwrap();
        let cache = ImageCache::new(directory.path().join("imgcache"));
        fs::write(
            directory.path().join("imgcache/artist_42_fallback.img"),
            b"old artwork",
        )
        .unwrap();
        for (kind, key) in [
            ("pleximg", "library_metadata_42_thumb.img"),
            ("metaimg", "0123456789abcdef0123456789abcdef.img"),
        ] {
            let path = directory.path().join(kind);
            fs::create_dir(&path).unwrap();
            fs::write(path.join(key), b"old artwork").unwrap();
            fs::write(path.join("notes.txt"), b"keep").unwrap();
        }
        cache.clear().unwrap();
        assert!(!directory
            .path()
            .join("imgcache/artist_42_fallback.img")
            .exists());
        assert!(!directory
            .path()
            .join("pleximg/library_metadata_42_thumb.img")
            .exists());
        assert!(!directory
            .path()
            .join("metaimg/0123456789abcdef0123456789abcdef.img")
            .exists());
        assert_eq!(
            fs::read(directory.path().join("pleximg/notes.txt")).unwrap(),
            b"keep"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_redirected_old_image_cache_is_not_followed_by_clear() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let outside = directory.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("library_metadata_42_thumb.img"), b"keep").unwrap();
        symlink(&outside, directory.path().join("pleximg")).unwrap();
        let cache = ImageCache::new(directory.path().join("imgcache"));
        assert!(cache.clear().is_err());
        assert_eq!(
            fs::read(outside.join("library_metadata_42_thumb.img")).unwrap(),
            b"keep"
        );
    }

    #[cfg(unix)]
    #[test]
    fn moving_a_cache_mid_write_cannot_redirect_temporary_file_cleanup() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("images");
        let moved = directory.path().join("moved");
        let outside = directory.path().join("outside");
        fs::create_dir(&outside).unwrap();
        let cache = ImageCache::new(path.clone());
        let mut filename = None;
        assert!(cache
            .store_with_before_publish(&cache.ticket(), &key(1), b"artwork", |temporary| {
                let name = temporary.file_name().unwrap().to_owned();
                fs::rename(&path, &moved).unwrap();
                symlink(&outside, &path).unwrap();
                fs::write(outside.join(&name), b"outside data").unwrap();
                filename = Some(name);
            })
            .is_err());
        let filename = filename.unwrap();
        assert_eq!(fs::read(outside.join(&filename)).unwrap(), b"outside data");
        assert!(moved.join(&filename).exists());
        // Once the original directory is restored, the owned orphan is safe
        // to clean up; the identically named outside file stays untouched.
        fs::remove_file(&path).unwrap();
        fs::rename(&moved, &path).unwrap();
        assert_eq!(cache.stats().unwrap().files, 0);
        assert!(!path.join(&filename).exists());
        assert_eq!(fs::read(outside.join(&filename)).unwrap(), b"outside data");
    }

    #[cfg(unix)]
    #[test]
    fn links_and_redirected_roots_cannot_read_or_modify_outside_files() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let directory = tempfile::tempdir().unwrap();
        let outside = directory.path().join("outside");
        fs::create_dir(&outside).unwrap();
        let victim = outside.join(key(1));
        fs::write(&victim, b"outside data").unwrap();
        fs::set_permissions(&victim, fs::Permissions::from_mode(0o644)).unwrap();
        let path = directory.path().join("images");
        let cache = ImageCache::new(path.clone());
        let ticket = cache.ticket();
        symlink(&victim, path.join(key(1))).unwrap();
        assert!(cache.read(&ticket, &key(1)).is_none());
        fs::hard_link(&victim, path.join(key(2))).unwrap();
        assert!(cache.read(&ticket, &key(2)).is_none());
        cache.clear().unwrap();
        assert_eq!(fs::read(&victim).unwrap(), b"outside data");
        assert_eq!(
            fs::metadata(&victim).unwrap().permissions().mode() & 0o777,
            0o644
        );
        fs::rename(&path, directory.path().join("moved")).unwrap();
        symlink(&outside, &path).unwrap();
        assert!(cache.store(&cache.ticket(), &key(1), b"changed").is_err());
        assert!(cache.clear().is_err());
        assert!(cache.read(&cache.ticket(), &key(1)).is_none());
        let redirected = ImageCache::new(path);
        assert!(redirected.stats().is_err());
        assert_eq!(fs::read(&victim).unwrap(), b"outside data");
    }

    #[tokio::test]
    async fn a_download_finishing_after_clear_returns_artwork_without_refilling_disk() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let directory = tempfile::tempdir().unwrap();
        let cache = Arc::new(ImageCache::new(directory.path().into()));
        let ticket = cache.ticket();
        const ARTWORK: &[u8] = &[
            137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1,
            8, 4, 0, 0, 0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 100, 248, 15,
            0, 1, 5, 1, 1, 39, 24, 227, 102, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
        ];
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let uri = format!("http://{}", listener.local_addr().unwrap());
        let (started, waiting) = tokio::sync::oneshot::channel();
        let (continue_download, released) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 2048];
            socket.read(&mut request).await.unwrap();
            let header = format!("HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", ARTWORK.len());
            socket.write_all(header.as_bytes()).await.unwrap();
            started.send(()).unwrap();
            released.await.unwrap();
            socket.write_all(ARTWORK).await.unwrap();
        });
        let pending_cache = cache.clone();
        let download = tokio::spawn(async move {
            let bytes = crate::image_fetch::fetch(crate::image_fetch::request(None, &uri).unwrap())
                .await
                .unwrap();
            store(pending_cache, ticket, key(1), bytes).await
        });
        waiting.await.unwrap();
        assert_eq!(cache.clear().unwrap().files, 0);
        continue_download.send(()).unwrap();
        assert_eq!(download.await.unwrap(), ARTWORK);
        server.await.unwrap();
        assert_eq!(cache.stats().unwrap().files, 0);
        assert!(!directory.path().join(key(1)).exists());
    }
}
