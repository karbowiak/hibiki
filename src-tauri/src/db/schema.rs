//! Database schema management — runs SQL migrations on startup.

use rusqlite::Connection;

/// Run all pending migrations against the given connection.
///
/// Uses a simple `schema_version` pragma to track which migrations have run.
/// Each migration is an idempotent SQL script applied in order.
pub fn run_migrations(conn: &Connection) -> Result<(), String> {
    let current_version: i64 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|e| format!("Failed to read schema version: {e}"))?;

    let migrations: &[(i64, &str)] = &[
        (1, include_str!("migrations/V1__initial.sql")),
        (2, include_str!("migrations/V2__offline_snapshots.sql")),
        // Retain the applied development migration for existing databases.
        // AI discovery is deferred; no active commands read/write these rows.
        (3, include_str!("migrations/V3__semantic_vectors.sql")),
        (4, include_str!("migrations/V4__local_audio.sql")),
        (5, include_str!("migrations/V5__plex_catalogue.sql")),
        (6, include_str!("migrations/V6__catalogue_sync.sql")),
        (7, include_str!("migrations/V7__download_entities.sql")),
    ];

    for &(version, sql) in migrations {
        if current_version < version {
            apply_migration(conn, version, sql)?;
        }
    }

    Ok(())
}

fn apply_migration(conn: &Connection, version: i64, sql: &str) -> Result<(), String> {
    let transaction = conn
        .unchecked_transaction()
        .map_err(|_| format!("Cannot start migration V{version}"))?;
    transaction
        .execute_batch(sql)
        .map_err(|_| format!("Migration V{version} failed"))?;
    transaction
        .pragma_update(None, "user_version", version)
        .map_err(|_| format!("Cannot record migration V{version}"))?;
    transaction
        .commit()
        .map_err(|_| format!("Cannot commit migration V{version}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_migrations_are_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();

        // Run once
        run_migrations(&conn).expect("first run");
        let v1: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(v1, 7);

        // Run again — should be a no-op
        run_migrations(&conn).expect("second run");
        let v2: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(v2, 7);
    }

    #[test]
    fn failed_migration_rolls_back_schema_and_version() {
        let conn = Connection::open_in_memory().unwrap();
        assert!(
            apply_migration(&conn, 1, "CREATE TABLE partial(id INTEGER); INVALID SQL;").is_err()
        );
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, 0);
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='partial'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
        run_migrations(&conn).unwrap();
    }

    #[test]
    fn legacy_rows_are_not_imported_into_account_snapshots() {
        let conn = Connection::open_in_memory().unwrap();
        apply_migration(&conn, 1, include_str!("migrations/V1__initial.sql")).unwrap();
        conn.execute("INSERT INTO artists(id,title) VALUES(1,'legacy')", [])
            .unwrap();
        run_migrations(&conn).unwrap();
        let legacy: i64 = conn
            .query_row("SELECT COUNT(*) FROM artists", [], |r| r.get(0))
            .unwrap();
        let scoped: i64 = conn
            .query_row("SELECT COUNT(*) FROM offline_snapshots", [], |r| r.get(0))
            .unwrap();
        assert_eq!((legacy, scoped), (1, 0));
    }

    #[test]
    fn test_all_tables_created() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        run_migrations(&conn).expect("migrations");

        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();

        let expected = vec![
            "album_reviews",
            "albums",
            "artist_locations",
            "artists",
            "kv",
            "lyrics",
            "media",
            "media_parts",
            "offline_snapshots",
            "play_history",
            "playlist_tracks",
            "playlists",
            "streams",
            "semantic_vectors",
            "tags",
            "tracks",
        ];

        for name in &expected {
            assert!(tables.contains(&name.to_string()), "missing table: {name}");
        }
    }
}
