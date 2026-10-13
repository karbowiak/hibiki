//! Local SQLite database layer.
//!
//! Stores artists, albums, tracks, playlists, and metadata from Plex with
//! properly typed columns — enabling fast queries, local search, and
//! deduplication.

pub mod albums;
pub mod artists;
pub mod kv;
pub mod offline;
pub mod playlists;
pub mod schema;
pub mod semantic;
pub mod tracks;

use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;
use serde::Serialize;

/// Shared database state managed by Tauri.
pub struct DbState(pub Mutex<Connection>);

impl DbState {
    /// Open (or create) the database at `db_path`, configure WAL mode and
    /// foreign keys, then run any pending migrations.
    pub fn open(db_path: &Path) -> Result<Self, String> {
        let parent = db_path
            .parent()
            .ok_or("Database has no private directory")?;
        if crate::cache_files::directory_id(parent).is_none() {
            return Err("Database directory is linked or unavailable".into());
        }
        // macOS /var and user-selected parent aliases are legitimate; pin the
        // verified leaf directory before SQLite's NOFOLLOW checks every component.
        let canonical_parent =
            std::fs::canonicalize(parent).map_err(|_| "Database directory unavailable")?;
        if crate::cache_files::directory_id(&canonical_parent)
            != crate::cache_files::directory_id(parent)
        {
            return Err("Database directory changed".into());
        }
        let normalized =
            canonical_parent.join(db_path.file_name().ok_or("Database filename unavailable")?);
        let db_path = normalized.as_path();
        let parent = canonical_parent.as_path();
        #[cfg(unix)]
        {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            let directory = std::fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
                .open(parent)
                .map_err(|_| "Database directory unavailable")?;
            directory
                .set_permissions(std::fs::Permissions::from_mode(0o700))
                .map_err(|_| "Cannot protect database directory")?;
        }
        // Create private files before enabling WAL. Existing linked database or
        // sidecar paths must not redirect writes/permission changes elsewhere.
        let sidecar = |suffix: &str| {
            let mut name = db_path.as_os_str().to_owned();
            name.push(suffix);
            std::path::PathBuf::from(name)
        };
        for path in [db_path.to_owned(), sidecar("-wal"), sidecar("-shm")] {
            match std::fs::symlink_metadata(&path) {
                Ok(_) => {
                    let file = crate::cache_files::open_regular_file(&path)
                        .map_err(|_| "Database path is linked or unavailable")?;
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        file.set_permissions(std::fs::Permissions::from_mode(0o600))
                            .map_err(|_| "Cannot protect database permissions")?;
                    }
                    #[cfg(not(unix))]
                    drop(file);
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err("Database path is unavailable".into()),
            }
        }
        match std::fs::File::create_new(db_path) {
            Ok(file) => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    file.set_permissions(std::fs::Permissions::from_mode(0o600))
                        .map_err(|_| "Cannot protect database permissions")?;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(format!("Failed to create database: {error}")),
        }
        let conn = Connection::open_with_flags(
            db_path,
            rusqlite::OpenFlags::default() | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .map_err(|e| format!("Failed to open database: {e}"))?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| format!("Failed to set WAL mode: {e}"))?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| format!("Failed to enable foreign keys: {e}"))?;
        schema::run_migrations(&conn)?;
        Ok(Self(Mutex::new(conn)))
    }

    /// Open an in-memory database for testing.
    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory()
            .map_err(|e| format!("Failed to open in-memory db: {e}"))?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| format!("Failed to enable foreign keys: {e}"))?;
        schema::run_migrations(&conn)?;
        Ok(Self(Mutex::new(conn)))
    }
}

