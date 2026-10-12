//! Artwork disk cache. Runtime reads, writes, and management operations run on
//! blocking workers. A request keeps its generation through fetch.

use crate::cache_files::{
    directory_id, file_is_current, open_regular_file, open_writable_regular_file, regular_file,
};
use crate::image_fetch::MAX_IMAGE_BYTES;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::SystemTime;

pub const MAX_CACHE_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_CACHE_FILES: usize = 4096;
const PROOF_FILE: &str = ".imgcache.verified-v1.json";
const MAX_PROOF_BYTES: u64 = 1024 * 1024;
// Bump whenever the full raster validation policy changes.
const VALIDATOR_VERSION: u32 = 2;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Proof {
    sha256: String,
    mime: String,
}

impl Proof {
    fn of(bytes: &[u8]) -> Option<Self> {
        Some(Self {
            sha256: format!("{:x}", Sha256::digest(bytes)),
            mime: crate::image_content::mime(bytes)?.to_owned(),
        })
    }
    fn matches(&self, bytes: &[u8]) -> bool {
        crate::image_content::mime(bytes) == Some(self.mime.as_str())
            && self.sha256 == format!("{:x}", Sha256::digest(bytes))
    }
    fn valid(&self) -> bool {
        self.sha256.len() == 64
            && self.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            && matches!(
                self.mime.as_str(),
                "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/bmp"
            )
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ProofManifest {
    validator_version: u32,
    entries: HashMap<String, Proof>,
}

pub struct ImageCacheState(pub Arc<ImageCache>);

#[derive(Clone)]
pub struct Ticket {
    owner: Arc<()>,
    generation: u64,
    key_owner: Option<(String, Arc<()>)>,
}

impl PartialEq for Ticket {
    fn eq(&self, other: &Self) -> bool {
        self.generation == other.generation && Arc::ptr_eq(&self.owner, &other.owner)
            && match (&self.key_owner, &other.key_owner) {
                (None, None) => true,
                (Some((a, owner_a)), Some((b, owner_b))) => a == b && Arc::ptr_eq(owner_a, owner_b),
                _ => false,
            }
    }
}
impl Eq for Ticket {}
impl Hash for Ticket {
    fn hash<H: Hasher>(&self, state: &mut H) {
        Arc::as_ptr(&self.owner).hash(state);
        self.generation.hash(state);
        if let Some((key, owner)) = &self.key_owner { key.hash(state); Arc::as_ptr(owner).hash(state); }
    }
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

impl Root {
    fn is_current(&self) -> bool {
        directory_id(&self.directory) == Some(self.identity)
            && file_is_current(&self._lock, &self.directory.join(".imgcache.lock"))
    }
}

impl Drop for Root {
    fn drop(&mut self) {
        // A concurrent spawn may retain a duplicate descriptor until exec.
        // Release at the final Arc owner instead of waiting for that close;
        // pending image writers still retain this root and its exclusion.
        if let Err(error) = self._lock.unlock() {
            tracing::warn!(%error, "failed to release artwork cache ownership");
        }
    }
}

struct PendingImage {
    file: Option<tempfile::NamedTempFile>,
    path: PathBuf,
    root: Arc<Root>,
}

impl PendingImage {
    fn new(root: Arc<Root>) -> Result<Self, String> {
        if !root.is_current() {
            return Err("Artwork cache ownership changed".into());
        }
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
        if !self.root.is_current() {
            return Err("Artwork cache ownership changed".into());
        }
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
        if self.root.is_current() {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[derive(Default)]
struct Index {
    loaded: bool,
    entries: HashMap<String, Entry>,
    bytes: u64,
    proof_bytes: u64,
}

struct Entry {
    proof: Option<Proof>,
    bytes: u64,
    accessed: SystemTime,
}

pub struct ImageCache {
    root: Mutex<Result<Arc<Root>, String>>,
    configured_directory: Option<PathBuf>,
    index: Mutex<Index>,
    owner: Arc<()>,
    generation: AtomicU64,
    key_owners: Mutex<HashMap<String, Weak<()>>>,
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
            key_owners: Mutex::new(HashMap::new()),
            max_bytes,
            max_files,
        }
    }

    pub fn ticket(&self) -> Ticket {
        Ticket {
            owner: self.owner.clone(),
            generation: self.generation.load(Ordering::Acquire),
            key_owner: None,
        }
    }

    fn accepts(&self, ticket: &Ticket) -> bool {
        Arc::ptr_eq(&self.owner, &ticket.owner)
            && ticket.generation == self.generation.load(Ordering::Acquire)
            && ticket.key_owner.as_ref().is_none_or(|(key, owner)| {
                self.key_owners.lock().ok().and_then(|owners| owners.get(key).and_then(Weak::upgrade))
                    .is_some_and(|current| Arc::ptr_eq(&current, owner))
            })
    }

    /// Capture source ownership before any queued read, download or publication.
    pub fn bind_key(&self, ticket: &Ticket, key: &str) -> Result<Ticket, String> {
        if !owned_image(key) || !self.accepts(ticket) { return Err("Artwork request was retired".into()); }
        if ticket.key_owner.as_ref().is_some_and(|(bound, _)| bound == key) { return Ok(ticket.clone()); }
        let mut owners = self.key_owners.lock().map_err(|_| "Artwork ownership is unavailable")?;
        owners.retain(|_, owner| owner.strong_count() > 0);
        if owners.len() >= 2048 && !owners.contains_key(key) { return Err("Too many pending artwork sources".into()); }
        let owner = owners.get(key).and_then(Weak::upgrade).unwrap_or_else(|| Arc::new(()));
        owners.insert(key.to_owned(), Arc::downgrade(&owner));
        let mut bound = ticket.clone();
        bound.key_owner = Some((key.to_owned(), owner));
        Ok(bound)
    }

    /// Replace one source without evicting unrelated images. Publication and
    /// source retirement share the index lock with every ordinary writer.
    pub fn refresh(&self, ticket: &Ticket, key: &str, bytes: &[u8]) -> Result<(), String> {
        if ticket.key_owner.as_ref().is_none_or(|(bound, _)| bound != key)
            || !owned_image(key) || bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
            return Err("Invalid artwork refresh".into());
        }
        let proof = Proof::of(bytes).ok_or("Invalid artwork refresh")?;
        let mut index = self.index.lock().map_err(|_| "Artwork cache is unavailable")?;
        let root = self.root()?;
        self.load(&mut index)?;
        if !self.accepts(ticket) { return Err("Artwork request was retired".into()); }
        if index.bytes.saturating_add(index.proof_bytes).saturating_add(bytes.len() as u64) > self.max_bytes
            || (!index.entries.contains_key(key) && index.entries.len() >= self.max_files) {
            return Err("Not enough artwork cache space to refresh this image".into());
        }
        self.publish(&mut index, &root, ticket, key, bytes, Some(proof), |_| {})?;
        let owner = Arc::new(());
        self.key_owners.lock().map_err(|_| "Artwork ownership is unavailable")?.insert(key.to_owned(), Arc::downgrade(&owner));
        // Proof persistence is optional and must not evict unrelated images.
        // The next validated read can save it using normal cache policy.
        Ok(())
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
        if !root.is_current() {
            return Err("Artwork cache directory or lock ownership changed".into());
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
        let (mut proofs, mut proof_bytes) = load_proofs(&root)?;
        if proof_bytes > self.max_bytes {
            remove_owned_file(&root.directory.join(PROOF_FILE))?;
            proofs.clear();
            proof_bytes = 0;
        }
        index.proof_bytes = proof_bytes;
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
            let proof = proofs.get(&name).cloned();
            index.entries.insert(
                name,
                Entry {
                    proof,
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
        while index
            .bytes
            .saturating_add(index.proof_bytes)
            .saturating_add(extra_bytes)
            > self.max_bytes
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
        self.read_with_proof(ticket, key).map(|(bytes, _)| bytes)
    }

    fn read_with_proof(&self, ticket: &Ticket, key: &str) -> Option<(Vec<u8>, bool)> {
        if !owned_image(key) || !self.accepts(ticket) {
            return None;
        }
        let mut index = self.index.lock().ok()?;
        let root = self.root().ok()?;
        self.load(&mut index).ok()?;
        if !self.accepts(ticket) {
            return None;
        }
        let path = root.directory.join(key);
        let file = open_writable_regular_file(&path)
            .or_else(|_| open_regular_file(&path))
            .ok()?;
        if file.metadata().ok()?.len() != index.entries.get(key)?.bytes {
            // Manual changes invalidate both the old size accounting and proof.
            index.loaded = false;
            self.load(&mut index).ok()?;
        }
        let entry = index.entries.get_mut(key)?;
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
        let verified = entry
            .proof
            .as_ref()
            .is_some_and(|proof| proof.matches(&bytes));
        Some((bytes, verified))
    }

    pub fn store(&self, ticket: &Ticket, key: &str, bytes: &[u8]) -> Result<(), String> {
        self.store_with_before_publish(ticket, key, bytes, |_| {})
    }

    fn discard_if_unchanged(
        &self,
        ticket: &Ticket,
        key: &str,
        expected: &[u8],
    ) -> Result<(), String> {
        if !owned_image(key) || !self.accepts(ticket) {
            return Ok(());
        }
        let mut index = self.index.lock().map_err(|e| e.to_string())?;
        let root = self.root()?;
        self.load(&mut index)?;
        if !self.accepts(ticket) {
            return Ok(());
        }
        let path = root.directory.join(key);
        let Ok(file) = open_regular_file(&path) else {
            return Ok(());
        };
        let mut current = Vec::new();
        file.take(MAX_IMAGE_BYTES as u64 + 1)
            .read_to_end(&mut current)
            .map_err(|e| e.to_string())?;
        if current != expected {
            return Ok(());
        }
        if !self.accepts(ticket) || !root.is_current() {
            return Ok(());
        }
        remove_owned_file(&path)?;
        if let Some(entry) = index.entries.remove(key) {
            index.bytes -= entry.bytes;
        }
        Ok(())
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
        self.publish(&mut index, &root, ticket, key, bytes, None, before_publish)
    }

    #[allow(clippy::too_many_arguments)]
    fn publish(
        &self,
        index: &mut Index,
        root: &Arc<Root>,
        ticket: &Ticket,
        key: &str,
        bytes: &[u8],
        proof: Option<Proof>,
        before_publish: impl FnOnce(&Path),
    ) -> Result<(), String> {
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
        self.make_room(index, bytes.len() as u64, extra_files, Some(key))?;
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
                proof,
                bytes: bytes.len() as u64,
                accessed: SystemTime::now(),
            },
        ) {
            index.bytes -= old.bytes;
        }
        index.bytes += bytes.len() as u64;
        Ok(())
    }

    /// Publish validation only if this generation still owns these exact input bytes.
    fn remember_validation(
        &self,
        ticket: &Ticket,
        key: &str,
        expected: &[u8],
        validated: &[u8],
    ) -> Result<(), String> {
        if !owned_image(key) || !self.accepts(ticket) {
            return Ok(());
        }
        let mut index = self.index.lock().map_err(|e| e.to_string())?;
        let root = self.root()?;
        self.load(&mut index)?;
        if !self.accepts(ticket) {
            return Ok(());
        }
        let path = root.directory.join(key);
        let Ok(file) = open_regular_file(&path) else {
            return Ok(());
        };
        let mut current = Vec::new();
        (&file)
            .take(MAX_IMAGE_BYTES as u64 + 1)
            .read_to_end(&mut current)
            .map_err(|e| e.to_string())?;
        if current != expected
            || !file_is_current(&file, &path)
            || !self.accepts(ticket)
            || !root.is_current()
        {
            return Ok(());
        }
        // Windows replacement can fail while the old read handle remains
        // open. Exact-byte/identity validation is complete and
        // the index mutex still serializes all cache publication.
        drop(file);
        let Some(proof) = Proof::of(validated) else {
            return Ok(());
        };
        if expected != validated {
            self.publish(
                &mut index,
                &root,
                ticket,
                key,
                validated,
                Some(proof),
                |_| {},
            )?;
        } else if let Some(entry) = index.entries.get_mut(key) {
            entry.proof = Some(proof);
        }
        self.save_proofs(&mut index, &root, ticket, Some(key))
    }

    fn store_verified(&self, ticket: &Ticket, key: &str, bytes: &[u8]) -> Result<(), String> {
        let Some(proof) = Proof::of(bytes) else {
            return self.store(ticket, key, bytes);
        };
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
        self.publish(&mut index, &root, ticket, key, bytes, Some(proof), |_| {})?;
        // Metadata durability is optional; valid artwork remains usable if it fails.
        self.save_proofs(&mut index, &root, ticket, Some(key))
    }

    fn save_proofs(
        &self,
        index: &mut Index,
        root: &Arc<Root>,
        ticket: &Ticket,
        protected: Option<&str>,
    ) -> Result<(), String> {
        let mut manifest = ProofManifest {
            validator_version: VALIDATOR_VERSION,
            entries: HashMap::new(),
        };
        let mut size = serde_json::to_vec(&manifest)
            .map_err(|e| e.to_string())?
            .len();
        let mut candidates: Vec<_> = index
            .entries
            .iter()
            .filter_map(|(name, entry)| {
                entry
                    .proof
                    .as_ref()
                    .map(|proof| (name, entry.accessed, proof))
            })
            .collect();
        candidates.sort_unstable_by_key(|(_, accessed, _)| std::cmp::Reverse(*accessed));
        for (name, _, proof) in candidates.into_iter().take(MAX_CACHE_FILES) {
            let extra = serde_json::to_vec(&(name, proof))
                .map_err(|e| e.to_string())?
                .len();
            if size + extra > MAX_PROOF_BYTES as usize {
                continue;
            }
            size += extra;
            manifest.entries.insert(name.clone(), proof.clone());
        }
        let bytes = serde_json::to_vec(&manifest).map_err(|e| e.to_string())?;
        if bytes.len() as u64 > MAX_PROOF_BYTES {
            return Err("Artwork verification manifest is too large".into());
        }
        // Both old manifest and its atomic replacement occupy disk until publication.
        self.make_room(index, bytes.len() as u64, 0, protected)?;
        let mut temporary = PendingImage::new(root.clone())?;
        temporary
            .file
            .as_mut()
            .expect("pending proof writer")
            .write_all(&bytes)
            .map_err(|e| e.to_string())?;
        if !self.accepts(ticket) || !root.is_current() {
            return Err("Artwork request was retired".into());
        }
        temporary.persist(&root.directory.join(PROOF_FILE))?;
        index.proof_bytes = bytes.len() as u64;
        Ok(())
    }

    fn info(&self, index: &Index) -> CacheInfo {
        CacheInfo {
            files: index.entries.len(),
            bytes: index.bytes + index.proof_bytes,
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
            if name.to_str().is_some_and(|name| {
                owned_image(name) || owned_temporary(name) || name == PROOF_FILE
            }) {
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

fn load_proofs(root: &Root) -> Result<(HashMap<String, Proof>, u64), String> {
    let path = root.directory.join(PROOF_FILE);
    let read = || -> Option<(HashMap<String, Proof>, u64)> {
        // The ordinary cache opener repairs mode bits. Verification metadata
        // must already be private before it can be accepted as trusted proof.
        let before = fs::symlink_metadata(&path).ok()?;
        if !regular_file(&before) {
            return None;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if before.permissions().mode() & 0o077 != 0 {
                return None;
            }
        }
        let file = open_regular_file(&path).ok()?;
        let metadata = file.metadata().ok()?;
        if metadata.len() == 0 || metadata.len() > MAX_PROOF_BYTES {
            return None;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o077 != 0 {
                return None;
            }
        }
        let mut bytes = Vec::new();
        (&file)
            .take(MAX_PROOF_BYTES + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        if bytes.len() as u64 != metadata.len()
            || !file_is_current(&file, &path)
            || !root.is_current()
        {
            return None;
        }
        let manifest: ProofManifest = serde_json::from_slice(&bytes).ok()?;
        if manifest.validator_version != VALIDATOR_VERSION
            || manifest.entries.len() > MAX_CACHE_FILES
            || manifest
                .entries
                .iter()
                .any(|(name, proof)| !owned_image(name) || !proof.valid())
        {
            return None;
        }
        Some((manifest.entries, metadata.len()))
    };
    if let Some(value) = read() {
        return Ok(value);
    }
    if !root.is_current() {
        return Err("Artwork cache ownership changed".into());
    }
    // Reserved metadata is disposable. Linked targets and unknown names stay untouched.
    remove_owned_file(&path)?;
    Ok((HashMap::new(), 0))
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
    if directory_id(&directory) != Some(identity) || !file_is_current(&lock, &path) {
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
            if !root.is_current() {
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

pub async fn read_validated(
    cache: Arc<ImageCache>,
    ticket: Ticket,
    key: String,
) -> Option<Vec<u8>> {
    read_validated_using(cache, ticket, key, |bytes| {
        crate::image_content::validate(bytes, None)
    })
    .await
}

async fn read_validated_using<F, Fut>(
    cache: Arc<ImageCache>,
    ticket: Ticket,
    key: String,
    validator: F,
) -> Option<Vec<u8>>
where
    F: FnOnce(Vec<u8>) -> Fut,
    Fut: std::future::Future<Output = Option<Vec<u8>>>,
{
    let reader = cache.clone();
    let read_ticket = ticket.clone();
    let read_key = key.clone();
    let (bytes, verified) =
        tokio::task::spawn_blocking(move || reader.read_with_proof(&read_ticket, &read_key))
            .await
            .ok()??;
    if verified {
        return Some(bytes);
    }
    if let Some(validated) = validator(bytes.clone()).await {
        let result = validated.clone();
        let _ = tokio::task::spawn_blocking(move || {
            cache.remember_validation(&ticket, &key, &bytes, &validated)
        })
        .await;
        return Some(result);
    }
    // Retire only the exact invalid snapshot, never a replacement or new generation.
    let _ = tokio::task::spawn_blocking(move || cache.discard_if_unchanged(&ticket, &key, &bytes))
        .await;
    None
}

pub async fn store(cache: Arc<ImageCache>, ticket: Ticket, key: String, bytes: Vec<u8>) -> Vec<u8> {
    // A failed disk write must not hide successfully fetched artwork.
    tokio::task::spawn_blocking(move || {
        let _ = cache.store_verified(&ticket, &key, &bytes);
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

    #[tokio::test]
    async fn selected_refresh_retires_only_old_source_writers_and_survives_restart() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("images");
        let cache = Arc::new(ImageCache::new(path.clone()));
        let base = cache.ticket();
        let old = cache.bind_key(&base, &key(1)).unwrap();
        let unrelated = cache.bind_key(&base, &key(2)).unwrap();
        let png = crate::image_content::test_png();
        cache.store(&old, &key(1), b"old").unwrap();
        cache.refresh(&old, &key(1), &png).unwrap();
        assert!(cache.store(&old, &key(1), b"late old response").is_err());
        cache.store(&unrelated, &key(2), b"unrelated").unwrap();
        let fresh = cache.bind_key(&base, &key(1)).unwrap();
        assert_eq!(read_validated(cache.clone(), fresh.clone(), key(1)).await, Some(png.clone()));
        assert_eq!(cache.read_with_proof(&unrelated, &key(2)).unwrap().0, b"unrelated");
        drop(fresh); drop(unrelated); drop(old); drop(base); drop(cache);
        let restored = Arc::new(ImageCache::new(path));
        let ticket = restored.bind_key(&restored.ticket(), &key(1)).unwrap();
        assert_eq!(read_validated(restored.clone(), ticket, key(1)).await, Some(png));
    }

    #[test]
    fn refresh_failure_preserves_existing_pixels_and_other_images_without_eviction() {
        let directory = tempfile::tempdir().unwrap();
        let png = crate::image_content::test_png();
        let cache = ImageCache::with_limits(directory.path().join("images"), png.len() as u64 + 6, 2);
        let base = cache.ticket();
        let source = cache.bind_key(&base, &key(1)).unwrap();
        cache.store(&source, &key(1), b"old").unwrap();
        cache.store(&base, &key(2), b"keep").unwrap();
        assert!(cache.refresh(&source, &key(1), &png).is_err());
        assert_eq!(cache.read_with_proof(&source, &key(1)).unwrap().0, b"old");
        assert_eq!(cache.read_with_proof(&base, &key(2)).unwrap().0, b"keep");
        assert!(cache.refresh(&source, &key(1), b"invalid").is_err());
        cache.store(&source, &key(1), b"still owns").unwrap();
    }

    #[test]
    fn source_owner_registry_prunes_finished_requests() {
        let directory = tempfile::tempdir().unwrap();
        let cache = ImageCache::new(directory.path().join("images"));
        for id in 0..5000 { drop(cache.bind_key(&cache.ticket(), &key(id)).unwrap()); }
        assert!(cache.key_owners.lock().unwrap().len() <= 1);
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
        // Parallel cross-process tests can briefly inherit the old lock across
        // fork, until exec closes its descriptor. Ownership must become usable
        // after that handoff; an immediate single read is a timing assumption.
        let after_owner_exit = |cache: &ImageCache| {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
            loop {
                if let Some(bytes) = cache.read(&cache.ticket(), &key(1)) {
                    break bytes;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "Artwork cache ownership did not transfer"
                );
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
        };
        assert_eq!(after_owner_exit(&second), b"owned");
        drop(second);
        let third = ImageCache::new(directory.path().into());
        assert_eq!(after_owner_exit(&third), b"owned");
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
    fn final_artwork_owner_releases_inherited_lock_but_pending_writer_keeps_ownership() {
        let directory = tempfile::tempdir().unwrap();
        let cache = ImageCache::new(directory.path().into());
        cache.store(&cache.ticket(), &key(1), b"owned").unwrap();
        let root = cache.root.lock().unwrap().as_ref().unwrap().clone();
        let inherited = root._lock.try_clone().unwrap();
        let pending = PendingImage::new(root).unwrap();
        drop(cache);
        let blocked = ImageCache::new(directory.path().into());
        assert!(
            blocked.stats().is_err(),
            "pending writer retains exclusivity"
        );
        drop(blocked);
        drop(pending);
        let restored = ImageCache::new(directory.path().into());
        assert_eq!(
            restored.read(&restored.ticket(), &key(1)).unwrap(),
            b"owned"
        );
        drop(inherited);
        let competing = ImageCache::new(directory.path().into());
        assert!(
            competing.stats().is_err(),
            "replacement owner retains exclusivity"
        );
        restored
            .store(&restored.ticket(), &key(2), b"next")
            .unwrap();
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
    fn replacing_the_lock_retires_tickets_and_preserves_reused_pending_paths() {
        let directory = tempfile::tempdir().unwrap();
        let cache = ImageCache::new(directory.path().into());
        let ticket = cache.ticket();
        cache.store(&ticket, &key(1), b"old image").unwrap();
        let mut replacement = None;
        let mut reused = None;
        assert!(cache
            .store_with_before_publish(&ticket, &key(1), b"obsolete image", |temporary| {
                fs::remove_file(directory.path().join(".imgcache.lock")).unwrap();
                let fresh = ImageCache::new(directory.path().into());
                fresh
                    .store(&fresh.ticket(), &key(1), b"replacement image")
                    .unwrap();
                // Reuse the retired writer pathname after new-owner orphan cleanup.
                fs::write(temporary, b"replacement temporary data").unwrap();
                reused = Some(temporary.to_owned());
                replacement = Some(fresh);
            })
            .is_err());
        let replacement = replacement.unwrap();
        assert_eq!(
            fs::read(reused.unwrap()).unwrap(),
            b"replacement temporary data"
        );
        assert_eq!(
            replacement.read(&replacement.ticket(), &key(1)).unwrap(),
            b"replacement image"
        );
        assert!(cache.read(&ticket, &key(1)).is_none());
        assert!(cache.stats().is_err());
        assert!(cache.clear().is_err());
        assert!(cache.store(&ticket, &key(2), b"obsolete").is_err());
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

    #[tokio::test]
    async fn malformed_cached_artwork_is_retired_and_valid_artwork_keeps_its_mime() {
        let directory = tempfile::tempdir().unwrap();
        let cache = Arc::new(ImageCache::new(directory.path().into()));
        let ticket = cache.ticket();
        cache
            .store(&ticket, &key(1), b"<html>Sign in</html>")
            .unwrap();
        assert!(read_validated(cache.clone(), ticket.clone(), key(1))
            .await
            .is_none());
        assert_eq!(cache.stats().unwrap().files, 0);
        let png = crate::image_content::test_png();
        cache.store(&ticket, &key(1), &png).unwrap();
        let bytes = read_validated(cache.clone(), ticket, key(1)).await.unwrap();
        assert_eq!(bytes, png);
        assert_eq!(crate::image_content::mime(&bytes), Some("image/png"));
    }

    #[test]
    fn late_invalid_image_reports_cannot_discard_a_replacement_or_new_generation() {
        let directory = tempfile::tempdir().unwrap();
        let cache = ImageCache::new(directory.path().into());
        let ticket = cache.ticket();
        let invalid = b"<html>Sign in</html>";
        cache.store(&ticket, &key(1), invalid).unwrap();
        let png = crate::image_content::test_png();
        cache.store(&ticket, &key(1), &png).unwrap();
        cache
            .discard_if_unchanged(&ticket, &key(1), invalid)
            .unwrap();
        assert_eq!(cache.read(&ticket, &key(1)), Some(png));
        cache.clear().unwrap();
        let current = cache.ticket();
        cache.store(&current, &key(1), invalid).unwrap();
        cache
            .discard_if_unchanged(&ticket, &key(1), invalid)
            .unwrap();
        assert_eq!(cache.read(&current, &key(1)), Some(invalid.to_vec()));
    }
    async fn counted_read(
        cache: Arc<ImageCache>,
        key: String,
        calls: Arc<AtomicU64>,
    ) -> Option<Vec<u8>> {
        read_validated_using(
            cache.clone(),
            cache.ticket(),
            key,
            move |bytes| async move {
                calls.fetch_add(1, Ordering::Relaxed);
                crate::image_content::validate(bytes, None).await
            },
        )
        .await
    }

    async fn reopen_after_owner_exit(directory: &Path) -> Arc<ImageCache> {
        let reopened = Arc::new(ImageCache::new(directory.into()));
        // A concurrently forked test child may retain the old lock until exec.
        // Wait for ownership before asserting the persistent validation proof.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while reopened.root().is_err() {
            assert!(
                std::time::Instant::now() < deadline,
                "Artwork cache ownership did not transfer"
            );
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
        reopened
    }

    #[tokio::test]
    async fn verified_cache_hits_skip_decoder_in_memory_and_after_native_restart() {
        let directory = tempfile::tempdir().unwrap();
        let png = crate::image_content::test_png();
        let calls = Arc::new(AtomicU64::new(0));
        let cache = Arc::new(ImageCache::new(directory.path().into()));
        cache.store(&cache.ticket(), &key(1), &png).unwrap();
        assert_eq!(
            counted_read(cache.clone(), key(1), calls.clone()).await,
            Some(png.clone())
        );
        assert_eq!(calls.load(Ordering::Relaxed), 1);
        assert_eq!(
            counted_read(cache.clone(), key(1), calls.clone()).await,
            Some(png.clone())
        );
        assert_eq!(calls.load(Ordering::Relaxed), 1);
        drop(cache);
        let reopened = reopen_after_owner_exit(directory.path()).await;
        assert_eq!(
            counted_read(reopened, key(1), calls.clone()).await,
            Some(png)
        );
        assert_eq!(calls.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn already_validated_downloads_get_persistent_proof_without_another_decode() {
        let directory = tempfile::tempdir().unwrap();
        let png = crate::image_content::test_png();
        let cache = Arc::new(ImageCache::new(directory.path().into()));
        assert_eq!(
            store(cache.clone(), cache.ticket(), key(1), png.clone()).await,
            png
        );
        drop(cache);
        let reopened = reopen_after_owner_exit(directory.path()).await;
        let calls = Arc::new(AtomicU64::new(0));
        assert_eq!(
            counted_read(reopened, key(1), calls.clone()).await,
            Some(png)
        );
        assert_eq!(calls.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn same_size_bitrot_invalidates_proof_and_retires_the_exact_corrupt_pixels() {
        let directory = tempfile::tempdir().unwrap();
        let png = crate::image_content::test_png();
        let cache = Arc::new(ImageCache::new(directory.path().into()));
        store(cache.clone(), cache.ticket(), key(1), png.clone()).await;
        let mut corrupt = png.clone();
        let idat = corrupt
            .windows(4)
            .position(|bytes| bytes == b"IDAT")
            .unwrap();
        corrupt[idat + 6] ^= 0xff;
        fs::write(directory.path().join(key(1)), &corrupt).unwrap();
        let calls = Arc::new(AtomicU64::new(0));
        assert!(counted_read(cache.clone(), key(1), calls.clone())
            .await
            .is_none());
        assert_eq!(calls.load(Ordering::Relaxed), 1);
        assert!(!directory.path().join(key(1)).exists());
        assert_eq!(cache.stats().unwrap().files, 0);
    }

    #[tokio::test]
    async fn normalized_legacy_pixels_are_replaced_before_their_persistent_proof() {
        let directory = tempfile::tempdir().unwrap();
        let ppm = b"P6\n1 1\n255\n\x01\x02\x03";
        let cache = Arc::new(ImageCache::new(directory.path().into()));
        cache.store(&cache.ticket(), &key(1), ppm).unwrap();
        let calls = Arc::new(AtomicU64::new(0));
        let png = counted_read(cache.clone(), key(1), calls.clone())
            .await
            .unwrap();
        assert_eq!(crate::image_content::mime(&png), Some("image/png"));
        assert_eq!(fs::read(directory.path().join(key(1))).unwrap(), png);
        drop(cache);
        let reopened = reopen_after_owner_exit(directory.path()).await;
        assert_eq!(
            counted_read(reopened, key(1), calls.clone()).await,
            Some(png)
        );
        assert_eq!(calls.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn normalized_publication_closes_its_original_handle_and_records_exact_new_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let ppm = b"P6\n1 1\n255\n\x01\x02\x03";
        let cache = ImageCache::new(directory.path().into());
        let ticket = cache.ticket();
        cache.store(&ticket, &key(1), ppm).unwrap();
        let png = crate::image_content::validate(ppm.to_vec(), None)
            .await
            .unwrap();
        // Assert publication itself, rather than the best-effort public read
        // path which intentionally still serves valid pixels on write failure.
        cache
            .remember_validation(&ticket, &key(1), ppm, &png)
            .unwrap();
        assert_eq!(fs::read(directory.path().join(key(1))).unwrap(), png);
        let (persisted, verified) = cache.read_with_proof(&ticket, &key(1)).unwrap();
        assert_eq!(persisted, png);
        assert!(verified);
        assert_eq!(cache.stats().unwrap().files, 1);
    }

    #[tokio::test]
    async fn old_validation_after_clear_cannot_republish_proof_or_normalized_pixels() {
        let directory = tempfile::tempdir().unwrap();
        let cache = Arc::new(ImageCache::new(directory.path().into()));
        let ppm = b"P6\n1 1\n255\n\x01\x02\x03";
        cache.store(&cache.ticket(), &key(1), ppm).unwrap();
        let (entered, entering) = tokio::sync::oneshot::channel();
        let (release, released) = tokio::sync::oneshot::channel();
        let pending = tokio::spawn(read_validated_using(
            cache.clone(),
            cache.ticket(),
            key(1),
            move |bytes| async move {
                entered.send(()).unwrap();
                released.await.unwrap();
                crate::image_content::validate(bytes, None).await
            },
        ));
        entering.await.unwrap();
        cache.clear().unwrap();
        // Identical bytes in a new generation must not inherit the old validation.
        cache.store(&cache.ticket(), &key(1), ppm).unwrap();
        release.send(()).unwrap();
        assert!(pending.await.unwrap().is_some());
        assert_eq!(fs::read(directory.path().join(key(1))).unwrap(), ppm);
        assert!(!directory.path().join(PROOF_FILE).exists());
    }

    #[tokio::test]
    async fn late_normalization_cannot_replace_newer_artwork_under_the_same_key() {
        let directory = tempfile::tempdir().unwrap();
        let cache = Arc::new(ImageCache::new(directory.path().into()));
        let ppm = b"P6\n1 1\n255\n\x01\x02\x03";
        cache.store(&cache.ticket(), &key(1), ppm).unwrap();
        let (entered, entering) = tokio::sync::oneshot::channel();
        let (release, released) = tokio::sync::oneshot::channel();
        let pending = tokio::spawn(read_validated_using(
            cache.clone(),
            cache.ticket(),
            key(1),
            move |bytes| async move {
                entered.send(()).unwrap();
                released.await.unwrap();
                crate::image_content::validate(bytes, None).await
            },
        ));
        entering.await.unwrap();
        let newer = crate::image_content::test_png();
        cache.store(&cache.ticket(), &key(1), &newer).unwrap();
        release.send(()).unwrap();
        assert!(pending.await.unwrap().is_some());
        assert_eq!(fs::read(directory.path().join(key(1))).unwrap(), newer);
        assert!(!directory.path().join(PROOF_FILE).exists());
    }

    #[tokio::test]
    async fn proof_persistence_failure_does_not_hide_artwork_or_exceed_the_disk_budget() {
        let directory = tempfile::tempdir().unwrap();
        let png = crate::image_content::test_png();
        let limit = png.len() as u64 + 16;
        let cache = Arc::new(ImageCache::with_limits(directory.path().into(), limit, 2));
        assert_eq!(
            store(cache.clone(), cache.ticket(), key(1), png.clone()).await,
            png
        );
        assert_eq!(cache.read(&cache.ticket(), &key(1)), Some(png.clone()));
        assert!(!directory.path().join(PROOF_FILE).exists());
        assert_eq!(cache.stats().unwrap().bytes, png.len() as u64);
        assert!(cache.stats().unwrap().bytes <= limit);
        let calls = Arc::new(AtomicU64::new(0));
        assert_eq!(counted_read(cache, key(1), calls.clone()).await, Some(png));
        assert_eq!(calls.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn clear_removes_only_the_reserved_proof_manifest_and_owned_images() {
        let directory = tempfile::tempdir().unwrap();
        let cache = Arc::new(ImageCache::new(directory.path().into()));
        let png = crate::image_content::test_png();
        store(cache.clone(), cache.ticket(), key(1), png).await;
        fs::write(directory.path().join("verified-notes.json"), b"keep").unwrap();
        let metadata = fs::metadata(directory.path().join(PROOF_FILE)).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
        }
        assert!(metadata.len() <= MAX_PROOF_BYTES);
        let info = cache.stats().unwrap();
        assert_eq!(
            info.bytes,
            metadata.len() + fs::metadata(directory.path().join(key(1))).unwrap().len()
        );
        assert_eq!(cache.clear().unwrap().bytes, 0);
        assert!(!directory.path().join(PROOF_FILE).exists());
        assert_eq!(
            fs::read(directory.path().join("verified-notes.json")).unwrap(),
            b"keep"
        );
    }

    #[tokio::test]
    async fn malformed_or_oversized_proofs_never_bypass_the_decoder() {
        let png = crate::image_content::test_png();
        let good = Proof::of(&png).unwrap();
        let mut excessive = HashMap::new();
        for id in 0..=MAX_CACHE_FILES as u64 {
            excessive.insert(key(id), good.clone());
        }
        let cases = [
            b"{invalid".to_vec(),
            vec![b' '; MAX_PROOF_BYTES as usize + 1],
            serde_json::to_vec(&ProofManifest {
                validator_version: VALIDATOR_VERSION + 1,
                entries: HashMap::from([(key(1), good.clone())]),
            })
            .unwrap(),
            serde_json::to_vec(&ProofManifest {
                validator_version: VALIDATOR_VERSION,
                entries: excessive,
            })
            .unwrap(),
            serde_json::to_vec(&ProofManifest {
                validator_version: VALIDATOR_VERSION,
                entries: HashMap::from([("../outside.img".into(), good)]),
            })
            .unwrap(),
        ];
        for manifest in cases {
            let directory = tempfile::tempdir().unwrap();
            fs::write(directory.path().join(key(1)), &png).unwrap();
            let path = directory.path().join(PROOF_FILE);
            fs::write(&path, manifest).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
            }
            let cache = Arc::new(ImageCache::new(directory.path().into()));
            let calls = Arc::new(AtomicU64::new(0));
            assert_eq!(
                counted_read(cache, key(1), calls.clone()).await,
                Some(png.clone())
            );
            assert_eq!(calls.load(Ordering::Relaxed), 1);
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn publicly_readable_or_linked_manifests_are_not_validation_proof() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let png = crate::image_content::test_png();
        for linked in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let images = directory.path().join("images");
            fs::create_dir(&images).unwrap();
            fs::write(images.join(key(1)), &png).unwrap();
            let outside = directory.path().join("outside.json");
            let raw = serde_json::to_vec(&ProofManifest {
                validator_version: VALIDATOR_VERSION,
                entries: HashMap::from([(key(1), Proof::of(&png).unwrap())]),
            })
            .unwrap();
            fs::write(&outside, &raw).unwrap();
            if linked {
                symlink(&outside, images.join(PROOF_FILE)).unwrap();
            } else {
                fs::write(images.join(PROOF_FILE), &raw).unwrap();
                fs::set_permissions(images.join(PROOF_FILE), fs::Permissions::from_mode(0o644))
                    .unwrap();
            }
            let calls = Arc::new(AtomicU64::new(0));
            assert_eq!(
                counted_read(Arc::new(ImageCache::new(images)), key(1), calls.clone()).await,
                Some(png.clone())
            );
            assert_eq!(calls.load(Ordering::Relaxed), 1);
            assert_eq!(fs::read(&outside).unwrap(), raw);
        }
    }
}