/// Atomically replace a metadata parent and its children, including inside a
/// bulk transaction. Dropping the guard rolls back early returns and panics.
pub(crate) fn atomic_upsert<T>(
    conn: &Connection,
    work: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    const NAME: &str = "hibiki_metadata_upsert";
    struct Rollback<'a> {
        conn: &'a Connection,
        active: bool,
    }
    impl Drop for Rollback<'_> {
        fn drop(&mut self) {
            if self.active {
                let _ = self.conn.execute_batch(
                    "ROLLBACK TO hibiki_metadata_upsert; RELEASE hibiki_metadata_upsert",
                );
            }
        }
    }
    conn.execute_batch(&format!("SAVEPOINT {NAME}"))
        .map_err(|error| format!("begin metadata savepoint error: {error}"))?;
    let mut rollback = Rollback { conn, active: true };
    let value = work(conn)?;
    conn.execute_batch(&format!("RELEASE {NAME}"))
        .map_err(|error| format!("commit metadata savepoint error: {error}"))?;
    rollback.active = false;
    Ok(value)
}

/// Database info returned by the `db_get_info` command.
#[derive(Debug, Serialize)]
pub struct DbInfo {
    pub artist_count: i64,
    pub album_count: i64,
    pub track_count: i64,
    pub playlist_count: i64,
    pub tag_count: i64,
    pub play_history_count: i64,
}

/// Helper: parse a Plex API path like "/library/metadata/12345" into the
/// trailing numeric ID, or return `None` if the path doesn't match.
pub fn parse_plex_id(path: &str) -> Option<i64> {
    path.rsplit('/').next().and_then(|s| s.parse().ok())
}

/// Convert an `Option<DateTime<Utc>>` to an ISO 8601 string or None.
pub fn datetime_to_iso(dt: &Option<chrono::DateTime<chrono::Utc>>) -> Option<String> {
    dt.map(|d| d.to_rfc3339())
}

/// Parse an ISO 8601 string back to `Option<DateTime<Utc>>`.
#[allow(dead_code)]
pub fn iso_to_datetime(s: &Option<String>) -> Option<chrono::DateTime<chrono::Utc>> {
    s.as_ref()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.with_timezone(&chrono::Utc))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_plex_id() {
        assert_eq!(parse_plex_id("/library/metadata/12345"), Some(12345));
        assert_eq!(parse_plex_id("/library/metadata/42/children"), None);
        assert_eq!(parse_plex_id(""), None);
        assert_eq!(parse_plex_id("12345"), Some(12345));
    }

    #[test]
    fn test_open_in_memory() {
        let db = DbState::open_in_memory().expect("should open in-memory db");
        let conn = db.0.lock().unwrap();
        // Verify tables exist by running a count query
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM artists", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }
}

#[cfg(all(test, unix))]
mod privacy_tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};
    #[test]
    fn database_and_wal_are_private_and_linked_paths_preserve_other_data() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db.sqlite");
        let db = DbState::open(&path).unwrap();
        let conn = db.0.lock().unwrap();
        crate::db::kv::set(&conn, "private", "listening history").unwrap();
        for file in [&path, &dir.path().join("db.sqlite-wal")] {
            assert_eq!(
                std::fs::metadata(file).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert_eq!(
            std::fs::metadata(dir.path()).unwrap().permissions().mode() & 0o777,
            0o700
        );
        drop(conn);
        drop(db);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        drop(DbState::open(&path).unwrap());
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        let outside = dir.path().join("outside");
        std::fs::write(&outside, b"unrelated bytes").unwrap();
        std::fs::set_permissions(&outside, std::fs::Permissions::from_mode(0o640)).unwrap();
        let hardlink = dir.path().join("hardlinked.sqlite");
        std::fs::hard_link(&outside, &hardlink).unwrap();
        assert!(DbState::open(&hardlink).is_err());
        assert_eq!(std::fs::metadata(&outside).unwrap().permissions().mode() & 0o777, 0o640);
        for (index, suffix) in ["", "-wal", "-shm"].into_iter().enumerate() {
            let path = dir.path().join(format!("linked{index}.sqlite"));
            let mut linked = path.as_os_str().to_owned();
            linked.push(suffix);
            symlink(&outside, std::path::PathBuf::from(linked)).unwrap();
            assert!(DbState::open(&path).is_err());
            assert_eq!(std::fs::read(&outside).unwrap(), b"unrelated bytes");
            assert_eq!(
                std::fs::metadata(&outside).unwrap().permissions().mode() & 0o777,
                0o640
            );
        }
    }
}
